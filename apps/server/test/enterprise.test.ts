import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enterprise, type EnterpriseOptions } from '../../../ee/index.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import type { Mail } from '../src/util.ts';
import { testDb } from './db.ts';

let dir: string;
let server: RunningServer;
let mails: Mail[];
let base: string;
let tdb: Awaited<ReturnType<typeof testDb>>;

const boot = async (o: EnterpriseOptions) => {
  server = await startServer({ port: 0, dir, pingMs: 60_000, db: tdb.db, appUrl: 'http://app.test/', mailer: { send: async (m) => void mails.push(m) }, enterprise: enterprise(o) });
  base = `http://localhost:${server.port}`;
};

beforeEach(async () => {
  tdb = await testDb();
  dir = mkdtempSync(join(tmpdir(), 'mfp-ee-'));
  mails = [];
});

afterEach(async () => {
  await server?.close();
  await tdb.dispose();
  rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>;
async function api(method: string, path: string, body?: unknown, token?: string, type = 'application/json'): Promise<{ status: number; data: Json; text: string; headers: Headers }> {
  const res = await fetch(base + path, { method, headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let data: Json = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // CSV etc.
  }
  return { status: res.status, data, text, headers: res.headers };
}
async function login(email: string): Promise<string> {
  await api('POST', '/api/auth/code', { email });
  const code = /(\d{6})/.exec(mails.filter((m) => m.to === email).at(-1)!.subject)![1]!;
  return (await api('POST', '/api/auth/verify', { email, code })).data.token;
}

describe('audit log', () => {
  it('sign-in, team, file, access — in the log; only an administrator can read it; CSV', async () => {
    await boot({});
    const anna = await login('anna@example.com');
    const boris = await login('boris@example.com');
    const team = (await api('POST', '/api/teams', { name: 'Студия' }, anna)).data;
    const file = (await api('POST', '/api/files', { name: 'Макет', projectId: team.projectId }, anna)).data;
    await api('POST', `/api/files/${file.id}/access`, { email: 'boris@example.com', role: 'view' }, anna);
    await api('PUT', `/api/files/${file.id}/link`, { role: 'view' }, anna);
    await new Promise((r) => setTimeout(r, 50));
    expect((await api('GET', '/api/admin/audit', undefined, boris)).status).toBe(403);
    const log = (await api('GET', '/api/admin/audit?user=anna@example.com', undefined, anna)).data.entries as Json[];
    expect(log.map((e) => e.action).reverse()).toEqual(['login', 'team.create', 'file.create', 'file.share', 'file.link']);
    expect(log.find((e) => e.action === 'file.share')).toMatchObject({ email: 'anna@example.com', target: file.id, status: 200 });
    const csv = await api('GET', '/api/admin/audit?action=file.&format=csv', undefined, anna);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    // The text() decoder strips the BOM (for Excel).
    expect(csv.text.split('\r\n')[0]).toBe('time,email,action,target,status,ip,userAgent,details');
    expect(csv.text.split('\r\n').length).toBe(4);
  });
});

/** Fake OIDC provider: discovery, JWKS, code exchange (PKCE) and a signed id_token. */
async function fakeIdp(opts: { aud?: string; key?: KeyObject } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map<string, { challenge: string; nonce: string; email: string }>();
  let issuer = '';
  const idp: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (url.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      if (url.pathname === '/jwks') return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
      if (url.pathname === '/token') {
        const p = new URLSearchParams(body);
        const c = codes.get(p.get('code') ?? '');
        const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (!c || challenge !== c.challenge || req.headers.authorization !== `Basic ${Buffer.from('mfp:secret').toString('base64')}`) return res.writeHead(400).end('{"error":"invalid_grant"}');
        const now = Math.floor(Date.now() / 1000);
        const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
        const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: opts.aud ?? 'mfp', sub: 'u-42', email: c.email, email_verified: true, name: 'Анна Петрова', nonce: c.nonce, iat: now, exp: now + 300 })).toString('base64url');
        const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(opts.key ?? privateKey).toString('base64url');
        return json({ id_token: `${head}.${claims}.${sig}`, access_token: 'x', token_type: 'Bearer' });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => idp.listen(0, r));
  issuer = `http://localhost:${(idp.address() as AddressInfo).port}`;
  /** “Browser”: start sign-in with us, “sign in” at the provider, come back with the code. */
  const signIn = async (email: string, redirect = 'http://app.test/') => {
    const start = await fetch(`${base}/api/sso/start?redirect=${encodeURIComponent(redirect)}`, { redirect: 'manual' });
    const auth = new URL(start.headers.get('location')!);
    const code = `code-${codes.size}`;
    codes.set(code, { challenge: auth.searchParams.get('code_challenge')!, nonce: auth.searchParams.get('nonce')!, email });
    const back = await fetch(`${base}/api/sso/callback?code=${code}&state=${auth.searchParams.get('state')}`, { redirect: 'manual' });
    return { location: back.headers.get('location')!, auth, state: auth.searchParams.get('state')! };
  };
  return { idp, issuer, signIn, close: () => new Promise((r) => idp.close(r)) };
}

describe('SSO (OIDC)', () => {
  it('sign-in via a provider: PKCE, JWKS signature, nonce; domains — SSO only', async () => {
    const idp = await fakeIdp();
    try {
      await boot({ oidc: { issuer: idp.issuer, clientId: 'mfp', clientSecret: 'secret', name: 'Войти через Okta', domains: ['corp.example'] } });
      expect((await api('GET', '/api/sso/config')).data).toEqual({ enabled: true, name: 'Войти через Okta', domains: ['corp.example'] });
      const r = await idp.signIn('anna@corp.example');
      expect(r.auth.searchParams.get('code_challenge_method')).toBe('S256');
      expect(r.auth.searchParams.get('redirect_uri')).toBe(`${base}/api/sso/callback`);
      const m = /^http:\/\/app\.test\/#sso=(.+)$/.exec(r.location);
      expect(m).toBeTruthy();
      const me = (await api('GET', '/api/me', undefined, m![1])).data.user;
      expect(me).toMatchObject({ email: 'anna@corp.example', name: 'Анна Петрова' });
      // Replaying the same state is rejected.
      const again = await fetch(`${base}/api/sso/callback?code=code-0&state=${r.state}`, { redirect: 'manual' });
      expect(decodeURIComponent(again.headers.get('location')!)).toContain('sso_error=Вход устарел');
      // Email code for the company domain is not allowed; a foreign redirect address goes to the server's editor.
      expect((await api('POST', '/api/auth/code', { email: 'boris@corp.example' })).data.error).toBe('Почта домена corp.example входит через SSO компании');
      expect((await idp.signIn('boris@corp.example', 'https://evil.example/steal')).location.startsWith('http://app.test/#sso=')).toBe(true);
      // The log records an SSO sign-in.
      const admin = m![1]!;
      expect(((await api('GET', '/api/admin/audit?action=login.sso', undefined, admin)).data.entries as Json[]).map((e) => e.email)).toContain('anna@corp.example');
    } finally {
      await idp.close();
    }
  });

  it('a foreign signature and a foreign audience — rejected', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const forged = await fakeIdp({ key: other });
    try {
      await boot({ oidc: { issuer: forged.issuer, clientId: 'mfp', clientSecret: 'secret' } });
      expect(decodeURIComponent((await forged.signIn('x@example.com')).location)).toContain('sso_error=OIDC: подпись id_token не сходится');
    } finally {
      await forged.close();
    }
    await server.close();
    const wrongAud = await fakeIdp({ aud: 'другое-приложение' });
    try {
      await boot({ oidc: { issuer: wrongAud.issuer, clientId: 'mfp', clientSecret: 'secret' } });
      expect(decodeURIComponent((await wrongAud.signIn('x@example.com')).location)).toContain('sso_error=OIDC: токен не для MFP (aud)');
    } finally {
      await wrongAud.close();
    }
  });
});

describe('SCIM 2.0', () => {
  it('users: create, find, disable (sessions are revoked); groups — teams', async () => {
    await boot({ scimToken: 'scim-secret' });
    const scim = (method: string, path: string, body?: unknown, token = 'scim-secret') => api(method, `/scim/v2${path}`, body, token, 'application/scim+json');
    expect((await scim('GET', '/Users', undefined, 'wrong')).status).toBe(401);
    const u = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'Ivan@Corp.example', name: { givenName: 'Иван', familyName: 'Петров' }, externalId: 'okta-1', active: true });
    expect(u.status).toBe(201);
    expect(u.data).toMatchObject({ userName: 'ivan@corp.example', displayName: 'Иван Петров', externalId: 'okta-1', active: true });
    expect((await scim('POST', '/Users', { userName: 'ivan@corp.example' })).status).toBe(409);
    const found = await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "ivan@corp.example"')}`);
    expect(found.data).toMatchObject({ totalResults: 1, Resources: [{ id: u.data.id }] });
    // Ivan signs in, then the directory disables him — the session is no longer valid.
    const token = await login('ivan@corp.example');
    expect((await api('GET', '/api/me', undefined, token)).status).toBe(200);
    expect((await scim('PATCH', `/Users/${u.data.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: false } }] })).data.active).toBe(false);
    expect((await api('GET', '/api/me', undefined, token)).status).toBe(401);
    expect((await api('POST', '/api/auth/code', { email: 'ivan@corp.example' })).status).toBe(403);
    // Group = team.
    const maria = (await scim('POST', '/Users', { userName: 'maria@corp.example' })).data;
    const g = await scim('POST', '/Groups', { displayName: 'Дизайн', members: [{ value: u.data.id }, { value: maria.id }] });
    expect(g.data.members.map((x: Json) => x.display).sort()).toEqual(['ivan@corp.example', 'maria@corp.example']);
    await scim('PATCH', `/Groups/${g.data.id}`, { Operations: [{ op: 'remove', path: `members[value eq "${u.data.id}"]` }, { op: 'replace', value: { displayName: 'Дизайн и бренд' } }] });
    expect((await scim('GET', `/Groups/${g.data.id}`)).data).toMatchObject({ displayName: 'Дизайн и бренд', members: [{ display: 'maria@corp.example' }] });
    const mtoken = await login('maria@corp.example');
    expect((await api('GET', '/api/teams', undefined, mtoken)).data.teams).toMatchObject([{ name: 'Дизайн и бренд', role: 'editor' }]);
    expect((await scim('DELETE', `/Groups/${g.data.id}`)).status).toBe(204);
    expect((await api('GET', '/api/teams', undefined, mtoken)).data.teams).toEqual([]);
  });
});
