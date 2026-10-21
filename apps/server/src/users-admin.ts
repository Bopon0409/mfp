// Company server with password sign-in (MFP_AUTH=password): first setup and accounts.
//
// First setup: while the server has no accounts at all, it prints a single-use code to the log
// (RunningServer.setupCode). Whoever opens the editor and enters the code creates the first admin
// with their own password — an outsider on the same network without access to the log cannot do this.
// Accounts: the server admin sees everyone, adds accounts (login and a temporary password to change
// on first sign-in), disables them, makes them admins and resets passwords.

import { randomInt, timingSafeEqual } from 'node:crypto';
import type { ApiDeps } from './api.ts';
import { Passwords } from './passwords.ts';
import type { Ctx, Router } from './router.ts';
import { fail, readJson, str } from './util.ts';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** First-setup code: 8 characters without look-alikes (0/O, 1/I), like ABCD-EF23. */
export function setupCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const y = Buffer.from(b.replace(/-/g, ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

interface UserRow {
  id: string;
  email: string;
  name: string;
  admin: number;
  disabled: number;
  created: number;
  login: string | null;
}

/** setup.code — first-setup code (null — already set up or sign-in is not by password). */
export function registerUsersAdmin(r: Router, d: ApiDeps) {
  const { db, auth } = d;
  const setup = d.setup ?? { code: null };
  const passwords = new Passwords(db, auth);
  let tries = 0;
  let window = 0;

  /** No accounts at all — the server is waiting for first setup. */
  const empty = async () => !(await db.get('SELECT id FROM users LIMIT 1'));

  r.add('POST', '/api/setup', async (c) => {
    if (!setup.code || !auth.passwordMode || !(await empty())) fail(404, 'Сервер уже настроен');
    const now = Date.now();
    if (now - window > 15 * 60_000) (tries = 0), (window = now);
    if (++tries > 10) fail(429, 'Слишком много попыток. Повторите через 15 минут');
    const b = await readJson(c.req);
    const code = setup.code!;
    if (typeof b.code !== 'string' || !same(b.code, code)) fail(403, 'Неверный код. Код первой настройки — в журнале сервера (docker compose logs mfp)');
    if (typeof b.password !== 'string') fail(400, 'Нужен пароль');
    // The code is single-use: claim it immediately, before the first await, so that two concurrent requests
    // do not create two admins; if it fails (wrong password, etc.) — release it.
    setup.code = null;
    let user;
    try {
      user = await passwords.provision(str(b.login, 'login', 32), b.password as string, str(b.name, 'name', 80), false);
      if (!user.admin) await db.run('UPDATE users SET admin = 1 WHERE id = ?', [user.id]);
    } catch (e) {
      if (await empty()) setup.code = code;
      throw e;
    }
    const token = await auth.newSession(user.id);
    return { token, user: { id: user.id, email: user.email, name: user.name, color: user.color, admin: true } };
  });

  const admin = (c: Ctx) => {
    const p = c.need();
    if (!p.user.admin) fail(403, 'Только для администраторов сервера');
    if (p.kind !== 'session') fail(403, 'Учётными записями управляют из редактора');
    return p;
  };

  r.add('GET', '/api/admin/users', async (c) => {
    admin(c);
    const users = await db.all<UserRow>(
      `SELECT u.id, u.email, u.name, u.admin, u.disabled, u.created, pc.login FROM users u LEFT JOIN password_credentials pc ON pc.user_id = u.id ORDER BY u.created`,
    );
    return { passwords: auth.passwordMode, users: users.map((u) => ({ id: u.id, email: u.email, name: u.name, login: u.login, admin: !!u.admin, disabled: !!u.disabled, created: Number(u.created) })) };
  });

  r.add('POST', '/api/admin/users', async (c) => {
    admin(c);
    if (!auth.passwordMode) fail(404, 'Учётные записи по логину — только при входе по паролю (MFP_AUTH=password)');
    const b = await readJson(c.req);
    if (typeof b.password !== 'string') fail(400, 'Нужен временный пароль');
    const user = await passwords.provision(str(b.login, 'login', 32), b.password as string, str(b.name, 'name', 80));
    return { id: user.id };
  });

  r.add('PATCH', '/api/admin/users/:id', async (c) => {
    const p = admin(c);
    const id = c.params.id!;
    const b = await readJson(c.req);
    if (!(await auth.byId(id))) fail(404, 'Нет такой учётной записи');
    if (id === p.user.id && (b.disabled === true || b.admin === false)) fail(400, 'Себя отключить или лишить прав нельзя');
    if (typeof b.disabled === 'boolean') {
      await db.run('UPDATE users SET disabled = ? WHERE id = ?', [b.disabled ? 1 : 0, id]);
      if (b.disabled) await db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    }
    if (typeof b.admin === 'boolean') await db.run('UPDATE users SET admin = ? WHERE id = ?', [b.admin ? 1 : 0, id]);
  });

  r.add('POST', '/api/admin/users/:id/password', async (c) => {
    admin(c);
    if (!auth.passwordMode) fail(404, 'Вход по паролю не включён');
    const b = await readJson(c.req);
    if (typeof b.password !== 'string') fail(400, 'Нужен временный пароль');
    await passwords.reset(c.params.id!, b.password as string);
  });
}
