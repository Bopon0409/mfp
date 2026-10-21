// Free distort handles (our own): for a selected layer with distortion — four diamonds
// at the corners of the resulting quadrilateral. Dragging a corner moves it (Shift — only
// horizontally or vertically); one drag — one undo step. A non-convex quadrilateral is not
// accepted (the corner stops). Distortion is enabled in the “Position” panel (“+ Distort”).

import type { Canvas, Paint as SkPaint } from 'canvaskit-wasm';
import { distortMatrix, FLAT_DISTORT, invert, type Matrix } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';

type Pt = [number, number];
const HIT = 9;
const SIZE = 5;

export class DistortHandles implements PointerInterceptor {
  private ed: Editor;
  private drag: { id: string; i: number; start: Pt; base: number[] } | null = null;
  private paints: { fill: SkPaint; ring: SkPaint; line: SkPaint } | null = null;
  private accentV = -1;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  get active() {
    return this.drag !== null;
  }

  private target(): { id: string; d: number[] } | null {
    const ed = this.ed;
    if (ed.selection.length !== 1 || ed.tool !== 'select' || ed.devMode) return null;
    const id = ed.selection[0]!;
    const d = ed.doc.get(id, 'distort');
    return d && d.length === 8 ? { id, d } : null;
  }

  /** Corners on screen (via the layer's world matrix without projection). */
  private points(t: { id: string; d: number[] }): Pt[] {
    const m = this.ed.worldMatrix(t.id) as Matrix;
    const w = this.ed.doc.get(t.id, 'width') ?? 0;
    const h = this.ed.doc.get(t.id, 'height') ?? 0;
    const out: Pt[] = [];
    for (let i = 0; i < 4; i++) {
      const x = t.d[i * 2]! * w;
      const y = t.d[i * 2 + 1]! * h;
      out.push(this.ed.worldToScreen(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]));
    }
    return out;
  }

  private hitAt(sx: number, sy: number): { id: string; i: number; d: number[] } | null {
    const t = this.target();
    if (!t) return null;
    const pts = this.points(t);
    for (let i = 0; i < 4; i++) if (Math.hypot(pts[i]![0] - sx, pts[i]![1] - sy) <= HIT) return { id: t.id, i, d: t.d };
    return null;
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (e.button !== 0) return false;
    const [sx, sy] = this.ed.worldToScreen(wx, wy);
    const hit = this.hitAt(sx, sy);
    if (!hit) return false;
    this.drag = { id: hit.id, i: hit.i, start: [wx, wy], base: [...hit.d] };
    this.ed.doc.beginGroup();
    this.ed.dirty = true;
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.drag) {
      const [sx, sy] = this.ed.worldToScreen(wx, wy);
      if (!this.hitAt(sx, sy)) return false;
      this.ed.canvasEl.style.cursor = 'crosshair';
      return true;
    }
    const { id, i, start, base } = this.drag;
    const doc = this.ed.doc;
    const inv = invert(this.ed.worldMatrix(id) as Matrix);
    const loc = (x: number, y: number): Pt => [inv[0] * x + inv[1] * y + inv[2], inv[3] * x + inv[4] * y + inv[5]];
    const a = loc(start[0], start[1]);
    const b = loc(wx, wy);
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    if (e.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const w = doc.get(id, 'width') || 1;
    const h = doc.get(id, 'height') || 1;
    const next = [...base];
    next[i * 2] = Math.round((base[i * 2]! + dx / w) * 10000) / 10000;
    next[i * 2 + 1] = Math.round((base[i * 2 + 1]! + dy / h) * 10000) / 10000;
    const flat = FLAT_DISTORT.every((v, k) => v === next[k]);
    // An inverted quadrilateral is not accepted — the corner stays at the last valid position.
    if (!flat && !distortMatrix(next, w, h)) return true;
    doc.transact(() => doc.set(id, { distort: next }));
    return true;
  }

  up(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.ed.doc.endGroup();
    return true;
  }

  private draw(canvas: Canvas) {
    const t = this.target();
    if (!t) return;
    const ck = this.ed.ck;
    if (this.paints && this.accentV !== canvasAccent.version) {
      for (const p of Object.values(this.paints)) p.delete();
      this.paints = null;
    }
    if (!this.paints) {
      this.accentV = canvasAccent.version;
      const mk = (color: Float32Array, stroke = 0) => {
        const q = new ck.Paint();
        q.setAntiAlias(true);
        q.setColor(color);
        if (stroke) {
          q.setStyle(ck.PaintStyle.Stroke);
          q.setStrokeWidth(stroke);
        }
        return q;
      };
      const accent = ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 1);
      this.paints = { fill: mk(ck.Color(255, 255, 255, 1)), ring: mk(accent, 1.5), line: mk(accent, 1) };
    }
    const P = this.paints;
    const pts = this.points(t);
    for (let i = 0; i < 4; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % 4]!;
      canvas.drawLine(a[0], a[1], b[0], b[1], P.line);
    }
    for (const [x, y] of pts) {
      const path = new ck.PathBuilder();
      path.moveTo(x, y - SIZE - 1);
      path.lineTo(x + SIZE + 1, y);
      path.lineTo(x, y + SIZE + 1);
      path.lineTo(x - SIZE - 1, y);
      path.close();
      const p = path.detachAndDelete();
      canvas.drawPath(p, P.fill);
      canvas.drawPath(p, P.ring);
      p.delete();
    }
  }
}
