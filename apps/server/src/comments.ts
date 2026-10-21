// File comments on the server: threads and replies, mentions (@ — notification and email),
// reactions, attachments, “resolved”. Participants of the open file get changes live (frame 6
// in live.ts), others — via notifications (the bell) and emails.
//
// Permissions: a viewer reads; a commenter writes, replies, reacts and resolves threads;
// the author edits and deletes their own; someone else's thread is moved by an editor and deleted by the file owner.

import { atLeast, fileRole, needFile, type FileRole, type FileRow } from './access.ts';
import type { ApiDeps } from './api.ts';
import type { User } from './auth.ts';
import type { Db } from './db.ts';
import type { Router } from './router.ts';
import { fail, newId, readBody, readJson, sendBytes } from './util.ts';

/** Thread location: page, anchor layer and a point in its coordinates (like CommentData in @mfp/core). */
export interface Place {
  page: string;
  anchor?: string | null;
  at: [number, number];
  pageAt?: [number, number];
}

interface CommentRow {
  id: string;
  file_id: string;
  thread_id: string | null;
  author_id: string;
  text: string;
  mentions: string | null;
  place: string | null;
  created: number;
  edited: number | null;
  resolved: number | null;
  resolved_by: string | null;
}

export interface CommentView {
  id: string;
  thread: string | null;
  author: { id: string; name: string; color: string };
  text: string;
  mentions: { id: string; name: string }[];
  place: Place | null;
  created: number;
  edited: number | null;
  resolved: number | null;
  reactions: { emoji: string; users: { id: string; name: string }[] }[];
  attachments: { id: string; name: string; type: string; size: number }[];
}

const MAX_TEXT = 10_000;
const MAX_ATTACHMENT = 20 * 2 ** 20;
/** Only images are shown directly in the browser; everything else (including SVG) is downloaded. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const attKey = (fileId: string, id: string) => `files/${fileId}/attachments/${id}`;

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]) ? [v[0] as number, v[1] as number] : null);

function readPlace(v: unknown): Place {
  const p = v as Partial<Place> | null;
  const at = point(p?.at);
  if (!p || typeof p.page !== 'string' || !p.page || !at) fail(400, 'Нужно место треда: page и at');
  const pageAt = point(p!.pageAt);
  return { page: p!.page!, anchor: typeof p!.anchor === 'string' ? p!.anchor : null, at: at!, ...(pageAt ? { pageAt } : {}) };
}

/** Who can see the file (for mentions): owner, personal access, the project team. */
export async function filePeople(db: Db, f: FileRow): Promise<(User & { role: FileRole })[]> {
  const rows = await db.all<User>(
    `SELECT DISTINCT u.* FROM users u
     LEFT JOIN file_access a ON a.user_id = u.id AND a.file_id = ?
     LEFT JOIN projects pr ON pr.id = ?
     LEFT JOIN team_members m ON m.user_id = u.id AND m.team_id = pr.team_id
     WHERE u.disabled = 0 AND (u.id = ? OR a.user_id IS NOT NULL OR m.user_id IS NOT NULL)
     ORDER BY u.name`,
    [f.id, f.project_id, f.owner_id],
  );
  return Promise.all(rows.map(async (u) => ({ ...u, role: await fileRole(db, f, u.id) })));
}

/** Notification for a user (the bell); the email is up to the caller. */
export async function notify(db: Db, n: { userId: string; kind: string; fileId?: string | null; threadId?: string | null; commentId?: string | null; actorId?: string | null; text?: string | null }) {
  await db.run(`INSERT INTO notifications (id, user_id, kind, file_id, thread_id, comment_id, actor_id, text, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    newId(),
    n.userId,
    n.kind,
    n.fileId ?? null,
    n.threadId ?? null,
    n.commentId ?? null,
    n.actorId ?? null,
    n.text ?? null,
    Date.now(),
  ]);
}

export function registerComments(r: Router, d: ApiDeps) {
  const { db } = d;

  /** Comments in client form (with authors, reactions, attachments). */
  const views = async (rows: CommentRow[]): Promise<CommentView[]> => {
    if (!rows.length) return [];
    const ids = rows.map((c) => c.id);
    const marks = ids.map(() => '?').join(',');
    const reactions = await db.all<{ comment_id: string; emoji: string; user_id: string; name: string }>(
      `SELECT r.comment_id, r.emoji, r.user_id, u.name FROM comment_reactions r JOIN users u ON u.id = r.user_id WHERE r.comment_id IN (${marks}) ORDER BY r.created`,
      ids,
    );
    const files = await db.all<{ id: string; comment_id: string; name: string; type: string; size: number }>(`SELECT id, comment_id, name, type, size FROM attachments WHERE comment_id IN (${marks}) ORDER BY created`, ids);
    const userIds = new Set<string>();
    for (const c of rows) {
      userIds.add(c.author_id);
      for (const m of JSON.parse(c.mentions ?? '[]') as string[]) userIds.add(m);
    }
    const users = new Map<string, User>();
    const list = [...userIds];
    if (list.length) for (const u of await db.all<User>(`SELECT * FROM users WHERE id IN (${list.map(() => '?').join(',')})`, list)) users.set(u.id, u);
    return rows.map((c) => {
      const a = users.get(c.author_id);
      const byEmoji = new Map<string, { id: string; name: string }[]>();
      for (const x of reactions) if (x.comment_id === c.id) byEmoji.set(x.emoji, [...(byEmoji.get(x.emoji) ?? []), { id: x.user_id, name: x.name }]);
      return {
        id: c.id,
        thread: c.thread_id,
        author: { id: c.author_id, name: a?.name ?? 'Удалённый пользователь', color: a?.color ?? '#888888' },
        text: c.text,
        mentions: (JSON.parse(c.mentions ?? '[]') as string[]).map((id) => ({ id, name: users.get(id)?.name ?? '' })).filter((m) => m.name),
        place: c.place ? (JSON.parse(c.place) as Place) : null,
        created: c.created,
        edited: c.edited,
        resolved: c.resolved,
        reactions: [...byEmoji].map(([emoji, us]) => ({ emoji, users: us })),
        attachments: files.filter((f) => f.comment_id === c.id).map(({ id, name, type, size }) => ({ id, name, type, size })),
      };
    });
  };
  const one = async (id: string) => (await views(await db.all<CommentRow>(`SELECT * FROM comments WHERE id = ?`, [id])))[0]!;
  const row = async (id: string) => {
    const c = await db.get<CommentRow>(`SELECT * FROM comments WHERE id = ?`, [id]);
    if (!c) fail(404, 'Нет такого комментария');
    return c!;
  };
  /** Mentioned — only those who can see the file. */
  const allowedMentions = async (f: FileRow, v: unknown): Promise<string[]> => {
    if (!Array.isArray(v)) return [];
    const want = new Set(v.filter((x): x is string => typeof x === 'string').slice(0, 50));
    const out: string[] = [];
    for (const id of want) if ((await fileRole(db, f, id)) !== 'none') out.push(id);
    return out;
  };
  const mail = async (userId: string, subject: string, text: string) => {
    const u = await db.get<User>(`SELECT * FROM users WHERE id = ?`, [userId]);
    if (u && !u.disabled) await d.mailer.send({ to: u.email, subject, text }).catch((e) => console.error('Письмо не ушло', e));
  };
  const link = (f: FileRow, thread: string) => `${d.appUrl}#file=${f.id}&comment=${thread}`;
  const snippet = (t: string) => (t.length > 140 ? `${t.slice(0, 140)}…` : t);
  /** Mentions and replies — notifications and emails (not to oneself). */
  const announce = async (f: FileRow, actor: User, c: { id: string; thread: string; text: string }, mentioned: string[], replyTo: string[]) => {
    const done = new Set([actor.id]);
    for (const uid of mentioned) {
      if (done.has(uid)) continue;
      done.add(uid);
      await notify(db, { userId: uid, kind: 'mention', fileId: f.id, threadId: c.thread, commentId: c.id, actorId: actor.id, text: snippet(c.text) });
      await mail(uid, `${actor.name}: упоминание в «${f.name}»`, `${actor.name} упоминает вас в комментарии к «${f.name}»:\n\n${c.text}\n\nОткрыть: ${link(f, c.thread)}`);
    }
    for (const uid of replyTo) {
      if (done.has(uid)) continue;
      done.add(uid);
      await notify(db, { userId: uid, kind: 'reply', fileId: f.id, threadId: c.thread, commentId: c.id, actorId: actor.id, text: snippet(c.text) });
      await mail(uid, `${actor.name}: ответ в «${f.name}»`, `${actor.name} ответил(а) в треде, где вы участвуете («${f.name}»):\n\n${c.text}\n\nОткрыть: ${link(f, c.thread)}`);
    }
  };
  const broadcast = (fileId: string, event: unknown) => d.live.event(fileId, event);

  // ---------- Threads and replies ----------

  r.add('GET', '/api/files/:id/comments', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.principal?.user.id ?? null, 'view', c.query.get('link'));
    return { comments: await views(await db.all<CommentRow>(`SELECT * FROM comments WHERE file_id = ? ORDER BY created`, [file.id])) };
  });

  /** Who can be mentioned: everyone who can see the file. */
  r.add('GET', '/api/files/:id/people', async (c) => {
    const { file } = await needFile(db, c.params.id!, c.need().user.id, 'comment', c.query.get('link'));
    return { people: (await filePeople(db, file)).map((u) => ({ id: u.id, name: u.name, email: u.email, color: u.color })) };
  });

  /** New comment: a thread (with location) or a reply; mentions, attachments, notifications, event. Permissions — checked by the caller. */
  const create = async (file: FileRow, user: User, b: { text?: unknown; place?: unknown; thread?: unknown; mentions?: unknown; attachments?: unknown }): Promise<CommentView> => {
    const text = typeof b.text === 'string' ? b.text.trim().slice(0, MAX_TEXT) : '';
    const attachments = Array.isArray(b.attachments) ? b.attachments.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
    if (!text && !attachments.length) fail(400, 'Пустой комментарий');
    let thread: CommentRow | null = null;
    if (typeof b.thread === 'string') {
      thread = await row(b.thread);
      if (thread.file_id !== file.id || thread.thread_id) fail(400, 'Отвечать можно только в тред этого файла');
    }
    const place = thread ? null : readPlace(b.place);
    const mentions = await allowedMentions(file, b.mentions);
    const id = newId();
    await db.tx(async () => {
      await db.run(`INSERT INTO comments (id, file_id, thread_id, author_id, text, mentions, place, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        id,
        file.id,
        thread?.id ?? null,
        user.id,
        text,
        mentions.length ? JSON.stringify(mentions) : null,
        place ? JSON.stringify(place) : null,
        Date.now(),
      ]);
      for (const a of attachments) await db.run(`UPDATE attachments SET comment_id = ? WHERE id = ? AND file_id = ? AND owner_id = ? AND comment_id IS NULL`, [id, a, file.id, user.id]);
    });
    // A reply — to the thread's participants (authors and those mentioned in it).
    const participants: string[] = [];
    if (thread) {
      for (const x of await db.all<{ author_id: string; mentions: string | null }>(`SELECT author_id, mentions FROM comments WHERE id = ? OR thread_id = ?`, [thread.id, thread.id])) {
        participants.push(x.author_id, ...(JSON.parse(x.mentions ?? '[]') as string[]));
      }
    }
    const view = await one(id);
    await announce(file, user, { id, thread: thread?.id ?? id, text }, mentions, [...new Set(participants)]);
    broadcast(file.id, { type: 'comment', comment: view });
    d.events?.emit('FILE_COMMENT', { fileId: file.id, by: user, comment: view });
    return view;
  };
  d.comments = {
    create,
    list: async (fileId) => views(await db.all<CommentRow>(`SELECT * FROM comments WHERE file_id = ? ORDER BY created`, [fileId])),
  };

  r.add('POST', '/api/files/:id/comments', async (c) => {
    const p = c.need();
    const { file } = await needFile(db, c.params.id!, p.user.id, 'comment', c.query.get('link'));
    return create(file, p.user, await readJson(c.req));
  });

  r.add('PATCH', '/api/comments/:id', async (c) => {
    const p = c.need();
    const cm = await row(c.params.id!);
    const { file, role } = await needFile(db, cm.file_id, p.user.id, 'comment', c.query.get('link'));
    const b = await readJson(c.req);
    const mine = cm.author_id === p.user.id;
    if (b.text !== undefined) {
      if (!mine) fail(403, 'Править можно только свой комментарий');
      const text = typeof b.text === 'string' ? b.text.trim().slice(0, MAX_TEXT) : '';
      if (!text) fail(400, 'Пустой комментарий');
      const before = new Set(JSON.parse(cm.mentions ?? '[]') as string[]);
      const mentions = await allowedMentions(file, b.mentions);
      await db.run(`UPDATE comments SET text = ?, mentions = ?, edited = ? WHERE id = ?`, [text, mentions.length ? JSON.stringify(mentions) : null, Date.now(), cm.id]);
      // New mentions — with a notification.
      await announce(file, p.user, { id: cm.id, thread: cm.thread_id ?? cm.id, text }, mentions.filter((m) => !before.has(m)), []);
    }
    if (b.place !== undefined) {
      if (cm.thread_id) fail(400, 'Переносят тред, а не ответ');
      if (!mine && !atLeast(role, 'edit')) fail(403, 'Переносить чужой тред может редактор файла');
      await db.run(`UPDATE comments SET place = ? WHERE id = ?`, [JSON.stringify(readPlace(b.place)), cm.id]);
    }
    if (b.resolved !== undefined) {
      if (cm.thread_id) fail(400, 'Решают тред, а не ответ');
      await db.run(`UPDATE comments SET resolved = ?, resolved_by = ? WHERE id = ?`, b.resolved ? [Date.now(), p.user.id, cm.id] : [null, null, cm.id]);
    }
    const view = await one(cm.id);
    broadcast(file.id, { type: 'comment', comment: view });
    return view;
  });

  r.add('DELETE', '/api/comments/:id', async (c) => {
    const p = c.need();
    const cm = await row(c.params.id!);
    const { file, role } = await needFile(db, cm.file_id, p.user.id, 'comment', c.query.get('link'));
    if (cm.author_id !== p.user.id && !atLeast(role, 'owner')) fail(403, 'Удалить можно свой комментарий (чужие — владелец файла)');
    const gone = await db.all<{ id: string }>(`SELECT a.id FROM attachments a JOIN comments c ON c.id = a.comment_id WHERE c.id = ? OR c.thread_id = ?`, [cm.id, cm.id]);
    await db.run(`DELETE FROM comments WHERE id = ?`, [cm.id]);
    for (const a of gone) await d.store.delete(attKey(file.id, a.id));
    broadcast(file.id, { type: 'comment-deleted', id: cm.id, thread: cm.thread_id });
  });

  /** Reaction: {emoji, on}. */
  r.add('PUT', '/api/comments/:id/reactions', async (c) => {
    const p = c.need();
    const cm = await row(c.params.id!);
    const { file } = await needFile(db, cm.file_id, p.user.id, 'comment', c.query.get('link'));
    const b = await readJson(c.req);
    const emoji = typeof b.emoji === 'string' ? b.emoji.trim() : '';
    if (!emoji || emoji.length > 16) fail(400, 'Нужна реакция (эмодзи)');
    if (b.on === false) await db.run(`DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?`, [cm.id, p.user.id, emoji]);
    else await db.run(`INSERT INTO comment_reactions (comment_id, user_id, emoji, created) VALUES (?, ?, ?, ?) ON CONFLICT (comment_id, user_id, emoji) DO NOTHING`, [cm.id, p.user.id, emoji, Date.now()]);
    const view = await one(cm.id);
    broadcast(file.id, { type: 'comment', comment: view });
    return view;
  });

  // ---------- Attachments ----------

  /** Attachment (body — file bytes, ?name=&type=): linked to a comment when it is sent. */
  r.add('POST', '/api/files/:id/attachments', async (c) => {
    const p = c.need();
    const { file } = await needFile(db, c.params.id!, p.user.id, 'comment', c.query.get('link'));
    const bytes = await readBody(c.req, MAX_ATTACHMENT);
    if (!bytes.length) fail(400, 'Пустой файл');
    const name = (c.query.get('name') ?? 'файл').replace(/[\\/\0]/g, '_').slice(0, 200) || 'файл';
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(c.query.get('type') ?? '') ? c.query.get('type')! : 'application/octet-stream';
    const id = newId();
    await d.store.put(attKey(file.id, id), bytes);
    await db.run(`INSERT INTO attachments (id, file_id, owner_id, name, type, size, created) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, file.id, p.user.id, name, type, bytes.length, Date.now()]);
    return { id, name, type, size: bytes.length };
  });

  r.add('GET', '/api/attachments/:id', async (c) => {
    const a = await db.get<{ id: string; file_id: string; name: string; type: string }>(`SELECT id, file_id, name, type FROM attachments WHERE id = ?`, [c.params.id]);
    if (!a) fail(404, 'Нет такого вложения');
    await needFile(db, a!.file_id, c.principal?.user.id ?? null, 'view', c.query.get('link'));
    const bytes = await d.store.get(attKey(a!.file_id, a!.id));
    if (!bytes) fail(404, 'Вложение потеряно');
    // Third-party files are never executed: only images are shown, everything else is downloaded.
    c.res.setHeader('x-content-type-options', 'nosniff');
    c.res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    c.res.setHeader('content-disposition', `${INLINE.has(a!.type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a!.name)}`);
    sendBytes(c.res, bytes!, INLINE.has(a!.type) ? a!.type : 'application/octet-stream', 'private, max-age=3600');
  });

  // ---------- Notifications ----------

  r.add('GET', '/api/notifications', async (c) => {
    const p = c.need();
    const rows = await db.all<{ id: string; kind: string; file_id: string | null; file_name: string | null; thread_id: string | null; comment_id: string | null; actor_name: string | null; actor_color: string | null; text: string | null; created: number; read: number | null }>(
      `SELECT n.*, f.name AS file_name, u.name AS actor_name, u.color AS actor_color
       FROM notifications n LEFT JOIN files f ON f.id = n.file_id LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ? ORDER BY n.created DESC LIMIT 50`,
      [p.user.id],
    );
    const unread = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read IS NULL`, [p.user.id]);
    return {
      unread: unread?.n ?? 0,
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        file: n.file_id ? { id: n.file_id, name: n.file_name ?? '' } : null,
        thread: n.thread_id,
        comment: n.comment_id,
        actor: n.actor_name ? { name: n.actor_name, color: n.actor_color ?? '#888888' } : null,
        text: n.text,
        created: n.created,
        read: n.read,
      })),
    };
  });

  /** Mark as read: {ids} or all. */
  r.add('POST', '/api/notifications/read', async (c) => {
    const p = c.need();
    const b = await readJson(c.req);
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : null;
    if (ids?.length) await db.run(`UPDATE notifications SET read = ? WHERE user_id = ? AND read IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [Date.now(), p.user.id, ...ids]);
    else if (!ids) await db.run(`UPDATE notifications SET read = ? WHERE user_id = ? AND read IS NULL`, [Date.now(), p.user.id]);
  });
}
