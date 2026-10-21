// Stop the beta app before running. Password is read from stdin, never argv or logs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqlite } from './db.ts';
import { passwordHash } from './passwords.ts';
const login = process.argv[2]?.trim().toLowerCase();
if (!login || process.env.MFP_AUTH !== 'password') throw new Error('Password beta and login required');
const hash = await passwordHash(readFileSync(0, 'utf8').trim());
const db = openSqlite(join(process.env.MFP_DATA ?? 'rooms', 'mfp.db'));
try {
  await db.tx(async () => {
    const row = await db.get<{ user_id: string }>('SELECT user_id FROM password_credentials WHERE login = ?', [login]);
    if (!row) throw new Error('Unknown login');
    await db.run('UPDATE password_credentials SET hash = ?, must_change = 1, attempts = 0, attempt_window = 0 WHERE login = ?', [hash, login]);
    await db.run('DELETE FROM sessions WHERE user_id = ?', [row.user_id]);
  });
  console.log('Temporary password reset; all sessions revoked');
} finally { await db.close(); }
