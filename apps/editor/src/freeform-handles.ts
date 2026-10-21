// Freeform gradient points on the canvas (MFP's own): for a selected layer with a freeform gradient
// fill, circles in the points' colors. Dragging moves a point (fractions of the layer box, may go
// outside it); one drag is one undo step. Point color and strength are edited in the paint popover.

import type { Canvas, Paint as SkPaint } from 'canvaskit-wasm';
import { invert, type FreeformGradientPaint, type Matrix, type Paint } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';

type Pt = [number, number];
const R = 6;
const HIT = 9;

export class FreeformHandles implements PointerInterceptor {
  private ed: Editor;
  private drag: { id: string; fill: number; i: number } | null = null;
  private paints: { ring: SkPaint; shadow: SkPaint; fill: SkPaint } | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  get active() {
    return this.drag !== null;
  }

  private target(): { id: string; fill: number; p: FreeformGradientPaint } | null {
    const ed = this.ed;
    if (ed.selection.length !== 1 || ed.tool !== 'select' || ed.devMode) return null;
    const id = ed.selection[0]!;
    const fills = (ed.doc.get(id, 'fills') ?? []) as Paint[];
    const fill = fills.findIndex((f) => f.type === 'GRADIENT_FREEFORM' && f.visible !== false);
    return fill < 0 ? null : { id, fill, p: fills[fill] as FreeformGradientPaint };
  }

  private points(t: { id: string; p: FreeformGradientPaint }): Pt[] {
    const m = this.ed.worldMatrix(t.id) as Matrix;
    const w = this.ed.doc.get(t.id, 'width') ?? 0;
    const h = this.ed.doc.get(t.id, 'height') ?? 0;
    return t.p.points.map((q) => this.ed.worldToScreen(m[0] * q.x * w + m[1] * q.y * h + m[2], m[3] * q.x * w + m[4] * q.y * h + m[5]));
  }

  private hitAt(sx: number, sy: number) {
    const t = this.target();
    if (!t) return null;
    const pts = this.points(t);
    for (let i = pts.length - 1; i >= 0; i--) if (Math.hypot(pts[i]![0] - sx, pts[i]![1] - sy) <= HIT) return { id: t.id, fill: t.fill, i };
    return null;
  }

  /** Pointer is over a point (a click there does not close the paint popover). */
  hitEvent(e: PointerEvent): boolean {
    const r = this.ed.canvasEl.getBoundingClientRect();
    return !!this.hitAt(e.clientX - r.left, e.clientY - r.top);
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (e.button !== 0) return false;
    const [sx, sy] = this.ed.worldToScreen(wx, wy);
    const hit = this.hitAt(sx, sy);
    if (!hit) return false;
    this.drag = hit;
    this.ed.doc.beginGroup();
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.drag) {
      const [sx, sy] = this.ed.worldToScreen(wx, wy);
      if (!this.hitAt(sx, sy)) return false;
      this.ed.canvasEl.style.cursor = 'move';
      return true;
    }
    const { id, fill, i } = this.drag;
    const doc = this.ed.doc;
    const fills = [...((doc.get(id, 'fills') ?? []) as Paint[])];
    const f = fills[fill];
    if (!f || f.type !== 'GRADIENT_FREEFORM') return true;
    const inv = invert(this.ed.worldMatrix(id) as Matrix);
    const w = doc.get(id, 'width') || 1;
    const h = doc.get(id, 'height') || 1;
    const x = Math.round(((inv[0] * wx + inv[1] * wy + inv[2]) / w) * 1000) / 1000;
    const y = Math.round(((inv[3] * wx + inv[4] * wy + inv[5]) / h) * 1000) / 1000;
    fills[fill] = { ...f, points: f.points.map((q, k) => (k === i ? { ...q, x, y } : q)) };
    doc.transact(() => doc.set(id, { fills }));
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
    if (!this.paints) {
      const mk = (c: Float32Array, stroke = 0) => {
        const q = new ck.Paint();
        q.setAntiAlias(true);
        q.setColor(c);
        if (stroke) {
          q.setStyle(ck.PaintStyle.Stroke);
          q.setStrokeWidth(stroke);
        }
        return q;
      };
      this.paints = { ring: mk(ck.Color(255, 255, 255, 1), 2), shadow: mk(ck.Color(0, 0, 0, 0.45), 1), fill: mk(ck.Color(0, 0, 0, 1)) };
    }
    const P = this.paints;
    this.points(t).forEach(([x, y], i) => {
      const c = t.p.points[i]!.color;
      P.fill.setColor(ck.Color4f(c.r, c.g, c.b, 1));
      canvas.drawCircle(x, y, R + 1.5, P.shadow);
      canvas.drawCircle(x, y, R, P.fill);
      canvas.drawCircle(x, y, R, P.ring);
    });
  }
}
