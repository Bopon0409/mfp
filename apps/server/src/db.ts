// Server database: users, teams, projects, files, permissions, comments, branches, webhooks, audit.
//
// Access is asynchronous (like PostgreSQL), queries use a common SQL subset: “?” for
// parameters (the PostgreSQL driver translates to $1…), TEXT / BIGINT / INTEGER, ON CONFLICT … DO
// UPDATE. Currently there is one driver — SQLite (built into Node as node:sqlite, no dependencies): the database
// file sits next to the data; for self-hosting with many users — PostgreSQL (postgres.ts).

import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';

export interface Db {
  /** A modification; returns the number of affected rows. */
  run(sql: string, params?: unknown[]): Promise<number>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Transaction: all or nothing. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly dialect: 'sqlite' | 'postgres';
}

/** Values for the driver: booleans as numbers, undefined as NULL. */
const norm = (params: unknown[]) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)) as (string | number | null | Uint8Array)[];

export function openSqlite(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // A single connection: while a transaction runs, other handlers' queries wait for it to end (otherwise they
  // would end up inside it). The transaction's own queries are recognized via AsyncLocalStorage.
  const als = new AsyncLocalStorage<number>();
  let current: { id: number; done: Promise<void> } | null = null;
  let seq = 0;
  const gate = async () => {
    while (current && als.getStore() !== current.id) await current.done;
  };
  return {
    dialect: 'sqlite',
    async run(sql, params = []) {
      await gate();
      return Number(db.prepare(sql).run(...norm(params)).changes);
    },
    async get<T>(sql: string, params: unknown[] = []) {
      await gate();
      return db.prepare(sql).get(...norm(params)) as T | undefined;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      await gate();
      return db.prepare(sql).all(...norm(params)) as T[];
    },
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      if (current && als.getStore() === current.id) return fn();
      while (current) await current.done;
      const id = ++seq;
      let release!: () => void;
      current = { id, done: new Promise<void>((r) => (release = r)) };
      try {
        return await als.run(id, async () => {
          db.exec('BEGIN IMMEDIATE');
          try {
            const r = await fn();
            db.exec('COMMIT');
            return r;
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
        });
      } finally {
        current = null;
        release();
      }
    },
    async close() {
      db.close();
    },
  };
}

/** Schema by versions: each is a list of statements; the meta table remembers applied ones. */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created BIGINT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      external_id TEXT,
      admin INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT,
      created BIGINT NOT NULL,
      expires BIGINT NOT NULL,
      last_used BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires BIGINT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      sent BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, created BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS invites (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      file_id TEXT,
      role TEXT NOT NULL,
      invited_by TEXT,
      created BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      created BIGINT NOT NULL,
      modified BIGINT NOT NULL,
      link_role TEXT NOT NULL DEFAULT 'none',
      link_token TEXT,
      parent_id TEXT,
      branch_base TEXT,
      trashed BIGINT,
      thumb INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS file_access (
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      PRIMARY KEY (file_id, user_id)
    )`,
    `CREATE INDEX IF NOT EXISTS files_project ON files(project_id)`,
    `CREATE INDEX IF NOT EXISTS files_owner ON files(owner_id)`,
    `CREATE INDEX IF NOT EXISTS members_user ON team_members(user_id)`,
    `CREATE INDEX IF NOT EXISTS invites_email ON invites(email)`,
  ],
  // v2: server comments, reactions, attachments, notifications.
  [
    `CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      mentions TEXT,
      place TEXT,
      created BIGINT NOT NULL,
      edited BIGINT,
      resolved BIGINT,
      resolved_by TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS comments_file ON comments(file_id, created)`,
    `CREATE INDEX IF NOT EXISTS comments_thread ON comments(thread_id)`,
    `CREATE TABLE IF NOT EXISTS comment_reactions (
      comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created BIGINT NOT NULL,
      PRIMARY KEY (comment_id, user_id, emoji)
    )`,
    `CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size BIGINT NOT NULL,
      created BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS attachments_comment ON attachments(comment_id)`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
      thread_id TEXT,
      comment_id TEXT,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      text TEXT,
      created BIGINT NOT NULL,
      read BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created)`,
  ],
  // v3: branches — when and by whom merged.
  [`ALTER TABLE files ADD COLUMN merged BIGINT`, `ALTER TABLE files ADD COLUMN merged_by TEXT`, `CREATE INDEX IF NOT EXISTS files_parent ON files(parent_id)`],
  // v4: team libraries and their usage.
  [
    `CREATE TABLE IF NOT EXISTS libraries (
      file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      version INTEGER NOT NULL,
      published BIGINT NOT NULL,
      published_by TEXT,
      assets TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS library_usage (
      library_id TEXT NOT NULL REFERENCES libraries(file_id) ON DELETE CASCADE,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      counts TEXT NOT NULL,
      updated BIGINT NOT NULL,
      PRIMARY KEY (library_id, file_id)
    )`,
  ],
  // v5: webhooks and integrations, delivery queue.
  [
    `CREATE TABLE IF NOT EXISTS hooks (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      events TEXT NOT NULL,
      config TEXT NOT NULL,
      description TEXT,
      created_by TEXT,
      created BIGINT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE INDEX IF NOT EXISTS hooks_team ON hooks(team_id)`,
    `CREATE INDEX IF NOT EXISTS hooks_file ON hooks(file_id)`,
    `CREATE TABLE IF NOT EXISTS hook_deliveries (
      id TEXT PRIMARY KEY,
      hook_id TEXT NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at BIGINT NOT NULL,
      response_status INTEGER,
      error TEXT,
      created BIGINT NOT NULL,
      finished BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS deliveries_due ON hook_deliveries(status, next_at)`,
    `CREATE INDEX IF NOT EXISTS deliveries_hook ON hook_deliveries(hook_id, created)`,
  ],
  [
    `CREATE TABLE IF NOT EXISTS password_credentials (login TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, attempt_window BIGINT NOT NULL DEFAULT 0)`,
  ],
  // OAuth for MCP clients (Claude, ChatGPT): clients from dynamic registration (RFC 7591).
  [
    `CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created BIGINT NOT NULL)`,
  ],
];

export async function migrate(db: Db) {
  await db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  const row = await db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`);
  let version = row ? Number(row.value) : 0;
  for (; version < MIGRATIONS.length; version++) {
    const steps = MIGRATIONS[version]!;
    await db.tx(async () => {
      for (const sql of steps) await db.run(sql);
      await db.run(`INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [String(version + 1)]);
    });
  }
}
