import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from '../src/server.ts';
import { betaFromEnv } from '../src/beta.ts';
import type { Mail } from '../src/util.ts';
import { testDb } from './db.ts';

let server: RunningServer | undefined;
let dir: string;
let tdb: Awaited<ReturnType<typeof testDb>> | undefined;
afterEach(async () => {
  await server?.close(); server = undefined;
  await tdb?.dispose(); tdb = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('beta configuration fails closed without owner, SMTP or HTTPS', () => {
  expect(betaFromEnv({})).toBeUndefined();
  const env = { MFP_BETA: '1', MFP_BETA_OWNER: 'Owner@example.com', MFP_BETA_EMAILS: 'owner@example.com,friend@example.com', SMTP_HOST: 'mail.example.com', SMTP_FROM: 'mfp@example.com', MFP_APP_URL: 'https://mfp.example.com' };
  expect(betaFromEnv(env)?.owner).toBe('owner@example.com');
  for (const field of ['MFP_BETA_OWNER', 'MFP_BETA_EMAILS', 'SMTP_HOST', 'SMTP_FROM', 'MFP_APP_URL']) {
    expect(() => betaFromEnv({ ...env, [field]: '' })).toThrow();
  }
  expect(() => betaFromEnv({ ...env, SCIM_TOKEN: 'secret' })).toThrow();
});

it('closed beta: invited login, explicit owner, private media, no anonymous rooms or API', async () => {
  dir = mkdtempSync(join(tmpdir(), 'mfp-beta-'));
  const mails: Mail[] = [];
  const beta = { owner: 'owner@example.com', emails: ['owner@example.com', 'friend@example.com'] };
  tdb = await testDb();
  server = await startServer({ port: 0, dir, db: tdb.db, beta, mailer: { send: async m => { mails.push(m); } } });
  const base = `http://localhost:${server.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('/api/auth/code', { email: 'stranger@example.com' })).status).toBe(403);
  expect(mails).toHaveLength(0);
  const login = async (email: string) => {
    expect((await post('/api/auth/code', { email })).status).toBe(200);
    const code = /код для входа (\d{6})/.exec(mails.at(-1)!.subject)![1];
    const r = await post('/api/auth/verify', { email, code });
    expect(r.status).toBe(200);
    return await r.json() as { token: string; user: { admin: boolean } };
  };
  const friend = await login('friend@example.com');
  expect(Number(friend.user.admin)).toBe(0);
  const owner = await login('owner@example.com');
  expect(Number(owner.user.admin)).toBe(1);
  expect((await fetch(base + '/api/files')).status).toBe(401);
  expect((await fetch(base + '/image/' + 'a'.repeat(40) + '?size=256')).status).toBe(401);
  const bytes = new TextEncoder().encode('beta image');
  const hash = createHash('sha1').update(bytes).digest('hex');
  const headers = { authorization: `Bearer ${friend.token}` };
  for (const method of ['HEAD', 'GET', 'PUT']) expect((await fetch(`${base}/image/${hash}`, { method })).status).toBe(401);
  expect((await fetch(`${base}/image/${hash}`, { method: 'PUT', headers, body: bytes })).status).toBe(201);
  const img = await fetch(`${base}/image/${hash}`, { headers });
  expect(img.status).toBe(200);
  expect(img.headers.get('cache-control')).toBe('private, no-store');
  expect(new Uint8Array(await img.arrayBuffer())).toEqual(bytes);
  for (const path of ['/room/test', '/file/test']) {
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(base.replace('http:', 'ws:') + path);
      ws.on('close', c => resolve(c)); ws.on('error', reject);
    });
    expect(code).toBe(4403);
  }
  expect(server.rooms).toBe(0);
  beta.emails = ['owner@example.com'];
  expect((await fetch(base + '/api/files', { headers })).status).toBe(401);
  // A global bound applies even when the attacker rotates email addresses.
  let last = 0;
  for (let i = 0; i < 61; i++) last = (await post('/api/auth/code', { email: `stranger${i}@example.com` })).status;
  expect(last).toBe(429);
});
