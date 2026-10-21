// Sign-in and accounts. Passwords aren't stored: sign-in is via a one-time code by email (6 digits, 10 minutes,
// 5 attempts, at most once per 30 s), and in a company — via SSO (ee/oidc.ts). Session and API token are
// a random secret; the database stores only its hash. On first sign-in, invitations for this email are applied
// (to teams and files).

import { randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import type { BetaOptions } from './beta.ts';
import { colorFor, fail, hashSecret, newId, newSecret, sameSecret, type Mailer } from './util.ts';

export interface User {
  id: string;
  email: string;
  name: string;
  color: string;
  created: number;
  disabled: number;
  admin: number;
  /** Link to the company directory (oidc:… or scim:…). */
  external_id?: string | null;
}

export interface Principal {
  user: User;
  /** session — sign-in in the editor, api — personal token (REST, MCP). */
  kind: 'session' | 'api';
  tokenId: string;
}

const CODE_TTL = 10 * 60_000;
const CODE_GAP = 30_000;
const SESSION_TTL = 30 * 24 * 3600_000;
const NEVER = 253402300799000; // 9999-12-31

export class Auth {
  private db: Db;
  private mailer: Mailer;
  private beta?: BetaOptions;
  /** Name in emails. */
  appName = 'MFP';
  /** Whether sign-in with a code is allowed for this email (ee/oidc.ts: company domains — SSO only). */
  codePolicy: ((email: string) => string | null) | null = null;

  /** Sign-in with login and password (MFP_AUTH=password): a company server without email and SSO. */
  private password: boolean;

  constructor(db: Db, mailer: Mailer, beta?: BetaOptions, opts: { password?: boolean } = {}) {
    this.db = db;
    this.mailer = mailer;
    this.beta = beta;
    this.password = !!opts.password;
  }

  private checkBeta(email: string) {
    if (this.beta && !this.passwordMode && !this.beta.emails.includes(email)) fail(403, 'Закрытая бета: эта почта не приглашена');
  }

  get passwordMode() { return this.beta?.auth === 'password' || this.password; }

  /** Service email for login-based accounts (for the beta — the previous one). */
  get loginDomain() { return this.beta ? 'beta.invalid' : 'users.invalid'; }

  /** Sign-in code by email. */
  async requestCode(email: string) {
    if (this.passwordMode) fail(403, 'Вход только по логину и паролю');
    this.checkBeta(email);
    const denied = this.codePolicy?.(email);
    if (denied) fail(403, denied);
    const now = Date.now();
    const prev = await this.db.get<{ sent: number }>(`SELECT sent FROM login_codes WHERE email = ?`, [email]);
    if (prev && now - prev.sent < CODE_GAP) fail(429, 'Код уже отправлен — подождите полминуты');
    const user = await this.byEmail(email);
    if (user?.disabled) fail(403, 'Учётная запись отключена');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.run(
      `INSERT INTO login_codes (email, code, expires, attempts, sent) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT (email) DO UPDATE SET code = excluded.code, expires = excluded.expires, attempts = 0, sent = excluded.sent`,
      [email, hashSecret(`${email}:${code}`), now + CODE_TTL, now],
    );
    await this.mailer.send({ to: email, subject: `${this.appName}: код для входа ${code}`, text: `Код для входа в ${this.appName}: ${code}\nДействует 10 минут. Если вы не входили — просто удалите письмо.` });
  }

  /** Verify the code: return a session (a new user is created). */
  async verifyCode(email: string, code: string): Promise<{ token: string; user: User }> {
    if (this.passwordMode) fail(403, 'Вход только по логину и паролю');
    this.checkBeta(email);
    const denied = this.codePolicy?.(email);
    if (denied) fail(403, denied);
    const row = await this.db.get<{ code: string; expires: number; attempts: number }>(`SELECT code, expires, attempts FROM login_codes WHERE email = ?`, [email]);
    if (!row || row.expires < Date.now()) fail(400, 'Код устарел — запросите новый');
    if (row!.attempts >= 5) fail(429, 'Слишком много попыток — запросите новый код');
    if (!sameSecret(row!.code, hashSecret(`${email}:${code.trim()}`))) {
      await this.db.run(`UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?`, [email]);
      fail(400, 'Неверный код');
    }
    await this.db.run(`DELETE FROM login_codes WHERE email = ?`, [email]);
    const user = await this.ensureUser(email);
    if (user.disabled) fail(403, 'Учётная запись отключена');
    return { token: await this.newSession(user.id), user };
  }

  async byEmail(email: string): Promise<User | undefined> {
    return this.db.get<User>(`SELECT * FROM users WHERE email = ?`, [email]);
  }

  async byId(id: string): Promise<User | undefined> {
    return this.db.get<User>(`SELECT * FROM users WHERE id = ?`, [id]);
  }

  /** The user with this email (none — create; the first one on the server — administrator). */
  async ensureUser(email: string, name?: string): Promise<User> {
    this.checkBeta(email);
    const found = await this.byEmail(email);
    if (found) return found;
    const count = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`);
    const user: User = { id: newId(), email, name: name?.trim() || email.split('@')[0]!, color: colorFor(email), created: Date.now(), disabled: 0, admin: this.beta ? Number(email === this.beta.owner) : count?.n ? 0 : 1 };
    await this.db.tx(async () => {
      await this.db.run(`INSERT INTO users (id, email, name, color, created, disabled, admin) VALUES (?, ?, ?, ?, ?, 0, ?)`, [user.id, user.email, user.name, user.color, user.created, user.admin]);
      await this.acceptInvites(user);
    });
    return user;
  }

  /** Invitations for the user's email — into team membership and file access. */
  private async acceptInvites(user: User) {
    const invites = await this.db.all<{ id: string; team_id: string | null; file_id: string | null; role: string }>(`SELECT id, team_id, file_id, role FROM invites WHERE email = ?`, [user.email]);
    for (const inv of invites) {
      if (inv.team_id) await this.db.run(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (team_id, user_id) DO NOTHING`, [inv.team_id, user.id, inv.role]);
      if (inv.file_id) await this.db.run(`INSERT INTO file_access (file_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (file_id, user_id) DO NOTHING`, [inv.file_id, user.id, inv.role]);
    }
    await this.db.run(`DELETE FROM invites WHERE email = ?`, [user.email]);
  }

  async newSession(userId: string, kind: 'session' | 'api' = 'session', name?: string): Promise<string> {
    const token = newSecret();
    const now = Date.now();
    await this.db.run(`INSERT INTO sessions (token, id, user_id, kind, name, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)`, [hashSecret(token), newId(), userId, kind, name ?? null, now, kind === 'api' ? NEVER : now + SESSION_TTL]);
    return kind === 'api' ? `mfp_${token}` : token;
  }

  /** Who presented the token (null — nobody, or expired). */
  async principal(token: string | null | undefined): Promise<Principal | null> {
    if (!token) return null;
    const raw = token.startsWith('mfp_') ? token.slice(4) : token;
    const row = await this.db.get<{ id: string; user_id: string; kind: 'session' | 'api'; expires: number }>(`SELECT id, user_id, kind, expires FROM sessions WHERE token = ?`, [hashSecret(raw)]);
    if (!row || row.expires < Date.now()) return null;
    const user = await this.byId(row.user_id);
    if (!user || user.disabled) return null;
    if (this.beta && !this.passwordMode && !this.beta.emails.includes(user.email)) return null;
    if (this.passwordMode && !await this.db.get('SELECT user_id FROM password_credentials WHERE user_id = ? AND must_change = 0', [user.id])) return null;
    await this.db.run(`UPDATE sessions SET last_used = ? WHERE id = ?`, [Date.now(), row.id]);
    return { user, kind: row.kind, tokenId: row.id };
  }

  async logout(p: Principal) {
    await this.db.run(`DELETE FROM sessions WHERE id = ?`, [p.tokenId]);
  }

  async tokens(userId: string) {
    return this.db.all<{ id: string; name: string; created: number; last_used: number | null }>(`SELECT id, name, created, last_used FROM sessions WHERE user_id = ? AND kind = 'api' ORDER BY created DESC`, [userId]);
  }

  async deleteToken(userId: string, id: string) {
    const n = await this.db.run(`DELETE FROM sessions WHERE id = ? AND user_id = ? AND kind = 'api'`, [id, userId]);
    if (!n) fail(404, 'Нет такого токена');
  }
}
