// PostgreSQL for multi-user self-hosting (DATABASE_URL=postgres://…): the same Db interface
// as SQLite. Queries use the common SQL subset: “?” here is translated to $1, $2…
// Driver: pg (connection pool: a transaction runs on its own connection, other queries run
// in parallel). For tests — PGlite (Postgres in WebAssembly): there is a single connection, so
// queries outside a transaction wait for it to end, as with SQLite.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from './db.ts';

interface Result {
  rows: unknown[];
  rowCount?: number | null;
  affectedRows?: number;
}

type Query = (sql: string, params: unknown[]) => Promise<Result>;

export interface PgBackend {
  query: Query;
  /** Dedicated connection for a transaction (pool); if absent — there is a single connection. */
  connect?(): Promise<{ query: Query; release(): void }>;
  end(): Promise<void>;
}

/** “?” → $1, $2 … (outside single-quoted strings). */
export function toPg(sql: string): string {
  let n = 0;
  let quoted = false;
  let out = '';
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += !quoted && ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

const norm = (params: unknown[]) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

export function pgDb(backend: PgBackend): Db {
  const als = new AsyncLocalStorage<Query>();
  let current: Promise<void> | null = null;
  const exec = async (sql: string, params: unknown[]) => {
    const tx = als.getStore();
    if (tx) return tx(toPg(sql), norm(params));
    // Single connection (PGlite): wait for another transaction to finish.
    if (!backend.connect) while (current) await current;
    return backend.query(toPg(sql), norm(params));
  };
  return {
    dialect: 'postgres',
    async run(sql, params = []) {
      const r = await exec(sql, params);
      return Number(r.rowCount ?? r.affectedRows ?? 0);
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return (await exec(sql, params)).rows[0] as T | undefined;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return (await exec(sql, params)).rows as T[];
    },
    async tx<T>(fn: () => Promise<T>): Promise<T> {
      if (als.getStore()) return fn();
      const run = async (q: Query) => {
        await q('BEGIN', []);
        try {
          const r = await als.run(q, fn);
          await q('COMMIT', []);
          return r;
        } catch (e) {
          await q('ROLLBACK', []);
          throw e;
        }
      };
      if (backend.connect) {
        const client = await backend.connect();
        try {
          return await run(client.query);
        } finally {
          client.release();
        }
      }
      while (current) await current;
      let release!: () => void;
      current = new Promise<void>((r) => (release = r));
      try {
        return await run(backend.query);
      } finally {
        current = null;
        release();
      }
    },
    close: () => backend.end(),
  };
}

/** pg pool at postgres://… (big numbers as numbers: time in ms fits in a double). */
export async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v: string) => Number(v));
  pg.types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', (e: Error) => console.error('PostgreSQL:', e.message));
  return pgDb({
    query: (sql, params) => pool.query(sql, params as unknown[]),
    connect: async () => {
      const c = await pool.connect();
      return { query: (sql, params) => c.query(sql, params as unknown[]), release: () => c.release() };
    },
    end: () => pool.end(),
  });
}
