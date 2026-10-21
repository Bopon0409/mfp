// Database for server tests: SQLite by default (in the data folder), PostgreSQL — PGlite in memory
// if MFP_TEST_DB=pglite (a second run of the same tests, vitest.config.ts).

import type { Db } from '../src/db.ts';
import { pgDb } from '../src/postgres.ts';

/** Database per test: the server's close does not close it (a server restart keeps the same data). */
export async function testDb(): Promise<{ db: Db | undefined; dispose(): Promise<void> }> {
  if (process.env.MFP_TEST_DB !== 'pglite') return { db: undefined, dispose: async () => {} };
  const { PGlite } = await import('@electric-sql/pglite');
  const pgl = new PGlite();
  const db = pgDb({ query: (sql, params) => pgl.query(sql, params as unknown[]), end: async () => {} });
  return { db, dispose: () => pgl.close() };
}
