// App updates: latest.json with this server's addresses, installer files, no sign-in.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';
import { rewriteLatest } from '../src/updates.ts';
import { testDb } from './db.ts';

let server: RunningServer | undefined;
let dir: string;
let tdb: Awaited<ReturnType<typeof testDb>>;
afterEach(async () => {
  await server?.close();
  await tdb?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const latest = {
  version: '0.2.0',
  notes: 'Новая версия',
  pub_date: '2026-10-20T12:00:00Z',
  platforms: { 'windows-x86_64': { url: 'https://github.com/Bopon0409/mfp/releases/download/v0.2.0/MFP_0.2.0_x64-setup.exe', signature: 'c2ln' } },
};

it('file URLs point to this server', () => {
  const out = JSON.parse(rewriteLatest(JSON.stringify(latest), 'http://corp.local:8080'));
  expect(out.platforms['windows-x86_64']).toEqual({ url: 'http://corp.local:8080/updates/MFP_0.2.0_x64-setup.exe', signature: 'c2ln' });
  expect(out.version).toBe('0.2.0');
});

it('serves latest.json and the installer without sign-in (also in the closed beta)', async () => {
  dir = mkdtempSync(join(tmpdir(), 'mfp-updates-'));
  tdb = await testDb();
  server = await startServer({ port: 0, dir, db: tdb.db, pingMs: 60_000, mailer: { send: async () => {} }, beta: { auth: 'password', owner: 'admin@beta.invalid', emails: [] } });
  const base = `http://localhost:${server.port}`;
  expect((await fetch(`${base}/updates/latest.json`)).status).toBe(404);
  mkdirSync(join(dir, 'updates'), { recursive: true });
  writeFileSync(join(dir, 'updates', 'latest.json'), JSON.stringify(latest));
  writeFileSync(join(dir, 'updates', 'MFP_0.2.0_x64-setup.exe'), Buffer.from('installer'));
  const r = await fetch(`${base}/updates/latest.json`);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('no-cache');
  const json = (await r.json()) as typeof latest;
  expect(json.platforms['windows-x86_64'].url).toBe(`${base}/updates/MFP_0.2.0_x64-setup.exe`);
  const file = await fetch(json.platforms['windows-x86_64'].url);
  expect(file.status).toBe(200);
  expect(await file.text()).toBe('installer');
  // Only file names from the updates folder.
  expect((await fetch(`${base}/updates/..%2Fmfp.db`)).status).not.toBe(200);
  expect((await fetch(`${base}/updates/nothing.exe`)).status).toBe(404);
  // Invalid %-encoding in the address — a response, not a server crash.
  expect((await fetch(`${base}/updates/%E0%A4`)).status).toBe(404);
  expect((await fetch(`${base}/api/files/%E0%A4`)).status).not.toBe(200);
  expect((await fetch(`${base}/health`)).status).toBe(200);
});
