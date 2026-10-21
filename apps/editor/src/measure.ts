// Measurements on the canvas:
// - with Alt: orange lines with numbers from the selection to the layer under the cursor, or, if the cursor is over empty
//   space or over the parent, to the parent's edges;
// - while dragging: teal marks for equal gaps between siblings (computed by snap.ts).
// Lines are drawn on the canvas, numbers as elements on top of it (crisp interface font).

import type { Canvas, Paint } from 'canvaskit-wasm';
import type { Editor, Rect } from './editor.ts';
import { arrangement, gapHandles, reorderHandles } from './smart.ts';

/** A measurement segment in page coordinates and its label. */
export interface Span {
  a: [number, number];
  b: [number, number];
  label: string;
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

export class Measure {
  private ed: Editor;
  private root: HTMLElement;
  private alt = false;
  private labels: HTMLElement[] = [];
  private paints: { measure: Paint; spacing: Paint; dash: Paint } | null = null;

  constructor(ed: Editor, root: HTMLElement) {
    this.ed = ed;
    this.root = root;
    ed.overlays.push((canvas) => this.draw(canvas));
    const set = (alt: boolean) => {
      if (this.alt === alt) return;
      this.alt = alt;
      ed.dirty = true;
    };
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Alt') return;
      set(true);
      // Do not let the browser have Alt: on Windows it would move focus to the window menu.
      if (!(e.target as HTMLElement).closest?.('input, textarea')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      if (e.key !== 'Alt') return;
      set(false);
      if (!(e.target as HTMLElement).closest?.('input, textarea')) e.preventDefault();
    });
    window.addEventListener('pointermove', (e) => set(e.altKey));
    window.addEventListener('blur', () => set(false));
  }

  private paint(): { measure: Paint; spacing: Paint; dash: Paint } {
    if (this.paints) return this.paints;
    const ck = this.ed.ck;
    const make = (hex: number, dashed = false) => {
      const p = new ck.Paint();
      p.setColor(ck.Color((hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 1));
      p.setStyle(ck.PaintStyle.Stroke);
      p.setStrokeWidth(1);
      p.setAntiAlias(true);
      if (dashed) p.setPathEffect(ck.PathEffect.MakeDash([3, 3], 0));
      return p;
    };
    this.paints = { measure: make(0xff7a2e), spacing: make(0x24c1c9), dash: make(0xff7a2e, true) };
    return this.paints;
  }

  private fill: Paint | null = null;
  private handleFill(): Paint {
    if (this.fill) return this.fill;
    const ck = this.ed.ck;
    this.fill = new ck.Paint();
    this.fill.setColor(ck.Color(242, 80, 155, 1));
    this.fill.setAntiAlias(true);
    return this.fill;
  }

  /** Alt-measurement segments: from the selection to the target under the cursor (or to the container edges). */
  private altSpans(): { spans: Span[]; dashed: Span[]; target: Rect | null } {
    const ed = this.ed;
    const doc = ed.doc;
    const sel = ed.selection.filter((id) => doc.has(id) && ed.isOnPage(id));
    // In developer mode: on hover, even without Alt (the usual developer mode behavior).
    if ((!this.alt && !ed.devMode) || !sel.length || ed.tool !== 'select') return { spans: [], dashed: [], target: null };
    const A = ed.selectionBounds(sel);
    if (!A) return { spans: [], dashed: [], target: null };
    let target = ed.hover && doc.has(ed.hover) && !sel.includes(ed.hover) ? ed.hover : null;
    if (!target && ed.devMode && !this.alt) return { spans: [], dashed: [], target: null };
    if (!target) {
      const p = doc.parent(sel[0]!);
      if (p && p !== ed.pageId) target = p;
    }
    if (!target) return { spans: [], dashed: [], target: null };
    const B = ed.selectionBounds([target]);
    if (!B) return { spans: [], dashed: [], target: null };
    return { ...measureRects(A, B), target: B };
  }

  private draw(canvas: Canvas) {
    const ed = this.ed;
    const { spans, dashed, target } = this.altSpans();
    const p = this.paint();
    const scr = (pt: [number, number]) => ed.worldToScreen(pt[0], pt[1]);
    const px = (v: number) => Math.round(v) + 0.5;
    const line = (s: Span, paint: Paint, ticks: boolean) => {
      const [x0, y0] = scr(s.a);
      const [x1, y1] = scr(s.b);
      const horizontal = Math.abs(y1 - y0) < Math.abs(x1 - x0);
      if (horizontal) canvas.drawLine(x0, px(y0), x1, px(y1), paint);
      else canvas.drawLine(px(x0), y0, px(x1), y1, paint);
      if (!ticks) return;
      // End ticks run across the line.
      for (const [x, y] of [
        [x0, y0],
        [x1, y1],
      ] as const) {
        if (horizontal) canvas.drawLine(px(x), y - 4, px(x), y + 4, paint);
        else canvas.drawLine(x - 4, px(y), x + 4, px(y), paint);
      }
    };
    // Box of the Alt-measurement target.
    if (target) {
      const [x0, y0] = ed.worldToScreen(target[0], target[1]);
      const [x1, y1] = ed.worldToScreen(target[2], target[3]);
      canvas.drawRect(ed.ck.LTRBRect(px(x0), px(y0), px(x1), px(y1)), p.measure);
    }
    for (const s of spans) line(s, p.measure, false);
    for (const s of dashed) line(s, p.dash, false);
    for (const s of ed.spacings) line(s, p.spacing, true);
    // Smart selection: handles in the gaps of a row (until dragging starts; then the marks are shown).
    if (!ed.spacings.length) {
      const arr = arrangement(ed);
      if (arr) {
        const fill = this.handleFill();
        for (const hp of gapHandles(ed, arr)) {
          const r = arr.axis === 'x' ? ed.ck.XYWHRect(hp.x - 1.5, hp.y - 7, 3, 14) : ed.ck.XYWHRect(hp.x - 7, hp.y - 1.5, 14, 3);
          canvas.drawRRect(ed.ck.RRectXY(r, 1.5, 1.5), fill);
        }
        // Reorder points are at the layer centers.
        for (const hp of reorderHandles(ed, arr)) if (hp) canvas.drawCircle(hp.x, hp.y, 4, fill);
      }
    }
    // Labels.
    const all = [...spans.map((s) => [s, 'measure'] as const), ...ed.spacings.map((s) => [s, 'spacing'] as const)];
    while (this.labels.length < all.length) {
      const el = document.createElement('div');
      this.root.append(el);
      this.labels.push(el);
    }
    this.labels.forEach((el, i) => {
      const item = all[i];
      if (!item) {
        el.style.display = 'none';
        return;
      }
      const [s, kind] = item;
      const [x0, y0] = scr(s.a);
      const [x1, y1] = scr(s.b);
      el.className = `measure-label ${kind}`;
      if (el.textContent !== s.label) el.textContent = s.label;
      el.style.display = '';
      el.style.transform = `translate(calc(${Math.round((x0 + x1) / 2)}px - 50%), calc(${Math.round((y0 + y1) / 2)}px - 50%))`;
    });
  }
}

/**
 * Distances between rectangles A (selection) and B (target):
 * one inside the other: from each edge to the matching edge; side by side: gaps along the axes (through the middle
 * of the shared span; if there is none, from the selection center, with a dashed line to the target).
 */
export function measureRects(A: Rect, B: Rect): { spans: Span[]; dashed: Span[] } {
  const spans: Span[] = [];
  const dashed: Span[] = [];
  const push = (a: [number, number], b: [number, number], d: number) => {
    if (d > 0.005) spans.push({ a, b, label: fmt(d) });
  };
  const overlapX = A[0] < B[2] && A[2] > B[0];
  const overlapY = A[1] < B[3] && A[3] > B[1];
  if (overlapX && overlapY) {
    // Inside (or overlapping): from the inner edges to the outer edges.
    const [inner, outer] = A[0] >= B[0] && A[2] <= B[2] && A[1] >= B[1] && A[3] <= B[3] ? [A, B] : [B, A];
    const cx = (inner[0] + inner[2]) / 2;
    const cy = (inner[1] + inner[3]) / 2;
    push([outer[0], cy], [inner[0], cy], inner[0] - outer[0]);
    push([inner[2], cy], [outer[2], cy], outer[2] - inner[2]);
    push([cx, outer[1]], [cx, inner[1]], inner[1] - outer[1]);
    push([cx, inner[3]], [cx, outer[3]], outer[3] - inner[3]);
    return { spans, dashed };
  }
  const cx = (A[0] + A[2]) / 2;
  const cy = (A[1] + A[3]) / 2;
  // Horizontally: the gap between the nearest edges.
  if (!overlapX) {
    const [x0, x1] = A[2] <= B[0] ? [A[2], B[0]] : [B[2], A[0]];
    const y = overlapY ? (Math.max(A[1], B[1]) + Math.min(A[3], B[3])) / 2 : cy;
    push([x0, y], [x1, y], x1 - x0);
    if (!overlapY) dashed.push({ a: [A[2] <= B[0] ? x1 : x0, y], b: [A[2] <= B[0] ? x1 : x0, y < B[1] ? B[1] : B[3]], label: '' });
  }
  if (!overlapY) {
    const [y0, y1] = A[3] <= B[1] ? [A[3], B[1]] : [B[3], A[1]];
    const x = overlapX ? (Math.max(A[0], B[0]) + Math.min(A[2], B[2])) / 2 : cx;
    push([x, y0], [x, y1], y1 - y0);
    if (!overlapX) dashed.push({ a: [x, A[3] <= B[1] ? y1 : y0], b: [x < B[0] ? B[0] : B[2], A[3] <= B[1] ? y1 : y0], label: '' });
  }
  return { spans, dashed };
}
