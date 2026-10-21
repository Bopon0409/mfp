import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';
import { Passwords } from '../src/passwords.ts';
import { testDb } from './db.ts';
let server: RunningServer | undefined;
let dir: string;
let tdb: Awaited<ReturnType<typeof testDb>>;
afterEach(async () => { await server?.close(); await tdb?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true }); });

// scrypt (intentionally slow) needs more time under the load of a full run.
it('password beta requires first-login rotation, never issues a temporary session, rejects email bypass and old passwords', async () => {
  dir = mkdtempSync(join(tmpdir(), 'mfp-password-')); tdb = await testDb();
  server = await startServer({ port: 0, dir, db: tdb.db, beta: { auth: 'password', owner: 'admin@beta.invalid', emails: [] } });
  const passwords = new Passwords(server.db, server.auth);
  const friend = await passwords.provision('friend01', 'Initial-password-123', 'Друг');
  expect(friend.admin).toBe(0);
  expect((await passwords.provision('admin', 'Initial-admin-123', 'Администратор')).admin).toBe(1);
  const base = `http://localhost:${server.port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() as Record<string, unknown> };
  };
  expect(await (await fetch(base + '/api/auth/config')).json()).toEqual({ mode: 'password', network: 'on' });
  expect((await post('/api/auth/code', { email: friend.email })).status).toBe(403);
  expect((await post('/api/auth/verify', { email: friend.email, code: '123456' })).status).toBe(403);
  expect((await post('/api/auth/password', { login: 'unknown', password: 'Initial-password-123' })).status).toBe(401);
  expect((await post('/api/auth/password', { login: 'friend01', password: 'bad' })).status).toBe(401);
  const initial = await post('/api/auth/password', { login: 'friend01', password: 'Initial-password-123' });
  expect(initial.data).toEqual({ mustChangePassword: true });
  expect(await server.db.all('SELECT * FROM sessions')).toHaveLength(0);
  expect((await post('/api/auth/password', { login: 'friend01', password: 'Initial-password-123', newPassword: 'short' })).status).toBe(400);
  const good = await post('/api/auth/password', { login: 'Friend01', password: 'Initial-password-123', newPassword: 'Changed-password-321' });
  expect(good.status).toBe(200);
  expect(good.data.token).toBeTypeOf('string');
  expect(await server.auth.principal(good.data.token as string)).not.toBeNull();
  expect((await post('/api/auth/password', { login: 'friend01', password: 'Initial-password-123' })).status).toBe(401);
  const changed = await post('/api/auth/password', { login: 'friend01', password: 'Changed-password-321', newPassword: 'Second-password-987' });
  expect(changed.status).toBe(200);
  expect(await server.auth.principal(good.data.token as string)).toBeNull();
  const row = await server.db.get<{ hash: string }>('SELECT hash FROM password_credentials WHERE login = ?', ['friend01']);
  expect(row?.hash).not.toContain('Second-password');
  await server.db.run('UPDATE users SET disabled = 1 WHERE id = ?', [friend.id]);
  expect(await server.auth.principal(changed.data.token as string)).toBeNull();
  expect((await post('/api/auth/password', { login: 'friend01', password: 'Second-password-987' })).status).toBe(401);
}, 60_000);

it('locks an account after ten password attempts, including parallel attempts', async () => {
  dir = mkdtempSync(join(tmpdir(), 'mfp-password-')); tdb = await testDb();
  server = await startServer({ port: 0, dir, db: tdb.db, beta: { auth: 'password', owner: 'admin@beta.invalid', emails: [] } });
  const passwords = new Passwords(server.db, server.auth);
  await passwords.provision('friend01', 'Initial-password-123', 'Друг');
  for (let batch = 0; batch < 5; batch++) await Promise.allSettled([passwords.login('friend01', 'bad'), passwords.login('friend01', 'bad')]);
  await expect(passwords.login('friend01', 'Initial-password-123')).rejects.toThrow('Слишком много попыток');
}, 60_000);
