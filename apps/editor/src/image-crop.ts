// Image crop on the canvas: the layer box is the crop window, the image lies beneath it.
// Dragging inside moves the image; the image corner handles resize it (aspect ratio is kept,
// Alt scales from the center); the window handles resize the window (the image stays put). Outside the
// window the image is semi-transparent. Enter, Esc or a click outside exits. The model is the CROP-mode
// imageTransform: it maps normalized layer coordinates to normalized image coordinates.

import type { Canvas, Paint as SkPaint } from 'canvaskit-wasm';
import { invert, multiply, type ImagePaint, type Matrix, type Paint } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';

export interface CropTarget {
  id: string;
  key: 'fills' | 'strokes';
  index: number;
}

/** Image in layer pixels: top-left corner and size. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HIT = 8;

/** imageTransform → image rectangle in layer pixels (ignoring image rotation). */
export function cropRect(t: ImagePaint['imageTransform'], lw: number, lh: number): Rect {
  const [[a, , c], [, e, f]] = t ?? [
    [1, 0, 0],
    [0, 1, 0],
  ];
  const w = lw / (a || 1);
  const h = lh / (e || 1);
  return { x: -c * w, y: -f * h, w, h };
}

/** Image rectangle in layer pixels → imageTransform. */
export function cropTransform(r: Rect, lw: number, lh: number): NonNullable<ImagePaint['imageTransform']> {
  return [
    [lw / r.w, 0, -r.x / r.w],
    [0, lh / r.h, -r.y / r.h],
  ];
}

/** Where the image is now (FILL is “like cover”, FIT is “like contain”, CROP follows the matrix), to enter cropping without a jump. */
export function placedRect(p: ImagePaint, lw: number, lh: number, aspect: number): Rect {
  if (p.scaleMode === 'CROP' && p.imageTransform) return cropRect(p.imageTransform, lw, lh);
  const fit = p.scaleMode === 'FIT';
  const s = fit ? Math.min(lw / aspect, lh) : Math.max(lw / aspect, lh);
  const w = aspect * s;
  return { x: (lw - w) / 2, y: (lh - s) / 2, w, h: s };
}

export class ImageCrop implements PointerInterceptor {
  private ed: Editor;
  target: CropTarget | null = null;
  private drag: { kind: 'pan' | 'image' | 'frame'; i: number; start: [number, number]; rect: Rect; lw: number; lh: number; local: Matrix } | null = null;
  private paints: { line: SkPaint; dash: SkPaint; fill: SkPaint; ghost: SkPaint } | null = null;
  private accentV = -1;
  private keys = (e: KeyboardEvent) => {
    if (!this.target || (e.key !== 'Enter' && e.key !== 'Escape')) return;
    e.preventDefault();
    e.stopPropagation();
    this.stop();
  };
  /** Enter and exit (the panel shows a “Done” button). */
  onChange: (() => void) | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.overlays.push((c) => this.draw(c));
    ed.onSelection.push(() => {
      if (this.target && !(ed.selection.length === 1 && ed.selection[0] === this.target.id)) this.stop();
    });
  }

  get active() {
    return this.drag !== null;
  }

  private paint(): ImagePaint | null {
    const t = this.target;
    const doc = this.ed.doc;
    if (!t || !doc.has(t.id)) return null;
    const p = ((doc.get(t.id, t.key) ?? []) as Paint[])[t.index];
    return p?.type === 'IMAGE' ? p : null;
  }

  private size(): [number, number] {
    const id = this.target!.id;
    return [this.ed.doc.get(id, 'width') ?? 1, this.ed.doc.get(id, 'height') ?? 1];
  }

  /** Enter cropping: the paint switches to CROP with the same image position (one undo step). */
  start(target: CropTarget) {
    const doc = this.ed.doc;
    const p = ((doc.get(target.id, target.key) ?? []) as Paint[])[target.index];
    if (p?.type !== 'IMAGE' || !p.imageHash) return;
    this.target = target;
    const [lw, lh] = this.size();
    if (p.scaleMode !== 'CROP' || !p.imageTransform) {
      const img = this.ed.imageFor(p.imageHash, Math.max(lw, lh));
      const aspect = img ? img.width() / img.height() : 1;
      const r = placedRect(p, lw, lh, aspect);
      this.write({ ...p, scaleMode: 'CROP', rotation: 0, imageTransform: cropTransform(r, lw, lh) });
    }
    this.ed.hideHandles = true;
    window.addEventListener('keydown', this.keys, true);
    this.ed.dirty = true;
    this.onChange?.();
  }

  stop() {
    if (!this.target) return;
    if (this.drag) this.ed.doc.endGroup();
    this.drag = null;
    this.target = null;
    this.ed.hideHandles = false;
    window.removeEventListener('keydown', this.keys, true);
    this.ed.canvasEl.style.cursor = '';
    this.ed.dirty = true;
    this.onChange?.();
  }

  private write(next: ImagePaint, extra: Record<string, unknown> = {}) {
    const t = this.target!;
    const doc = this.ed.doc;
    doc.transact(() => {
      const list = [...((doc.get(t.id, t.key) ?? []) as Paint[])];
      list[t.index] = next;
      doc.set(t.id, { [t.key]: list, ...extra });
    });
  }

  /** Layer pixels → screen. */
  private toScreen(x: number, y: number): [number, number] {
    const m = this.ed.worldMatrix(this.target!.id) as Matrix;
    return this.ed.worldToScreen(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
  }

  /** World → layer pixels. */
  private toLocal(wx: number, wy: number): [number, number] {
    const m = invert(this.ed.worldMatrix(this.target!.id) as Matrix);
    return [m[0] * wx + m[1] * wy + m[2], m[3] * wx + m[4] * wy + m[5]];
  }

  private state() {
    const p = this.paint()!;
    const [lw, lh] = this.size();
    const r = cropRect(p.imageTransform, lw, lh);
    const corners: [number, number][] = [
      [r.x, r.y],
      [r.x + r.w, r.y],
      [r.x + r.w, r.y + r.h],
      [r.x, r.y + r.h],
    ];
    // Window handles: corners and side midpoints clockwise from the top left.
    const frame: [number, number][] = [
      [0, 0],
      [lw / 2, 0],
      [lw, 0],
      [lw, lh / 2],
      [lw, lh],
      [lw / 2, lh],
      [0, lh],
      [0, lh / 2],
    ];
    return { p, lw, lh, r, corners, frame };
  }

  private hitAt(sx: number, sy: number): { kind: 'pan' | 'image' | 'frame'; i: number } | null {
    if (!this.paint()) return null;
    const { r, lw, lh, corners, frame } = this.state();
    const near = (q: [number, number]) => {
      const [x, y] = this.toScreen(q[0], q[1]);
      return Math.hypot(x - sx, y - sy) <= HIT;
    };
    for (let i = 0; i < 8; i++) if (near(frame[i]!)) return { kind: 'frame', i };
    for (let i = 0; i < 4; i++) if (near(corners[i]!)) return { kind: 'image', i };
    const [lx, ly] = this.toLocal(...this.ed.screenToWorld(sx, sy));
    const inside = (lx >= 0 && ly >= 0 && lx <= lw && ly <= lh) || (lx >= r.x && ly >= r.y && lx <= r.x + r.w && ly <= r.y + r.h);
    return inside ? { kind: 'pan', i: 0 } : null;
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.target || e.button !== 0) return false;
    if (!this.paint()) {
      this.stop();
      return false;
    }
    const [sx, sy] = this.ed.worldToScreen(wx, wy);
    const hit = this.hitAt(sx, sy);
    // A click outside ends cropping (and the click still does its own thing).
    if (!hit) {
      this.stop();
      return false;
    }
    const { r, lw, lh } = this.state();
    this.drag = { ...hit, start: this.toLocal(wx, wy), rect: r, lw, lh, local: [...((this.ed.doc.get(this.target.id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix)] as Matrix };
    this.ed.doc.beginGroup();
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.target) return false;
    const [sx, sy] = this.ed.worldToScreen(wx, wy);
    const d = this.drag;
    if (!d) {
      const hit = this.hitAt(sx, sy);
      if (!hit) return false;
      const CUR = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];
      this.ed.canvasEl.style.cursor = hit.kind === 'pan' ? 'move' : hit.kind === 'image' ? (hit.i % 2 ? 'nesw-resize' : 'nwse-resize') : CUR[hit.i]!;
      return true;
    }
    const p = this.paint();
    if (!p) return true;
    // Offset is computed in layer pixels as of the drag start (the window may move by itself).
    const m0 = this.ed.worldMatrix(this.target.id) as Matrix;
    const parentWorld = multiply(m0, invert(this.ed.doc.get(this.target.id, 'transform') as Matrix));
    const startWorld = multiply(parentWorld, d.local);
    const inv = invert(startWorld);
    const [lx, ly] = [inv[0] * wx + inv[1] * wy + inv[2], inv[3] * wx + inv[4] * wy + inv[5]];
    const dx = lx - d.start[0];
    const dy = ly - d.start[1];
    const r0 = d.rect;
    if (d.kind === 'pan') {
      this.write({ ...p, imageTransform: cropTransform({ ...r0, x: r0.x + dx, y: r0.y + dy }, d.lw, d.lh) });
      return true;
    }
    if (d.kind === 'image') {
      // The opposite corner (or the center with Alt) stays fixed; the image aspect ratio is kept.
      const ax = e.altKey ? r0.x + r0.w / 2 : d.i === 0 || d.i === 3 ? r0.x + r0.w : r0.x;
      const ay = e.altKey ? r0.y + r0.h / 2 : d.i === 0 || d.i === 1 ? r0.y + r0.h : r0.y;
      const k = e.altKey ? 2 : 1;
      const sxk = Math.abs(lx - ax) * k / r0.w;
      const syk = Math.abs(ly - ay) * k / r0.h;
      const s = Math.max(0.02, Math.max(sxk, syk));
      const w = r0.w * s;
      const h = r0.h * s;
      const x = e.altKey ? ax - w / 2 : d.i === 0 || d.i === 3 ? ax - w : ax;
      const y = e.altKey ? ay - h / 2 : d.i === 0 || d.i === 1 ? ay - h : ay;
      this.write({ ...p, imageTransform: cropTransform({ x, y, w, h }, d.lw, d.lh) });
      return true;
    }
    // Window: move the sides of the layer box; the image stays put (its rectangle is relative to the new corner).
    let [x0, y0, x1, y1] = [0, 0, d.lw, d.lh];
    const i = d.i;
    if (i === 0 || i === 6 || i === 7) x0 = Math.min(d.lw - 1, dx);
    if (i === 2 || i === 3 || i === 4) x1 = Math.max(1, d.lw + dx);
    if (i === 0 || i === 1 || i === 2) y0 = Math.min(d.lh - 1, dy);
    if (i === 4 || i === 5 || i === 6) y1 = Math.max(1, d.lh + dy);
    const lw = x1 - x0;
    const lh = y1 - y0;
    const L = d.local;
    const transform: Matrix = [L[0], L[1], L[0] * x0 + L[1] * y0 + L[2], L[3], L[4], L[3] * x0 + L[4] * y0 + L[5]];
    this.write({ ...p, imageTransform: cropTransform({ ...r0, x: r0.x - x0, y: r0.y - y0 }, lw, lh) }, { width: lw, height: lh, transform });
    return true;
  }

  up(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.ed.doc.endGroup();
    return true;
  }

  private draw(canvas: Canvas) {
    const p = this.paint();
    if (!p || !this.target) return;
    const ck = this.ed.ck;
    if (this.paints && this.accentV !== canvasAccent.version) {
      for (const q of Object.values(this.paints)) q.delete();
      this.paints = null;
    }
    if (!this.paints) {
      this.accentV = canvasAccent.version;
      const mk = (stroke: number, color: Float32Array) => {
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
      const dash = mk(1, accent);
      dash.setPathEffect(ck.PathEffect.MakeDash([4, 3], 0));
      const ghost = new ck.Paint();
      ghost.setAlphaf(0.4);
      this.paints = { line: mk(1.5, accent), dash, fill: mk(0, ck.WHITE), ghost };
    }
    const P = this.paints;
    const { r, lw, lh, corners, frame } = this.state();
    const d = this.ed.dpr;
    canvas.save();
    canvas.scale(d, d);
    // Image outside the window is semi-transparent (in layer coordinates, with the window cut out).
    const img = p.imageHash ? this.ed.imageFor(p.imageHash, Math.max(r.w, r.h) * this.ed.camera.zoom) : undefined;
    if (img) {
      const m = this.ed.worldMatrix(this.target.id) as Matrix;
      const z = this.ed.camera.zoom;
      const cam = this.ed.camera;
      canvas.save();
      canvas.concat([z * m[0], z * m[1], z * (m[2] - cam.x), z * m[3], z * m[4], z * (m[5] - cam.y), 0, 0, 1]);
      canvas.clipRect(ck.XYWHRect(0, 0, lw, lh), ck.ClipOp.Difference, true);
      canvas.drawImageRect(img, ck.XYWHRect(0, 0, img.width(), img.height()), ck.XYWHRect(r.x, r.y, r.w, r.h), P.ghost);
      canvas.restore();
    }
    const quad = (pts: [number, number][], paint: SkPaint) => {
      const b = new ck.PathBuilder();
      pts.forEach(([x, y], i) => {
        const [sx, sy] = this.toScreen(x, y);
        if (i) b.lineTo(sx, sy);
        else b.moveTo(sx, sy);
      });
      b.close();
      const path = b.detachAndDelete();
      canvas.drawPath(path, paint);
      path.delete();
    };
    quad(corners, P.dash);
    quad([frame[0]!, frame[2]!, frame[4]!, frame[6]!], P.line);
    // Image handles are circles, window handles are squares.
    for (const c of corners) {
      const [x, y] = this.toScreen(c[0], c[1]);
      canvas.drawCircle(x, y, 4.5, P.fill);
      canvas.drawCircle(x, y, 4.5, P.line);
    }
    for (const c of frame) {
      const [x, y] = this.toScreen(c[0], c[1]);
      const q = ck.XYWHRect(x - 4, y - 4, 8, 8);
      canvas.drawRect(q, P.fill);
      canvas.drawRect(q, P.line);
    }
    canvas.restore();
  }
}
