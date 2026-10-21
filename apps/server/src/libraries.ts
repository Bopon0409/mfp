// Team libraries: a file publishes its components, styles and variables —
// a version (document snapshot) and a list of assets. Team files add the library (import —
// on the client, @mfp/core importLibrary), see new versions and report how many instances of which
// components they have — hence usage statistics for library authors.

import { atLeast, fileRole, fileRow, needFile, type FileRow } from './access.ts';
import type { ApiDeps } from './api.ts';
import type { Router } from './router.ts';
import { fail, readJson, sendBytes, str } from './util.ts';

interface LibraryRow {
  file_id: string;
  name: string;
  description: string | null;
  version: number;
  published: number;
  published_by: string | null;
  assets: string;
}

interface Asset {
  key: string;
  name: string;
  type: string;
}

const snapKey = (id: string, version: number) => `files/${id}/library/${version}.loro`;

export function registerLibraries(r: Router, d: ApiDeps) {
  const { db } = d;

  const view = async (l: LibraryRow, f?: FileRow) => {
    const file = f ?? (await fileRow(db, l.file_id));
    const team = file?.project_id ? await db.get<{ name: string }>(`SELECT t.name FROM teams t JOIN projects p ON p.team_id = t.id WHERE p.id = ?`, [file.project_id]) : null;
    const by = l.published_by ? await db.get<{ name: string }>(`SELECT name FROM users WHERE id = ?`, [l.published_by]) : null;
    const assets = JSON.parse(l.assets) as Asset[];
    return {
      id: l.file_id,
      name: l.name,
      description: l.description,
      version: l.version,
      published: l.published,
      publishedBy: by?.name ?? null,
      fileName: file?.name ?? '',
      teamName: team?.name ?? null,
      counts: {
        components: assets.filter((a) => a.type === 'COMPONENT' || a.type === 'COMPONENT_SET').length,
        styles: assets.filter((a) => a.type === 'STYLE').length,
        variables: assets.filter((a) => a.type === 'VARIABLE').length,
      },
      assets,
    };
  };

  /** Publish (or a new version): {name, description, assets}. The snapshot is the current document. */
  r.add('POST', '/api/files/:id/publish', async (c) => {
    const p = c.need();
    const { file } = await needFile(db, c.params.id!, p.user.id, 'edit');
    if (file.parent_id) fail(400, 'Публикуют основной файл, а не ветку');
    const b = await readJson(c.req);
    const name = str(b.name ?? file.name, 'name', 200);
    const description = typeof b.description === 'string' ? b.description.trim().slice(0, 2000) : '';
    const assets = (Array.isArray(b.assets) ? b.assets : [])
      .filter((a): a is Asset => !!a && typeof (a as Asset).key === 'string' && typeof (a as Asset).name === 'string' && typeof (a as Asset).type === 'string')
      .slice(0, 20_000)
      .map((a) => ({ key: a.key.slice(0, 200), name: a.name.slice(0, 200), type: a.type.slice(0, 40) }));
    if (!assets.length) fail(400, 'Публиковать нечего: в файле нет компонентов, стилей и переменных');
    const prev = await db.get<LibraryRow>(`SELECT * FROM libraries WHERE file_id = ?`, [file.id]);
    const version = (prev?.version ?? 0) + 1;
    await d.store.put(snapKey(file.id, version), await d.live.snapshot(file.id));
    await db.run(
      `INSERT INTO libraries (file_id, name, description, version, published, published_by, assets) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (file_id) DO UPDATE SET name = excluded.name, description = excluded.description, version = excluded.version, published = excluded.published, published_by = excluded.published_by, assets = excluded.assets`,
      [file.id, name, description || null, version, Date.now(), p.user.id, JSON.stringify(assets)],
    );
    d.events?.emit('LIBRARY_PUBLISH', { fileId: file.id, by: p.user, library: { name, version, description: description || null } });
    return view((await db.get<LibraryRow>(`SELECT * FROM libraries WHERE file_id = ?`, [file.id]))!, file);
  });

  /** Unpublish (what others have added stays as their own assets). */
  r.add('DELETE', '/api/files/:id/publish', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'owner');
    await db.run(`DELETE FROM libraries WHERE file_id = ?`, [file.id]);
    await d.store.delete(`files/${file.id}/library`);
  });

  /** The file's library (if published). */
  r.add('GET', '/api/files/:id/library', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'view');
    const l = await db.get<LibraryRow>(`SELECT * FROM libraries WHERE file_id = ?`, [file.id]);
    return { library: l ? await view(l, file) : null };
  });

  /** Libraries available to the user (files they can see). */
  r.add('GET', '/api/libraries', async (c) => {
    const p = c.need();
    const rows = await db.all<LibraryRow & { f_trashed: number | null }>(`SELECT l.*, f.trashed AS f_trashed FROM libraries l JOIN files f ON f.id = l.file_id WHERE f.trashed IS NULL ORDER BY l.name`);
    const out = [];
    for (const l of rows) {
      const f = await fileRow(db, l.file_id);
      if (f && (await fileRole(db, f, p.user.id)) !== 'none') out.push(await view(l, f));
    }
    return { libraries: out.map(({ assets: _a, ...rest }) => rest) };
  });

  /** Version contents (Loro snapshot) — for adding and updating. */
  r.add('GET', '/api/libraries/:id/content', async (c) => {
    const p = c.need();
    const { file } = await needFile(db, c.params.id!, p.user.id, 'view');
    const l = await db.get<LibraryRow>(`SELECT * FROM libraries WHERE file_id = ?`, [file.id]);
    if (!l) fail(404, 'Файл не опубликован как библиотека');
    const version = Number(c.query.get('version') ?? l!.version);
    const bytes = await d.store.get(snapKey(file.id, version));
    if (!bytes) fail(404, 'Нет такой версии');
    c.res.setHeader('x-library-version', String(version));
    sendBytes(c.res, bytes!);
  });

  /** A subscriber reports usage: {fileId, version, counts: {key: instances}}. */
  r.add('POST', '/api/libraries/:id/usage', async (c) => {
    const p = c.need();
    const { file: lib } = await needFile(db, c.params.id!, p.user.id, 'view');
    const b = await readJson(c.req);
    if (typeof b.fileId !== 'string') fail(400, 'Нужен fileId');
    const { file, role } = await needFile(db, b.fileId as string, p.user.id, 'view');
    if (!atLeast(role, 'comment')) fail(403, 'Недостаточно прав у файла');
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries((b.counts ?? {}) as Record<string, unknown>).slice(0, 20_000)) if (typeof v === 'number' && v >= 0) counts[k.slice(0, 200)] = Math.floor(v);
    await db.run(
      `INSERT INTO library_usage (library_id, file_id, version, counts, updated) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (library_id, file_id) DO UPDATE SET version = excluded.version, counts = excluded.counts, updated = excluded.updated`,
      [lib.id, file.id, Number(b.version) || 0, JSON.stringify(counts), Date.now()],
    );
  });

  /** A file removed the library. */
  r.add('DELETE', '/api/libraries/:id/usage', async (c) => {
    const p = c.need();
    const fileId = c.query.get('fileId') ?? '';
    await needFile(db, fileId, p.user.id, 'comment');
    await db.run(`DELETE FROM library_usage WHERE library_id = ? AND file_id = ?`, [c.params.id, fileId]);
  });

  /** Where it is used: files (that the requester can see) and instances per component. */
  r.add('GET', '/api/libraries/:id/usage', async (c) => {
    const p = c.need();
    const { file } = await needFile(db, c.params.id!, p.user.id, 'view');
    const l = await db.get<LibraryRow>(`SELECT * FROM libraries WHERE file_id = ?`, [file.id]);
    if (!l) fail(404, 'Файл не опубликован как библиотека');
    const rows = await db.all<{ file_id: string; version: number; counts: string; updated: number; name: string }>(
      `SELECT u.file_id, u.version, u.counts, u.updated, f.name FROM library_usage u JOIN files f ON f.id = u.file_id WHERE u.library_id = ? AND f.trashed IS NULL ORDER BY u.updated DESC`,
      [file.id],
    );
    const totals = new Map<string, { instances: number; files: number }>();
    const files = [];
    let hidden = 0;
    for (const u of rows) {
      const counts = JSON.parse(u.counts) as Record<string, number>;
      for (const [k, n] of Object.entries(counts)) {
        const t = totals.get(k) ?? { instances: 0, files: 0 };
        t.instances += n;
        if (n) t.files++;
        totals.set(k, t);
      }
      const f = await fileRow(db, u.file_id);
      // Others' files — only in totals, without names.
      if (f && (await fileRole(db, f, p.user.id)) !== 'none') files.push({ id: u.file_id, name: u.name, version: u.version, instances: Object.values(counts).reduce((a, b) => a + b, 0), updated: u.updated });
      else hidden++;
    }
    const names = new Map((JSON.parse(l!.assets) as Asset[]).map((a) => [a.key, a]));
    return {
      version: l!.version,
      files,
      hiddenFiles: hidden,
      components: [...totals]
        .map(([key, t]) => ({ key, name: names.get(key)?.name ?? key, ...t }))
        .sort((a, b) => b.instances - a.instances),
    };
  });
}
