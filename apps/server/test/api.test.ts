import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LoroDoc } from 'loro-crdt';
import { startServer, type RunningServer } from '../src/server.ts';
import type { Mail } from '../src/util.ts';
import { testDb } from './db.ts';

let dir: string;
let server: RunningServer;
let mails: Mail[];
let tdb: Awaited<ReturnType<typeof testDb>>;

const boot = async () => {
  server = await startServer({ port: 0, dir, pingMs: 60_000, db: tdb.db, mailer: { send: async (m) => void mails.push(m) } });
};

beforeEach(async () => {
  tdb = await testDb();
  dir = mkdtempSync(join(tmpdir(), 'mfp-api-'));
  mails = [];
  await boot();
});

afterEach(async () => {
  await server.close();
  await tdb.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown> & { error?: string } }> {
  const res = await fetch(`http://localhost:${server.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

/** Sign in with the code from the email. */
async function login(email: string): Promise<string> {
  expect((await api('POST', '/api/auth/code', { email })).status).toBe(200);
  const code = /код для входа (\d{6})/.exec(mails.filter((m) => m.to === email).at(-1)!.subject)![1]!;
  const r = await api('POST', '/api/auth/verify', { email, code });
  expect(r.status).toBe(200);
  return r.data.token as string;
}

describe('accounts and teams', () => {
  it('sign-in by code: wrong code, rate limit, profile, sign-out', async () => {
    expect((await api('POST', '/api/auth/code', { email: 'не почта' })).status).toBe(400);
    await api('POST', '/api/auth/code', { email: 'anna@example.com' });
    expect((await api('POST', '/api/auth/code', { email: 'anna@example.com' })).status).toBe(429);
    expect((await api('POST', '/api/auth/verify', { email: 'anna@example.com', code: '000000x' })).status).toBe(400);
    const code = /(\d{6})/.exec(mails[0]!.subject)![1]!;
    const ok = await api('POST', '/api/auth/verify', { email: 'Anna@Example.com', code });
    expect(ok.status).toBe(200);
    const token = ok.data.token as string;
    const me = await api('GET', '/api/me', undefined, token);
    expect(me.data.user).toMatchObject({ email: 'anna@example.com', name: 'anna', admin: true });
    expect((await api('PATCH', '/api/me', { name: 'Анна' }, token)).data.user).toMatchObject({ name: 'Анна' });
    // The code is single-use.
    expect((await api('POST', '/api/auth/verify', { email: 'anna@example.com', code })).status).toBe(400);
    // A personal API token keeps working after signing out of the session.
    const pat = (await api('POST', '/api/tokens', { name: 'CI' }, token)).data.token as string;
    expect(pat.startsWith('mfp_')).toBe(true);
    await api('POST', '/api/auth/logout', undefined, token);
    expect((await api('GET', '/api/me', undefined, token)).status).toBe(401);
    expect((await api('GET', '/api/me', undefined, pat)).status).toBe(200);
  });

  it('team: email invitation before registration, roles, the owner stays', async () => {
    const anna = await login('anna@example.com');
    const team = await api('POST', '/api/teams', { name: 'Студия' }, anna);
    const teamId = team.data.id as string;
    expect((await api('POST', `/api/teams/${teamId}/members`, { email: 'boris@example.com', role: 'editor' }, anna)).data).toMatchObject({ invited: true });
    expect(mails.some((m) => m.to === 'boris@example.com' && m.subject.includes('Студия'))).toBe(true);
    const boris = await login('boris@example.com');
    const info = await api('GET', `/api/teams/${teamId}`, undefined, boris);
    expect(info.data.role).toBe('editor');
    expect((info.data.members as { email: string }[]).map((m) => m.email).sort()).toEqual(['anna@example.com', 'boris@example.com']);
    // An editor does not manage members; the owner cannot leave as the last one.
    expect((await api('POST', `/api/teams/${teamId}/members`, { email: 'c@example.com' }, boris)).status).toBe(403);
    const annaId = ((await api('GET', '/api/me', undefined, anna)).data.user as { id: string }).id;
    expect((await api('DELETE', `/api/teams/${teamId}/members/${annaId}`, undefined, anna)).status).toBe(400);
    // Someone else's team — as if it does not exist.
    const viktor = await login('viktor@example.com');
    expect((await api('GET', `/api/teams/${teamId}`, undefined, viktor)).status).toBe(404);
  });
});

describe('files and access', () => {
  it('file in a team project: roles, personal access, link', async () => {
    const anna = await login('anna@example.com');
    const team = (await api('POST', '/api/teams', { name: 'Студия' }, anna)).data;
    await api('POST', `/api/teams/${team.id}/members`, { email: 'boris@example.com', role: 'viewer' }, anna);
    const boris = await login('boris@example.com');
    const viktor = await login('viktor@example.com');
    const file = (await api('POST', '/api/files', { name: 'Макет', projectId: team.projectId }, anna)).data;
    expect(file.role).toBe('owner');
    // A team viewer views and comments.
    expect((await api('GET', `/api/files/${file.id}`, undefined, boris)).data.role).toBe('comment');
    expect(((await api('GET', '/api/files', undefined, boris)).data.files as { id: string }[]).map((f) => f.id)).toEqual([file.id]);
    // An outsider does not see it; personal access opens it.
    expect((await api('GET', `/api/files/${file.id}`, undefined, viktor)).status).toBe(404);
    await api('POST', `/api/files/${file.id}/access`, { email: 'viktor@example.com', role: 'edit' }, anna);
    expect((await api('GET', `/api/files/${file.id}`, undefined, viktor)).data.role).toBe('edit');
    expect((await api('PUT', `/api/files/${file.id}/link`, { role: 'comment' }, viktor)).status).toBe(403);
    // Link: without sign-in — view only, with sign-in — the link's role.
    const link = (await api('PUT', `/api/files/${file.id}/link`, { role: 'comment' }, anna)).data.token as string;
    expect((await api('GET', `/api/files/${file.id}?link=${link}`)).data.role).toBe('view');
    const galina = await login('galina@example.com');
    expect((await api('GET', `/api/files/${file.id}?link=${link}`, undefined, galina)).data.role).toBe('comment');
    expect((await api('GET', `/api/files/${file.id}?link=неверная`, undefined, galina)).status).toBe(404);
    // Trash: the file is unavailable via link and in lists.
    await api('DELETE', `/api/files/${file.id}`, undefined, anna);
    expect(((await api('GET', '/api/files', undefined, boris)).data.files as unknown[]).length).toBe(0);
  });

  it('file with a document snapshot, edit via REST, garbage — 400', async () => {
    const anna = await login('anna@example.com');
    const base = `http://localhost:${server.port}`;
    const bin = { authorization: `Bearer ${anna}`, 'content-type': 'application/octet-stream' };
    const src = new LoroDoc();
    src.getMap('m').set('a', 1);
    src.commit();
    const file = (await (await fetch(`${base}/api/files?name=${encodeURIComponent('Загрузка')}`, { method: 'POST', headers: bin, body: src.export({ mode: 'snapshot' }) as BodyInit })).json()) as { id: string };
    expect(file).toMatchObject({ name: 'Загрузка', role: 'owner', projectId: null });
    const before = src.oplogVersion();
    src.getMap('m').set('b', 2);
    src.commit();
    expect((await fetch(`${base}/api/files/${file.id}/doc`, { method: 'POST', headers: bin, body: src.export({ mode: 'update', from: before }) as BodyInit })).status).toBe(200);
    const snap = new LoroDoc();
    snap.import(new Uint8Array(await (await fetch(`${base}/api/files/${file.id}/doc`, { headers: { authorization: `Bearer ${anna}` } })).arrayBuffer()));
    expect(snap.getMap('m').toJSON()).toEqual({ a: 1, b: 2 });
    expect((await fetch(`${base}/api/files?name=x`, { method: 'POST', headers: bin, body: new Uint8Array([1, 2, 3]) as BodyInit })).status).toBe(400);
    expect(((await api('GET', '/api/files?scope=drafts', undefined, anna)).data.files as unknown[]).length).toBe(1);
  });

  it('live: edits only with edit permission, the document is saved, revoking access disconnects', async () => {
    const anna = await login('anna@example.com');
    const file = (await api('POST', '/api/files', { name: 'Макет' }, anna)).data;
    await api('POST', `/api/files/${file.id}/access`, { email: 'boris@example.com', role: 'view' }, anna);
    const boris = await login('boris@example.com');
    const connect = (token: string) =>
      new Promise<{ ws: WebSocket; role: string; doc: LoroDoc; closed: Promise<number> }>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${server.port}/file/${file.id}?token=${token}`);
        const doc = new LoroDoc();
        let role = '';
        const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
        ws.on('message', (data: Buffer) => {
          const b = new Uint8Array(data);
          if (b[0] === 5) {
            const m = JSON.parse(new TextDecoder().decode(b.subarray(1)));
            if (m.role) role = m.role;
            if (m.error && !role) reject(new Error(m.error));
          } else if (b[0] === 1) {
            doc.import(b.subarray(1));
            resolve({ ws, role, doc, closed });
          } else if (b[0] === 2) doc.import(b.subarray(1));
        });
      });
    const a = await connect(anna);
    const b = await connect(boris);
    expect([a.role, b.role]).toEqual(['owner', 'view']);
    const send = (p: { ws: WebSocket; doc: LoroDoc }, key: string) => {
      const before = p.doc.oplogVersion();
      p.doc.getMap('m').set(key, 1);
      p.doc.commit();
      const u = p.doc.export({ mode: 'update', from: before });
      const out = new Uint8Array(u.length + 1);
      out[0] = 2;
      out.set(u, 1);
      p.ws.send(out);
    };
    send(b, 'от зрителя');
    send(a, 'от владельца');
    await new Promise((r) => setTimeout(r, 200));
    const snap = new LoroDoc();
    snap.import(new Uint8Array(await (await fetch(`http://localhost:${server.port}/api/files/${file.id}/doc`, { headers: { authorization: `Bearer ${anna}` } })).arrayBuffer()));
    expect(snap.getMap('m').toJSON()).toEqual({ 'от владельца': 1 });
    // Revoking access disconnects the viewer.
    const borisId = ((await api('GET', '/api/me', undefined, boris)).data.user as { id: string }).id;
    await api('DELETE', `/api/files/${file.id}/access/${borisId}`, undefined, anna);
    expect(await b.closed).toBe(4403);
    a.ws.close();
    await a.closed;
    // Server restart: the document is intact.
    await server.close();
    await boot();
    const again = new LoroDoc();
    again.import(new Uint8Array(await (await fetch(`http://localhost:${server.port}/api/files/${file.id}/doc`, { headers: { authorization: `Bearer ${anna}` } })).arrayBuffer()));
    expect(again.getMap('m').toJSON()).toEqual({ 'от владельца': 1 });
  });
});
