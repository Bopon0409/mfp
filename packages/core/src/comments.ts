// Comments (no accounts: the author is the participant's name). A thread is a COMMENT node on the
// internal comments page; replies are its children. The thread point is in the coordinates of the anchor layer
// (the frame under the point: move it and the comment moves with it) or of the page if there is no anchor.
//
// Edits use the 'comment' source: they reach the file, collaboration and versions, but not undo
// (Ctrl+Z). The comments page is separate, not “Resources”: that one may appear as an undo step
// (the first style), and undoing it would take the comments with it.

import type { Document } from './document.ts';
import { invert, multiply } from './geometry.ts';
import { pageOf } from './prototype.ts';
import type { CommentData, Matrix } from './types.ts';

export const COMMENT_ORIGIN = 'comment';
const I: Matrix = [1, 0, 0, 0, 1, 0];

/** Internal comment pages (there may be several during collaboration). */
export function commentPages(doc: Document): string[] {
  return doc.children(doc.root).filter((p) => doc.get(p, 'commentsPage') === true);
}

/** The comments page (created outside the undo history). */
function commentsPage(doc: Document): string {
  return commentPages(doc)[0] ?? doc.create('PAGE', doc.root, { name: 'Комментарии', internal: true, commentsPage: true, backgrounds: [] });
}

/** Node matrix in its page's coordinates. */
function worldOf(doc: Document, id: string): Matrix {
  let m = I;
  for (let c: string | null = id; c && doc.type(c) !== 'PAGE'; c = doc.parent(c)) m = multiply((doc.get(c, 'transform') ?? I) as Matrix, m);
  return m;
}

const apply = (m: Matrix, [x, y]: readonly [number, number]): [number, number] => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
/** Thread points rounded to hundredths (no tails like 100.00000000000011 in the file). */
const round = ([x, y]: [number, number]): [number, number] => [Math.round(x * 100) / 100, Math.round(y * 100) / 100];

/** Thread location: page, anchor layer and a point in its coordinates (the page point is a fallback). */
export type CommentPlace = Pick<CommentData, 'page' | 'anchor' | 'at' | 'pageAt'>;

/** The location's anchor, if it is still in the document and on the user's page. */
function liveAnchor(doc: Document, place: CommentPlace | undefined): string | null {
  const a = place?.anchor;
  if (!a || !doc.has(a)) return null;
  const p = pageOf(doc, a);
  return p && !doc.get(p, 'internal') ? a : null;
}

/** The location's page: the anchor's, if there is one, otherwise the recorded one. */
export function placePage(doc: Document, place: CommentPlace | undefined): string | null {
  const a = liveAnchor(doc, place);
  return a ? pageOf(doc, a) : (place?.page ?? null);
}

/** The location's point on its page (if the anchor was moved, the point moves with it). */
export function placePoint(doc: Document, place: CommentPlace | undefined): [number, number] {
  const a = liveAnchor(doc, place);
  if (a && place?.at) return apply(worldOf(doc, a), place.at);
  return place?.pageAt ? [place.pageAt[0], place.pageAt[1]] : place?.at ? [place.at[0], place.at[1]] : [0, 0];
}

/** Threads (all or of one page), by creation time. */
export function commentThreads(doc: Document, page?: string): string[] {
  const out: string[] = [];
  for (const p of commentPages(doc)) for (const id of doc.children(p)) if (doc.type(id) === 'COMMENT' && (!page || threadPage(doc, id) === page)) out.push(id);
  return out.sort((a, b) => (doc.get(a, 'comment')?.created ?? 0) - (doc.get(b, 'comment')?.created ?? 0));
}

/** Thread replies (in order). */
export function commentReplies(doc: Document, thread: string): string[] {
  return doc.children(thread).filter((id) => doc.type(id) === 'COMMENT');
}

/** The comment's thread (the thread itself or the reply's parent). */
export function threadOf(doc: Document, id: string): string | null {
  if (doc.type(id) !== 'COMMENT') return null;
  const p = doc.parent(id);
  return p && doc.type(p) === 'COMMENT' ? p : id;
}

/** Thread page: the anchor's, if there is one, otherwise the recorded one. */
export function threadPage(doc: Document, thread: string): string | null {
  return placePage(doc, doc.get(thread, 'comment'));
}

/** Thread point on its page. */
export function threadPoint(doc: Document, thread: string): [number, number] {
  return placePoint(doc, doc.get(thread, 'comment'));
}

/** Thread location for a page point: the anchor (if any) and the point in its coordinates. */
export function commentPlace(doc: Document, page: string, point: [number, number], anchor: string | null): CommentPlace {
  return placeOf(doc, page, point, anchor);
}

function placeOf(doc: Document, page: string, point: [number, number], anchor: string | null): CommentPlace {
  const p = round(point);
  if (anchor && doc.has(anchor)) return { page, anchor, at: round(apply(invert(worldOf(doc, anchor)), point)), pageAt: p };
  return { page, anchor: undefined, at: p, pageAt: p };
}

/** Without empty fields (undefined is not stored in the document). */
const clean = (c: CommentData): CommentData => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as unknown as CommentData;

export interface NewComment {
  author: string;
  color?: string;
  text: string;
}

/** New thread at a page point; anchor — the layer it will move with. */
export function addCommentThread(doc: Document, page: string, point: [number, number], anchor: string | null, c: NewComment, now = Date.now()): string {
  return doc.transact(() => doc.create('COMMENT', commentsPage(doc), { name: 'Комментарий', comment: clean({ ...c, created: now, ...placeOf(doc, page, point, anchor) }) }), COMMENT_ORIGIN);
}

/** Reply in a thread. */
export function addCommentReply(doc: Document, thread: string, c: NewComment, now = Date.now()): string {
  return doc.transact(() => doc.create('COMMENT', thread, { name: 'Ответ', comment: clean({ ...c, created: now }) }), COMMENT_ORIGIN);
}

/** Change the comment text. */
export function editComment(doc: Document, id: string, text: string, now = Date.now()) {
  const c = doc.get(id, 'comment');
  if (!c || c.text === text) return;
  doc.transact(() => doc.set(id, { comment: { ...c, text, edited: now } }), COMMENT_ORIGIN);
}

/** The thread is resolved (hidden from the canvas) or reopened. */
export function resolveThread(doc: Document, thread: string, resolved: boolean) {
  const c = doc.get(thread, 'comment');
  if (!c || !!c.resolved === resolved) return;
  doc.transact(() => doc.set(thread, { comment: clean({ ...c, resolved: resolved || undefined }) }), COMMENT_ORIGIN);
}

/** Move the thread to a page point (and to a different anchor). */
export function moveThread(doc: Document, thread: string, page: string, point: [number, number], anchor: string | null) {
  const c = doc.get(thread, 'comment');
  if (!c) return;
  doc.transact(() => doc.set(thread, { comment: clean({ ...c, ...placeOf(doc, page, point, anchor) }) }), COMMENT_ORIGIN);
}

/** Delete a comment (a thread — together with its replies). */
export function deleteComment(doc: Document, id: string) {
  if (doc.type(id) !== 'COMMENT') return;
  doc.transact(() => doc.delete(id), COMMENT_ORIGIN);
}

/**
 * Comments of document from go into document to, replacing its own: restoring a version
 * does not roll back comments.
 */
export function transplantComments(from: Document, to: Document) {
  to.transact(() => {
    for (const p of commentPages(to)) to.delete(p);
    const copy = (id: string, parent: string) => {
      const n = from.node(id);
      if (!n) return;
      to.createWithId(id, n.type, parent, structuredClone(n.props));
      for (const c of from.children(id)) copy(c, id);
    };
    for (const p of commentPages(from)) copy(p, to.root);
  }, COMMENT_ORIGIN);
}
