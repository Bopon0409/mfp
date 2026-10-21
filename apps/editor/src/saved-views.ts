// Saved views (own feature): named canvas places — page, position and zoom. Stored in the file (root
// property savedViews), visible to all participants. “View → Saved views”: go to (with a fly-over),
// save the current one, rename, delete. Back/forward through place history — Alt+← / Alt+→.

import type { Document } from '@mfp/core';
import { h, modal } from './dom.ts';
import type { Editor } from './editor.ts';
import type { MenuEntry } from './menu.ts';

export interface SavedView {
  id: string;
  name: string;
  pageId: string;
  x: number;
  y: number;
  zoom: number;
}

export const savedViews = (doc: Document): SavedView[] => (doc.get(doc.root, 'savedViews') as SavedView[] | undefined) ?? [];

const put = (doc: Document, views: SavedView[]) => doc.transact(() => doc.set(doc.root, { savedViews: views.length ? views : undefined }));

/** Go to a view: the page (if different) and the camera (center and zoom as they were, fitted to the current window size). */
export function goToView(ed: Editor, v: SavedView) {
  if (!ed.doc.has(v.pageId)) return;
  if (v.pageId !== ed.pageId) ed.setPage(v.pageId);
  ed.flyTo({ zoom: v.zoom, x: v.x - ed.viewW / 2 / v.zoom, y: v.y - ed.viewH / 2 / v.zoom });
}

/** Current view — the screen center in world space (windows differ for everyone, so we store the center, not a corner). */
export function currentView(ed: Editor, name: string): SavedView {
  const z = ed.camera.zoom;
  return { id: Math.random().toString(36).slice(2, 10), name, pageId: ed.pageId, x: Math.round((ed.camera.x + ed.viewW / 2 / z) * 100) / 100, y: Math.round((ed.camera.y + ed.viewH / 2 / z) * 100) / 100, zoom: Math.round(z * 10000) / 10000 };
}

/** Ask for a name (dialog) and do something with it. */
function askName(title: string, value: string, done: (name: string) => void) {
  const m = modal(title);
  const input = h('input', { class: 'm-input', value, style: 'width:100%' }) as HTMLInputElement;
  const ok = () => {
    const name = input.value.trim();
    if (!name) return input.focus();
    m.close();
    done(name);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
  m.body.append(input, h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => m.close() }, 'Отмена'), h('button', { class: 'm-btn primary', onclick: ok }, 'Сохранить')));
  setTimeout(() => (input.focus(), input.select()), 0);
}

/** “Saved views” submenu. */
export function savedViewsMenu(ed: Editor): MenuEntry[] {
  const doc = ed.doc;
  const views = savedViews(doc).filter((v) => doc.has(v.pageId));
  const pageName = (id: string) => doc.get(id, 'name') || 'Страница';
  const multiPage = new Set(views.map((v) => v.pageId)).size > 1 || views.some((v) => v.pageId !== ed.pageId);
  const items: MenuEntry[] = views.map((v) => ({ label: multiPage ? `${v.name} — ${pageName(v.pageId)}` : v.name, run: () => goToView(ed, v) }));
  if (items.length) items.push('sep');
  items.push({
    label: 'Сохранить текущий вид…',
    run: () => askName('Сохранить вид', `Вид ${views.length + 1}`, (name) => put(doc, [...savedViews(doc), currentView(ed, name)])),
  });
  if (views.length) {
    items.push(
      {
        label: 'Обновить вид',
        submenu: views.map((v) => ({ label: v.name, run: () => put(doc, savedViews(doc).map((x) => (x.id === v.id ? { ...currentView(ed, v.name), id: v.id } : x))) })),
      },
      {
        label: 'Переименовать вид',
        submenu: views.map((v) => ({ label: v.name, run: () => askName('Имя вида', v.name, (name) => put(doc, savedViews(doc).map((x) => (x.id === v.id ? { ...x, name } : x)))) })),
      },
      {
        label: 'Удалить вид',
        submenu: views.map((v) => ({ label: v.name, run: () => put(doc, savedViews(doc).filter((x) => x.id !== v.id)) })),
      },
    );
  }
  return items;
}
