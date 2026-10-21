import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { startServer, type RunningServer } from '../src/server.ts';
import type { Mail } from '../src/util.ts';
import { testDb } from './db.ts';

let dir: string;
let server: RunningServer;
let mails: Mail[];
let tdb: Awaited<ReturnType<typeof testDb>>;
let base: string;

beforeEach(async () => {
  tdb = await testDb();
  dir = mkdtempSync(join(tmpdir(), 'mfp-branches-'));
  mails = [];
  server = await startServer({ port: 0, dir, pingMs: 60_000, db: tdb.db, mailer: { send: async (m) => void mails.push(m) } });
  base = `http://localhost:${server.port}`;
});

afterEach(async () => {
  await server.close();
  await tdb.dispose();
  rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>;

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: Json }> {
  const binary = body instanceof Uint8Array;
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : binary ? (body as BodyInit) : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text.startsWith('{') ? JSON.parse(text) : {} };
}

async function login(email: string): Promise<string> {
  await api('POST', '/api/auth/code', { email });
  const code = /(\d{6})/.exec(mails.filter((m) => m.to === email).at(-1)!.subject)![1]!;
  return (await api('POST', '/api/auth/verify', { email, code })).data.token;
}

const docOf = async (id: string, token: string, path = 'doc') => {
  const d = new LoroDoc();
  d.import(new Uint8Array(await (await fetch(`${base}/api/files/${id}/${path}`, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer()));
  return d;
};

describe('branches', () => {
  it('create, edit both sides, merge; permissions and deletion', async () => {
    const anna = await login('anna@example.com');
    const boris = await login('boris@example.com');
    const viktor = await login('viktor@example.com');
    // Main file with a document: m = {a: 1}.
    const src = new LoroDoc();
    src.getMap('m').set('a', 1);
    src.commit();
    const main = (await api('POST', '/api/files?name=Main', src.export({ mode: 'snapshot' }), anna)).data;
    await api('POST', `/api/files/${main.id}/access`, { email: 'boris@example.com', role: 'comment' }, anna);
    await api('POST', `/api/files/${main.id}/access`, { email: 'viktor@example.com', role: 'edit' }, anna);

    // A commenter cannot create a branch; an editor creates and edits it.
    expect((await api('POST', `/api/files/${main.id}/branches`, { name: 'Кнопки' }, boris)).status).toBe(403);
    const branch = (await api('POST', `/api/files/${main.id}/branches`, { name: 'Кнопки' }, viktor)).data;
    expect(branch).toMatchObject({ name: 'Кнопки', parentId: main.id, role: 'edit', mainName: 'Main' });
    // The branch is not in file lists; permissions are the same as the main file's (a commenter sees it).
    expect(((await api('GET', '/api/files', undefined, anna)).data.files as Json[]).map((f) => f.id)).toEqual([main.id]);
    expect((await api('GET', `/api/files/${branch.id}`, undefined, boris)).data.role).toBe('comment');
    expect((await api('GET', `/api/files/${main.id}/branches`, undefined, boris)).data.branches).toMatchObject([{ id: branch.id, name: 'Кнопки', ownerName: 'viktor', merged: null }]);

    // Edits to the branch (b) and the main file (c) are separate.
    const work = await docOf(branch.id, viktor);
    let v = work.oplogVersion();
    work.getMap('m').set('b', 2);
    work.commit();
    await api('POST', `/api/files/${branch.id}/doc`, work.export({ mode: 'update', from: v }), viktor);
    const mainNow = await docOf(main.id, anna);
    v = mainNow.oplogVersion();
    mainNow.getMap('m').set('c', 3);
    mainNow.commit();
    await api('POST', `/api/files/${main.id}/doc`, mainNow.export({ mode: 'update', from: v }), anna);

    // The base is the main file at branch creation.
    expect((await docOf(branch.id, viktor, 'base')).getMap('m').toJSON()).toEqual({ a: 1 });

    // Merge (as the client does it): main + branch → an update for main.
    const target = await docOf(main.id, viktor);
    const before = target.oplogVersion();
    target.import((await docOf(branch.id, viktor)).export({ mode: 'snapshot' }));
    const update = target.export({ mode: 'update', from: before });
    expect((await api('POST', `/api/files/${branch.id}/merge`, update, boris)).status).toBe(403);
    expect((await api('POST', `/api/files/${branch.id}/merge`, update, viktor)).status).toBe(200);
    expect((await docOf(main.id, anna)).getMap('m').toJSON()).toEqual({ a: 1, b: 2, c: 3 });
    expect((await api('GET', `/api/files/${main.id}/branches`, undefined, anna)).data.branches[0].merged).toBeGreaterThan(0);

    // Deleting a branch: neither the author nor the owner — not allowed; the author — allowed.
    expect((await api('DELETE', `/api/files/${branch.id}`, undefined, boris)).status).toBe(403);
    expect((await api('DELETE', `/api/files/${branch.id}`, undefined, viktor)).status).toBe(200);
    expect((await api('GET', `/api/files/${main.id}/branches`, undefined, anna)).data.branches).toEqual([]);
  });

  it('main file in the trash — branches are closed', async () => {
    const anna = await login('anna@example.com');
    const main = (await api('POST', '/api/files', { name: 'Main' }, anna)).data;
    const branch = (await api('POST', `/api/files/${main.id}/branches`, { name: 'B' }, anna)).data;
    await api('DELETE', `/api/files/${main.id}`, undefined, anna);
    expect((await api('GET', `/api/files/${branch.id}`, undefined, anna)).status).toBe(404);
    await api('POST', `/api/files/${main.id}/restore`, undefined, anna);
    expect((await api('GET', `/api/files/${branch.id}`, undefined, anna)).status).toBe(200);
  });
});
