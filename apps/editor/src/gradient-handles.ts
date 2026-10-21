// Gradient handles on the canvas: while a gradient is open in the paint popover, the layer shows its
// handles: start and end for linear, center and two radii for the rest (with the shape outline),
// color stops on the axis. Dragging a handle changes gradientTransform (Shift snaps the axis to 45°),
// dragging a stop changes its position. One drag is one undo step.

import type { Canvas, Paint as SkPaint } from 'canvaskit-wasm';
import { invert, type GradientPaint, type Matrix, type Paint } from '@mfp/core';
import type { Editor } from './editor.ts';
import { dragHandle, gradientHandles, sortStops, toLayer, type Pt } from './gradient.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';
import { snapGradientPoint, type GradientGuide } from './gradient-snap.ts';

export interface GradientTarget {
  id: string;
  key: 'fills' | 'strokes';
  index: number;
  /** Selected color stop (highlighted). */
  stop: number;
}

const HANDLE_R = 5;
const STOP = 10;
const HIT = 8;

export class GradientHandles implements PointerInterceptor {
  private ed: Editor;
  target: GradientTarget | null = null;
  /** A color stop was selected on the canvas (wired in main.ts: the paint popover shows its color). */
  onStop: ((i: number) => void) | null = null;
  private drag: { kind: 'handle' | 'stop'; i: number } | null = null;
  private paints: { line: SkPaint; shadow: SkPaint; fill: SkPaint; ring: SkPaint; accent: SkPaint; thin: SkPaint } | null = null;
  private accentV = -1;
  private guides: GradientGuide[] = [];

  constructor(ed: Editor) {
    this.ed = ed;
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  get active() {
    return this.drag !== null;
  }

  set(target: GradientTarget | null) {
    this.guides = [];
    this.target = target;
    // While gradient handles are visible, the layer box has no resize handles.
    this.ed.hideHandles = !!target;
    this.ed.dirty = true;
  }

  private paint(): GradientPaint | null {
    const t = this.target;
    const doc = this.ed.doc;
    if (!t || !doc.has(t.id)) return null;
    const p = ((doc.get(t.id, t.key) ?? []) as Paint[])[t.index];
    return p && p.type !== 'SOLID' && p.type !== 'IMAGE' && p.type !== 'VIDEO' && p.type !== 'LOTTIE' && p.type !== 'MODEL3D' && p.type !== 'PATTERN' && p.type !== 'SHADER' && p.type !== 'GRADIENT_FREEFORM' ? p : null;
  }

  private size(): [number, number] {
    const id = this.target!.id;
    return [this.ed.doc.get(id, 'width') ?? 0, this.ed.doc.get(id, 'height') ?? 0];
  }

  /** Normalized layer point → screen. */
  private toScreen(q: Pt): Pt {
    const [w, h] = this.size();
    const m = this.ed.worldMatrix(this.target!.id) as Matrix;
    const x = q[0] * w;
    const y = q[1] * h;
    return this.ed.worldToScreen(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
  }

  /** World → layer pixels. */
  private toLocal(wx: number, wy: number): Pt {
    const m = invert(this.ed.worldMatrix(this.target!.id) as Matrix);
    return [m[0] * wx + m[1] * wy + m[2], m[3] * wx + m[4] * wy + m[5]];
  }

  private screenState(p: GradientPaint) {
    const handles = gradientHandles(p).map((q) => this.toScreen(q)) as [Pt, Pt, Pt];
    const [a, b] = handles;
    const stops = p.gradientStops.map((s): Pt => [a[0] + (b[0] - a[0]) * s.position, a[1] + (b[1] - a[1]) * s.position]);
    return { handles, stops };
  }

  /** What is under the pointer (screen coordinates): a handle or a color stop. */
  private hitAt(sx: number, sy: number): { kind: 'handle' | 'stop'; i: number } | null {
    const p = this.paint();
    if (!p) return null;
    const { handles, stops } = this.screenState(p);
    const near = (q: Pt, r: number) => Math.hypot(q[0] - sx, q[1] - sy) <= r;
    // Stops at the axis ends coincide with the handles; they are moved in the popover strip, the canvas takes the handle.
    for (let i = stops.length - 1; i >= 0; i--) {
      const pos = p.gradientStops[i]!.position;
      if (pos > 0.001 && pos < 0.999 && near(stops[i]!, STOP / 2 + 2)) return { kind: 'stop', i };
    }
    const shown = p.type === 'GRADIENT_LINEAR' ? 2 : 3;
    for (let i = 0; i < shown; i++) if (near(handles[i]!, HIT)) return { kind: 'handle', i };
    return null;
  }

  /** Pointer is over a handle (for the paint popover: such a click does not close it). */
  hitEvent(e: PointerEvent): boolean {
    if (!this.target) return false;
    const r = this.ed.canvasEl.getBoundingClientRect();
    return !!this.hitAt(e.clientX - r.left, e.clientY - r.top);
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.target || e.button !== 0) return false;
    const [sx, sy] = this.ed.worldToScreen(wx, wy);
    const hit = this.hitAt(sx, sy);
    if (!hit) return false;
    this.drag = hit;
    if (hit.kind === 'stop') {
      this.target.stop = hit.i;
      this.onStop?.(hit.i);
    }
    this.ed.doc.beginGroup();
    this.ed.dirty = true;
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.target) return false;
    const [sx, sy] = this.ed.worldToScreen(wx, wy);
    if (!this.drag) {
      const hit = this.hitAt(sx, sy);
      if (!hit) return false;
      this.ed.canvasEl.style.cursor = hit.kind === 'stop' ? 'grab' : 'move';
      return true;
    }
    const p = this.paint();
    if (!p) return true;
    this.guides = [];
    const t = this.target;
    let next: GradientPaint;
    if (this.drag.kind === 'stop') {
      const { handles } = this.screenState(p);
      const [a, b] = handles;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const pos = Math.max(0, Math.min(1, ((sx - a[0]) * dx + (sy - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      // Stops are kept in ascending order; one dragged past its neighbor changes index, so track it.
      const r = sortStops(
        p.gradientStops.map((s, k) => (k === this.drag!.i ? { ...s, position: Math.round(pos * 1000) / 1000 } : s)),
        this.drag.i,
      );
      if (r.index !== this.drag.i) {
        this.drag.i = r.index;
        t.stop = r.index;
        this.onStop?.(r.index);
      }
      next = { ...p, gradientStops: r.stops };
    } else {
      const [w, h] = this.size();
      let to = this.toLocal(wx, wy);
      // Shift: gradient axis in 45° steps from the fixed point.
      const i = this.drag.i;
      const pts = gradientHandles(p).map((q): Pt => [q[0] * w, q[1] * h]);
      let constraint: { origin: Pt; direction: Pt } | undefined;
      if (e.shiftKey && i < 2) {
        const fixed = p.type === 'GRADIENT_LINEAR' ? pts[1 - i]! : pts[0]!;
        if (p.type === 'GRADIENT_LINEAR' || i === 1) {
          const ang = Math.round(Math.atan2(to[1] - fixed[1], to[0] - fixed[0]) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(to[0] - fixed[0], to[1] - fixed[1]);
          to = [fixed[0] + Math.cos(ang) * len, fixed[1] + Math.sin(ang) * len];
          constraint = { origin: fixed, direction: [Math.cos(ang), Math.sin(ang)] };
        }
      }
      if (i === 2) {
        const a = pts[0]!, b = pts[1]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const d: Pt = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
        const along = (to[0] - a[0]) * d[0] + (to[1] - a[1]) * d[1];
        to = [a[0] + d[0] * along, a[1] + d[1] * along];
        constraint = { origin: a, direction: d };
      }
      if (!e.ctrlKey && !e.metaKey && w > 0 && h > 0) {
        const snapped = snapGradientPoint(to, w, h, q => this.toScreen([q[0] / w, q[1] / h]), pts.filter((_, k) => k !== i), constraint);
        const fixed = p.type === 'GRADIENT_LINEAR' ? pts[1 - i] : i > 0 ? pts[0] : null;
        if (!fixed || Math.hypot(snapped.point[0] - fixed[0], snapped.point[1] - fixed[1]) > 1e-5) {
          to = snapped.point; this.guides = snapped.guides;
        }
      }
      next = { ...p, gradientTransform: dragHandle(p, i, to, w, h) };
    }
    const doc = this.ed.doc;
    doc.transact(() => {
      const list = [...((doc.get(t.id, t.key) ?? []) as Paint[])];
      list[t.index] = next;
      doc.set(t.id, { [t.key]: list });
    });
    return true;
  }

  up(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.guides = [];
    this.ed.dirty = true;
    this.ed.doc.endGroup();
    return true;
  }

  private draw(canvas: Canvas) {
    const p = this.paint();
    if (!p || this.ed.tool !== 'select') return;
    const ck = this.ed.ck;
    // The theme changed the selection color; recreate the paints.
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
        accent: mk(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 1), 2),
        thin: mk(ck.Color(255, 255, 255, 0.8), 1),
      };
    }
    const P = this.paints;
    const [w, h] = this.size();
    if (w > 0 && h > 0) for (const [u, v] of this.guides) {
      const a = this.toScreen([u[0] / w, u[1] / h]), b = this.toScreen([v[0] / w, v[1] / h]);
      canvas.drawLine(a[0], a[1], b[0], b[1], P.accent);
    }
    const { handles, stops } = this.screenState(p);
    const [a, b, c] = handles;
    const line = (u: Pt, v: Pt) => {
      canvas.drawLine(u[0], u[1], v[0], v[1], P.shadow);
      canvas.drawLine(u[0], u[1], v[0], v[1], P.line);
    };
    // Shape outline: an ellipse for radial and angular, a diamond for diamond.
    if (p.type !== 'GRADIENT_LINEAR') {
      const pts: Pt[] =
        p.type === 'GRADIENT_DIAMOND'
          ? [
              [1, 0.5],
              [0.5, 1],
              [0, 0.5],
              [0.5, 0],
            ]
          : Array.from({ length: 72 }, (_, k): Pt => [0.5 + 0.5 * Math.cos((k / 72) * Math.PI * 2), 0.5 + 0.5 * Math.sin((k / 72) * Math.PI * 2)]);
      const pb = new ck.PathBuilder();
      pts.map((q) => this.toScreen(toLayer(p, q))).forEach(([x, y], k) => (k ? pb.lineTo(x, y) : pb.moveTo(x, y)));
      pb.close();
      const path = pb.detachAndDelete();
      canvas.drawPath(path, P.shadow);
      canvas.drawPath(path, P.thin);
      path.delete();
      line(a, c);
    }
    line(a, b);
    const circle = (q: Pt, r: number) => {
      canvas.drawCircle(q[0], q[1], r + 1, P.ring);
      canvas.drawCircle(q[0], q[1], r, P.fill);
    };
    circle(a, HANDLE_R);
    circle(b, HANDLE_R);
    if (p.type !== 'GRADIENT_LINEAR') circle(c, HANDLE_R - 1);
    // Color stops: squares in the stop color on the axis; the selected one has a blue border.
    p.gradientStops.forEach((s, i) => {
      const [x, y] = stops[i]!;
      const r = ck.XYWHRect(x - STOP / 2, y - STOP / 2, STOP, STOP);
      const rr = ck.RRectXY(r, 2, 2);
      const fill = new ck.Paint();
      fill.setAntiAlias(true);
      fill.setColor(ck.Color4f(s.color.r, s.color.g, s.color.b, Math.max(0.15, s.color.a)));
      canvas.drawRRect(ck.RRectXY(ck.XYWHRect(x - STOP / 2 - 2, y - STOP / 2 - 2, STOP + 4, STOP + 4), 3, 3), P.fill);
      canvas.drawRRect(rr, fill);
      fill.delete();
      if (i === this.target!.stop) canvas.drawRRect(ck.RRectXY(ck.XYWHRect(x - STOP / 2 - 3, y - STOP / 2 - 3, STOP + 6, STOP + 6), 4, 4), P.accent);
      else canvas.drawRRect(ck.RRectXY(ck.XYWHRect(x - STOP / 2 - 2.5, y - STOP / 2 - 2.5, STOP + 5, STOP + 5), 3, 3), P.ring);
    });
  }
}
