// Server policy for editors: closed network (MFP_NETWORK=off).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startServer } from '../src/server.ts';
import { testDb } from './db.ts';

async function config(opts: { network?: 'on' | 'off' }) {
  const tdb = await testDb();
  const dir = mkdtempSync(join(tmpdir(), 'mfp-policy-'));
  const server = await startServer({ port: 0, dir, pingMs: 60_000, db: tdb.db, mailer: { send: async () => {} }, ...opts });
  try {
    return await (await fetch(`http://localhost:${server.port}/api/auth/config`)).json();
  } finally {
    await server.close();
    await tdb.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('server policy', () => {
  it('internet is allowed by default', async () => {
    expect(await config({})).toEqual({ mode: 'email', network: 'on' });
  });
  it('closed network', async () => {
    expect(await config({ network: 'off' })).toEqual({ mode: 'email', network: 'off' });
  });
});
