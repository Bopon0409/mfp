// “Stroke width” tool (Shift+W): for a stroked vector or shape —
// the center line and width points. Dragging from the line — thickness at that spot (a new point; Alt —
// one side only); dragging a point itself — along the line; Delete — remove the point; Esc — exit.
// The first point also adds end points with the previous thickness: only the point's neighborhood changes.

import type { Canvas, Paint as SkPaint } from 'canvaskit-wasm';
import { invert, networkChains, networkOf, type Matrix, type WidthPoint } from '@mfp/core';
import { nodeOutline, pathToSvg } from '@mfp/editing';
import { PathTextMap, textPathScale, widthAt } from '@mfp/renderer';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';

const HIT = 8;

/** Width profiles for the panel: thicknesses as fractions of half the stroke. */
export const WIDTH_PROFILES: { id: string; label: string; points: [number, number][] }[] = [
  { id: 'uniform', label: 'Равномерная', points: [] },
  { id: 'taper-end', label: 'Сужение к концу', points: [[0, 1], [1, 0.05]] },
  { id: 'taper-start', label: 'Сужение к началу', points: [[0, 0.05], [1, 1]] },
  { id: 'taper-both', label: 'С обеих сторон', points: [[0, 0.05], [0.5, 1], [1, 0.05]] },
  { id: 'bulge', label: 'Утолщение в середине', points: [[0, 1], [0.5, 2], [1, 1]] },
];

/** Node center line: consecutive paths (for a vector — network chains, for a shape — its outline), length maps. */
interface Chains {
  maps: { map: PathTextMap; offset: number }[];
  total: number;
}

export class WidthTool implements PointerInterceptor {
  private ed: Editor;
  /** The layer we work with (the selected stroked one or the one under the pointer). */
  private id: string | null = null;
  private chains: { id: string; key: string; c: Chains } | null = null;
  private selected: number | null = null;
  private drag: { index: number; kind: 'width' | 'move'; side: 'both' | 'left' | 'right' } | null = null;
  private hover: { u: number; d: number } | null = null;
  private paints: { line: SkPaint; dot: SkPaint; ring: SkPaint; width: SkPaint } | null = null;
  private accentV = -1;
  /** Exit the tool (wired up by main.ts). */
  onExit: (() => void) | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  get active() {
    return this.ed.tool === 'width';
  }

  /** The layer qualifies: a vector, line or shape with a visible stroke. */
  private stroked(id: string): boolean {
    const doc = this.ed.doc;
    const t = doc.type(id);
    if (t !== 'VECTOR' && t !== 'LINE' && t !== 'RECTANGLE' && t !== 'ELLIPSE' && t !== 'POLYGON' && t !== 'STAR') return false;
    return (doc.get(id, 'strokes') ?? []).some((p) => p.visible !== false) && (doc.get(id, 'strokeWeight') ?? 1) > 0;
  }

  private geometry(id: string): Chains {
    const doc = this.ed.doc;
    const p = doc.props(id);
    const key = JSON.stringify([p.vectorNetwork, p.width, p.height, p.geometrySize, p.cornerRadius, p.pointCount, p.innerRadius, p.arcData, doc.type(id)]);
    if (this.chains?.id === id && this.chains.key === key) return this.chains.c;
    for (const m of this.chains?.c.maps ?? []) m.map.delete();
    const net = doc.type(id) === 'VECTOR' ? networkOf(doc, id) : null;
    const [sx, sy] = net ? textPathScale(p) : [1, 1];
    const datas = net ? networkChains(net).map((ch) => ch.data) : doc.type(id) === 'LINE' ? [`M0 0L${p.width ?? 0} 0`] : [pathToSvg(nodeOutline(doc, id), 0, 0)];
    const maps: Chains['maps'] = [];
    let total = 0;
    for (const data of datas) {
      const map = new PathTextMap(this.ed.ck, data, 0, 0, 'LEFT', 0, sx, sy);
      if (!map.ok) {
        map.delete();
        continue;
      }
      maps.push({ map, offset: total });
      total += map.length;
    }
    const c = { maps, total };
    this.chains = { id, key, c };
    return c;
  }

  /** Layer point → nearest center line spot: length fraction u and signed distance (left +). */
  private project(c: Chains, lx: number, ly: number): { u: number; d: number } | null {
    let best: { u: number; d: number } | null = null;
    for (const { map, offset } of c.maps) {
      const [s, y] = map.fromLocal(lx, ly);
      const along = Math.max(0, Math.min(map.length, s));
      // fromLocal: y goes down from the baseline (to the right along the direction); left — plus.
      const d = -y;
      if (!best || Math.abs(d) < Math.abs(best.d)) best = { u: (offset + along) / c.total, d };
    }
    return best;
  }

  /** Length fraction u → layer point, tangent. */
  private at(c: Chains, u: number): { x: number; y: number; tx: number; ty: number } {
    const s = u * c.total;
    const m = [...c.maps].reverse().find((x) => s >= x.offset - 1e-6) ?? c.maps[0]!;
    const [x, y, angle] = m.map.toLocal(Math.min(m.map.length, s - m.offset), 0);
    return { x, y, tx: Math.cos(angle), ty: Math.sin(angle) };
  }

  private toLocal(id: string, wx: number, wy: number): [number, number] {
    const m = invert(this.ed.worldMatrix(id) as Matrix);
    return [m[0] * wx + m[1] * wy + m[2], m[3] * wx + m[4] * wy + m[5]];
  }

  private toScreen(id: string, x: number, y: number): [number, number] {
    const m = this.ed.worldMatrix(id);
    return this.ed.worldToScreen(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
  }

  private points(id: string): WidthPoint[] {
    return this.ed.doc.get(id, 'variableWidthPoints') ?? [];
  }

  /** Layer under the pointer: the selected stroked one first. */
  private targetAt(wx: number, wy: number): string | null {
    const ed = this.ed;
    const sel = ed.selection.length === 1 && this.stroked(ed.selection[0]!) ? ed.selection[0]! : null;
    if (sel) return sel;
    const tol = HIT / ed.camera.zoom;
    for (const n of [...ed.scene.hitPath(wx, wy, tol)].reverse()) {
      const id = ed.scene.id(n)!;
      if (this.stroked(id)) return id;
    }
    return null;
  }

  /** Width point handle under the pointer: middle (move along) or ends (thickness). */
  private handleAt(id: string, sx: number, sy: number): { index: number; kind: 'width' | 'move' } | null {
    const c = this.geometry(id);
    if (!c.total) return null;
    const pts = this.points(id);
    for (let i = pts.length - 1; i >= 0; i--) {
      const w = pts[i]!;
      const q = this.at(c, w.position);
      const [cx, cy] = this.toScreen(id, q.x, q.y);
      if (Math.hypot(cx - sx, cy - sy) <= HIT) return { index: i, kind: 'move' };
      for (const side of [w.ascent, -w.descent]) {
        const [ex, ey] = this.toScreen(id, q.x + q.ty * side, q.y - q.tx * side);
        if (Math.hypot(ex - sx, ey - sy) <= HIT) return { index: i, kind: 'width' };
      }
    }
    return null;
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.active || e.button !== 0) return false;
    const ed = this.ed;
    const id = this.targetAt(wx, wy);
    if (!id) {
      this.selected = null;
      ed.select([]);
      return true;
    }
    if (ed.selection.length !== 1 || ed.selection[0] !== id) ed.select([id]);
    this.id = id;
    const [sx, sy] = ed.worldToScreen(wx, wy);
    const handle = this.handleAt(id, sx, sy);
    const doc = ed.doc;
    if (handle) {
      this.selected = handle.index;
      this.drag = { index: handle.index, kind: handle.kind, side: e.altKey ? 'left' : 'both' };
      doc.beginGroup();
      ed.dirty = true;
      return true;
    }
    const c = this.geometry(id);
    const [lx, ly] = this.toLocal(id, wx, wy);
    const hit = c.total ? this.project(c, lx, ly) : null;
    const pts = this.points(id);
    const half = (doc.get(id, 'strokeWeight') ?? 1) / 2;
    const [asc, desc] = pts.length ? widthAt(pts, hit?.u ?? 0) : [half, half];
    const reach = Math.max(asc, desc) + HIT / ed.camera.zoom;
    if (!hit || Math.abs(hit.d) > reach) {
      this.selected = null;
      ed.dirty = true;
      return true;
    }
    // A new point; for a uniform stroke — also end points with the previous thickness.
    const next: WidthPoint[] = pts.length
      ? [...pts]
      : [
          { position: 0, ascent: half, descent: half },
          { position: 1, ascent: half, descent: half },
        ];
    next.push({ position: Math.round(hit.u * 10000) / 10000, ascent: asc, descent: desc });
    next.sort((a, b) => a.position - b.position);
    const index = next.findIndex((p) => p.position === Math.round(hit.u * 10000) / 10000);
    doc.beginGroup();
    doc.set(id, { variableWidthPoints: next });
    this.selected = index;
    this.drag = { index, kind: 'width', side: e.altKey ? (hit.d >= 0 ? 'left' : 'right') : 'both' };
    ed.dirty = true;
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.active) return false;
    const ed = this.ed;
    if (!this.drag || !this.id) {
      // Highlight of the center line and the spot under the pointer.
      const id = this.targetAt(wx, wy);
      this.id = id ?? this.id;
      if (id) {
        const c = this.geometry(id);
        const [lx, ly] = this.toLocal(id, wx, wy);
        this.hover = c.total ? this.project(c, lx, ly) : null;
        const [sx, sy] = ed.worldToScreen(wx, wy);
        ed.canvasEl.style.cursor = this.handleAt(id, sx, sy)?.kind === 'move' ? 'move' : 'crosshair';
      } else this.hover = null;
      ed.dirty = true;
      return true;
    }
    const id = this.id;
    const c = this.geometry(id);
    if (!c.total) return true;
    const [lx, ly] = this.toLocal(id, wx, wy);
    const pts = [...this.points(id)];
    const w = pts[this.drag.index];
    if (!w) return true;
    if (this.drag.kind === 'move') {
      const hit = this.project(c, lx, ly);
      if (!hit) return true;
      pts[this.drag.index] = { ...w, position: Math.round(hit.u * 10000) / 10000 };
    } else {
      // Thickness — the distance from the center line at the point's spot.
      const q = this.at(c, w.position);
      const d = (lx - q.x) * q.ty - (ly - q.y) * q.tx;
      const v = Math.max(0, Math.round(Math.abs(d) * 100) / 100);
      const side = this.drag.side;
      pts[this.drag.index] = side === 'both' ? { ...w, ascent: v, descent: v } : side === 'left' || (side !== 'right' && d >= 0) ? { ...w, ascent: v } : { ...w, descent: v };
    }
    ed.doc.set(id, { variableWidthPoints: pts });
    return true;
  }

  up(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.ed.doc.endGroup();
    // Points are ordered by position on the line; the selected one stays selected.
    const id = this.id;
    if (id) {
      const pts = this.points(id);
      const sel = this.selected !== null ? pts[this.selected] : undefined;
      const sorted = [...pts].sort((a, b) => a.position - b.position);
      if (sorted.some((p, i) => p !== pts[i])) {
        this.ed.doc.set(id, { variableWidthPoints: sorted });
        this.selected = sel ? sorted.indexOf(sel) : null;
      }
    }
    return true;
  }

  /** Tool keys: Delete — remove the selected point, Esc — exit. true — handled. */
  key(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === 'Escape') {
      this.onExit?.();
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.id && this.selected !== null) {
      const pts = this.points(this.id).filter((_, i) => i !== this.selected);
      // Only end points with equal thickness remain — the stroke is uniform again.
      const uniform = pts.length <= 2 && pts.every((p) => p.ascent === pts[0]?.ascent && p.descent === pts[0]?.descent);
      this.ed.doc.set(this.id, { variableWidthPoints: uniform ? [] : pts });
      this.selected = null;
      this.ed.dirty = true;
      return true;
    }
    return false;
  }

  private draw(canvas: Canvas) {
    if (!this.active || !this.id || !this.ed.doc.has(this.id)) return;
    const ck = this.ed.ck;
    // The theme changed the selection color — recreate the paints.
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
      this.paints = { line: mk(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 1), 1), dot: mk(ck.Color(255, 255, 255, 1)), ring: mk(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 1), 1.5), width: mk(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 1), 1) };
    }
    const P = this.paints;
    const id = this.id;
    const c = this.geometry(id);
    if (!c.total) return;
    // Center line.
    const b = new ck.PathBuilder();
    const steps = Math.min(2000, Math.max(32, Math.ceil(c.total / 2)));
    let prev: { m: unknown } | null = null;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const q = this.at(c, u);
      const [x, y] = this.toScreen(id, q.x, q.y);
      const chain = c.maps.find((m) => u * c.total >= m.offset - 1e-6 && u * c.total <= m.offset + m.map.length + 1e-6) ?? null;
      if (!prev || prev.m !== chain) b.moveTo(x, y);
      else b.lineTo(x, y);
      prev = { m: chain };
    }
    const path = b.detachAndDelete();
    canvas.drawPath(path, P.line);
    path.delete();
    // Width points: a cross bar for the thickness, ends and middle.
    this.points(id).forEach((w, i) => {
      const q = this.at(c, w.position);
      const [cx, cy] = this.toScreen(id, q.x, q.y);
      const [ax, ay] = this.toScreen(id, q.x + q.ty * w.ascent, q.y - q.tx * w.ascent);
      const [dx, dy] = this.toScreen(id, q.x - q.ty * w.descent, q.y + q.tx * w.descent);
      canvas.drawLine(ax, ay, dx, dy, P.width);
      for (const [x, y] of [
        [ax, ay],
        [dx, dy],
      ] as const) {
        canvas.drawCircle(x, y, 3, P.dot);
        canvas.drawCircle(x, y, 3, P.ring);
      }
      canvas.drawCircle(cx, cy, i === this.selected ? 5 : 4, i === this.selected ? P.ring : P.dot);
      if (i !== this.selected) canvas.drawCircle(cx, cy, 4, P.ring);
    });
    // Spot under the pointer on the line.
    if (this.hover && !this.drag) {
      const q = this.at(c, this.hover.u);
      const [x, y] = this.toScreen(id, q.x, q.y);
      canvas.drawCircle(x, y, 3, P.ring);
    }
  }
}
