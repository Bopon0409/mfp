// File branches: a copy of the main file with its own Loro history. The branch base is a snapshot
// of the main file at creation time: the client compares both sides against it (what changed in the branch, what
// in the main file, where the conflicts are). The client computes the merge (with choices for conflicts); a ready
// Loro update for the main file arrives here; the branch is marked as merged.

import { fileRow, needFile, type FileRow } from './access.ts';
import { fileView, MAX_DOC, readLoro, type ApiDeps } from './api.ts';
import { docKey } from './live.ts';
import type { Router } from './router.ts';
import { fail, newId, readBody, readJson, sendBytes, str } from './util.ts';

const baseKey = (id: string) => `files/${id}/base.loro`;

export function registerBranches(r: Router, d: ApiDeps) {
  const { db } = d;

  /** Branches of the main file (from a branch — its siblings and the main file). */
  r.add('GET', '/api/files/:id/branches', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'view', c.query.get('link'));
    const main = file.parent_id ? ((await fileRow(db, file.parent_id)) ?? file) : file;
    const rows = await db.all<FileRow & { owner_name: string }>(
      `SELECT f.*, u.name AS owner_name FROM files f JOIN users u ON u.id = f.owner_id WHERE f.parent_id = ? AND f.trashed IS NULL ORDER BY f.merged IS NOT NULL, f.modified DESC`,
      [main.id],
    );
    return {
      main: { id: main.id, name: main.name },
      branches: rows.map((b) => ({ id: b.id, name: b.name, ownerId: b.owner_id, ownerName: b.owner_name, created: b.created, modified: b.modified, merged: b.merged ?? null })),
    };
  });

  /** New branch: a snapshot of the main file becomes its document and base. */
  r.add('POST', '/api/files/:id/branches', async (c) => {
    const p = c.need();
    const { file } = await needFile(db, c.params.id!, p.user.id, 'edit', c.query.get('link'));
    if (file.parent_id) fail(400, 'Ветку делают от основного файла');
    const b = await readJson(c.req);
    const name = str(b.name, 'name', 200);
    const snapshot = await d.live.snapshot(file.id);
    const id = newId();
    const now = Date.now();
    await d.store.put(docKey(id), snapshot);
    await d.store.put(baseKey(id), snapshot);
    await db.run(`INSERT INTO files (id, project_id, owner_id, name, created, modified, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, file.project_id, p.user.id, name, now, now, file.id]);
    return fileView((await fileRow(db, id))!, 'edit', { mainName: file.name });
  });

  /** Branch base (snapshot of the main file at creation). */
  r.add('GET', '/api/files/:id/base', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.principal?.user.id ?? null, 'view', c.query.get('link'));
    if (!file.parent_id) fail(400, 'Это не ветка');
    const bytes = await d.store.get(baseKey(file.id));
    if (!bytes) fail(404, 'База ветки потеряна');
    sendBytes(c.res, bytes!);
  });

  /** Merge a branch: the body is a Loro update for the main file. Requires edit access to the main file. */
  r.add('POST', '/api/files/:id/merge', async (c) => {
    const p = c.need();
    const { file } = await needFile(db, c.params.id!, p.user.id, 'view', c.query.get('link'));
    if (!file.parent_id) fail(400, 'Это не ветка');
    const { file: main } = await needFile(db, file.parent_id!, p.user.id, 'edit', c.query.get('link'));
    const bytes = await readBody(c.req, MAX_DOC);
    readLoro(bytes);
    await d.live.apply(main.id, bytes);
    await db.run(`UPDATE files SET merged = ?, merged_by = ? WHERE id = ?`, [Date.now(), p.user.id, file.id]);
    const event = { type: 'branch-merged', branch: { id: file.id, name: file.name }, main: { id: main.id, name: main.name }, by: p.user.name };
    d.live.event(main.id, event);
    d.live.event(file.id, event);
    d.events?.emit('BRANCH_MERGED', { fileId: main.id, by: p.user, branch: { id: file.id, name: file.name } });
    return { ok: true };
  });
}
