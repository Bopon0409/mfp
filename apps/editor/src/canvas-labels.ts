// Canvas labels: names of top-level frames above their corner and the selection size
// below it. Regular elements over the canvas — crisp text in the interface font.

import { formatLength, UNIT_LABEL, type NodeType } from '@mfp/core';
import { getSizing, type Axis } from '@mfp/editing';
import type { Editor } from './editor.ts';
import { labelColor } from './layer-labels.ts';
import { t } from './i18n/index.ts';

const LABELED = new Set<NodeType>(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);
/** Don't keep more labels than this at once (huge pages). */
const MAX_LABELS = 400;
const fmt = (v: number) => String(Math.round(v * 100) / 100);
/** Sizing mode next to the number (“450 Fill × 162 Hug”). */
const MODE_WORD = { FIXED: '', HUG: ' по содерж.', FILL: ' заполн.', PERCENT: '' } as const;

export class CanvasLabels {
  private ed: Editor;
  private root: HTMLElement;
  private labels = new Map<string, HTMLElement>();
  /** Who can be labeled (top level, section frames and variants) — until tree edits. */
  private candidates: string[] | null = null;
  /** Candidates' bounds in the world — until the node itself or its candidate parent is edited. */
  private world = new Map<string, [number, number, number, number]>();
  /** What is already written into the label style (no extra DOM writes on every frame). */
  private placed = new Map<string, string>();
  /** Pressing a frame label (select and drag) and double-click (rename). */
  onLabelDown: ((id: string, e: PointerEvent) => void) | null = null;
  onLabelDblClick: ((id: string) => void) | null = null;
  private badge: HTMLElement;

  constructor(ed: Editor, root: HTMLElement) {
    this.ed = ed;
    this.root = root;
    this.badge = document.createElement('div');
    this.badge.className = 'size-badge';
    this.badge.style.display = 'none';
    root.append(this.badge);
    ed.overlays.push(() => this.update());
    ed.onDocument.push((ops) => {
      for (const o of ops) {
        if (o.op === 'blob') continue;
        if (o.op !== 'set') {
          this.candidates = null;
          this.world.clear();
          return;
        }
        if (!this.world.has(o.id)) continue;
        // A section and a variant set move their frames too.
        this.world.delete(o.id);
        for (const c of ed.doc.children(o.id)) this.world.delete(c);
      }
    });
    ed.onPage.push(() => {
      this.candidates = null;
      this.world.clear();
    });
  }

  /** Node bounds in the world (by rotated corners) — from the cache. */
  private worldBox(id: string): [number, number, number, number] {
    let b = this.world.get(id);
    if (!b) {
      b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of this.ed.corners(id)) {
        b[0] = Math.min(b[0], x);
        b[1] = Math.min(b[1], y);
        b[2] = Math.max(b[2], x);
        b[3] = Math.max(b[3], y);
      }
      this.world.set(id, b);
    }
    return b;
  }

  /** Node bounds on screen (by rotated corners). */
  private screenBox(id: string): [number, number, number, number] {
    const pts = this.ed.corners(id).map(([x, y]) => this.ed.worldToScreen(x, y));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1];
  }

  private update() {
    const { ed } = this;
    const doc = ed.doc;
    const sel = new Set(ed.selection);
    const seen = new Set<string>();
    const W = ed.viewW;
    const H = ed.viewH;
    let count = 0;
    // Page top level and frames directly inside sections.
    if (!this.candidates) {
      const list: string[] = [];
      for (const id of doc.children(ed.pageId)) {
        list.push(id);
        if (doc.type(id) === 'SECTION') list.push(...doc.children(id));
        // Set variants are labeled too (the set and each variant).
        if (doc.type(id) === 'COMPONENT_SET') list.push(...doc.children(id));
      }
      this.candidates = list;
    }
    const { x: cx, y: cy, zoom } = ed.camera;
    for (const id of this.candidates) {
      const type = doc.type(id);
      if (!type || !LABELED.has(type) || doc.get(id, 'visible') === false) continue;
      const w = this.worldBox(id);
      const x0 = (w[0] - cx) * zoom;
      const y0 = (w[1] - cy) * zoom;
      const x1 = (w[2] - cx) * zoom;
      const y1 = (w[3] - cy) * zoom;
      if (x1 < 0 || x0 > W || y1 < 0 || y0 - 20 > H || x1 - x0 < 24) continue;
      if (++count > MAX_LABELS) break;
      let el = this.labels.get(id);
      if (!el) {
        el = document.createElement('div');
        el.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          this.onLabelDown?.(id, e);
        });
        el.addEventListener('dblclick', () => this.onLabelDblClick?.(id));
        this.root.append(el);
        this.labels.set(id, el);
      }
      seen.add(id);
      const name = doc.get(id, 'name') ?? '';
      if (el.textContent !== name) el.textContent = name;
      const cls = `frame-label${sel.has(id) ? ' selected' : type === 'COMPONENT' || type === 'COMPONENT_SET' ? ' component' : ''}`;
      if (el.className !== cls) el.className = cls;
      // Layer label — name color (selected — as usual, in the selection color).
      const tint = sel.has(id) ? '' : (labelColor(doc, id) ?? '');
      if (el.style.color !== tint) el.style.color = tint;
      const place = `${Math.round(x0)},${Math.round(y0 - 17)},${Math.round(x1 - x0)}`;
      if (this.placed.get(id) !== place) {
        this.placed.set(id, place);
        el.style.transform = `translate(${Math.round(x0)}px, ${Math.round(y0 - 17)}px)`;
        el.style.maxWidth = `${Math.round(x1 - x0)}px`;
      }
    }
    for (const [id, el] of this.labels) {
      if (seen.has(id)) continue;
      el.remove();
      this.labels.delete(id);
      this.placed.delete(id);
    }
    this.updateBadge(sel);
  }

  /** Selection size: for one layer — its width and height, for several — of the common bounds. */
  private updateBadge(sel: Set<string>) {
    const { ed } = this;
    const doc = ed.doc;
    const ids = [...sel].filter((id) => doc.has(id) && ed.isOnPage(id));
    if (!ids.length || ed.tool === 'text') {
      this.badge.style.display = 'none';
      return;
    }
    let w: number;
    let h: number;
    let wMode = '';
    let hMode = '';
    // Size in percent of the parent — as a percentage (“50%”), not computed pixels.
    let wText: string | null = null;
    let hText: string | null = null;
    if (ids.length === 1) {
      w = doc.get(ids[0]!, 'width') ?? 0;
      h = doc.get(ids[0]!, 'height') ?? 0;
      const mode = (axis: Axis) => t(MODE_WORD[getSizing(doc, ids[0]!, axis)]);
      wMode = mode('width');
      hMode = mode('height');
      if (getSizing(doc, ids[0]!, 'width') === 'PERCENT') wText = `${fmt(doc.get(ids[0]!, 'widthPercent') ?? 0)}%`;
      if (getSizing(doc, ids[0]!, 'height') === 'PERCENT') hText = `${fmt(doc.get(ids[0]!, 'heightPercent') ?? 0)}%`;
    } else {
      const b = ed.selectionBounds(ids);
      if (!b) {
        this.badge.style.display = 'none';
        return;
      }
      w = b[2] - b[0];
      h = b[3] - b[1];
    }
    let x0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of ids) {
      const b = this.screenBox(id);
      x0 = Math.min(x0, b[0]);
      x1 = Math.max(x1, b[2]);
      y1 = Math.max(y1, b[3]);
    }
    // Document units (mm, cm, …) — shown in them, with the unit label.
    const u = doc.get(doc.root, 'documentUnits');
    const units = u && u.unit !== 'px' ? u : undefined;
    const len = (v: number) => (units ? formatLength(v, units) : fmt(v));
    const text = `${wText ?? len(w)}${wMode} × ${hText ?? len(h)}${hMode}${units ? ' ' + UNIT_LABEL[units.unit] : ''}`;
    if (this.badge.textContent !== text) this.badge.textContent = text;
    const component = ids.every((id) => {
      const t = doc.type(id);
      return t === 'COMPONENT' || t === 'COMPONENT_SET' || t === 'INSTANCE';
    });
    this.badge.className = component ? 'size-badge component' : 'size-badge';
    this.badge.style.display = '';
    this.badge.style.transform = `translate(calc(${Math.round((x0 + x1) / 2)}px - 50%), ${Math.round(y1 + 8)}px)`;
  }
}
