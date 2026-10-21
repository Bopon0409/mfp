// Progressive blur handles on the canvas: for a selected layer with such a blur —
// start (where the blur is startRadius) and end (radius), with a line between them. Dragging a handle moves
// the point (fractions of the layer bounds; Shift — direction in 45° steps); one drag — one undo step.

import type { Canvas, Paint as SkPaint } from 'canvaskit-wasm';
import { invert, type BlurEffect, type Effect, type Matrix } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';

type Pt = [number, number];

const HANDLE_R = 5;
const HIT = 8;

export class BlurHandles implements PointerInterceptor {
  private ed: Editor;
  private drag: { id: string; index: number; i: 0 | 1 } | null = null;
  private paints: { line: SkPaint; shadow: SkPaint; fill: SkPaint; ring: SkPaint; dot: SkPaint } | null = null;
  private accentV = -1;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  get active() {
    return this.drag !== null;
  }

  /** The selected layer and its progressive blur (the first visible one). */
  private target(): { id: string; index: number; e: BlurEffect } | null {
    const ed = this.ed;
    if (ed.selection.length !== 1 || ed.tool !== 'select') return null;
    const id = ed.selection[0]!;
    const list = (ed.doc.get(id, 'effects') ?? []) as Effect[];
    const index = list.findIndex((e) => (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') && e.blurType === 'PROGRESSIVE' && e.visible);
    return index < 0 ? null : { id, index, e: list[index] as BlurEffect };
  }

  /** Start and end on screen. */
  private points(t: { id: string; e: BlurEffect }): [Pt, Pt] {
    const doc = this.ed.doc;
    const w = doc.get(t.id, 'width') ?? 0;
    const h = doc.get(t.id, 'height') ?? 0;
    const m = this.ed.worldMatrix(t.id) as Matrix;
    const at = (q: { x: number; y: number }): Pt => {
      const x = q.x * w;
      const y = q.y * h;
      return this.ed.worldToScreen(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
    };
    return [at(t.e.startOffset ?? { x: 0.5, y: 0 }), at(t.e.endOffset ?? { x: 0.5, y: 1 })];
  }

  private hitAt(sx: number, sy: number): { id: string; index: number; i: 0 | 1 } | null {
    const t = this.target();
    if (!t) return null;
    const pts = this.points(t);
    // The end is on top (drawn second), so it is picked first.
    for (const i of [1, 0] as const) if (Math.hypot(pts[i][0] - sx, pts[i][1] - sy) <= HIT) return { id: t.id, index: t.index, i };
    return null;
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (e.button !== 0) return false;
    const [sx, sy] = this.ed.worldToScreen(wx, wy);
    const hit = this.hitAt(sx, sy);
    if (!hit) return false;
    this.drag = hit;
    this.ed.doc.beginGroup();
    this.ed.dirty = true;
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.drag) {
      const [sx, sy] = this.ed.worldToScreen(wx, wy);
      if (!this.hitAt(sx, sy)) return false;
      this.ed.canvasEl.style.cursor = 'move';
      return true;
    }
    const { id, index, i } = this.drag;
    const doc = this.ed.doc;
    const list = [...((doc.get(id, 'effects') ?? []) as Effect[])];
    const blur = list[index] as BlurEffect | undefined;
    if (!blur || (blur.type !== 'LAYER_BLUR' && blur.type !== 'BACKGROUND_BLUR')) return true;
    const w = doc.get(id, 'width') || 1;
    const h = doc.get(id, 'height') || 1;
    const m = invert(this.ed.worldMatrix(id) as Matrix);
    let lx = m[0] * wx + m[1] * wy + m[2];
    let ly = m[3] * wx + m[4] * wy + m[5];
    // Shift: direction from the fixed point in 45° steps.
    if (e.shiftKey) {
      const other = i === 0 ? (blur.endOffset ?? { x: 0.5, y: 1 }) : (blur.startOffset ?? { x: 0.5, y: 0 });
      const fx = other.x * w;
      const fy = other.y * h;
      const ang = Math.round(Math.atan2(ly - fy, lx - fx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(lx - fx, ly - fy);
      lx = fx + Math.cos(ang) * len;
      ly = fy + Math.sin(ang) * len;
    }
    const q = { x: Math.round((lx / w) * 1000) / 1000, y: Math.round((ly / h) * 1000) / 1000 };
    list[index] = { ...blur, ...(i === 0 ? { startOffset: q } : { endOffset: q }) };
    doc.transact(() => doc.set(id, { effects: list }));
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
    // The appearance changed the selection color — recreate the paints.
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
      this.paints = {
        line: mk(ck.Color(255, 255, 255, 1), 1.5),
        shadow: mk(ck.Color(0, 0, 0, 0.35), 3.5),
        fill: mk(ck.Color(255, 255, 255, 1)),
        ring: mk(ck.Color(0, 0, 0, 0.45), 1),
        dot: mk(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 1)),
      };
    }
    const P = this.paints;
    const [a, b] = this.points(t);
    canvas.drawLine(a[0], a[1], b[0], b[1], P.shadow);
    canvas.drawLine(a[0], a[1], b[0], b[1], P.line);
    // Start — a white circle (sharp), end — with a blue center (most blurred).
    for (const [q, end] of [
      [a, false],
      [b, true],
    ] as const) {
      canvas.drawCircle(q[0], q[1], HANDLE_R + 1, P.ring);
      canvas.drawCircle(q[0], q[1], HANDLE_R, P.fill);
      if (end) canvas.drawCircle(q[0], q[1], HANDLE_R - 2.5, P.dot);
    }
  }
}
