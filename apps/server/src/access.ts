// Permissions. Team role: viewer (views and comments), editor (edits), admin (manages
// the team), owner. File role: view, comment, edit, owner (manages access). The effective result for
// a person is the best of: file owner, role in the project's team, personal file access, link
// (without sign-in, a link gives view only).

import type { Db } from './db.ts';
import { fail } from './util.ts';

export type TeamRole = 'viewer' | 'editor' | 'admin' | 'owner';
export type FileRole = 'none' | 'view' | 'comment' | 'edit' | 'owner';

export const TEAM_RANK: Record<TeamRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
export const FILE_RANK: Record<FileRole, number> = { none: 0, view: 1, comment: 2, edit: 3, owner: 4 };
const FROM_TEAM: Record<TeamRole, FileRole> = { viewer: 'comment', editor: 'edit', admin: 'owner', owner: 'owner' };

export const isTeamRole = (r: unknown): r is TeamRole => typeof r === 'string' && r in TEAM_RANK;
export const isFileRole = (r: unknown): r is FileRole => typeof r === 'string' && r in FILE_RANK && r !== 'none';
export const atLeast = (r: FileRole, need: FileRole) => FILE_RANK[r] >= FILE_RANK[need];
export const maxRole = (a: FileRole, b: FileRole): FileRole => (FILE_RANK[a] >= FILE_RANK[b] ? a : b);

export interface FileRow {
  id: string;
  project_id: string | null;
  owner_id: string;
  name: string;
  created: number;
  modified: number;
  link_role: FileRole;
  link_token: string | null;
  /** Branch: the main file. */
  parent_id: string | null;
  branch_base: string | null;
  trashed: number | null;
  thumb: number;
  /** The branch was merged into the main file (when). */
  merged?: number | null;
}

export async function teamRole(db: Db, teamId: string, userId: string): Promise<TeamRole | null> {
  const r = await db.get<{ role: TeamRole }>(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`, [teamId, userId]);
  return r?.role ?? null;
}

/** Require a team role of at least need. */
export async function needTeam(db: Db, teamId: string, userId: string, need: TeamRole): Promise<TeamRole> {
  const r = await teamRole(db, teamId, userId);
  if (!r) fail(404, 'Нет такой команды');
  if (TEAM_RANK[r!] < TEAM_RANK[need]) fail(403, 'Недостаточно прав в команде');
  return r!;
}

export async function fileRow(db: Db, id: string): Promise<FileRow | undefined> {
  return db.get<FileRow>(`SELECT * FROM files WHERE id = ?`, [id]);
}

/** The file's project team (null — the owner's draft). */
export async function fileTeam(db: Db, f: FileRow): Promise<string | null> {
  if (!f.project_id) return null;
  return (await db.get<{ team_id: string }>(`SELECT team_id FROM projects WHERE id = ?`, [f.project_id]))?.team_id ?? null;
}

export async function fileRole(db: Db, f: FileRow, userId: string | null, link?: string | null): Promise<FileRole> {
  // A branch — the main file's permissions; its author gets at least editor.
  if (f.parent_id) {
    const main = await fileRow(db, f.parent_id);
    if (!main || main.trashed) return 'none';
    const role = await fileRole(db, main, userId, link);
    return userId && f.owner_id === userId && role !== 'none' ? maxRole(role, 'edit') : role;
  }
  let role: FileRole = 'none';
  if (userId) {
    if (f.owner_id === userId) return 'owner';
    const team = await fileTeam(db, f);
    if (team) {
      const t = await teamRole(db, team, userId);
      if (t) role = maxRole(role, FROM_TEAM[t]);
    }
    const own = await db.get<{ role: FileRole }>(`SELECT role FROM file_access WHERE file_id = ? AND user_id = ?`, [f.id, userId]);
    if (own) role = maxRole(role, own.role);
  }
  if (link && f.link_token && f.link_role !== 'none' && link === f.link_token) role = maxRole(role, userId ? f.link_role : 'view');
  return role;
}

/** File and role; no access — as if the file doesn't exist. */
export async function needFile(db: Db, id: string, userId: string | null, need: FileRole, link?: string | null): Promise<{ file: FileRow; role: FileRole }> {
  const file = await fileRow(db, id);
  const role = file ? await fileRole(db, file, userId, link) : 'none';
  if (!file || role === 'none') fail(404, 'Нет такого файла');
  if (!atLeast(role, need)) fail(403, 'Недостаточно прав у файла');
  return { file: file!, role };
}
