// Offline provisioning. stdin: [{login,password,name}]. Never prints credentials.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LoroDoc } from 'loro-crdt';
import { Auth } from './auth.ts';
import { betaFromEnv } from './beta.ts';
import { migrate, openSqlite } from './db.ts';
import { Passwords } from './passwords.ts';
import { fsStore, newId } from './util.ts';

const beta = betaFromEnv(process.env);
if (beta?.auth !== 'password') throw new Error('Password beta profile required');
const accounts = JSON.parse(readFileSync(0, 'utf8')) as { login: string; password: string; name: string }[];
if (!Array.isArray(accounts) || !accounts.length || accounts.length > 100) throw new Error('Expected 1–100 accounts');
if (!accounts.some(a => `${a.login}@beta.invalid` === beta.owner)) throw new Error('Owner account missing');
const dir = process.env.MFP_DATA ?? 'rooms';
const db = openSqlite(join(dir, 'mfp.db'));
try {
  await migrate(db);
  const auth = new Auth(db, { send: async () => {} }, beta);
  const passwords = new Passwords(db, auth);
  await db.tx(async () => {
    const users = [];
    for (const a of accounts) users.push(await passwords.provision(a.login, a.password, a.name));
    const owner = users.find(u => u.email === beta.owner)!;
    const team = newId(), project = newId(), file = newId(), now = Date.now();
    await db.run('INSERT INTO teams (id, name, created) VALUES (?, ?, ?)', [team, 'MFP Beta', now]);
    await db.run('INSERT INTO projects (id, team_id, name, created) VALUES (?, ?, ?, ?)', [project, team, 'Совместные тесты', now]);
    for (const user of users) await db.run('INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)', [team, user.id, user.id === owner.id ? 'owner' : 'editor']);
    await db.run('INSERT INTO files (id, project_id, owner_id, name, created, modified) VALUES (?, ?, ?, ?, ?, ?)', [file, project, owner.id, 'Общий тестовый макет', now, now]);
    await fsStore(dir).put(`files/${file}/doc.loro`, new LoroDoc().export({ mode: 'snapshot' }));
    console.log(JSON.stringify({ accounts: users.length, team, project, file }));
  });
} finally { await db.close(); }
