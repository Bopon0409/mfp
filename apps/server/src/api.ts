// Server REST API (JSON): sign-in, profile and tokens, teams and members, projects, files, access.
// The editor and external programs call it with the header Authorization: Bearer <token>.

import { LoroDoc } from 'loro-crdt';
import { atLeast, fileRole, fileTeam, isFileRole, isTeamRole, needFile, needTeam, TEAM_RANK, teamRole, type FileRole, type FileRow, type TeamRole } from './access.ts';
import type { Auth, User } from './auth.ts';
import { Passwords } from './passwords.ts';
import type { Db } from './db.ts';
import { notify, type CommentView } from './comments.ts';
import { docKey, type LiveFiles } from './live.ts';
import type { Router } from './router.ts';
import { email, fail, newId, newSecret, readBody, readJson, sendBytes, str, type BlobStore, type Mailer } from './util.ts';

export interface ApiDeps {
  db: Db;
  auth: Auth;
  store: BlobStore;
  live: LiveFiles;
  mailer: Mailer;
  /** Editor URL for links in emails. */
  appUrl: string;
  /** Server policy for editors: internet (off — closed network: editors don't go online). */
  policy?: { network: 'on' | 'off' };
  /** First-setup code (users-admin.ts): while it exists, a server without accounts waits for an administrator. */
  setup?: { code: string | null };
  /** Comments (filled by registerComments): for REST v1, MCP and integrations. */
  comments?: {
    create(file: FileRow, user: User, input: { text: string; place?: unknown; thread?: string | null; mentions?: unknown; attachments?: string[] }): Promise<CommentView>;
    list(fileId: string): Promise<CommentView[]>;
  };
  /** Events for webhooks and integrations (filled by hooks.ts). */
  events?: { emit(type: string, data: { fileId: string; by?: User | null; [k: string]: unknown }): void };
}

const userView = (u: User) => ({ id: u.id, email: u.email, name: u.name, color: u.color, admin: !!u.admin });

/** Document in a request — no larger than this (a giant file's snapshot with images separate is about 100 MB). */
export const MAX_DOC = 256 * 2 ** 20;

/** Loro bytes from the request (unreadable — 400). */
export function readLoro(bytes: Uint8Array): LoroDoc {
  const doc = new LoroDoc();
  try {
    doc.import(bytes);
  } catch {
    fail(400, 'Документ не читается (нужен снимок или обновление Loro)');
  }
  return doc;
}

export function fileView(f: FileRow, role: FileRole, extra: Record<string, unknown> = {}) {
  return {
    id: f.id,
    name: f.name,
    projectId: f.project_id,
    ownerId: f.owner_id,
    created: f.created,
    modified: f.modified,
    role,
    linkRole: f.link_role,
    thumb: !!f.thumb,
    parentId: f.parent_id,
    trashed: f.trashed ?? null,
    merged: f.merged ?? null,
    ...extra,
  };
}

/**
 * Notification email (invitation, file access): failing to deliver it is no reason to undo what was done.
 * Accounts with a login (service email …@*.invalid) aren't sent emails.
 */
async function mailQuietly(d: ApiDeps, mail: Parameters<Mailer['send']>[0]) {
  if (/\.invalid$/i.test(mail.to)) return;
  await d.mailer.send(mail).catch((e: unknown) => console.warn('Письмо не отправлено', mail.to, e));
}

export function registerApi(r: Router, d: ApiDeps) {
  const { db, auth } = d;
  const passwords = new Passwords(db, auth);
  /** Whom to grant access: an email or (password sign-in) an account login. */
  const recipient = (v: unknown) => (auth.passwordMode && typeof v === 'string' && /^[a-z][a-z0-9_-]{2,31}$/i.test(v.trim()) ? `${v.trim().toLowerCase()}@${auth.loginDomain}` : email(v));
  // No sign-in required: sign-in method and server policy (the editor reads it at startup).
  r.add('GET', '/api/auth/config', async () => ({
    mode: auth.passwordMode ? 'password' : 'email',
    network: d.policy?.network ?? 'on',
    ...(d.setup?.code && !(await db.get('SELECT id FROM users LIMIT 1')) ? { setup: true } : {}),
  }));
  r.add('POST', '/api/auth/password', async c => {
    if (!auth.passwordMode) fail(404, 'Вход по паролю не включён');
    const b = await readJson(c.req);
    if (typeof b.password !== 'string' || (b.newPassword !== undefined && typeof b.newPassword !== 'string')) fail(400, 'Нужен пароль');
    const result = await passwords.login(str(b.login, 'login', 32), b.password as string, b.newPassword as string | undefined);
    return 'user' in result ? { token: result.token, user: userView(result.user!) } : result;
  });

  // ---------- Sign-in ----------

  r.add('POST', '/api/auth/code', async (c) => {
    const b = await readJson(c.req);
    await auth.requestCode(email(b.email));
    return { ok: true };
  });

  r.add('POST', '/api/auth/verify', async (c) => {
    const b = await readJson(c.req);
    const { token, user } = await auth.verifyCode(email(b.email), str(b.code, 'code', 12));
    return { token, user: userView(user) };
  });

  r.add('POST', '/api/auth/logout', async (c) => {
    await auth.logout(c.need());
  });

  /** Who is signed in, their teams and their projects; appUrl — editor URL for file links. */
  r.add('GET', '/api/me', async (c) => {
    const p = c.need();
    const teams = await db.all<{ id: string; name: string; role: TeamRole }>(
      `SELECT t.id, t.name, m.role FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.name`,
      [p.user.id],
    );
    const projects = await db.all<{ id: string; teamId: string; name: string }>(
      `SELECT pr.id, pr.team_id AS "teamId", pr.name FROM projects pr JOIN team_members m ON m.team_id = pr.team_id WHERE m.user_id = ? ORDER BY pr.name`,
      [p.user.id],
    );
    return { user: userView(p.user), teams, projects, appUrl: d.appUrl };
  });

  r.add('PATCH', '/api/me', async (c) => {
    const p = c.need();
    const b = await readJson(c.req);
    await db.run(`UPDATE users SET name = ? WHERE id = ?`, [str(b.name, 'name', 80), p.user.id]);
    return { user: userView((await auth.byId(p.user.id))!) };
  });

  r.add('GET', '/api/tokens', async (c) => ({ tokens: await auth.tokens(c.need().user.id) }));
  r.add('POST', '/api/tokens', async (c) => {
    const p = c.need();
    if (p.kind !== 'session') fail(403, 'Токены выпускают из редактора');
    const b = await readJson(c.req);
    return { token: await auth.newSession(p.user.id, 'api', str(b.name, 'name', 80)) };
  });
  r.add('DELETE', '/api/tokens/:id', async (c) => {
    await auth.deleteToken(c.need().user.id, c.params.id!);
  });

  // ---------- Teams ----------

  r.add('GET', '/api/teams', async (c) => ({
    teams: await db.all(`SELECT t.id, t.name, m.role FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = ? ORDER BY t.name`, [c.need().user.id]),
  }));

  r.add('POST', '/api/teams', async (c) => {
    const p = c.need();
    const b = await readJson(c.req);
    const id = newId();
    const project = newId();
    const now = Date.now();
    await db.tx(async () => {
      await db.run(`INSERT INTO teams (id, name, created) VALUES (?, ?, ?)`, [id, str(b.name, 'name', 80), now]);
      await db.run(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')`, [id, p.user.id]);
      await db.run(`INSERT INTO projects (id, team_id, name, created) VALUES (?, ?, ?, ?)`, [project, id, 'Проект', now]);
    });
    return { id, projectId: project };
  });

  r.add('GET', '/api/teams/:id', async (c) => {
    const p = c.need();
    const id = c.params.id!;
    const role = await needTeam(db, id, p.user.id, 'viewer');
    const team = await db.get<{ id: string; name: string; created: number }>(`SELECT * FROM teams WHERE id = ?`, [id]);
    const members = await db.all<User & { role: TeamRole }>(`SELECT u.*, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.name`, [id]);
    const invites = await db.all(`SELECT id, email, role, created FROM invites WHERE team_id = ? ORDER BY created`, [id]);
    const projects = await db.all(`SELECT id, name, created FROM projects WHERE team_id = ? ORDER BY name`, [id]);
    return { team, role, members: members.map((m) => ({ ...userView(m), role: m.role })), invites, projects };
  });

  r.add('PATCH', '/api/teams/:id', async (c) => {
    await needTeam(db, c.params.id!, c.need().user.id, 'admin');
    const b = await readJson(c.req);
    await db.run(`UPDATE teams SET name = ? WHERE id = ?`, [str(b.name, 'name', 80), c.params.id]);
  });

  r.add('DELETE', '/api/teams/:id', async (c) => {
    await needTeam(db, c.params.id!, c.need().user.id, 'owner');
    // The team's files remain with their owners as drafts.
    await db.run(`DELETE FROM teams WHERE id = ?`, [c.params.id]);
    await d.live.refreshAll();
  });

  r.add('POST', '/api/teams/:id/members', async (c) => {
    const p = c.need();
    const teamId = c.params.id!;
    const mine = await needTeam(db, teamId, p.user.id, 'admin');
    const b = await readJson(c.req);
    const to = recipient(b.email);
    const role: TeamRole = isTeamRole(b.role) ? b.role : 'editor';
    if (TEAM_RANK[role] > TEAM_RANK[mine]) fail(403, 'Нельзя дать роль выше своей');
    const team = await db.get<{ name: string }>(`SELECT name FROM teams WHERE id = ?`, [teamId]);
    const user = await auth.byEmail(to);
    if (auth.passwordMode && !user) fail(400, 'Добавлять можно только учётные записи, созданные администратором сервера');
    if (user) {
      await db.run(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role`, [teamId, user.id, role]);
      await d.live.refreshAll();
      if (user.id !== p.user.id) await notify(db, { userId: user.id, kind: 'team', actorId: p.user.id, text: team?.name ?? '' });
    } else {
      await db.run(`INSERT INTO invites (id, email, team_id, role, invited_by, created) VALUES (?, ?, ?, ?, ?, ?)`, [newId(), to, teamId, role, p.user.id, Date.now()]);
    }
    await mailQuietly(d, { to, subject: `${p.user.name} приглашает в команду «${team?.name ?? ''}»`, text: `${p.user.name} (${p.user.email}) добавил вас в команду «${team?.name ?? ''}» в MFP.\nОткройте ${d.appUrl} и войдите с этой почтой.` });
    return { added: !!user, invited: !user };
  });

  r.add('PATCH', '/api/teams/:id/members/:userId', async (c) => {
    const p = c.need();
    const teamId = c.params.id!;
    const mine = await needTeam(db, teamId, p.user.id, 'admin');
    const b = await readJson(c.req);
    if (!isTeamRole(b.role)) fail(400, 'Неизвестная роль');
    const role = b.role as TeamRole;
    if (TEAM_RANK[role] > TEAM_RANK[mine]) fail(403, 'Нельзя дать роль выше своей');
    const target = await teamRole(db, teamId, c.params.userId!);
    if (!target) fail(404, 'Нет такого участника');
    if (TEAM_RANK[target!] > TEAM_RANK[mine]) fail(403, 'Нельзя менять роль старшего');
    if (target === 'owner' && role !== 'owner') await keepOwner(teamId, c.params.userId!);
    await db.run(`UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?`, [role, teamId, c.params.userId]);
    await d.live.refreshAll();
  });

  r.add('DELETE', '/api/teams/:id/members/:userId', async (c) => {
    const p = c.need();
    const teamId = c.params.id!;
    const self = c.params.userId === p.user.id;
    const mine = await needTeam(db, teamId, p.user.id, self ? 'viewer' : 'admin');
    const target = await teamRole(db, teamId, c.params.userId!);
    if (!target) fail(404, 'Нет такого участника');
    if (!self && TEAM_RANK[target!] > TEAM_RANK[mine]) fail(403, 'Нельзя удалить старшего');
    if (target === 'owner') await keepOwner(teamId, c.params.userId!);
    await db.run(`DELETE FROM team_members WHERE team_id = ? AND user_id = ?`, [teamId, c.params.userId]);
    await d.live.refreshAll();
  });

  /** A team must keep at least one owner. */
  const keepOwner = async (teamId: string, leaving: string) => {
    const owners = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner' AND user_id <> ?`, [teamId, leaving]);
    if (!owners?.n) fail(400, 'У команды должен остаться владелец');
  };

  r.add('DELETE', '/api/teams/:id/invites/:inviteId', async (c) => {
    await needTeam(db, c.params.id!, c.need().user.id, 'admin');
    await db.run(`DELETE FROM invites WHERE id = ? AND team_id = ?`, [c.params.inviteId, c.params.id]);
  });

  // ---------- Projects ----------

  r.add('POST', '/api/teams/:id/projects', async (c) => {
    await needTeam(db, c.params.id!, c.need().user.id, 'editor');
    const b = await readJson(c.req);
    const id = newId();
    await db.run(`INSERT INTO projects (id, team_id, name, created) VALUES (?, ?, ?, ?)`, [id, c.params.id, str(b.name, 'name', 80), Date.now()]);
    return { id };
  });

  const projectTeam = async (id: string) => {
    const pr = await db.get<{ id: string; team_id: string; name: string; created: number }>(`SELECT * FROM projects WHERE id = ?`, [id]);
    if (!pr) fail(404, 'Нет такого проекта');
    return pr!;
  };

  r.add('GET', '/api/projects/:id', async (c) => {
    const p = c.need();
    const pr = await projectTeam(c.params.id!);
    await needTeam(db, pr.team_id, p.user.id, 'viewer');
    const files = await db.all<FileRow>(`SELECT * FROM files WHERE project_id = ? AND trashed IS NULL AND parent_id IS NULL ORDER BY modified DESC`, [pr.id]);
    return { project: pr, files: await Promise.all(files.map(async (f) => fileView(f, await fileRole(db, f, p.user.id)))) };
  });

  r.add('PATCH', '/api/projects/:id', async (c) => {
    const pr = await projectTeam(c.params.id!);
    await needTeam(db, pr.team_id, c.need().user.id, 'editor');
    const b = await readJson(c.req);
    await db.run(`UPDATE projects SET name = ? WHERE id = ?`, [str(b.name, 'name', 80), pr.id]);
  });

  r.add('DELETE', '/api/projects/:id', async (c) => {
    const pr = await projectTeam(c.params.id!);
    await needTeam(db, pr.team_id, c.need().user.id, 'admin');
    // Project files go to their owners' trash (they aren't lost).
    await db.tx(async () => {
      await db.run(`UPDATE files SET trashed = ? WHERE project_id = ? AND trashed IS NULL`, [Date.now(), pr.id]);
      await db.run(`DELETE FROM projects WHERE id = ?`, [pr.id]);
    });
    await d.live.refreshAll();
  });

  // ---------- Files ----------

  /** Files: recent, drafts, shared personally, trash. */
  r.add('GET', '/api/files', async (c) => {
    const p = c.need();
    const scope = c.query.get('scope') ?? 'recent';
    let rows: FileRow[];
    if (scope === 'drafts') rows = await db.all<FileRow>(`SELECT * FROM files WHERE owner_id = ? AND project_id IS NULL AND trashed IS NULL AND parent_id IS NULL ORDER BY modified DESC`, [p.user.id]);
    else if (scope === 'shared') rows = await db.all<FileRow>(`SELECT f.* FROM files f JOIN file_access a ON a.file_id = f.id WHERE a.user_id = ? AND f.trashed IS NULL ORDER BY f.modified DESC`, [p.user.id]);
    else if (scope === 'trash') rows = await db.all<FileRow>(`SELECT * FROM files WHERE owner_id = ? AND trashed IS NOT NULL ORDER BY trashed DESC`, [p.user.id]);
    else
      rows = await db.all<FileRow>(
        `SELECT DISTINCT f.* FROM files f
         LEFT JOIN projects pr ON pr.id = f.project_id
         LEFT JOIN team_members m ON m.team_id = pr.team_id AND m.user_id = ?
         LEFT JOIN file_access a ON a.file_id = f.id AND a.user_id = ?
         WHERE f.trashed IS NULL AND f.parent_id IS NULL AND (f.owner_id = ? OR m.user_id IS NOT NULL OR a.user_id IS NOT NULL)
         ORDER BY f.modified DESC LIMIT 100`,
        [p.user.id, p.user.id, p.user.id],
      );
    return { files: await Promise.all(rows.map(async (f) => fileView(f, await fileRole(db, f, p.user.id)))) };
  });

  /**
   * New file: empty (JSON {name, projectId}) or with a document right away — an application/octet-stream body
   * with a Loro snapshot, name and project in the URL (?name=…&projectId=…).
   */
  r.add('POST', '/api/files', async (c) => {
    const p = c.need();
    const binary = (c.req.headers['content-type'] ?? '').startsWith('application/octet-stream');
    const b: Record<string, unknown> = binary ? Object.fromEntries(c.query) : await readJson(c.req);
    const project = typeof b.projectId === 'string' && b.projectId ? b.projectId : null;
    if (project) await needTeam(db, (await projectTeam(project)).team_id, p.user.id, 'editor');
    const name = str(b.name ?? 'Без названия', 'name', 200);
    const snapshot = binary ? readLoro(await readBody(c.req, MAX_DOC)).export({ mode: 'snapshot' }) : new LoroDoc().export({ mode: 'snapshot' });
    const id = newId();
    const now = Date.now();
    await d.store.put(docKey(id), snapshot);
    await db.run(`INSERT INTO files (id, project_id, owner_id, name, created, modified) VALUES (?, ?, ?, ?, ?, ?)`, [id, project, p.user.id, name, now, now]);
    return fileView((await db.get<FileRow>(`SELECT * FROM files WHERE id = ?`, [id]))!, 'owner');
  });

  r.add('GET', '/api/files/:id', async (c) => {
    const { file, role } = await needFile(db, c.params.id!, c.principal?.user.id ?? null, 'view', c.query.get('link'));
    const team = await fileTeam(db, file);
    const project = file.project_id ? await db.get<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE id = ?`, [file.project_id]) : null;
    const teamName = team ? (await db.get<{ name: string }>(`SELECT name FROM teams WHERE id = ?`, [team]))?.name : null;
    const main = file.parent_id ? await db.get<{ name: string }>(`SELECT name FROM files WHERE id = ?`, [file.parent_id]) : null;
    return fileView(file, role, { teamId: team, teamName, projectName: project?.name ?? null, mainName: main?.name ?? null });
  });

  r.add('PATCH', '/api/files/:id', async (c) => {
    const p = c.need();
    const { file, role } = await needFile(db, c.params.id!, p.user.id, 'edit');
    const b = await readJson(c.req);
    if (b.name !== undefined) await db.run(`UPDATE files SET name = ? WHERE id = ?`, [str(b.name, 'name', 200), file.id]);
    if (b.projectId !== undefined) {
      if (!atLeast(role, 'owner')) fail(403, 'Переносить файл может его владелец');
      const target = typeof b.projectId === 'string' && b.projectId ? b.projectId : null;
      if (target) await needTeam(db, (await projectTeam(target)).team_id, p.user.id, 'editor');
      await db.run(`UPDATE files SET project_id = ? WHERE id = ?`, [target, file.id]);
      await d.live.refresh(file.id);
    }
    return fileView((await db.get<FileRow>(`SELECT * FROM files WHERE id = ?`, [file.id]))!, await fileRole(db, file, p.user.id));
  });

  r.add('DELETE', '/api/files/:id', async (c) => {
    const p = c.need();
    const { file, role } = await needFile(db, c.params.id!, p.user.id, 'view');
    // A branch is deleted by its author or the main file's owner — immediately, without the trash.
    if (file.parent_id) {
      if (file.owner_id !== p.user.id && role !== 'owner') fail(403, 'Удалить ветку может её автор или владелец файла');
      await db.run(`DELETE FROM files WHERE id = ?`, [file.id]);
      await d.store.delete(`files/${file.id}`);
      await d.live.refresh(file.id);
      return;
    }
    if (role !== 'owner') fail(403, 'Удалить файл может его владелец');
    if (c.query.get('forever') === '1') {
      if (!file.trashed) fail(400, 'Сначала — в корзину');
      for (const b of await db.all<{ id: string }>(`SELECT id FROM files WHERE parent_id = ?`, [file.id])) await d.store.delete(`files/${b.id}`);
      await db.run(`DELETE FROM files WHERE parent_id = ?`, [file.id]);
      await db.run(`DELETE FROM files WHERE id = ?`, [file.id]);
      await d.store.delete(`files/${file.id}`);
    } else {
      await db.run(`UPDATE files SET trashed = ? WHERE id = ?`, [Date.now(), file.id]);
      d.events?.emit('FILE_DELETE', { fileId: file.id, by: p.user });
    }
    await d.live.refresh(file.id);
    // Branches of a deleted file are closed too.
    for (const b of await db.all<{ id: string }>(`SELECT id FROM files WHERE parent_id = ?`, [file.id])) await d.live.refresh(b.id);
  });

  r.add('POST', '/api/files/:id/restore', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'owner');
    await db.run(`UPDATE files SET trashed = NULL WHERE id = ?`, [file.id]);
  });

  r.add('GET', '/api/files/:id/doc', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.principal?.user.id ?? null, 'view', c.query.get('link'));
    sendBytes(c.res, await d.live.snapshot(file.id));
  });

  /** External edit: a Loro update (from another copy of the document, a script) is merged into the file. */
  r.add('POST', '/api/files/:id/doc', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'edit');
    const bytes = await readBody(c.req, MAX_DOC);
    readLoro(bytes);
    await d.live.apply(file.id, bytes);
  });

  r.add('GET', '/api/files/:id/thumb', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.principal?.user.id ?? null, 'view', c.query.get('link'));
    const png = await d.store.get(`files/${file.id}/thumb.png`);
    if (!png) fail(404, 'Миниатюры нет');
    sendBytes(c.res, png!, 'image/png', 'private, max-age=60');
  });

  r.add('PUT', '/api/files/:id/thumb', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'edit');
    const png = await readBody(c.req, 4 * 2 ** 20);
    if (png[0] !== 0x89 || png[1] !== 0x50) fail(400, 'Нужен PNG');
    await d.store.put(`files/${file.id}/thumb.png`, png);
    await db.run(`UPDATE files SET thumb = 1 WHERE id = ?`, [file.id]);
  });

  // ---------- File access ----------

  r.add('GET', '/api/files/:id/access', async (c) => {
    const p = c.need();
    const { file, role } = await needFile(db, c.params.id!, p.user.id, 'view');
    const people = await db.all<User & { role: FileRole }>(`SELECT u.*, a.role FROM file_access a JOIN users u ON u.id = a.user_id WHERE a.file_id = ? ORDER BY u.name`, [file.id]);
    const owner = await auth.byId(file.owner_id);
    const invites = await db.all(`SELECT id, email, role, created FROM invites WHERE file_id = ? ORDER BY created`, [file.id]);
    return {
      role,
      owner: owner ? userView(owner) : null,
      people: people.map((u) => ({ ...userView(u), role: u.role })),
      invites,
      link: { role: file.link_role, token: atLeast(role, 'owner') || file.link_role !== 'none' ? file.link_token : null },
    };
  });

  r.add('POST', '/api/files/:id/access', async (c) => {
    const p = c.need();
    const { file } = await needFile(db, c.params.id!, p.user.id, 'owner');
    const b = await readJson(c.req);
    const to = recipient(b.email);
    if (!isFileRole(b.role) || b.role === 'owner') fail(400, 'Роль: view, comment или edit');
    const role = b.role as FileRole;
    const user = await auth.byEmail(to);
    if (auth.passwordMode && !user) fail(400, 'Добавлять можно только учётные записи, созданные администратором сервера');
    if (user) {
      await db.run(`INSERT INTO file_access (file_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (file_id, user_id) DO UPDATE SET role = excluded.role`, [file.id, user.id, role]);
      await d.live.refresh(file.id);
      if (user.id !== p.user.id) await notify(db, { userId: user.id, kind: 'share', fileId: file.id, actorId: p.user.id, text: role });
    } else await db.run(`INSERT INTO invites (id, email, file_id, role, invited_by, created) VALUES (?, ?, ?, ?, ?, ?)`, [newId(), to, file.id, role, p.user.id, Date.now()]);
    await mailQuietly(d, { to, subject: `${p.user.name} открыл вам «${file.name}»`, text: `${p.user.name} (${p.user.email}) открыл вам файл «${file.name}» в MFP.\n${d.appUrl}#file=${file.id}` });
    return { added: !!user, invited: !user };
  });

  r.add('DELETE', '/api/files/:id/access/:userId', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'owner');
    await db.run(`DELETE FROM file_access WHERE file_id = ? AND user_id = ?`, [file.id, c.params.userId]);
    await d.live.refresh(file.id);
  });

  r.add('DELETE', '/api/files/:id/invites/:inviteId', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'owner');
    await db.run(`DELETE FROM invites WHERE id = ? AND file_id = ?`, [c.params.inviteId, file.id]);
  });

  /** Link access: none, view, comment or edit (the link token is new when first enabled). */
  r.add('PUT', '/api/files/:id/link', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'owner');
    const b = await readJson(c.req);
    const role = b.role === 'none' ? 'none' : isFileRole(b.role) && b.role !== 'owner' ? (b.role as FileRole) : fail(400, 'Роль: none, view, comment или edit');
    const token = file.link_token ?? newSecret();
    await db.run(`UPDATE files SET link_role = ?, link_token = ? WHERE id = ?`, [role, token, file.id]);
    await d.live.refresh(file.id);
    return { role, token };
  });
}
