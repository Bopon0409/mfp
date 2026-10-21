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
  dir = mkdtempSync(join(tmpdir(), 'mfp-libs-'));
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

async function api(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: Json; headers: Headers }> {
  const binary = body instanceof Uint8Array;
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : binary ? (body as BodyInit) : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text.startsWith('{') ? JSON.parse(text) : {}, headers: res.headers };
}

async function login(email: string): Promise<string> {
  await api('POST', '/api/auth/code', { email });
  const code = /(\d{6})/.exec(mails.filter((m) => m.to === email).at(-1)!.subject)![1]!;
  return (await api('POST', '/api/auth/verify', { email, code })).data.token;
}

const assets = [
  { key: 'btn', name: 'Кнопка', type: 'COMPONENT_SET' },
  { key: 'icon', name: 'Иконка', type: 'COMPONENT' },
  { key: 'brand', name: 'Бренд', type: 'STYLE' },
];

describe('team libraries', () => {
  it('publishing, versions, list, contents, usage, unpublishing', async () => {
    const anna = await login('anna@example.com');
    const boris = await login('boris@example.com');
    const viktor = await login('viktor@example.com');
    const team = (await api('POST', '/api/teams', { name: 'Студия' }, anna)).data;
    await api('POST', `/api/teams/${team.id}/members`, { email: 'boris@example.com', role: 'editor' }, anna);
    // Library file in a team project.
    const src = new LoroDoc();
    src.getMap('m').set('v', 1);
    src.commit();
    const lib = (await api('POST', `/api/files?name=${encodeURIComponent('UI Kit')}&projectId=${team.projectId}`, src.export({ mode: 'snapshot' }), anna)).data;
    expect((await api('POST', `/api/files/${lib.id}/publish`, { assets }, viktor)).status).toBe(404);
    expect((await api('POST', `/api/files/${lib.id}/publish`, { assets: [] }, anna)).status).toBe(400);
    const v1 = (await api('POST', `/api/files/${lib.id}/publish`, { name: 'UI Kit', description: 'Основа', assets }, anna)).data;
    expect(v1).toMatchObject({ id: lib.id, name: 'UI Kit', version: 1, teamName: 'Студия', publishedBy: 'anna', counts: { components: 2, styles: 1, variables: 0 } });

    // A new version is a new snapshot; the old one stays available.
    const v = src.oplogVersion();
    src.getMap('m').set('v', 2);
    src.commit();
    await api('POST', `/api/files/${lib.id}/doc`, src.export({ mode: 'update', from: v }), anna);
    expect((await api('POST', `/api/files/${lib.id}/publish`, { name: 'UI Kit', assets }, boris)).data.version).toBe(2);

    // Team members see it; an outsider does not.
    expect(((await api('GET', '/api/libraries', undefined, boris)).data.libraries as Json[]).map((l) => [l.name, l.version])).toEqual([['UI Kit', 2]]);
    expect((await api('GET', '/api/libraries', undefined, viktor)).data.libraries).toEqual([]);
    const content = async (q: string) => {
      const res = await fetch(`${base}/api/libraries/${lib.id}/content${q}`, { headers: { authorization: `Bearer ${boris}` } });
      const d = new LoroDoc();
      d.import(new Uint8Array(await res.arrayBuffer()));
      return [res.headers.get('x-library-version'), d.getMap('m').get('v')];
    };
    expect(await content('')).toEqual(['2', 2]);
    expect(await content('?version=1')).toEqual(['1', 1]);

    // Usage: Boris's file in the team and Viktor's draft (Anna cannot see it).
    const app = (await api('POST', '/api/files', { name: 'Приложение', projectId: team.projectId }, boris)).data;
    await api('POST', `/api/libraries/${lib.id}/usage`, { fileId: app.id, version: 2, counts: { btn: 12, icon: 3 } }, boris);
    await api('POST', `/api/teams/${team.id}/members`, { email: 'viktor@example.com', role: 'viewer' }, anna);
    const draft = (await api('POST', '/api/files', { name: 'Черновик' }, viktor)).data;
    await api('POST', `/api/libraries/${lib.id}/usage`, { fileId: draft.id, version: 1, counts: { btn: 1 } }, viktor);
    const usage = (await api('GET', `/api/libraries/${lib.id}/usage`, undefined, anna)).data;
    expect(usage.files.map((f: Json) => [f.name, f.version, f.instances])).toEqual([['Приложение', 2, 15]]);
    expect(usage.hiddenFiles).toBe(1);
    expect(usage.components).toEqual([
      { key: 'btn', name: 'Кнопка', instances: 13, files: 2 },
      { key: 'icon', name: 'Иконка', instances: 3, files: 1 },
    ]);
    // Disabled: drops out of the stats; only the owner can unpublish.
    await api('DELETE', `/api/libraries/${lib.id}/usage?fileId=${draft.id}`, undefined, viktor);
    expect((await api('GET', `/api/libraries/${lib.id}/usage`, undefined, anna)).data.hiddenFiles).toBe(0);
    expect((await api('DELETE', `/api/files/${lib.id}/publish`, undefined, boris)).status).toBe(403);
    await api('DELETE', `/api/files/${lib.id}/publish`, undefined, anna);
    expect((await api('GET', '/api/libraries', undefined, boris)).data.libraries).toEqual([]);
  });
});
