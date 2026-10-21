// Team files live: ws://server/file/<id>?token=…&link=… — the same protocol as rooms
// (1 — snapshot, 2 — Loro update, 3 — presence), plus 5 — server info (JSON: role,
// file name, refusal) and 6 — file events (JSON: comments). Edits (2) are accepted only with edit permission; viewers and commenters
// receive updates and send presence. The document is in storage (files/<id>/doc.loro): saved at most
// once per 2 s and when the last participant leaves. Protected pages (pageProtection on the page):
// edits to their nodes are accepted only from the file owners and the listed people — an edit
// is checked on a copy of the document (fork) via Loro events: which nodes it touches.

import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { LoroDoc, type TreeID } from 'loro-crdt';
import { atLeast, fileRole, fileRow, type FileRole } from './access.ts';
import type { Auth } from './auth.ts';
import type { Db } from './db.ts';
import { relaySignal, safeDecode, type BlobStore } from './util.ts';

export const SNAPSHOT = 1;
export const UPDATE = 2;
export const PRESENCE = 3;
export const INFO = 5;
export const EVENT = 6;
export const SIGNAL = 7;

interface Client {
  userId: string | null;
  role: FileRole;
  link: string | null;
  presenceId: string | null;
  presence: Uint8Array | null;
  alive: boolean;
}

/** A participant on the server itself (network MCP): receives edits like a connected client. */
interface Local {
  onUpdate(update: Uint8Array): void;
}

interface LiveFile {
  id: string;
  doc: LoroDoc;
  clients: Map<WebSocket, Client>;
  locals: Set<Local>;
  timer: ReturnType<typeof setTimeout> | null;
  saving?: Promise<void>;
}

const frame = (type: number, data: Uint8Array) => {
  const out = new Uint8Array(data.length + 1);
  out[0] = type;
  out.set(data, 1);
  return out;
};
const info = (o: unknown) => frame(INFO, new TextEncoder().encode(JSON.stringify(o)));

/** Protected pages a person isn't allowed to edit: page TreeID → name. */
function lockedPages(doc: LoroDoc, userId: string | null): Map<TreeID, string> {
  const out = new Map<TreeID, string>();
  for (const n of doc.getTree('nodes').roots()) {
    const p = n.data.get('pageProtection') as { editors?: string[] } | undefined;
    if (p && typeof p === 'object' && !(userId && p.editors?.includes(userId))) out.set(n.id, String(n.data.get('name') ?? 'Страница'));
  }
  return out;
}

const PROTECTION_KEY = new TextEncoder().encode('pageProtection');

/** Whether the update bytes contain the protection key name (small Loro updates store keys as is). */
function mentionsProtection(u: Uint8Array): boolean {
  outer: for (let i = 0; i + PROTECTION_KEY.length <= u.length; i++) {
    for (let j = 0; j < PROTECTION_KEY.length; j++) if (u[i + j] !== PROTECTION_KEY[j]) continue outer;
    return true;
  }
  return false;
}

/** Whether the edit needs checking on a copy: there are closed pages, the edit is large or touches protection. */
function needsCheck(doc: LoroDoc, update: Uint8Array, userId: string | null): boolean {
  return lockedPages(doc, userId).size > 0 || update.length > 65536 || mentionsProtection(update);
}

/** The node's page (top-level TreeID) in the document; no node — null. */
function pageOf(doc: LoroDoc, id: TreeID): TreeID | null {
  const tree = doc.getTree('nodes');
  if (!tree.has(id)) return null;
  let n = tree.getNodeByID(id);
  for (let p = n?.parent(); n && p; p = n.parent()) n = p;
  return n?.id ?? null;
}

/**
 * An edit from a person for whom protected pages are closed: the name of the page it touches
 * (or whose protection it changes), otherwise null. Checked on a copy of the document.
 */
function forbiddenEdit(doc: LoroDoc, update: Uint8Array, userId: string | null): string | null {
  const locked = lockedPages(doc, userId);
  const probe = doc.fork();
  const touched = new Set<TreeID>();
  let protection = false;
  const isTree = (p: unknown): p is TreeID => typeof p === 'string' && /^\d+@\d+$/.test(p);
  const unsubscribe = probe.subscribe((batch) => {
    for (const e of batch.events) {
      if (e.diff.type === 'tree') {
        for (const item of e.diff.diff) {
          touched.add(item.target);
          const it = item as { parent?: TreeID; oldParent?: TreeID };
          if (it.parent) touched.add(it.parent);
          if (it.oldParent) touched.add(it.oldParent);
        }
      } else if (e.diff.type === 'map') {
        const t = [...e.path].reverse().find(isTree);
        if (t) touched.add(t);
        if ('pageProtection' in e.diff.updated) protection = true;
      }
    }
  });
  try {
    probe.import(update);
  } finally {
    unsubscribe();
  }
  // Only owners change protection.
  if (protection) return 'защита страниц';
  if (!locked.size) return null;
  for (const id of touched) {
    // Page — from the document before the edit (a new node — from the copy with the edit).
    const page = pageOf(doc, id) ?? pageOf(probe, id);
    if (page && locked.has(page)) return locked.get(page)!;
  }
  return null;
}
export const docKey = (id: string) => `files/${id}/doc.loro`;

export class LiveFiles {
  private closing = false;
  private files = new Map<string, LiveFile>();
  private loading = new Map<string, Promise<LiveFile>>();
  private db: Db;
  private store: BlobStore;
  private auth: Auth;
  /** File change (webhooks, “changed” in the list): no more often than saving. */
  onChange: ((fileId: string) => void)[] = [];

  constructor(db: Db, store: BlobStore, auth: Auth) {
    this.db = db;
    this.store = store;
    this.auth = auth;
  }

  get open() {
    return this.files.size;
  }

  /** The file's document in memory (load if needed). */
  async load(id: string): Promise<LiveFile> {
    const ready = this.files.get(id);
    if (ready) return ready;
    let p = this.loading.get(id);
    if (!p) {
      p = (async () => {
        const doc = new LoroDoc();
        const bytes = await this.store.get(docKey(id));
        if (bytes) doc.import(bytes);
        const f: LiveFile = { id, doc, clients: new Map(), locals: new Set(), timer: null };
        this.files.set(id, f);
        return f;
      })().finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  /** Document snapshot (from memory or storage). */
  async snapshot(id: string): Promise<Uint8Array> {
    const f = this.files.get(id);
    if (f) return f.doc.export({ mode: 'snapshot' });
    return (await this.store.get(docKey(id))) ?? new LoroDoc().export({ mode: 'snapshot' });
  }

  /** An edit from the server (REST, MCP, branch merge): into the document and to all participants. */
  async apply(id: string, update: Uint8Array) {
    const f = await this.load(id);
    f.doc.import(update);
    this.broadcast(f, null, frame(UPDATE, update));
    this.scheduleSave(f);
    if (!f.clients.size && !f.locals.size) await this.save(f);
  }

  /** Write the document directly (a new file from a snapshot, restore). */
  async replace(id: string, snapshot: Uint8Array) {
    const f = this.files.get(id);
    if (f) {
      f.doc.import(snapshot);
      this.broadcast(f, null, frame(UPDATE, snapshot));
      await this.save(f);
    } else await this.store.put(docKey(id), snapshot);
  }

  /** File event (a comment, etc.) — to everyone connected to it. */
  event(fileId: string, payload: unknown) {
    const f = this.files.get(fileId);
    if (f) this.broadcast(f, null, frame(EVENT, new TextEncoder().encode(JSON.stringify(payload))));
  }

  private broadcast(f: LiveFile, from: WebSocket | null, bytes: Uint8Array, fromLocal?: Local) {
    for (const c of f.clients.keys()) if (c !== from && c.readyState === c.OPEN) c.send(bytes);
    if (bytes[0] === UPDATE) for (const l of f.locals) if (l !== fromLocal) l.onUpdate(bytes.subarray(1));
  }

  /** A participant on the server: snapshot, own edits — submit (to everyone and the file), others' — onUpdate. */
  async participant(id: string, onUpdate: (update: Uint8Array) => void): Promise<{ snapshot: Uint8Array; submit(update: Uint8Array): void; leave(): void }> {
    const f = await this.load(id);
    const local: Local = { onUpdate };
    f.locals.add(local);
    return {
      snapshot: f.doc.export({ mode: 'snapshot' }),
      submit: (u) => {
        f.doc.import(u);
        this.broadcast(f, null, frame(UPDATE, u), local);
        this.scheduleSave(f);
      },
      leave: () => {
        f.locals.delete(local);
        this.unloadIfIdle(f);
      },
    };
  }

  /** Nobody left — save and unload. */
  private unloadIfIdle(f: LiveFile) {
    if (this.closing) return;
    if (f.clients.size || f.locals.size || this.files.get(f.id) !== f) return;
    void this.save(f).then(() => {
      if (!f.timer && !f.saving && !f.clients.size && !f.locals.size && this.files.get(f.id) === f) this.files.delete(f.id);
    }).catch(e => this.retrySave(f, e));
  }

  private scheduleSave(f: LiveFile) {
    if (this.closing) return;
    f.timer ??= setTimeout(() => {
      f.timer = null;
      if (!f.clients.size && !f.locals.size) this.unloadIfIdle(f);
      else void this.save(f).catch(e => this.retrySave(f, e));
    }, 2000);
  }

  private retrySave(f: LiveFile, error: unknown) {
    console.error(`Файл ${f.id}: не удалось сохранить`, error);
    this.broadcast(f, null, info({ error: 'Не удалось сохранить на сервере. Повторяем; сохраните локальную копию файла.' }));
    this.scheduleSave(f);
  }

  private async save(f: LiveFile) {
    if (f.timer) clearTimeout(f.timer);
    f.timer = null;
    // Serialize snapshots: a slower older write must never overwrite a newer one.
    const saving = (f.saving ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.store.put(docKey(f.id), f.doc.export({ mode: 'snapshot' }));
      await this.db.run(`UPDATE files SET modified = ? WHERE id = ?`, [Date.now(), f.id]);
      for (const cb of this.onChange) cb(f.id);
    });
    f.saving = saving;
    try { await saving; } finally { if (f.saving === saving) f.saving = undefined; }
  }

  /** Participant connection (URL /file/<id>?token=…&link=…). */
  async connect(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://x');
    const id = safeDecode(url.pathname.replace(/^\/file\//, '')) ?? '';
    const principal = await this.auth.principal(url.searchParams.get('token'));
    const link = url.searchParams.get('link');
    const row = await fileRow(this.db, id);
    const role = row && !row.trashed ? await fileRole(this.db, row, principal?.user.id ?? null, link) : 'none';
    if (!row || role === 'none') {
      ws.send(info({ error: principal ? 'Нет доступа к файлу' : 'Нужно войти' }));
      ws.close(4403, 'forbidden');
      return;
    }
    const f = await this.load(id);
    const me: Client = { userId: principal?.user.id ?? null, role, link, presenceId: null, presence: null, alive: true };
    f.clients.set(ws, me);
    ws.on('pong', () => (me.alive = true));
    ws.send(info({ role, file: { id: row.id, name: row.name, parentId: row.parent_id } }));
    ws.send(frame(SNAPSHOT, f.doc.export({ mode: 'snapshot' })));
    for (const c of f.clients.values()) if (c.presence) ws.send(c.presence);
    ws.on('message', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      if (bytes[0] === UPDATE) {
        if (!atLeast(me.role, 'edit')) {
          ws.send(info({ error: 'Только просмотр: правки не сохраняются' }));
          return;
        }
        // Protected pages: edits only from owners and listed people.
        if (me.role !== 'owner') {
          let page: string | null = null;
          try {
            if (needsCheck(f.doc, bytes.subarray(1), me.userId)) page = forbiddenEdit(f.doc, bytes.subarray(1), me.userId);
          } catch (e) {
            console.error(`Файл ${id}: плохое обновление`, e);
            return;
          }
          if (page) {
            ws.send(info({ error: `Страница «${page}» защищена: правка не сохранена — откройте файл заново` }));
            return;
          }
        }
        try {
          f.doc.import(bytes.subarray(1));
        } catch (e) {
          console.error(`Файл ${id}: плохое обновление`, e);
          return;
        }
        this.broadcast(f, ws, bytes);
        this.scheduleSave(f);
      } else if (bytes[0] === PRESENCE) {
        try {
          const p = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as { id?: string; leave?: boolean };
          if (p.id) me.presenceId = p.id;
          me.presence = p.leave ? null : bytes;
        } catch {
          return;
        }
        this.broadcast(f, ws, bytes);
      } else if (bytes[0] === SIGNAL) {
        relaySignal([...f.clients].map(([w, c]) => [w, c.presenceId] as [typeof w, string | null]), me.presenceId, bytes);
      }
    });
    ws.on('close', () => {
      f.clients.delete(ws);
      if (me.presenceId) this.broadcast(f, ws, frame(PRESENCE, new TextEncoder().encode(JSON.stringify({ id: me.presenceId, leave: true }))));
      this.unloadIfIdle(f);
    });
  }

  /** Permissions changed (access, team role): recompute for connected clients, disconnect those who lost access. */
  async refresh(fileId: string) {
    const f = this.files.get(fileId);
    if (!f) return;
    const row = await fileRow(this.db, fileId);
    for (const [ws, c] of f.clients) {
      const role = row && !row.trashed ? await fileRole(this.db, row, c.userId, c.link) : 'none';
      if (role === 'none') {
        ws.send(info({ error: 'Доступ к файлу закрыт' }));
        ws.close(4403, 'forbidden');
      } else if (role !== c.role) {
        c.role = role;
        ws.send(info({ role }));
      }
    }
  }

  /** All open files (a change of team roles affects many). */
  async refreshAll() {
    for (const id of this.files.keys()) await this.refresh(id);
  }

  /** Ping: dropped connections are disconnected. */
  ping() {
    for (const f of this.files.values()) {
      for (const [ws, c] of f.clients) {
        if (!c.alive) {
          ws.terminate();
          continue;
        }
        c.alive = false;
        ws.ping();
      }
    }
  }

  async close() {
    this.closing = true;
    for (const f of this.files.values()) {
      for (const ws of f.clients.keys()) ws.terminate();
      await this.save(f);
    }
    this.files.clear();
  }
}
