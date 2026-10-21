// Company server with password sign-in: first setup with the code from the log, and accounts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server.ts';
import { testDb } from './db.ts';

let server: RunningServer | undefined;
let dir: string;
let tdb: Awaited<ReturnType<typeof testDb>>;
afterEach(async () => {
  await server?.close();
  await tdb?.dispose();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Passwords use scrypt (intentionally slow): about a dozen hashes, up to a minute under the load of a full run.
it('initial setup, adding, disabling and password reset', { timeout: 60_000 }, async () => {
  dir = mkdtempSync(join(tmpdir(), 'mfp-users-'));
  tdb = await testDb();
  server = await startServer({ port: 0, dir, db: tdb.db, pingMs: 60_000, auth: 'password', mailer: { send: async () => {} } });
  const base = `http://localhost:${server.port}`;
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, data: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };

  // Closed server: without sign-in — no TURN, no images, no API (except sign-in and first setup).
  expect((await fetch(`${base}/ice`)).status).toBe(401);
  expect((await fetch(`${base}/image/${'0'.repeat(40)}`, { method: 'PUT', body: 'x' })).status).toBe(401);
  expect((await call('GET', '/api/me')).status).toBe(401);

  // A server without accounts waits for first setup.
  const code = server.setupCode!;
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect((await call('GET', '/api/auth/config')).data).toEqual({ mode: 'password', network: 'on', setup: true });
  expect((await call('POST', '/api/setup', { code: 'AAAA-AAAA', login: 'boss', name: 'Начальник', password: 'Admin-password-123' })).status).toBe(403);
  const setup = await call('POST', '/api/setup', { code: code.toLowerCase().replace('-', ' '), login: 'boss', name: 'Начальник', password: 'Admin-password-123' });
  expect(setup.status).toBe(200);
  expect(setup.data.user.admin).toBe(true);
  const admin = setup.data.token as string;
  expect((await call('GET', '/api/auth/config')).data).toEqual({ mode: 'password', network: 'on' });
  expect((await call('POST', '/api/setup', { code, login: 'evil', name: 'X', password: 'Admin-password-123' })).status).toBe(404);
  expect(server.setupCode).toBeNull();
  // The admin's own password works immediately.
  expect((await call('POST', '/api/auth/password', { login: 'boss', password: 'Admin-password-123' })).data.token).toBeTruthy();

  // New account: temporary password — change it on first sign-in.
  expect((await call('POST', '/api/admin/users', { login: 'anna', name: 'Анна', password: 'Temp-password-123' }, admin)).status).toBe(200);
  expect((await call('POST', '/api/admin/users', { login: 'anna', name: 'Анна', password: 'Temp-password-123' }, admin)).status).toBe(409);
  expect((await call('POST', '/api/auth/password', { login: 'anna', password: 'Temp-password-123' })).data).toEqual({ mustChangePassword: true });
  const anna = (await call('POST', '/api/auth/password', { login: 'anna', password: 'Temp-password-123', newPassword: 'Anna-own-password-1' })).data.token as string;
  expect(anna).toBeTruthy();
  const list = (await call('GET', '/api/admin/users', undefined, admin)).data;
  expect(list.passwords).toBe(true);
  expect(list.users.map((u: { login: string; admin: boolean }) => [u.login, u.admin])).toEqual([['boss', true], ['anna', false]]);
  const annaId = list.users[1].id as string;
  const bossId = list.users[0].id as string;

  // File access by login instead of email.
  const file = (await call('POST', '/api/files', { name: 'Макет' }, admin)).data.id as string;
  expect((await call('POST', `/api/files/${file}/access`, { email: 'anna', role: 'edit' }, admin)).data.invited).toBe(false);
  expect((await fetch(`${base}/api/files/${file}/doc`, { headers: { authorization: `Bearer ${anna}` } })).status).toBe(200);
  expect((await call('POST', `/api/files/${file}/access`, { email: 'nobody', role: 'edit' }, admin)).status).toBe(400);

  // Not an admin — no access; you cannot disable yourself.
  expect((await call('GET', '/api/admin/users', undefined, anna)).status).toBe(403);
  expect((await call('PATCH', `/api/admin/users/${bossId}`, { disabled: true }, admin)).status).toBe(400);

  // Password reset: sessions ended, temporary again.
  expect((await call('POST', `/api/admin/users/${annaId}/password`, { password: 'Second-temp-123' }, admin)).status).toBe(200);
  expect((await call('GET', '/api/me', undefined, anna)).status).toBe(401);
  expect((await call('POST', '/api/auth/password', { login: 'anna', password: 'Second-temp-123' })).data).toEqual({ mustChangePassword: true });

  // Disabling: sign-in is closed.
  expect((await call('PATCH', `/api/admin/users/${annaId}`, { disabled: true }, admin)).status).toBe(200);
  expect((await call('POST', '/api/auth/password', { login: 'anna', password: 'Second-temp-123', newPassword: 'Anna-new-password-2' })).status).toBe(401);
  expect((await call('PATCH', `/api/admin/users/${annaId}`, { disabled: false, admin: true }, admin)).status).toBe(200);
  expect((await call('GET', '/api/admin/users', undefined, admin)).data.users[1]).toMatchObject({ login: 'anna', admin: true, disabled: false });
});

it('email sign-in: no initial setup', async () => {
  dir = mkdtempSync(join(tmpdir(), 'mfp-users-'));
  tdb = await testDb();
  server = await startServer({ port: 0, dir, db: tdb.db, pingMs: 60_000, mailer: { send: async () => {} } });
  expect(server.setupCode).toBeNull();
  const r = await fetch(`http://localhost:${server.port}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(r.status).toBe(404);
});
