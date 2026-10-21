// Shape handles on the canvas: for an ellipse — arc (sweep, start) and hole (ring),
// for a star — ray ratio. One drag — one undo step; Shift — angles in 15° steps.

import type { Canvas, Paint as SkPaint } from 'canvaskit-wasm';
import { invert, type ArcData, type Matrix } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';

type Pt = [number, number];
type Kind = 'sweep' | 'start' | 'ratio' | 'star';

const TAU = Math.PI * 2;
const R = 4.5;
const HIT = 8;
/** Arc handles sit this many screen pixels inside the ellipse (not to be confused with resize handles). */
const INSET = 14;
const FULL: ArcData = { startingAngle: 0, endingAngle: TAU, innerRadius: 0 };

const sweepOf = (a: ArcData) => {
  const s = (((a.endingAngle - a.startingAngle) % TAU) + TAU) % TAU;
  return s < 1e-6 ? TAU : s;
};

export class ShapeHandles implements PointerInterceptor {
  private ed: Editor;
  private drag: { kind: Kind; id: string } | null = null;
  private paints: { fill: SkPaint; ring: SkPaint; line: SkPaint } | null = null;
  private accentV = -1;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  get active() {
    return this.drag !== null;
  }

  /** Shape with handles: a single selected ellipse or star, the “Selection” tool, at least 24 px on screen. */
  private target(): string | null {
    const { ed } = this;
    if (ed.tool !== 'select' || ed.selection.length !== 1 || ed.hideHandles) return null;
    const id = ed.selection[0]!;
    const t = ed.doc.has(id) ? ed.doc.type(id) : null;
    if (t !== 'ELLIPSE' && t !== 'STAR') return null;
    const w = (ed.doc.get(id, 'width') ?? 0) * ed.camera.zoom;
    const h = (ed.doc.get(id, 'height') ?? 0) * ed.camera.zoom;
    return w >= 24 && h >= 24 ? id : null;
  }

  private matrix(id: string): Matrix {
    return this.ed.worldMatrix(id) as Matrix;
  }

  /** Shape point (unit circle → ellipse in the node's box) on screen. */
  private onShape(id: string, angle: number, radius: number, inset = 0): Pt {
    const doc = this.ed.doc;
    const w = doc.get(id, 'width') ?? 0;
    const h = doc.get(id, 'height') ?? 0;
    const m = this.matrix(id);
    // Inward offset — in screen pixels, toward the center.
    const z = this.ed.camera.zoom;
    const rx = Math.max(0, (w / 2) * radius - inset / z);
    const ry = Math.max(0, (h / 2) * radius - inset / z);
    const x = w / 2 + rx * Math.cos(angle);
    const y = h / 2 + ry * Math.sin(angle);
    return this.ed.worldToScreen(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
  }

  /** Pointer → angle and radius ratio in the shape's “unit circle”. */
  private polar(id: string, wx: number, wy: number): { angle: number; radius: number } {
    const doc = this.ed.doc;
    const w = doc.get(id, 'width') ?? 1;
    const h = doc.get(id, 'height') ?? 1;
    const m = invert(this.matrix(id));
    const x = m[0] * wx + m[1] * wy + m[2];
    const y = m[3] * wx + m[4] * wy + m[5];
    const ux = (x - w / 2) / (w / 2 || 1);
    const uy = (y - h / 2) / (h / 2 || 1);
    return { angle: Math.atan2(uy, ux), radius: Math.hypot(ux, uy) };
  }

  private handles(id: string): { kind: Kind; at: Pt }[] {
    const doc = this.ed.doc;
    if (doc.type(id) === 'STAR') {
      const n = Math.max(3, doc.get(id, 'pointCount') ?? 5);
      const ratio = doc.get(id, 'innerRadius') ?? 0.382;
      return [{ kind: 'star', at: this.onShape(id, -Math.PI / 2 + Math.PI / n, ratio) }];
    }
    const arc = doc.get(id, 'arcData') ?? FULL;
    const sweep = sweepOf(arc);
    const full = sweep >= TAU - 1e-6;
    const out: { kind: Kind; at: Pt }[] = [{ kind: 'sweep', at: this.onShape(id, arc.startingAngle + sweep, 1, INSET) }];
    if (!full) out.push({ kind: 'start', at: this.onShape(id, arc.startingAngle, 1, INSET) });
    // Hole: at the center, and for a ring — on the inner radius at the middle of the arc.
    out.push({ kind: 'ratio', at: arc.innerRadius > 0 ? this.onShape(id, arc.startingAngle + sweep / 2, arc.innerRadius) : this.onShape(id, 0, 0) });
    return out;
  }

  private hitAt(id: string, sx: number, sy: number): Kind | null {
    let best: Kind | null = null;
    let bestD = HIT;
    for (const hd of this.handles(id)) {
      const d = Math.hypot(hd.at[0] - sx, hd.at[1] - sy);
      if (d <= bestD) {
        bestD = d;
        best = hd.kind;
      }
    }
    return best;
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    const id = this.target();
    if (!id || e.button !== 0) return false;
    const [sx, sy] = this.ed.worldToScreen(wx, wy);
    const kind = this.hitAt(id, sx, sy);
    if (!kind) return false;
    this.drag = { kind, id };
    this.ed.doc.beginGroup();
    this.ed.dirty = true;
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    const d = this.drag;
    if (!d) {
      const id = this.target();
      if (!id) return false;
      const [sx, sy] = this.ed.worldToScreen(wx, wy);
      const kind = this.hitAt(id, sx, sy);
      if (!kind) return false;
      this.ed.canvasEl.style.cursor = 'pointer';
      this.ed.canvasEl.title = { sweep: 'Дуга: охват', start: 'Дуга: начало', ratio: 'Отверстие', star: 'Доля лучей' }[kind];
      return true;
    }
    const doc = this.ed.doc;
    if (!doc.has(d.id)) return true;
    const { angle, radius } = this.polar(d.id, wx, wy);
    const snap = (a: number) => (e.shiftKey ? Math.round(a / (Math.PI / 12)) * (Math.PI / 12) : a);
    if (d.kind === 'star') {
      doc.set(d.id, { innerRadius: Math.round(Math.max(0, Math.min(1, radius)) * 1000) / 1000 });
    } else {
      const arc = doc.get(d.id, 'arcData') ?? FULL;
      if (d.kind === 'ratio') doc.set(d.id, { arcData: { ...arc, innerRadius: Math.round(Math.max(0, Math.min(1, radius)) * 1000) / 1000 } });
      else if (d.kind === 'start') {
        const start = snap(angle);
        doc.set(d.id, { arcData: { ...arc, startingAngle: start, endingAngle: start + sweepOf(arc) } });
      } else {
        // Sweep: clockwise from the start to the pointer; right at the start — a full ellipse.
        let sweep = (((snap(angle) - arc.startingAngle) % TAU) + TAU) % TAU;
        if (sweep < 0.02 || sweep > TAU - 0.02) sweep = TAU;
        doc.set(d.id, { arcData: { ...arc, endingAngle: arc.startingAngle + sweep } });
      }
    }
    this.ed.dirty = true;
    return true;
  }

  up(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.ed.doc.endGroup();
    this.ed.canvasEl.title = '';
    return true;
  }

  private draw(canvas: Canvas) {
    const id = this.target();
    if (!id) return;
    const ck = this.ed.ck;
    // The theme changed the selection color — recreate the paints.
    if (this.paints && this.accentV !== canvasAccent.version) {
      for (const p of Object.values(this.paints)) p.delete();
      this.paints = null;
    }
    if (!this.paints) {
      this.accentV = canvasAccent.version;
      const fill = new ck.Paint();
      fill.setAntiAlias(true);
      fill.setColor(ck.WHITE);
      const ring = new ck.Paint();
      ring.setAntiAlias(true);
      ring.setStyle(ck.PaintStyle.Stroke);
      ring.setStrokeWidth(1.5);
      ring.setColor(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 1));
      const line = new ck.Paint();
      line.setAntiAlias(true);
      line.setStyle(ck.PaintStyle.Stroke);
      line.setStrokeWidth(1);
      line.setColor(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 0.6));
      this.paints = { fill, ring, line };
    }
    const p = this.paints;
    for (const hd of this.handles(id)) {
      canvas.drawCircle(hd.at[0], hd.at[1], R, p.fill);
      canvas.drawCircle(hd.at[0], hd.at[1], R, p.ring);
    }
  }
}
