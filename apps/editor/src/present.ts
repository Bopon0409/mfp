// Prototype presentation from the editor: a separate tab or a preview window over the canvas
// (Shift+Space, like Preview). Both are the ?player=token page; they receive the document, images
// and edits from here via BroadcastChannel (player/protocol.ts). Comments in presentation also come
// from here: screen threads and new ones go through the editor's comment source.

import { commentPlace, pageOf, placePage, placePoint, prototypePages, screenOf, userPages, type Document } from '@mfp/core';
import type { CommentStore } from './comment-store.ts';
import type { Editor } from './editor.ts';
import { presentInPage } from './preview.ts';
import { isDesktop } from './platform.ts';
import { channelName, type PlayerThread, type ToEditor, type ToPlayer } from './player/protocol.ts';

const sources = new WeakMap<Document, string>();
let commentsSource: (() => CommentStore) | null = null;
let tabPresenter: ((id: string, name: string, url: string) => void) | null = null;
export function presentTabs(open: (id: string, name: string, url: string) => void) { tabPresenter = open; }

export function presentComments(get: () => CommentStore) {
  commentsSource = get;
}

/** The layer is the screen itself or inside it. */
function within(doc: Document, id: string | null | undefined, screen: string): boolean {
  for (let c = id ?? null; c && doc.type(c) !== 'PAGE'; c = doc.parent(c)) if (c === screen) return true;
  return false;
}

/** Screen threads (unresolved): points in its coordinates. */
function screenThreads(doc: Document, store: CommentStore, screen: string): PlayerThread[] {
  const page = pageOf(doc, screen);
  if (!page) return [];
  return store
    .threads()
    .filter((c) => !c.resolved && c.place && placePage(doc, c.place) === page && within(doc, c.place.anchor, screen))
    .map((c) => ({
      id: c.id,
      at: commentPlace(doc, page, placePoint(doc, c.place!), screen).at ?? [0, 0],
      author: { name: c.author.name, color: c.author.color },
      text: c.text,
      created: c.created,
      replies: store.replies(c.id).map((r) => ({ id: r.id, author: { name: r.author.name, color: r.author.color }, text: r.text, created: r.created })),
    }));
}

function serve(ed: Editor, name: () => string) {
  const doc = ed.doc;
  const existing = sources.get(doc);
  if (existing) return existing;
  const token = crypto.randomUUID();
  sources.set(doc, token);
  const ch = new BroadcastChannel(channelName(token));
  const store = ed.store;
  const fileName = name();
  const sourcePage = ed.pageId;
  const sourceComments = commentsSource?.();
  const players = new Set<string>();
  let timer = 0;
  let watched: CommentStore | null = null;
  let commentsTimer = 0;
  let cleanupTimer = 0;
  let closed = false;
  let commentsChanged: (() => void) | null = null;
  const stop = () => {
    if (closed) return;
    closed = true;
    ch.close(); sources.delete(doc); unsubscribe();
    clearTimeout(timer); clearTimeout(commentsTimer); clearTimeout(cleanupTimer);
    if (watched && commentsChanged) {
      const at = watched.onChange.indexOf(commentsChanged);
      if (at >= 0) watched.onChange.splice(at, 1);
    }
    watched = null;
  };
  cleanupTimer = window.setTimeout(() => { if (!players.size) stop(); }, 60000);
  const send = (m: ToPlayer) => { if (!closed) ch.postMessage(m); };
  ch.onmessage = async (ev: MessageEvent<ToEditor>) => {
    const m = ev.data;
    if (m.type === 'hello') {
      clearTimeout(cleanupTimer);
      players.add(m.from);
      const d = doc;
      // The document may have changed: then its first page.
      const page = m.page && d.has(m.page) && d.type(m.page) === 'PAGE' ? m.page : (userPages(d)[0] ?? sourcePage);
      const internal = d.children(d.root).filter((x) => d.get(x, 'internal') && !d.get(x, 'commentsPage'));
      // Prototype across the whole file: also the pages that transitions lead to (along the chain).
      const pages = [...new Set([...prototypePages(d, page), ...internal])];
      send({ type: 'doc', to: m.from, snapshot: d.snapshot(pages), page, name: ed.doc === doc ? name() : fileName });
    } else if (m.type === 'image') {
      const bytes = (await store.readImage(m.hash).catch(() => undefined)) ?? null;
      send({ type: 'image', to: m.from, id: m.id, bytes });
    } else if (m.type === 'comments' || m.type === 'comment') {
      const store = sourceComments;
      // Own and others' comment edits — notify presentations so they re-request.
      if (store && store !== watched) {
        watched = store;
        commentsChanged = () => {
          if (closed || watched !== store) return;
          clearTimeout(commentsTimer);
          commentsTimer = window.setTimeout(() => send({ type: 'commentsChanged' }), 200);
        };
        store.onChange.push(commentsChanged);
      }
      let error: string | undefined;
      if (m.type === 'comment') {
        try {
          if (ed.doc !== doc || !store?.canWrite()) throw new Error('комментировать этот файл нельзя');
          const page = doc.has(m.screen) ? pageOf(doc, m.screen) : null;
          if (m.thread) await store.reply(m.thread, m.text);
          else if (page && m.at) await store.create(page, placePoint(doc, { page, anchor: m.screen, at: m.at }), m.screen, m.text);
          else throw new Error('экрана нет в документе');
        } catch (e) {
          error = `Комментарий не отправлен: ${(e as Error).message}`;
        }
      }
      const threads = store && doc.has(m.screen) ? screenThreads(doc, store, m.screen) : [];
      send({ type: 'comments', to: m.from, screen: m.screen, threads, canWrite: ed.doc === doc && !!store?.canWrite(), ...(error ? { error } : {}) });
    } else if (m.type === 'bye') { players.delete(m.from); if (!players.size) { clearTimeout(cleanupTimer); cleanupTimer = window.setTimeout(stop, 1000); } }
  };
  // Edits go to presentations (at most once every half second); they request the document themselves.
  const unsubscribe = doc.onChange(() => {
    if (!players.size) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => send({ type: 'changed' }), 500);
  });
  return token;
}

/** Presentation URL: page and starting screen — the selected one (otherwise the page flow, otherwise the first frame). */
export function playerUrl(ed: Editor, name: () => string, opts: { embed?: boolean; start?: string | null } = {}) {
  const token = serve(ed, name);
  const doc = ed.doc;
  const start = opts.start ?? ed.selection.map((id) => (doc.has(id) ? screenOf(doc, id) : null)).find((x): x is string => !!x) ?? null;
  const q = new URLSearchParams({ player: token, page: ed.pageId });
  if (start) q.set('start', start);
  if (opts.embed) q.set('embed', '1');
  return `${location.pathname}?${q}`;
}

/**
 * Presentation in a separate tab (start — from this screen), on desktop — inside the tab bar.
 * If that fails (popups blocked) — presentation over the editor, not an error.
 */
export function present(ed: Editor, name: () => string, start?: string | null) {
  const url = playerUrl(ed, name, { start });
  if (tabPresenter) {
    tabPresenter('player:' + new URLSearchParams(url.split('?')[1]).get('player'), name(), url);
    return;
  }
  if (isDesktop) { presentInPage(ed, name, { start, device: true }); return; }
  const w = window.open(url, 'mfp-player');
  if (w) return void w.focus();
  presentInPage(ed, name, { start, device: true });
  ed.notify?.('Браузер не дал открыть вкладку — показ внутри окна (чтобы открывался вкладкой, разрешите всплывающие окна для сайта)');
}
