// Assets (left panel tab): components of the document and libraries — with thumbnails and search.
// Click — an instance in the center of the screen, drag — at a point on the canvas (into the frame under it).
// The same list is the component picker: swap instance, the “instance swap” property.

import { findVariant, instantiate, propertyDefinitions, userPages, type Document } from '@mfp/core';
import type { Editor } from './editor.ts';
import { h, popover, searchInput, svgEl } from './dom.ts';
import { ICON } from './icons.ts';

export interface ComponentEntry {
  id: string;
  name: string;
  /** Page (or “Libraries” — mains from the service page). */
  group: string;
  isSet: boolean;
  /** Set: how many variants. */
  variants: number;
  description: string;
}

/** Document components and sets (set variants — as a single set). */
export function componentEntries(doc: Document): ComponentEntry[] {
  const out: ComponentEntry[] = [];
  const walk = (id: string, group: string) => {
    for (const c of doc.children(id)) {
      const t = doc.type(c);
      if (t === 'COMPONENT_SET') {
        out.push({ id: c, name: doc.get(c, 'name') ?? '', group, isSet: true, variants: doc.children(c).filter((v) => doc.type(v) === 'COMPONENT').length, description: doc.get(c, 'description') ?? '' });
        continue;
      }
      if (t === 'COMPONENT') {
        out.push({ id: c, name: doc.get(c, 'name') ?? '', group, isSet: false, variants: 0, description: doc.get(c, 'description') ?? '' });
        continue;
      }
      if (t === 'INSTANCE' || t === 'TEXT' || t === 'STYLE' || t === 'VARIABLE_COLLECTION') continue;
      walk(c, group);
    }
  };
  for (const p of userPages(doc)) walk(p, doc.get(p, 'name') ?? '');
  for (const p of doc.children(doc.root)) if (doc.get(p, 'internal')) walk(p, 'Библиотеки');
  return out;
}

/** The set's default variant (default variant values), otherwise the first one. */
export function defaultVariant(doc: Document, setId: string): string | null {
  const defs = propertyDefinitions(doc, setId);
  const values: Record<string, string> = {};
  for (const [k, d] of Object.entries(defs)) if (d.type === 'VARIANT') values[k] = String(d.defaultValue);
  return findVariant(doc, setId, values) ?? doc.children(setId).find((c) => doc.type(c) === 'COMPONENT') ?? null;
}

/** Insert a component instance (for a set — the default variant): at the world point or in the center of the screen. */
export function insertComponent(ed: Editor, id: string, world?: [number, number]): string | null {
  const doc = ed.doc;
  const comp = doc.type(id) === 'COMPONENT_SET' ? defaultVariant(doc, id) : id;
  if (!comp) return null;
  const w = doc.get(comp, 'width') ?? 0;
  const hh = doc.get(comp, 'height') ?? 0;
  const v = ed.viewportRect();
  const [cx, cy] = world ?? [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2];
  // Into the (top-level) frame under the point, otherwise onto the page.
  let parent = ed.pageId;
  let px = 0;
  let py = 0;
  if (world) {
    for (const f of [...doc.children(ed.pageId)].reverse()) {
      const t = doc.type(f);
      if (t !== 'FRAME' && t !== 'SECTION') continue;
      const m = doc.get(f, 'transform') ?? [1, 0, 0, 0, 1, 0];
      if (m[1] || m[3]) continue;
      if (cx >= m[2] && cy >= m[5] && cx <= m[2] + (doc.get(f, 'width') ?? 0) && cy <= m[5] + (doc.get(f, 'height') ?? 0)) {
        parent = f;
        px = m[2];
        py = m[5];
        break;
      }
    }
  }
  const inst = doc.transact(() => instantiate(doc, comp, parent, [1, 0, Math.round(cx - w / 2 - px), 0, 1, Math.round(cy - hh / 2 - py)]));
  ed.select([inst]);
  return inst;
}

// ---------- Thumbnails ----------

const thumbs = new Map<string, Promise<string | null>>();

/** Component thumbnail (for a set — the default variant): image URL or null. */
function thumbnail(ed: Editor, id: string): Promise<string | null> {
  let p = thumbs.get(id);
  if (!p) {
    const doc = ed.doc;
    const target = doc.type(id) === 'COMPONENT_SET' ? defaultVariant(doc, id) : id;
    p = target ? ed.renderThumbnail(target, 96).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null) : Promise.resolve(null);
    thumbs.set(id, p);
  }
  return p;
}

/** A component (or set) changed — redraw the thumbnail. */
function dropThumb(id: string) {
  const p = thumbs.get(id);
  if (!p) return;
  thumbs.delete(id);
  void p.then((url) => url && URL.revokeObjectURL(url));
}

/** Component row: thumbnail, name, caption. */
function entryRow(ed: Editor, e: ComponentEntry, seen: IntersectionObserver | null, onPick: (id: string) => void, current?: string | null): HTMLElement {
  const img = h('div', { class: 'asset-thumb' });
  const row = h(
    'div',
    { class: `asset-row${e.id === current ? ' current' : ''}`, title: e.description || e.name, draggable: true, 'data-id': e.id },
    img,
    h('div', { class: 'asset-text' }, h('div', { class: 'asset-name' }, e.name), h('div', { class: 'asset-sub' }, e.isSet ? `Набор · вариантов: ${e.variants}` : 'Компонент')),
  );
  row.addEventListener('click', () => onPick(e.id));
  row.addEventListener('dragstart', (ev) => {
    ev.dataTransfer?.setData('application/x-mfp-component', e.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  });
  const load = () =>
    void thumbnail(ed, e.id).then((url) => {
      if (url) img.style.backgroundImage = `url(${url})`;
      else img.append(svgEl('span', { class: 'asset-ic' }, e.isSet ? ICON.componentSet : ICON.component));
    });
  if (seen) {
    (row as HTMLElement & { loadThumb?: () => void }).loadThumb = load;
    seen.observe(row);
  } else load();
  return row;
}

/** Thumbnails — when the row is visible. */
function lazyThumbs(root: HTMLElement): IntersectionObserver {
  return new IntersectionObserver(
    (entries, obs) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        obs.unobserve(en.target);
        (en.target as HTMLElement & { loadThumb?: () => void }).loadThumb?.();
      }
    },
    { root },
  );
}

/** List by groups; no more than limit rows (the rest — via search). */
function renderList(ed: Editor, box: HTMLElement, entries: ComponentEntry[], q: string, onPick: (id: string) => void, opts: { preferred?: string[]; current?: string | null; limit?: number } = {}) {
  box.replaceChildren();
  const seen = lazyThumbs(box);
  const match = (e: ComponentEntry) => !q || e.name.toLowerCase().includes(q) || e.group.toLowerCase().includes(q);
  const limit = opts.limit ?? 300;
  let shown = 0;
  if (opts.preferred?.length) {
    const pref = entries.filter((e) => opts.preferred!.includes(e.id) && match(e));
    if (pref.length) {
      box.append(h('div', { class: 'asset-group' }, 'Предпочтительные'));
      for (const e of pref) box.append(entryRow(ed, e, seen, onPick, opts.current));
    }
  }
  let group = '';
  const found = entries.filter(match);
  for (const e of found) {
    if (shown >= limit) break;
    if (e.group !== group) {
      group = e.group;
      box.append(h('div', { class: 'asset-group' }, group));
    }
    box.append(entryRow(ed, e, seen, onPick, opts.current));
    shown++;
  }
  if (found.length > shown) box.append(h('div', { class: 'empty' }, `Ещё ${found.length - shown} — уточните поиск`));
  if (!found.length) box.append(h('div', { class: 'empty' }, q ? 'Ничего не найдено' : 'В документе нет компонентов. Выделите слои и нажмите Ctrl+Alt+K.'));
}

/** Component picker at an anchor. sets — a set can be chosen (otherwise its default variant is chosen). */
export function openComponentPicker(ed: Editor, anchor: HTMLElement, opts: { current?: string | null; preferred?: string[]; sets?: boolean; title?: string; onPick(id: string): void }) {
  const { box, close } = popover(anchor, 'picker', { width: 280, side: 'left' });
  if (!box.isConnected) return;
  const entries = componentEntries(ed.doc);
  const list = h('div', { class: 'pop-list assets-list' });
  const pick = (id: string) => {
    close();
    const doc = ed.doc;
    opts.onPick(!opts.sets && doc.type(id) === 'COMPONENT_SET' ? (defaultVariant(doc, id) ?? id) : id);
  };
  const search = searchInput('Поиск компонента', (q) => renderList(ed, list, entries, q, pick, { preferred: opts.preferred, current: opts.current }));
  box.append(h('div', { class: 'pop-head' }, opts.title ?? 'Компоненты'), search, list);
  renderList(ed, list, entries, '', pick, { preferred: opts.preferred, current: opts.current });
  setTimeout(() => search.focus(), 0);
}

/** Left panel tabs “File” / “Assets” and the asset list. */
export class AssetsPanel {
  /** Dot on the “Libraries” button: updates available. */
  setLibraryUpdates(n: number) {
    this.libsBtn.classList.toggle('dot', n > 0);
    this.libsBtn.title = n ? `Библиотеки (Alt+3) — обновлений: ${n}` : 'Библиотеки (Alt+3)';
  }

  private ed: Editor;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private q = '';
  private active = false;
  private timer = 0;
  /** Open the “Assets” tab. */
  show: () => void = () => {};
  /** Open the “File” tab (pages and layers). */
  showFile: () => void = () => {};
  /** The “Libraries” window (Alt+3) — the button next to search. */
  onLibraries: (() => void) | null = null;
  private libsBtn: HTMLButtonElement;

  constructor(ed: Editor) {
    this.ed = ed;
    const left = document.getElementById('left')!;
    // “File” and “Assets” sections — in the strip on the left.
    const rail = document.getElementById('rail')!;
    const railBtn = (icon: string, label: string, title: string) => {
      const b = h('button', { class: 'rail-btn', title, 'aria-label': label }, h('span', { class: 'rail-ic' }), h('span', {}, label));
      b.firstElementChild!.innerHTML = icon;
      return b;
    };
    const fileTab = railBtn(ICON.layers, 'Файл', 'Страницы и слои');
    const assetsTab = railBtn(ICON.assets, 'Ассеты', 'Компоненты, стили и библиотеки');
    fileTab.classList.add('on');
    const setTab = (assets: boolean) => {
      this.active = assets;
      fileTab.classList.toggle('on', !assets);
      assetsTab.classList.toggle('on', assets);
      left.classList.toggle('assets-mode', assets);
      if (assets) this.render();
    };
    this.show = () => setTab(true);
    this.showFile = () => setTab(false);
    fileTab.addEventListener('click', () => setTab(false));
    assetsTab.addEventListener('click', () => setTab(true));
    rail.append(h('div', { class: 'rail-sep' }), fileTab, assetsTab);
    this.list = h('div', { class: 'assets-list' });
    this.search = searchInput('Поиск ассетов', (q) => {
      this.q = q;
      this.render();
    });
    this.libsBtn = h('button', { class: 'assets-libs', title: 'Библиотеки (Alt+3)', 'aria-label': 'Библиотеки', onclick: () => this.onLibraries?.() });
    this.libsBtn.innerHTML = ICON.library;
    left.append(h('div', { class: 'section', id: 'assets-section' }, h('div', { class: 'assets-search' }, this.search, this.libsBtn), this.list));
    // Component edits — thumbnails again; new and deleted components — the list again.
    ed.onDocument.push((ops) => {
      let relist = false;
      for (const o of ops) {
        if (o.op === 'blob') continue;
        if (o.op === 'create' && (o.type === 'COMPONENT' || o.type === 'COMPONENT_SET')) relist = true;
        if (o.op === 'delete' || (o.op === 'set' && ('name' in o.props || 'description' in o.props))) relist = true;
        if (o.op === 'delete' || !ed.doc.has(o.id)) continue;
        for (let p: string | null = o.id; p; p = ed.doc.parent(p)) {
          const t = ed.doc.type(p);
          if (t === 'COMPONENT' || t === 'COMPONENT_SET') dropThumb(p);
        }
      }
      if (relist && this.active) this.schedule();
    });
    ed.onPage.push(() => {
      if (this.active) this.schedule();
    });
    // Dragging onto the canvas.
    const canvas = ed.canvasEl;
    canvas.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('application/x-mfp-component')) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    canvas.addEventListener('drop', (e) => {
      const id = e.dataTransfer?.getData('application/x-mfp-component');
      if (!id || !ed.doc.has(id)) return;
      e.preventDefault();
      e.stopPropagation();
      const r = canvas.getBoundingClientRect();
      insertComponent(ed, id, ed.screenToWorld(e.clientX - r.left, e.clientY - r.top));
      canvas.focus();
    });
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.render(), 150);
  }

  render() {
    renderList(this.ed, this.list, componentEntries(this.ed.doc), this.q, (id) => insertComponent(this.ed, id));
  }
}
