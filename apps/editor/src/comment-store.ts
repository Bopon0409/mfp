// Comment source for the interface (comments-ui.ts). For a file on this device — COMMENT
// nodes in the document itself (@mfp/core), for a file on a server — the server: REST, and others' edits —
// as WebSocket events (collab.ts, frame 6). Mentions, reactions and attachments — server only.

import {
  addCommentReply,
  addCommentThread,
  commentPages,
  commentPlace,
  commentReplies,
  commentThreads,
  deleteComment,
  editComment,
  moveThread,
  resolveThread,
  type CommentPlace,
  type Document,
  type Op,
} from '@mfp/core';
import { canComment, canEdit, type Account, type FileRole } from './account.ts';

export interface Person {
  id: string;
  name: string;
  email?: string;
  color: string;
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface CommentItem {
  id: string;
  /** Thread of a reply (null — the thread itself). */
  thread: string | null;
  author: { id?: string; name: string; color: string };
  text: string;
  mentions: { id: string; name: string }[];
  created: number;
  edited: number | null;
  resolved: boolean;
  place: CommentPlace | null;
  reactions: { emoji: string; users: { id: string; name: string }[] }[];
  attachments: Attachment[];
}

export interface CommentExtra {
  mentions?: string[];
  attachments?: string[];
}

export interface CommentStore {
  readonly kind: 'local' | 'server';
  readonly doc: Document;
  /** Loading (server): no threads until it finishes. */
  readonly ready: Promise<void>;
  /** Write: new threads, replies, reactions, “resolved”. */
  canWrite(): boolean;
  /** Own — editable. */
  mine(c: CommentItem): boolean;
  canDelete(c: CommentItem): boolean;
  canMove(c: CommentItem): boolean;
  /** Threads — by creation time. */
  threads(): CommentItem[];
  replies(thread: string): CommentItem[];
  get(id: string): CommentItem | undefined;
  create(page: string, point: [number, number], anchor: string | null, text: string, extra?: CommentExtra): Promise<string>;
  reply(thread: string, text: string, extra?: CommentExtra): Promise<string>;
  edit(id: string, text: string, mentions?: string[]): Promise<void>;
  remove(id: string): Promise<void>;
  resolve(thread: string, on: boolean): Promise<void>;
  move(thread: string, page: string, point: [number, number], anchor: string | null): Promise<void>;
  react?(id: string, emoji: string, on: boolean): Promise<void>;
  upload?(file: Blob, name: string): Promise<Attachment>;
  attachmentUrl?(a: Attachment): Promise<string>;
  people?(): Promise<Person[]>;
  /** Jira issue from a thread (team integration). */
  jira?(thread: string): Promise<{ key: string; url: string }>;
  /** Who I am (reactions: whether it's mine). */
  me(): string | null;
  onChange: (() => void)[];
  dispose(): void;
}

const PALETTE = ['#f45a56', '#4d7bfd', '#40c786', '#ba82f5', '#ffb848', '#e0609a', '#2fb3b8'];
/** Color of an author without an account — by name: the same name always gets the same color. */
export function authorColor(name: string): string {
  let x = 0;
  for (const ch of name) x = (x * 31 + ch.codePointAt(0)!) | 0;
  return PALETTE[Math.abs(x) % PALETTE.length]!;
}

/** Comments in the document (file on this device, room): the author is the participant's name. */
export class LocalCommentStore implements CommentStore {
  readonly kind = 'local';
  readonly doc: Document;
  readonly ready = Promise.resolve();
  onChange: (() => void)[] = [];
  private name: () => string;
  /** Comment nodes: they show that an edit concerns comments. */
  private known = new Set<string>();
  private off: () => void;

  constructor(doc: Document, name: () => string) {
    this.doc = doc;
    this.name = name;
    this.refreshKnown();
    this.off = doc.onChange((ops: Op[]) => {
      if (!ops.some((o) => (o.op === 'create' ? o.type === 'COMMENT' || o.type === 'PAGE' : 'id' in o && this.known.has(o.id)))) return;
      this.refreshKnown();
      for (const cb of this.onChange) cb();
    });
  }

  private refreshKnown() {
    this.known = new Set();
    for (const p of commentPages(this.doc)) for (const id of this.doc.descendants(p)) this.known.add(id);
  }

  private item(id: string): CommentItem | undefined {
    const doc = this.doc;
    const c = doc.type(id) === 'COMMENT' ? doc.get(id, 'comment') : undefined;
    if (!c) return undefined;
    const parent = doc.parent(id);
    const thread = parent && doc.type(parent) === 'COMMENT' ? parent : null;
    return {
      id,
      thread,
      author: { name: c.author, color: c.color ?? authorColor(c.author) },
      text: c.text,
      mentions: [],
      created: c.created,
      edited: c.edited ?? null,
      resolved: !!c.resolved,
      place: thread ? null : { page: c.page, anchor: c.anchor, at: c.at, pageAt: c.pageAt },
      reactions: [],
      attachments: [],
    };
  }

  me() {
    return null;
  }
  canWrite() {
    return true;
  }
  mine(c: CommentItem) {
    return c.author.name === this.name();
  }
  /** Anyone can delete a thread (as before, without accounts), a reply — its author. */
  canDelete(c: CommentItem) {
    return !c.thread || this.mine(c);
  }
  canMove() {
    return true;
  }
  threads() {
    return commentThreads(this.doc)
      .map((id) => this.item(id))
      .filter((c): c is CommentItem => !!c);
  }
  replies(thread: string) {
    return commentReplies(this.doc, thread)
      .map((id) => this.item(id))
      .filter((c): c is CommentItem => !!c);
  }
  get(id: string) {
    return this.doc.has(id) ? this.item(id) : undefined;
  }
  async create(page: string, point: [number, number], anchor: string | null, text: string) {
    const author = this.name();
    return addCommentThread(this.doc, page, point, anchor, { author, color: authorColor(author), text });
  }
  async reply(thread: string, text: string) {
    const author = this.name();
    return addCommentReply(this.doc, thread, { author, color: authorColor(author), text });
  }
  async edit(id: string, text: string) {
    editComment(this.doc, id, text);
  }
  async remove(id: string) {
    deleteComment(this.doc, id);
  }
  async resolve(thread: string, on: boolean) {
    resolveThread(this.doc, thread, on);
  }
  async move(thread: string, page: string, point: [number, number], anchor: string | null) {
    moveThread(this.doc, thread, page, point, anchor);
  }
  dispose() {
    this.off();
  }
}

/** A comment as the server returns it (apps/server/src/comments.ts). */
interface ServerComment {
  id: string;
  thread: string | null;
  author: { id: string; name: string; color: string };
  text: string;
  mentions: { id: string; name: string }[];
  place: CommentPlace | null;
  created: number;
  edited: number | null;
  resolved: number | null;
  reactions: { emoji: string; users: { id: string; name: string }[] }[];
  attachments: Attachment[];
}

export type CommentEvent = { type: 'comment'; comment: ServerComment } | { type: 'comment-deleted'; id: string; thread: string | null };

/** Comments of a file on the server. */
export class ServerCommentStore implements CommentStore {
  readonly kind = 'server';
  readonly doc: Document;
  ready: Promise<void>;
  onChange: (() => void)[] = [];
  private items = new Map<string, CommentItem>();
  private account: Account;
  private fileId: string;
  private link: string | null;
  private role: () => FileRole | null;
  private urls = new Map<string, Promise<string>>();
  private peopleList: Promise<Person[]> | null = null;
  private disposed = false;

  constructor(account: Account, fileId: string, link: string | null, doc: Document, role: () => FileRole | null) {
    this.account = account;
    this.fileId = fileId;
    this.link = link;
    this.doc = doc;
    this.role = role;
    this.ready = this.load();
  }

  /** API address with the link token (if the file was opened via a link). */
  private url(path: string, params: Record<string, string> = {}) {
    const q = new URLSearchParams(params);
    if (this.link) q.set('link', this.link);
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  }

  private emit() {
    if (!this.disposed) for (const cb of this.onChange) cb();
  }

  /** All comments from the server (on open and after reconnecting: events may have been lost). */
  async load() {
    try {
      const r = await this.account.api<{ comments: ServerComment[] }>('GET', this.url(`/api/files/${this.fileId}/comments`));
      this.items = new Map(r.comments.map((c) => [c.id, this.toItem(c)]));
    } catch (e) {
      console.warn('Комментарии не загрузились', e);
    }
    this.emit();
  }

  /** Event from the server: a comment was added, changed or deleted. */
  event(e: CommentEvent) {
    if (e.type === 'comment') this.items.set(e.comment.id, this.toItem(e.comment));
    else if (e.type === 'comment-deleted') {
      this.items.delete(e.id);
      for (const [id, c] of this.items) if (c.thread === e.id) this.items.delete(id);
    }
    this.emit();
  }

  private toItem(c: ServerComment): CommentItem {
    return { ...c, resolved: c.resolved != null };
  }

  private upsert(c: ServerComment): string {
    this.items.set(c.id, this.toItem(c));
    this.emit();
    return c.id;
  }

  me() {
    return this.account.user?.id ?? null;
  }
  canWrite() {
    return this.account.signedIn && canComment(this.role());
  }
  mine(c: CommentItem) {
    return !!this.account.user && c.author.id === this.account.user.id;
  }
  canDelete(c: CommentItem) {
    return this.mine(c) || this.role() === 'owner';
  }
  canMove(c: CommentItem) {
    return this.mine(c) || canEdit(this.role());
  }
  threads() {
    return [...this.items.values()].filter((c) => !c.thread).sort((a, b) => a.created - b.created);
  }
  replies(thread: string) {
    return [...this.items.values()].filter((c) => c.thread === thread).sort((a, b) => a.created - b.created);
  }
  get(id: string) {
    return this.items.get(id);
  }
  async create(page: string, point: [number, number], anchor: string | null, text: string, extra: CommentExtra = {}) {
    const place = commentPlace(this.doc, page, point, anchor);
    return this.upsert(await this.account.api<ServerComment>('POST', this.url(`/api/files/${this.fileId}/comments`), { text, place, ...extra }));
  }
  async reply(thread: string, text: string, extra: CommentExtra = {}) {
    return this.upsert(await this.account.api<ServerComment>('POST', this.url(`/api/files/${this.fileId}/comments`), { text, thread, ...extra }));
  }
  async edit(id: string, text: string, mentions: string[] = []) {
    this.upsert(await this.account.api<ServerComment>('PATCH', this.url(`/api/comments/${id}`), { text, mentions }));
  }
  async remove(id: string) {
    await this.account.api('DELETE', this.url(`/api/comments/${id}`));
    this.event({ type: 'comment-deleted', id, thread: this.items.get(id)?.thread ?? null });
  }
  async resolve(thread: string, on: boolean) {
    this.upsert(await this.account.api<ServerComment>('PATCH', this.url(`/api/comments/${thread}`), { resolved: on }));
  }
  async move(thread: string, page: string, point: [number, number], anchor: string | null) {
    const place = commentPlace(this.doc, page, point, anchor);
    // The pin moves to its new place immediately, without waiting for the server.
    const c = this.items.get(thread);
    if (c) {
      this.items.set(thread, { ...c, place });
      this.emit();
    }
    this.upsert(await this.account.api<ServerComment>('PATCH', this.url(`/api/comments/${thread}`), { place }));
  }
  async react(id: string, emoji: string, on: boolean) {
    this.upsert(await this.account.api<ServerComment>('PUT', this.url(`/api/comments/${id}/reactions`), { emoji, on }));
  }
  async upload(file: Blob, name: string) {
    return this.account.api<Attachment>('POST', this.url(`/api/files/${this.fileId}/attachments`, { name, type: file.type || 'application/octet-stream' }), file);
  }
  /** Attachment — as a blob: URL (the request carries a token, so not a direct link). */
  attachmentUrl(a: Attachment) {
    let u = this.urls.get(a.id);
    if (!u) {
      u = this.account.api<Uint8Array>('GET', this.url(`/api/attachments/${a.id}`)).then((bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: a.type })));
      u.catch(() => this.urls.delete(a.id));
      this.urls.set(a.id, u);
    }
    return u;
  }
  jira(thread: string) {
    return this.account.api<{ key: string; url: string }>('POST', this.url(`/api/comments/${thread}/jira`));
  }
  people() {
    this.peopleList ??= this.account
      .api<{ people: Person[] }>('GET', this.url(`/api/files/${this.fileId}/people`))
      .then((r) => r.people)
      .catch(() => {
        this.peopleList = null;
        return [];
      });
    return this.peopleList;
  }
  dispose() {
    this.disposed = true;
    for (const u of this.urls.values()) void u.then((x) => URL.revokeObjectURL(x), () => {});
    this.urls.clear();
  }
}
