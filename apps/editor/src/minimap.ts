// Canvas minimap (our own; like the minimap in VS Code): a scaled-down page outline in the canvas
// corner — bounds of top-level layers (frames in their background color) and the viewport
// rectangle. Clicking or dragging on the map moves the screen center there, zoom unchanged. The “−”
// button collapses the map into an icon, the icon expands it; “View → Minimap” removes it entirely.
// The state is remembered.
//
// The map is built from page content only (not the viewport): otherwise moving the view would
// expand the map, and the same point under the pointer would lead even further — the view would
// “run away”. For the same reason the target point does not go beyond the content edges.

import type { Paint } from '@mfp/core';
import type { Editor, Rect } from './editor.ts';

const KEY = 'mfp.minimap';
const W = 200;
const H = 140;
const PAD = 8;

interface Item {
  b: Rect;
  color: string;
  frame: boolean;
}

type State = 'open' | 'collapsed' | 'off';

export class Minimap {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private pill: HTMLButtonElement;
  private ed: Editor;
  private items: Item[] | null = null;
  private drawn = '';
  /** World → map: scale and offset; page content (in world space). */
  private map = { s: 1, x: 0, y: 0 };
  private content: Rect = [0, 0, 1, 1];
  private state: State = 'off';

  constructor(ed: Editor, root: HTMLElement) {
    this.ed = ed;
    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-label', 'Мини-карта страницы: щелчок — перейти');
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    const hide = document.createElement('button');
    hide.className = 'minimap-hide';
    hide.title = 'Свернуть мини-карту';
    hide.textContent = '−';
    hide.addEventListener('click', () => this.setState('collapsed'));
    this.el.append(this.canvas, hide);
    this.pill = document.createElement('button');
    this.pill.className = 'minimap-pill';
    this.pill.title = 'Показать мини-карту';
    this.pill.textContent = '▦';
    this.pill.addEventListener('click', () => this.setState('open'));
    root.append(this.el, this.pill);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* no storage — disabled */
    }
    this.setState(saved === '1' ? 'open' : saved === 'c' ? 'collapsed' : 'off', false);
    ed.overlays.push(() => this.draw());
    ed.onDocument.push(() => (this.items = null));
    ed.onPage.push(() => (this.items = null));
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* no capture — drag only over the map */
      }
      this.goTo(e);
      const move = (m: PointerEvent) => this.goTo(m);
      const up = () => {
        this.canvas.removeEventListener('pointermove', move);
        this.canvas.removeEventListener('pointerup', up);
        this.canvas.removeEventListener('pointercancel', up);
      };
      this.canvas.addEventListener('pointermove', move);
      this.canvas.addEventListener('pointerup', up);
      this.canvas.addEventListener('pointercancel', up);
    });
    // Wheel over the map does not scroll the canvas beneath it.
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  get visible(): boolean {
    return this.state !== 'off';
  }

  /** “View → Minimap” menu: turn on (expanded) or remove entirely. */
  toggle(on = !this.visible) {
    this.setState(on ? 'open' : 'off');
  }

  private setState(state: State, remember = true) {
    this.state = state;
    this.el.hidden = state !== 'open';
    this.pill.hidden = state !== 'collapsed';
    this.drawn = '';
    if (remember) {
      try {
        localStorage.setItem(KEY, state === 'open' ? '1' : state === 'collapsed' ? 'c' : '0');
      } catch {
        /* won't be remembered */
      }
    }
    this.ed.dirty = true;
  }

  /** Move the viewport center to the map point under the pointer (within content), zoom unchanged. */
  private goTo(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const c = this.content;
    const wx = Math.max(c[0], Math.min(c[2], (e.clientX - r.left - this.map.x) / this.map.s));
    const wy = Math.max(c[1], Math.min(c[3], (e.clientY - r.top - this.map.y) / this.map.s));
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    const { ed } = this;
    const z = ed.camera.zoom;
    ed.setCamera({ zoom: z, x: wx - ed.viewW / 2 / z, y: wy - ed.viewH / 2 / z });
  }

  /** Top-level layers of the page: bounds in world space and color. */
  private collect(): Item[] {
    const { ed } = this;
    const doc = ed.doc;
    const out: Item[] = [];
    for (const id of doc.children(ed.pageId)) {
      if (doc.get(id, 'visible') === false) continue;
      const pts = ed.corners(id);
      const b: Rect = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
      if (!b.every(Number.isFinite)) continue;
      const type = doc.type(id);
      const frame = type === 'FRAME' || type === 'COMPONENT' || type === 'COMPONENT_SET' || type === 'SECTION' || type === 'INSTANCE';
      const fill = ((doc.get(id, 'fills') ?? []) as Paint[]).find((p) => p.type === 'SOLID' && p.visible !== false);
      const c = fill?.type === 'SOLID' ? fill.color : null;
      const color = c ? `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})` : frame ? '#ffffff' : '#9aa0a6';
      out.push({ b, color, frame });
    }
    return out;
  }

  private draw() {
    if (this.state !== 'open') return;
    const { ed } = this;
    const rebuilt = !this.items;
    const items = (this.items ??= this.collect());
    if (rebuilt) {
      // Page content is the map bounds; an empty page — the area around the origin.
      this.content = items.length
        ? [Math.min(...items.map((i) => i.b[0])), Math.min(...items.map((i) => i.b[1])), Math.max(...items.map((i) => i.b[2])), Math.max(...items.map((i) => i.b[3]))]
        : [-500, -500, 500, 500];
      const [x0, y0, x1, y1] = this.content;
      const s = Math.min((W - 2 * PAD) / Math.max(1, x1 - x0), (H - 2 * PAD) / Math.max(1, y1 - y0));
      this.map = { s, x: PAD + (W - 2 * PAD - (x1 - x0) * s) / 2 - x0 * s, y: PAD + (H - 2 * PAD - (y1 - y0) * s) / 2 - y0 * s };
      this.drawn = '';
    }
    const view: Rect = [ed.camera.x, ed.camera.y, ed.camera.x + ed.viewW / ed.camera.zoom, ed.camera.y + ed.viewH / ed.camera.zoom];
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#4d7bfd';
    const key = `${view.map((v) => Math.round(v)).join(',')}|${accent}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const dpr = devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(W * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const c = this.canvas.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const { s } = this.map;
    const px = (b: Rect) => [b[0] * s + this.map.x, b[1] * s + this.map.y, Math.max(1, (b[2] - b[0]) * s), Math.max(1, (b[3] - b[1]) * s)] as const;
    for (const it of items) {
      const [x, y, w, h] = px(it.b);
      c.fillStyle = it.color;
      c.globalAlpha = it.frame ? 1 : 0.7;
      c.fillRect(x, y, w, h);
      if (it.frame) {
        c.globalAlpha = 0.35;
        c.strokeStyle = '#000';
        c.lineWidth = 0.5;
        c.strokeRect(x, y, w, h);
      }
    }
    c.globalAlpha = 1;
    // Viewport within the map (a view beyond the content edge is clamped to the edge).
    let [vx, vy, vw, vh] = px(view);
    const x0 = Math.max(1, Math.min(W - 3, vx));
    const y0 = Math.max(1, Math.min(H - 3, vy));
    const x1 = Math.max(x0 + 2, Math.min(W - 1, vx + vw));
    const y1 = Math.max(y0 + 2, Math.min(H - 1, vy + vh));
    [vx, vy, vw, vh] = [x0, y0, x1 - x0, y1 - y0];
    c.fillStyle = `${accent}22`;
    c.fillRect(vx, vy, vw, vh);
    c.strokeStyle = accent;
    c.lineWidth = 1.5;
    c.strokeRect(vx + 0.75, vy + 0.75, Math.max(1, vw - 1.5), Math.max(1, vh - 1.5));
  }
}
