// Columns, rows and grid in frames (layout guides): semi-transparent strips over
// the frame; layers snap to their edges. Ctrl+Shift+4 shows or hides them.

import type { Canvas, Paint } from 'canvaskit-wasm';
import type { LayoutGrid, Matrix } from '@mfp/core';
import type { Editor } from './editor.ts';

const RED = { r: 1, g: 0, b: 0, a: 0.1 };

/** Column (or row) strips of a frame of width (height) size: start and size of each strip. */
export function stripes(g: Extract<LayoutGrid, { pattern: 'COLUMNS' | 'ROWS' }>, size: number): [number, number][] {
  const n = Math.max(1, Math.round(g.count));
  const gutter = g.gutterSize ?? 0;
  const offset = g.offset ?? 0;
  let w = g.sectionSize ?? 0;
  let start: number;
  switch (g.alignment) {
    case 'STRETCH':
      w = (size - 2 * offset - (n - 1) * gutter) / n;
      start = offset;
      break;
    case 'MAX':
      start = size - offset - n * w - (n - 1) * gutter;
      break;
    case 'CENTER':
      start = (size - (n * w + (n - 1) * gutter)) / 2 + offset;
      break;
    default:
      start = offset;
  }
  const out: [number, number][] = [];
  if (!(w > 0)) return out;
  for (let i = 0; i < n; i++) out.push([start + i * (w + gutter), w]);
  return out;
}

/** Snapping lines: strip edges and grid lines in frame coordinates. */
export function gridLines(grids: readonly LayoutGrid[], w: number, h: number): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const g of grids) {
    if (g.visible === false) continue;
    if (g.pattern === 'GRID') {
      const s = g.sectionSize;
      if (!(s >= 2)) continue;
      for (let x = s; x < w && xs.length < 2000; x += s) xs.push(x);
      for (let y = s; y < h && ys.length < 2000; y += s) ys.push(y);
      continue;
    }
    for (const [a, size] of stripes(g, g.pattern === 'COLUMNS' ? w : h)) (g.pattern === 'COLUMNS' ? xs : ys).push(a, a + size);
  }
  return { xs, ys };
}

export class LayoutGrids {
  private ed: Editor;
  visible = true;
  /** Frames with layout grids on the open page (null: find again); deleted and moved-away ones are filtered out when drawing. */
  private frames: Set<string> | null = null;
  private paint: Paint | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.underlays.push((canvas) => this.draw(canvas));
    // The list of frames with grids is updated from edits (walking the whole page of a large file on every
    // drag step ate half a frame, and tens of milliseconds after moving a layer) and rebuilt
    // on another page.
    ed.onDocument.push((ops) => {
      const frames = this.frames;
      if (!frames) return;
      const doc = ed.doc;
      const has = (id: string) => !!doc.get(id, 'layoutGrids')?.length;
      for (const o of ops) {
        if (o.op === 'set' && 'layoutGrids' in o.props) {
          if (has(o.id)) frames.add(o.id);
          else frames.delete(o.id);
        } else if (o.op === 'create') {
          if (has(o.id)) frames.add(o.id);
        } else if (o.op === 'move') {
          // It may have been moved from another page, with its subtree.
          if (has(o.id)) frames.add(o.id);
          for (const d of doc.descendants(o.id)) if (has(d)) frames.add(d);
        }
      }
    });
    ed.onPage.push(() => (this.frames = null));
  }

  toggle() {
    this.visible = !this.visible;
    this.ed.dirty = true;
  }

  private withGrids(): Set<string> {
    if (this.frames) return this.frames;
    const doc = this.ed.doc;
    const out = new Set<string>();
    for (const id of doc.descendants(this.ed.pageId)) if ((doc.get(id, 'layoutGrids') ?? []).length) out.add(id);
    this.frames = out;
    return out;
  }

  private draw(canvas: Canvas) {
    if (!this.visible) return;
    const ed = this.ed;
    const doc = ed.doc;
    const ck = ed.ck;
    const view = ed.viewportRect();
    const cam = ed.camera;
    this.paint ??= new ck.Paint();
    const p = this.paint;
    p.setAntiAlias(true);
    const frames = this.withGrids();
    for (const id of frames) {
      if (!doc.has(id) || !doc.get(id, 'layoutGrids')?.length) {
        frames.delete(id);
        continue;
      }
      if (doc.get(id, 'visible') === false || !ed.isOnPage(id)) continue;
      const b = ed.selectionBounds([id]);
      if (!b || b[2] < view[0] || b[0] > view[2] || b[3] < view[1] || b[1] > view[3]) continue;
      const m = ed.worldMatrix(id) as Matrix;
      const w = doc.get(id, 'width') ?? 0;
      const h = doc.get(id, 'height') ?? 0;
      // Canvas in frame coordinates (screen = (world − camera) · scale; the frame may be rotated):
      // strips are drawn as rectangles, without building paths every frame.
      const z = cam.zoom;
      canvas.save();
      canvas.concat([m[0] * z, m[1] * z, (m[2] - cam.x) * z, m[3] * z, m[4] * z, (m[5] - cam.y) * z, 0, 0, 1]);
      const quad = (x0: number, y0: number, x1: number, y1: number) => canvas.drawRect(ck.LTRBRect(x0, y0, x1, y1), p);
      for (const g of doc.get(id, 'layoutGrids') ?? []) {
        if (g.visible === false) continue;
        const c = g.color ?? RED;
        if (g.pattern === 'GRID') {
          // Grid lines only when cells on screen are at least 4 px.
          const s = g.sectionSize;
          if (!(s * ed.camera.zoom >= 4)) continue;
          p.setColor(ck.Color4f(c.r, c.g, c.b, Math.min(1, (c.a ?? 0.1) * 2)));
          p.setStyle(ck.PaintStyle.Fill);
          const t = 1 / ed.camera.zoom;
          for (let x = s; x < w; x += s) quad(x - t / 2, 0, x + t / 2, h);
          for (let y = s; y < h; y += s) quad(0, y - t / 2, w, y + t / 2);
          continue;
        }
        p.setColor(ck.Color4f(c.r, c.g, c.b, c.a ?? 0.1));
        p.setStyle(ck.PaintStyle.Fill);
        for (const [a, size] of stripes(g, g.pattern === 'COLUMNS' ? w : h)) {
          if (g.pattern === 'COLUMNS') quad(a, 0, a + size, h);
          else quad(0, a, w, a + size);
        }
      }
      canvas.restore();
    }
  }
}
