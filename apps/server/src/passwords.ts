import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Auth } from './auth.ts';
import type { Db } from './db.ts';
import { fail } from './util.ts';

const params = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 32, params, (error, key) => error ? reject(error) : resolve(key));
});
export async function passwordHash(password: string) {
  if (password.length < 12 || password.length > 128) fail(400, 'Пароль должен содержать от 12 до 128 символов');
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1:${salt}:${(await derive(password, salt)).toString('hex')}`;
}
async function matches(password: string, hash: string) {
  const [version, salt, key] = hash.split(':');
  if (version !== 'scrypt-v1' || !salt || !key) return false;
  const actual = await derive(password, salt);
  const expected = Buffer.from(key, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
interface Credential { user_id: string; hash: string; must_change: number; attempts: number; attempt_window: number }
export class Passwords {
  private db: Db;
  private auth: Auth;
  private active = 0;
  constructor(db: Db, auth: Auth) { this.db = db; this.auth = auth; }

  /** Account by login; mustChange — change the password on first sign-in (temporary one from the admin). */
  async provision(login: string, password: string, name: string, mustChange = true) {
    login = login.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(login)) fail(400, 'Логин: 3–32 латинские буквы, цифры, дефис или подчёркивание');
    const hash = await passwordHash(password);
    return this.db.tx(async () => {
      if (await this.db.get('SELECT user_id FROM password_credentials WHERE login = ?', [login])) fail(409, 'Логин уже существует');
      const user = await this.auth.ensureUser(`${login}@${this.auth.loginDomain}`, name);
      await this.db.run('INSERT INTO password_credentials (login, user_id, hash, must_change, attempts, attempt_window) VALUES (?, ?, ?, ?, 0, 0)', [login, user.id, hash, mustChange ? 1 : 0]);
      return user;
    });
  }

  /** New temporary password (admin): change on sign-in, end all sessions. */
  async reset(userId: string, password: string) {
    const hash = await passwordHash(password);
    await this.db.tx(async () => {
      if (!(await this.db.get('SELECT login FROM password_credentials WHERE user_id = ?', [userId]))) fail(404, 'У учётной записи нет входа по паролю');
      await this.db.run('UPDATE password_credentials SET hash = ?, must_change = 1, attempts = 0, attempt_window = 0 WHERE user_id = ?', [hash, userId]);
      await this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    });
  }

  async login(login: string, password: string, newPassword?: string) {
    if (this.active >= 4) fail(429, 'Подождите несколько секунд и повторите вход');
    this.active++;
    try {
      login = login.trim().toLowerCase();
      if (password.length > 128) fail(400, 'Слишком длинный пароль');
      const now = Date.now();
      const row = await this.db.tx(async () => {
        const row = await this.db.get<Credential>('SELECT * FROM password_credentials WHERE login = ?' + (this.db.dialect === 'postgres' ? ' FOR UPDATE' : ''), [login]);
        if (row) {
          const attempts = now - row.attempt_window < 15 * 60_000 ? row.attempts : 0;
          if (attempts >= 10) fail(429, 'Слишком много попыток. Повторите через 15 минут');
          await this.db.run('UPDATE password_credentials SET attempts = ?, attempt_window = ? WHERE login = ?', [attempts + 1, attempts ? row.attempt_window : now, login]);
        }
        return row;
      });
      const valid = await matches(password, row?.hash ?? `scrypt-v1:${'0'.repeat(32)}:${'0'.repeat(64)}`);
      const user = row ? await this.auth.byId(row.user_id) : null;
      if (!valid || !user || user.disabled) fail(401, 'Неверный логин или пароль');
      if (row!.must_change && !newPassword) return { mustChangePassword: true as const };
      if (newPassword === password) fail(400, 'Новый пароль должен отличаться от временного');
      const hash = newPassword ? await passwordHash(newPassword) : null;
      return await this.db.tx(async () => {
        const current = await this.db.get<Credential>('SELECT * FROM password_credentials WHERE login = ?' + (this.db.dialect === 'postgres' ? ' FOR UPDATE' : ''), [login]);
        if (current?.hash !== row!.hash) fail(401, 'Пароль уже изменён. Войдите заново');
        if (hash) {
          await this.db.run('UPDATE password_credentials SET hash = ?, must_change = 0 WHERE login = ?', [hash, login]);
          await this.db.run('DELETE FROM sessions WHERE user_id = ?', [user!.id]);
        }
        await this.db.run('UPDATE password_credentials SET attempts = 0 WHERE login = ?', [login]);
        return { token: await this.auth.newSession(user!.id), user: user! };
      });
    } finally { this.active--; }
  }
}
