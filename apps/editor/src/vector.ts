// Pen (P), pencil (Shift+P) and vector editing (double click on a vector or Enter) — on the vector
// network: points and segments with branches, fill regions.
//
// Edit mode has its own tools: move (V), pen (P), paint bucket (B), lasso (Q), knife (X);
// Ctrl — bend (click on a point: corner ⇄ smooth, drag from a point — handles, drag a segment —
// bend it). Move: click — a point or segment, Shift — several, drag on empty space — a box;
// a point dropped onto another merges with it. Pen: click — a point (from the selected end), on a
// point — connect (branch or close), on a segment — a new point on it; drag — handles.
// Bucket — fill or unfill a region. Lasso — select points by drawing around them. Knife — cut:
// filled regions are split along the cut line, open paths come apart.
//
// Edits go straight into the document (networkProps: network, fill paths per region, center lines
// for the stroke; node box — fitted to the shape). A shape (rectangle, ellipse, polygon, star,
// line) becomes a vector with the same id on the first edit.

import type { Canvas, CanvasKit, Paint } from 'canvaskit-wasm';
import {
  adjacency,
  bezierAt,
  cloneNetwork,
  connect,
  decodeNetwork,
  faceAt,
  invert,
  isStraight,
  loopPolygon,
  mergeVertices,
  networkBounds,
  networkFaces,
  networkFillPaths,
  networkFromSvg,
  networkOf,
  networkProps,
  pointInPolygon,
  regionIndexAt,
  removeSegments,
  removeVertices,
  segmentPoints,
  splitSegment,
  transformNetwork,
  type HandleMirroring,
  type Matrix,
  type NodeType,
  type Paint as DocPaint,
  type Props,
  type StrokeBrush,
  type VectorNetwork,
  type VectorRegion,
} from '@mfp/core';
import { cornerIndices, fitCurve, healVertices, nodeOutline, pathToSvg, simplifyPolyline, type CurvePoint } from '@mfp/editing';
import type { Editor } from './editor.ts';
import { h } from './dom.ts';
import { BRUSHES } from '@mfp/renderer';
import { canvasAccent } from './appearance.ts';

interface XY {
  x: number;
  y: number;
}

/** Point type: corner without handles, free handles, mirrored angle, mirrored angle and length. */
export type PointType = 'STRAIGHT' | 'NONE' | 'ANGLE' | 'ANGLE_AND_LENGTH';

export const POINT_TYPE_LABEL: Record<PointType, string> = {
  STRAIGHT: 'Угол',
  NONE: 'Свободные',
  ANGLE: 'Зеркальный угол',
  ANGLE_AND_LENGTH: 'Зеркально',
};

/** Edit mode tools. */
export type VectorSubTool = 'move' | 'pen' | 'bucket' | 'lasso' | 'knife' | 'eraser';

export const SUB_TOOLS: { tool: VectorSubTool; label: string; short: string; key: string }[] = [
  { tool: 'move', label: 'Перемещение', short: 'Точки', key: 'V' },
  { tool: 'pen', label: 'Перо', short: 'Перо', key: 'P' },
  { tool: 'bucket', label: 'Заливка областей', short: 'Ведро', key: 'B' },
  { tool: 'lasso', label: 'Лассо', short: 'Лассо', key: 'Q' },
  { tool: 'knife', label: 'Нож', short: 'Нож', key: 'X' },
  { tool: 'eraser', label: 'Ластик', short: 'Ластик', key: 'E' },
];

/** Pointer interception for tools (pen, path editing). true — the event is handled. */
export interface PointerInterceptor {
  /** The interceptor is currently active (pen or path editing). */
  readonly active?: boolean;
  down(e: PointerEvent, wx: number, wy: number): boolean;
  move(e: PointerEvent, wx: number, wy: number): boolean;
  up(e: PointerEvent, wx: number, wy: number): boolean;
  dblclick?(e: MouseEvent, wx: number, wy: number): boolean;
}

/** Shapes edited as a vector (they become a vector on the first edit). */
const SHAPES = new Set<NodeType>(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE']);
/** Shape properties a vector doesn't have. */
const SHAPE_ONLY: (keyof Props)[] = ['cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius', 'pointCount', 'innerRadius', 'arcData', 'vectorPaths', 'strokePaths', 'centerPaths', 'geometrySize'];

const HIT = 7; // screen pixels
/** Keep contextual tool shortcuts usable with Cyrillic keyboard input. */
export function vectorKey(e: Pick<KeyboardEvent, 'code' | 'key'>): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  if (e.code === 'BracketLeft') return '[';
  if (e.code === 'BracketRight') return ']';
  return e.key.toLowerCase();
}
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];
/** Region fill if the vector has no fills of its own. */
const DEFAULT_FILL: DocPaint = { type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } };

const mapPt = (m: Matrix, p: XY): XY => ({ x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5] });
const len = (p: XY) => Math.hypot(p.x, p.y);

/** Angle of segment a→b — snapped to the nearest multiple of 45° (Shift), same length. */
function snap45(a: XY, b: XY): XY {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: a.x + Math.cos(ang) * l, y: a.y + Math.sin(ang) * l };
}

/** Tangent of segment k at vertex v (relative to the vertex). */
function tangentAt(net: VectorNetwork, k: number, v: number): XY {
  const g = net.segments[k]!;
  const t = g.start === v ? g.tangentStart : g.tangentEnd;
  return t ? { x: t.x, y: t.y } : { x: 0, y: 0 };
}

/** Set the tangent of segment k at vertex v (the other one, if absent, is zero). */
function setTangent(net: VectorNetwork, k: number, v: number, t: XY) {
  const g = net.segments[k]!;
  if (!g.tangentStart) g.tangentStart = { x: 0, y: 0 };
  if (!g.tangentEnd) g.tangentEnd = { x: 0, y: 0 };
  if (g.start === v) g.tangentStart = { x: t.x, y: t.y };
  else g.tangentEnd = { x: t.x, y: t.y };
  if (isStraight(g)) {
    delete g.tangentStart;
    delete g.tangentEnd;
  }
}

/** Point type from its handles and mirroring (for a point with exactly two segments). */
export function vertexType(net: VectorNetwork, v: number, adj: number[][] = adjacency(net)): PointType {
  const ks = adj[v] ?? [];
  const ts = ks.map((k) => tangentAt(net, k, v));
  if (ts.every((t) => len(t) < 1e-9)) return 'STRAIGHT';
  const stored = net.vertices[v]!.handleMirroring;
  if (stored) return stored;
  if (ks.length !== 2) return 'NONE';
  const [a, b] = ts as [XY, XY];
  const la = len(a);
  const lb = len(b);
  if (la < 1e-6 || lb < 1e-6) return 'NONE';
  // Handles on one straight line on opposite sides of the point.
  if (Math.abs(a.x * b.y - a.y * b.x) > 0.01 * la * lb || a.x * b.x + a.y * b.y > 0) return 'NONE';
  return Math.abs(la - lb) < 0.5 ? 'ANGLE_AND_LENGTH' : 'ANGLE';
}

/** Network from pencil points: smooth curves, corners stay corners; closed if the end is near the start. */
export function pencilNetwork(points: readonly XY[], error: number, closeWithin: number): VectorNetwork | null {
  const corners = cornerIndices(points as CurvePoint[]);
  const curves = fitCurve(points as CurvePoint[], error, corners);
  if (!curves.length) return null;
  const net: VectorNetwork = { vertices: [{ x: curves[0]![0].x, y: curves[0]![0].y }], segments: [] };
  for (const c of curves) {
    const a = net.vertices.length - 1;
    const b = net.vertices.push({ x: c[3].x, y: c[3].y }) - 1;
    net.segments.push({ start: a, end: b, tangentStart: { x: c[1].x - c[0].x, y: c[1].y - c[0].y }, tangentEnd: { x: c[2].x - c[3].x, y: c[2].y - c[3].y } });
  }
  // Smooth joints — mirrored points, corners — free.
  const cornerAt = new Set(corners.map((i) => (points[i] ? `${points[i]!.x},${points[i]!.y}` : '')));
  for (let v = 1; v < net.vertices.length - 1; v++) {
    const p = net.vertices[v]!;
    p.handleMirroring = cornerAt.has(`${p.x},${p.y}`) ? 'NONE' : 'ANGLE';
  }
  const first = net.vertices[0]!;
  const last = net.vertices[net.vertices.length - 1]!;
  if (net.segments.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) <= closeWithin) mergeVertices(net, net.vertices.length - 1, 0);
  return net;
}

// ---------- Tool ----------

type Hit =
  | { kind: 'handle'; v: number; k: number }
  | { kind: 'vertex'; v: number }
  | { kind: 'segment'; k: number; t: number };

type Drag =
  | { kind: 'move'; start: XY; orig: Map<number, XY>; moved: boolean; merge: number | null }
  | { kind: 'handle'; v: number; k: number; type: PointType }
  | { kind: 'bend-point'; v: number; at: XY; moved: boolean }
  | { kind: 'bend-seg'; k: number; t: number }
  | { kind: 'marquee'; start: XY; end: XY; add: boolean }
  | { kind: 'lasso'; points: XY[]; add: boolean }
  | { kind: 'knife'; points: XY[] }
  | { kind: 'eraser'; points: XY[] }
  | { kind: 'pen'; v: number; at: XY; moved: boolean; freeIn: XY | null; closing: boolean; seg: number | null }
  | { kind: 'pencil'; points: XY[] };

export class VectorTool implements PointerInterceptor {
  private ed: Editor;
  private ck: CanvasKit;
  /** off — none; edit — editing (or a pen that hasn't started a vector yet); pencil — pencil. */
  mode: 'off' | 'edit' | 'pencil' = 'off';
  /** Edit mode tool. */
  sub: VectorSubTool = 'move';
  /** Vector started with the pen from the toolbar (Esc / Enter — finish; empty — delete). */
  private creating = false;
  /** The node and its network (node coordinates at the current size). */
  private target: string | null = null;
  private net: VectorNetwork = { vertices: [], segments: [] };
  /** Selected points and segments. */
  private selV = new Set<number>();
  private selS = new Set<number>();
  /** Pen: which point the next segment starts from, and its outgoing handle (relative to the point). */
  private penFrom: number | null = null;
  private penOut: XY | null = null;
  /** Pointer (world) — for the pen preview and bucket highlight. */
  private cursor: XY | null = null;
  private drag: Drag | null = null;
  /** The drag opened an undo group and a live layer. */
  private grouped = false;
  /** Bucket: highlight of the region under the pointer (polygons in node coordinates) and what will happen. */
  private bucketHover: { polygons: XY[][]; remove: boolean } | null = null;
  /** The last written network (we don't re-read our own write). */
  private written: string | null = null;
  private paints: Record<'line' | 'lineSel' | 'point' | 'pointSel' | 'handle' | 'preview' | 'fill' | 'unfill' | 'knife' | 'eraser' | 'eraserRing', Paint>;
  private accentV = canvasAccent.version;
  /** Eraser radius, screen pixels ([ and ] — smaller and larger). */
  eraserSize = 10;
  /** The “Brush” tool: a freehand line, like the pencil, with a brush, thickness and color. */
  private brushMode = false;
  brush: StrokeBrush = { type: 'STRETCH', name: 'ink' };
  brushWeight = 8;
  brushColor = { r: 0.1, g: 0.1, b: 0.12 };
  /** The selection or point types changed (the panel shows what is selected). */
  onChange: (() => void) | null = null;
  onDone: (() => void) | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    this.ck = ed.ck;
    const ck = this.ck;
    const stroke = (r: number, g: number, b: number, w: number, a = 1) => {
      const p = new ck.Paint();
      p.setAntiAlias(true);
      p.setStyle(ck.PaintStyle.Stroke);
      p.setStrokeWidth(w);
      p.setColor(ck.Color4f(r, g, b, a));
      return p;
    };
    const fill = (r: number, g: number, b: number, a = 1) => {
      const p = new ck.Paint();
      p.setAntiAlias(true);
      p.setColor(ck.Color4f(r, g, b, a));
      return p;
    };
    const { r, g, b } = canvasAccent;
    this.paints = {
      line: stroke(r, g, b, 1.5),
      lineSel: stroke(r, g, b, 3),
      point: fill(1, 1, 1),
      pointSel: fill(r, g, b),
      handle: stroke(r, g, b, 1),
      preview: stroke(r, g, b, 1),
      fill: fill(r, g, b, 0.18),
      unfill: fill(0.95, 0.25, 0.2, 0.18),
      knife: stroke(0.95, 0.25, 0.2, 1.5),
      eraser: (() => {
        const p = stroke(0.95, 0.3, 0.3, 1, 0.35);
        p.setStrokeCap(ck.StrokeCap.Round);
        p.setStrokeJoin(ck.StrokeJoin.Round);
        return p;
      })(),
      eraserRing: stroke(0.95, 0.3, 0.3, 1),
    };
    ed.overlays.push((canvas) => this.draw(canvas));
    // Undo, redo, an edit by another participant — the network is re-read from the document.
    ed.onDocument.push((ops) => {
      if (this.mode !== 'edit' || !this.target) return;
      const t = this.target;
      if (!ops.some((o) => o.op !== 'blob' && o.id === t)) return;
      if (!ed.doc.has(t)) return this.stopEdit();
      if (this.drag) return;
      if (this.storedNetwork() === this.written) return;
      this.reload();
    });
  }

  get active() {
    return this.mode !== 'off';
  }

  /** The vector being edited (or null). */
  get editing(): string | null {
    return this.mode === 'edit' ? this.target : null;
  }

  // ---------- Enter and exit ----------

  /** Pen from the toolbar: a new vector from the first point. */
  startPen() {
    this.stopEdit();
    this.mode = 'edit';
    this.sub = 'pen';
    this.creating = true;
    this.target = null;
    this.net = { vertices: [], segments: [] };
    this.clearSelection();
    this.penFrom = null;
    this.penOut = null;
    this.ed.hideHandles = true;
    this.ed.dirty = true;
    this.onChange?.();
  }

  /** Pen from the toolbar finished (Esc, Enter, another tool). */
  finishPen() {
    if (this.creating) this.stopEdit();
  }

  /** Pencil: each freehand line is a new vector; brush — the “Brush” tool (with a stroke brush). */
  startPencil(brush = false) {
    this.stopEdit();
    this.brushMode = brush;
    this.mode = 'pencil';
    this.ed.hideHandles = true;
    this.ed.dirty = true;
  }

  stopPencil() {
    if (this.mode !== 'pencil') return;
    this.mode = 'off';
    this.drag = null;
    this.ed.hideHandles = false;
    this.ed.dirty = true;
  }

  /** Whether the node can be edited as a vector. */
  canEdit(id: string): boolean {
    const t = this.ed.doc.type(id);
    return t === 'VECTOR' || (!!t && SHAPES.has(t));
  }

  startEdit(id: string) {
    if (!this.canEdit(id)) return;
    this.stopPencil();
    if (this.mode === 'edit') this.stopEdit(false);
    const net = this.readNetwork(id);
    if (!net) return;
    this.mode = 'edit';
    this.sub = 'move';
    this.creating = false;
    this.target = id;
    this.net = net;
    this.written = this.storedNetwork();
    this.clearSelection();
    this.penFrom = null;
    this.penOut = null;
    this.ed.hideHandles = true;
    this.ed.select([id]);
    this.ed.dirty = true;
    this.onChange?.();
  }

  stopEdit(notify = true) {
    if (this.mode !== 'edit') return;
    const id = this.target;
    const doc = this.ed.doc;
    // The pen left a vector without segments — it is gone.
    if (this.creating && id && doc.has(id) && !this.net.segments.length) doc.transact(() => doc.delete(id));
    if (this.grouped) {
      this.ed.endLive();
      this.ed.doc.endGroup();
      this.grouped = false;
    }
    this.mode = 'off';
    this.creating = false;
    this.target = null;
    this.net = { vertices: [], segments: [] };
    this.clearSelection();
    this.penFrom = null;
    this.penOut = null;
    this.drag = null;
    this.bucketHover = null;
    this.ed.hideHandles = false;
    this.ed.dirty = true;
    if (id && doc.has(id)) this.ed.select([id]);
    this.onChange?.();
    if (notify) this.onDone?.();
  }

  /** Edit mode tool (V, P, B, Q, X). */
  setSub(sub: VectorSubTool) {
    if (this.mode !== 'edit') return;
    this.sub = sub;
    this.penFrom = sub === 'pen' && this.selV.size === 1 ? this.endpointSelected() : null;
    this.penOut = null;
    this.bucketHover = null;
    this.ed.dirty = true;
    this.onChange?.();
  }

  /** Edit mode keys; true — handled. */
  key(e: KeyboardEvent): boolean {
    if (this.mode === 'pencil') {
      if (e.key === 'Escape' || e.key === 'Enter') {
        this.stopPencil();
        this.onDone?.();
        return true;
      }
      return false;
    }
    if (this.mode !== 'edit') return false;
    const k = vectorKey(e);
    const mod = e.ctrlKey || e.metaKey;
    if (k === 'escape' || k === 'enter') {
      // Pen: first finish the path, then exit.
      if (k === 'escape' && this.sub === 'pen' && this.penFrom !== null && !this.creating) {
        this.penFrom = null;
        this.penOut = null;
        this.ed.dirty = true;
        return true;
      }
      this.stopEdit();
      return true;
    }
    if (mod && k === 'a') {
      this.selV = new Set(this.net.vertices.map((_, i) => i));
      this.selS.clear();
      this.changed();
      return true;
    }
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyJ') return this.joinSelected();
    if (mod || e.altKey) return false;
    if (k === 'delete' || k === 'backspace') return this.deleteSelected(e.shiftKey);
    if (k.startsWith('arrow')) {
      const step = e.shiftKey ? 10 : 1;
      const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k] as [number, number] | undefined;
      if (!d) return false;
      return this.nudge(d[0], d[1]);
    }
    if (this.sub === 'eraser' && (k === '[' || k === ']')) {
      this.eraserSize = Math.max(2, Math.min(200, Math.round(this.eraserSize * (k === ']' ? 1.25 : 0.8))));
      this.ed.dirty = true;
      this.onChange?.();
      return true;
    }
    const sub = SUB_TOOLS.find((s) => s.key.toLowerCase() === k)?.tool;
    if (sub && !e.shiftKey) {
      this.setSub(sub);
      return true;
    }
    return false;
  }

  // ---------- Document ----------

  /** Node network (at the current size); for a shape — from its outline. */
  private readNetwork(id: string): VectorNetwork | null {
    const doc = this.ed.doc;
    if (doc.type(id) === 'VECTOR') {
      const net = networkOf(doc, id);
      return net ? cloneNetwork(net) : { vertices: [], segments: [] };
    }
    const segs = nodeOutline(doc, id);
    const net = segs.length ? networkFromSvg(pathToSvg(segs, 0, 0)) : null;
    if (net && doc.type(id) === 'LINE') delete net.regions;
    return net;
  }

  /** Network string in the document (for comparison with our own write). */
  private storedNetwork(): string | null {
    const id = this.target;
    if (!id) return null;
    const ref = this.ed.doc.get(id, 'vectorNetwork') as { data?: string; blob?: string } | undefined;
    return ref?.data ?? (ref?.blob ? (this.ed.doc.blob(ref.blob) ?? null) : null);
  }

  /** Re-read the network (after undo and others' edits); selection — whatever still exists. */
  private reload() {
    const id = this.target!;
    const net = this.readNetwork(id);
    if (!net) return this.stopEdit();
    this.net = net;
    this.written = this.storedNetwork();
    for (const v of [...this.selV]) if (v >= net.vertices.length) this.selV.delete(v);
    for (const k of [...this.selS]) if (k >= net.segments.length) this.selS.delete(k);
    if (this.penFrom !== null && this.penFrom >= net.vertices.length) this.penFrom = null;
    this.changed();
  }

  /** A shape becomes a vector on the first edit (same id, same place in layers). */
  private ensureVector() {
    const id = this.target;
    const doc = this.ed.doc;
    if (!id || doc.type(id) === 'VECTOR') return;
    const rec = doc.node(id);
    const parent = doc.parent(id);
    if (!rec || !parent) return;
    const props: Props = { ...doc.props(id) };
    for (const k of SHAPE_ONLY) delete (props as Record<string, unknown>)[k];
    // The rectangle drew its fill and stroke along its own shape: the vector's stroke is centered.
    if (rec.type === 'LINE') props.fills = [];
    const index = doc.children(parent).indexOf(id);
    doc.delete(id);
    doc.createWithId(id, 'VECTOR', parent, props, index);
  }

  /** Write the network: box — fitted to the shape (same position on screen), working copy — relative to the box corner. */
  private commit() {
    const id = this.target;
    const doc = this.ed.doc;
    if (!id || !doc.has(id)) return;
    if (!this.net.vertices.length) {
      doc.delete(id);
      this.stopEdit();
      return;
    }
    this.ensureVector();
    const b = networkBounds(this.net) ?? [0, 0, 0, 0];
    const props = networkProps(doc, id, this.net);
    if (b[0] || b[1]) this.net = transformNetwork(this.net, [1, 0, -b[0], 0, 1, -b[1]]);
    this.written = (props.vectorNetwork as { data?: string }).data ?? null;
    doc.set(id, props);
  }

  /** Edit as a single undo step. */
  private edit(fn: () => void) {
    this.ed.doc.transact(() => {
      fn();
      this.commit();
    });
    this.changed();
  }

  private changed() {
    this.ed.dirty = true;
    this.onChange?.();
  }

  private clearSelection() {
    this.selV.clear();
    this.selS.clear();
  }

  /** The selected point is a path end (the pen continues from it). */
  private endpointSelected(): number | null {
    if (this.selV.size !== 1) return null;
    const v = [...this.selV][0]!;
    return (adjacency(this.net)[v]?.length ?? 0) <= 1 ? v : null;
  }

  // ---------- Coordinates ----------

  private world(): Matrix {
    return this.target && this.ed.doc.has(this.target) ? (this.ed.worldMatrix(this.target) as Matrix) : IDENTITY;
  }

  private toLocal(w: XY): XY {
    return mapPt(invert(this.world()), w);
  }

  private screenDist(a: XY, b: XY) {
    return Math.hypot(a.x - b.x, a.y - b.y) * this.ed.camera.zoom;
  }

  // ---------- Hit testing ----------

  /** Handles currently visible: on selected points and segments, on the point the pen continues from. */
  private visibleHandles(): { v: number; k: number }[] {
    const adj = adjacency(this.net);
    const out: { v: number; k: number }[] = [];
    const seen = new Set<string>();
    const add = (v: number, k: number) => {
      const key = `${v}:${k}`;
      if (seen.has(key) || len(tangentAt(this.net, k, v)) < 1e-9) return;
      seen.add(key);
      out.push({ v, k });
    };
    for (const v of this.selV) for (const k of adj[v] ?? []) add(v, k);
    for (const k of this.selS) {
      const g = this.net.segments[k];
      if (!g) continue;
      add(g.start, k);
      add(g.end, k);
    }
    return out;
  }

  private hit(w: XY, handles = true): Hit | null {
    const m = this.world();
    if (handles) {
      for (const { v, k } of this.visibleHandles()) {
        const p = this.net.vertices[v]!;
        const t = tangentAt(this.net, k, v);
        if (this.screenDist(mapPt(m, { x: p.x + t.x, y: p.y + t.y }), w) <= HIT) return { kind: 'handle', v, k };
      }
    }
    let bestV = -1;
    let bestVD = Infinity;
    this.net.vertices.forEach((p, v) => {
      const d = this.screenDist(mapPt(m, p), w);
      if (d <= HIT && d < bestVD) {
        bestV = v;
        bestVD = d;
      }
    });
    if (bestV >= 0) return { kind: 'vertex', v: bestV };
    // Segments: the nearest point on the curve (stepwise search).
    let best: { k: number; t: number; d: number } | null = null;
    this.net.segments.forEach((_, k) => {
      const p = segmentPoints(this.net, k);
      for (let i = 1; i < 32; i++) {
        const t = i / 32;
        const d = this.screenDist(mapPt(m, bezierAt(p, t)), w);
        if (d <= HIT && (!best || d < best.d)) best = { k, t, d };
      }
    });
    const b = best as { k: number; t: number; d: number } | null;
    return b ? { kind: 'segment', k: b.k, t: b.t } : null;
  }

  // ---------- Pointer ----------

  down(e: PointerEvent, wx: number, wy: number): boolean {
    const at = { x: wx, y: wy };
    if (this.mode === 'pencil') {
      this.drag = { kind: 'pencil', points: [at] };
      return true;
    }
    if (this.mode !== 'edit') return false;
    if (this.sub === 'pen') return this.penDown(e, at);
    if (this.sub === 'bucket') return this.bucketClick(at);
    if (this.sub === 'lasso') {
      this.drag = { kind: 'lasso', points: [at], add: e.shiftKey };
      return true;
    }
    if (this.sub === 'knife') {
      this.drag = { kind: 'knife', points: [at] };
      return true;
    }
    if (this.sub === 'eraser') {
      this.drag = { kind: 'eraser', points: [at] };
      this.ed.dirty = true;
      return true;
    }
    return this.moveDown(e, at);
  }

  private beginGesture() {
    this.ed.doc.beginGroup();
    this.ensureVectorNow();
    this.ed.beginLive([this.target!], 'direct');
    this.grouped = true;
  }

  /** Shape → vector before the drag starts (the live layer is already on the vector). */
  private ensureVectorNow() {
    if (this.target && this.ed.doc.type(this.target) !== 'VECTOR') this.ed.doc.transact(() => this.commit());
  }

  private moveDown(e: PointerEvent, at: XY): boolean {
    const doc = this.ed.doc;
    const h = this.hit(at);
    const bend = e.ctrlKey || e.metaKey;
    if (!h) {
      // Miss: inside the layer — a point selection box; outside the layer — exit editing (the click reaches the layers).
      const local = this.toLocal(at);
      const w = doc.get(this.target!, 'width') ?? 0;
      const ht = doc.get(this.target!, 'height') ?? 0;
      const pad = HIT / this.ed.camera.zoom;
      if (local.x < -pad || local.y < -pad || local.x > w + pad || local.y > ht + pad) {
        this.stopEdit();
        return false;
      }
      this.drag = { kind: 'marquee', start: at, end: at, add: e.shiftKey };
      return true;
    }
    if (h.kind === 'handle') {
      this.beginGesture();
      this.drag = { kind: 'handle', v: h.v, k: h.k, type: e.altKey ? 'NONE' : vertexType(this.net, h.v) };
      if (e.altKey) this.net.vertices[h.v]!.handleMirroring = 'NONE';
      return true;
    }
    if (bend && h.kind === 'vertex') {
      this.selV = new Set([h.v]);
      this.selS.clear();
      this.beginGesture();
      this.drag = { kind: 'bend-point', v: h.v, at, moved: false };
      this.changed();
      return true;
    }
    if (bend && h.kind === 'segment') {
      this.beginGesture();
      this.drag = { kind: 'bend-seg', k: h.k, t: h.t };
      return true;
    }
    // Selection: Shift — add or remove; without it — the selection stays if the click was on it.
    if (h.kind === 'vertex') {
      if (e.shiftKey) {
        if (this.selV.has(h.v)) this.selV.delete(h.v);
        else this.selV.add(h.v);
      } else if (!this.selV.has(h.v)) {
        this.selV = new Set([h.v]);
        this.selS.clear();
      }
    } else if (e.shiftKey) {
      if (this.selS.has(h.k)) this.selS.delete(h.k);
      else this.selS.add(h.k);
    } else if (!this.selS.has(h.k)) {
      this.selS = new Set([h.k]);
      this.selV.clear();
    }
    // Drag: selected points and ends of selected segments (positions — in world space).
    const m = this.world();
    const orig = new Map<number, XY>();
    for (const v of this.movingVertices()) orig.set(v, mapPt(m, this.net.vertices[v]!));
    this.beginGesture();
    this.drag = { kind: 'move', start: at, orig, moved: false, merge: null };
    this.changed();
    return true;
  }

  /** Points that move during a drag: selected ones and ends of selected segments. */
  private movingVertices(): Set<number> {
    const out = new Set(this.selV);
    for (const k of this.selS) {
      const g = this.net.segments[k];
      if (g) out.add(g.start).add(g.end);
    }
    return out;
  }

  private penDown(e: PointerEvent, at: XY): boolean {
    const doc = this.ed.doc;
    // New vector: the first point immediately creates a layer (parent — the deepest frame under it).
    if (!this.target) {
      doc.beginGroup();
      let parent = this.ed.pageId;
      for (const n of this.ed.scene.hitPath(at.x, at.y)) {
        const id = this.ed.scene.id(n)!;
        const t = doc.type(id);
        if (t === 'FRAME' || t === 'COMPONENT' || t === 'SECTION') parent = id;
      }
      const pw = (parent === this.ed.pageId ? IDENTITY : this.ed.worldMatrix(parent)) as Matrix;
      const p = mapPt(invert(pw), at);
      const id = doc.transact(() =>
        doc.create('VECTOR', parent, {
          name: 'Vector',
          transform: [1, 0, Math.round(p.x), 0, 1, Math.round(p.y)],
          fills: [],
          strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
          strokeWeight: 1,
          strokeAlign: 'CENTER',
        }),
      );
      this.target = id;
      this.net = { vertices: [{ x: 0, y: 0 }], segments: [] };
      doc.transact(() => this.commit());
      this.selV = new Set([0]);
      this.selS.clear();
      this.penFrom = 0;
      this.penOut = null;
      this.ed.select([id]);
      this.ed.beginLive([id], 'direct');
      this.grouped = true;
      this.drag = { kind: 'pen', v: 0, at, moved: false, freeIn: null, closing: false, seg: null };
      this.changed();
      return true;
    }
    const h = this.hit(at, false);
    const from = this.penFrom;
    this.beginGesture();
    let v: number;
    let closing = false;
    let seg: number | null = null;
    const link = (to: number) => this.net.segments.push({ start: from!, end: to, ...(this.penOut ? { tangentStart: this.penOut, tangentEnd: { x: 0, y: 0 } } : {}) }) - 1;
    if (h?.kind === 'vertex') {
      v = h.v;
      // Connect: closing the path or a branch.
      if (from !== null && from !== v) {
        seg = link(v);
        closing = true;
      }
    } else if (h?.kind === 'segment') {
      // A point on a segment (the shape doesn't change); from the pen — connect to it.
      v = splitSegment(this.net, h.k, h.t);
      if (from !== null) {
        seg = link(v);
        closing = true;
      }
    } else {
      const fromPt = from !== null ? this.net.vertices[from] : undefined;
      let local = this.toLocal(at);
      if (e.shiftKey && fromPt) local = snap45(fromPt, local);
      v = this.net.vertices.push({ x: local.x, y: local.y }) - 1;
      if (from !== null) seg = link(v);
    }
    this.commitInGroup();
    this.selV = new Set([v]);
    this.selS.clear();
    this.penOut = null;
    this.drag = { kind: 'pen', v, at, moved: false, freeIn: null, closing, seg };
    this.changed();
    return true;
  }

  /** Write inside an already open undo group (drag). */
  private commitInGroup() {
    this.ed.doc.transact(() => this.commit());
  }

  private bucketClick(at: XY): boolean {
    const local = this.toLocal(at);
    const doc = this.ed.doc;
    const fills = doc.get(this.target!, 'fills') ?? [];
    const before = this.net.regions?.length ?? 0;
    this.edit(() => {
      // A network without regions but with a fill (filled entirely): first make all faces their own regions.
      if (!this.net.regions?.length && fills.length) {
        this.net.regions = [];
        for (const f of facesOf(this.net)) this.net.regions.push(f);
      }
      const i = regionIndexAt(this.net, local.x, local.y);
      if (i >= 0) {
        this.net.regions!.splice(i, 1);
        if (!this.net.regions!.length) this.net.regions = [];
        return;
      }
      const face = faceAt(this.net, local.x, local.y);
      if (!face) return;
      // For a vector without a fill, the region gets its own (otherwise it isn't visible).
      (this.net.regions ??= []).push(fills.length ? face : { ...face, fills: [DEFAULT_FILL] });
    });
    // All regions removed: a network “without regions” would be filled entirely — remove the node's fill too.
    if (before && !this.net.regions?.length && fills.length) doc.transact(() => doc.set(this.target!, { fills: [] }));
    this.updateBucketHover(at);
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    const at = { x: wx, y: wy };
    this.cursor = at;
    if (this.mode === 'pencil') {
      const d = this.drag;
      if (d?.kind === 'pencil') {
        const last = d.points[d.points.length - 1]!;
        if (this.screenDist(last, at) >= 1.5) d.points.push(at);
      }
      this.ed.dirty = true;
      return true;
    }
    if (this.mode !== 'edit') return false;
    const d = this.drag;
    if (!d) {
      if (this.sub === 'bucket') this.updateBucketHover(at);
      this.ed.dirty = true;
      return this.sub !== 'move';
    }
    const local = this.toLocal(at);
    switch (d.kind) {
      case 'marquee':
        d.end = at;
        break;
      case 'lasso':
      case 'knife':
      case 'eraser':
        if (this.screenDist(d.points[d.points.length - 1]!, at) >= 2) d.points.push(at);
        break;
      case 'move': {
        if (!d.moved && this.screenDist(d.start, at) < 2) return true;
        d.moved = true;
        let dx = at.x - d.start.x;
        let dy = at.y - d.start.y;
        // A point near another snaps to it (they merge on release).
        d.merge = null;
        if (d.orig.size === 1) {
          const [v, o] = [...d.orig][0]!;
          const m = this.world();
          const target = { x: o.x + dx, y: o.y + dy };
          for (let u = 0; u < this.net.vertices.length; u++) {
            if (u === v) continue;
            const p = mapPt(m, this.net.vertices[u]!);
            if (this.screenDist(p, target) <= HIT) {
              d.merge = u;
              dx = p.x - o.x;
              dy = p.y - o.y;
              break;
            }
          }
        }
        const inv = invert(this.world());
        for (const [v, o] of d.orig) {
          const p = mapPt(inv, { x: o.x + dx, y: o.y + dy });
          const vert = this.net.vertices[v];
          if (vert) {
            vert.x = p.x;
            vert.y = p.y;
          }
        }
        this.commitInGroup();
        break;
      }
      case 'handle': {
        const v = this.net.vertices[d.v]!;
        if (e.altKey && d.type !== 'NONE') {
          d.type = 'NONE';
          v.handleMirroring = 'NONE';
        }
        const t = { x: local.x - v.x, y: local.y - v.y };
        setTangent(this.net, d.k, d.v, t);
        this.mirror(d.v, d.k, d.type);
        this.commitInGroup();
        break;
      }
      case 'bend-point': {
        if (!d.moved && this.screenDist(d.at, at) < 3) return true;
        d.moved = true;
        const v = this.net.vertices[d.v]!;
        const ks = adjacency(this.net)[d.v] ?? [];
        const t = { x: local.x - v.x, y: local.y - v.y };
        // Dragging from a point: symmetric handles (at an end — one).
        if (ks.length >= 1) setTangent(this.net, ks[ks.length - 1]!, d.v, t);
        if (ks.length === 2) setTangent(this.net, ks[0]!, d.v, { x: -t.x, y: -t.y });
        v.handleMirroring = 'ANGLE_AND_LENGTH';
        this.commitInGroup();
        break;
      }
      case 'bend-seg':
        this.bendSegment(d.k, d.t, local);
        this.commitInGroup();
        break;
      case 'pen': {
        if (!d.moved && this.screenDist(d.at, at) < 2) return true;
        d.moved = true;
        const v = this.net.vertices[d.v]!;
        let out = { x: local.x - v.x, y: local.y - v.y };
        if (e.shiftKey) {
          const s = snap45({ x: 0, y: 0 }, out);
          out = s;
        }
        // Drag: the outgoing handle follows the pointer, the incoming one (of the created segment) is mirrored
        // (Alt — as it was). Closing on a point with two segments — the second handle follows.
        const incoming = d.seg;
        if (incoming !== null) {
          if (e.altKey) {
            if (d.freeIn === null) d.freeIn = tangentAt(this.net, incoming, d.v);
            setTangent(this.net, incoming, d.v, d.freeIn);
            v.handleMirroring = 'NONE';
          } else {
            setTangent(this.net, incoming, d.v, { x: -out.x, y: -out.y });
            v.handleMirroring = 'ANGLE_AND_LENGTH';
            if (d.closing) this.mirror(d.v, incoming, 'ANGLE_AND_LENGTH');
          }
        } else v.handleMirroring = e.altKey ? 'NONE' : 'ANGLE_AND_LENGTH';
        this.penOut = out;
        this.commitInGroup();
        break;
      }
      default:
        break;
    }
    this.ed.dirty = true;
    return true;
  }

  up(): boolean {
    if (this.mode === 'pencil') {
      const d = this.drag;
      this.drag = null;
      if (d?.kind === 'pencil') this.finishPencil(d.points);
      this.ed.dirty = true;
      return true;
    }
    if (this.mode !== 'edit') return false;
    const d = this.drag;
    this.drag = null;
    if (!d) return this.sub !== 'move';
    switch (d.kind) {
      case 'marquee':
        return this.finishMarquee(d);
      case 'lasso':
        this.finishLasso(d.points, d.add);
        return true;
      case 'knife':
        this.cut(d.points);
        return true;
      case 'eraser':
        this.erase(d.points);
        return true;
      case 'bend-point':
        // Ctrl-click without a drag: corner ⇄ smooth.
        if (!d.moved) {
          this.setVertexType(d.v, vertexType(this.net, d.v) === 'STRAIGHT' ? 'ANGLE_AND_LENGTH' : 'STRAIGHT');
          this.commitInGroup();
        }
        break;
      case 'move':
        if (d.merge !== null && d.orig.size === 1) {
          const [v] = [...d.orig.keys()];
          mergeVertices(this.net, v!, d.merge);
          const to = d.merge > v! ? d.merge - 1 : d.merge;
          this.selV = new Set([Math.min(to, this.net.vertices.length - 1)]);
          this.selS.clear();
          this.commitInGroup();
        }
        break;
      case 'pen': {
        // Closed or connected — the path is finished; otherwise the pen continues from the new point.
        this.penFrom = d.closing ? null : d.v;
        if (d.closing) this.penOut = null;
        break;
      }
      default:
        break;
    }
    if (this.grouped) {
      this.ed.endLive();
      this.ed.doc.endGroup();
      this.grouped = false;
    }
    this.changed();
    return true;
  }

  dblclick(_e: MouseEvent, wx: number, wy: number): boolean {
    if (this.mode === 'pencil') return true;
    if (this.mode !== 'edit') return false;
    if (this.sub === 'pen') {
      // Double click with the pen — finish the path.
      this.penFrom = null;
      this.penOut = null;
      this.ed.dirty = true;
      return true;
    }
    // Double click on a segment — a point on it.
    const h = this.hit({ x: wx, y: wy }, false);
    if (h?.kind === 'segment') {
      let v = -1;
      this.edit(() => (v = splitSegment(this.net, h.k, h.t)));
      if (v >= 0) {
        this.selV = new Set([v]);
        this.selS.clear();
        this.changed();
      }
    }
    return true;
  }

  private finishMarquee(d: Extract<Drag, { kind: 'marquee' }>): boolean {
    if (this.screenDist(d.start, d.end) < 3) {
      if (!d.add) this.clearSelection();
      this.changed();
      return true;
    }
    const m = this.world();
    const x0 = Math.min(d.start.x, d.end.x);
    const x1 = Math.max(d.start.x, d.end.x);
    const y0 = Math.min(d.start.y, d.end.y);
    const y1 = Math.max(d.start.y, d.end.y);
    if (!d.add) this.clearSelection();
    this.net.vertices.forEach((p, v) => {
      const w = mapPt(m, p);
      if (w.x >= x0 && w.x <= x1 && w.y >= y0 && w.y <= y1) this.selV.add(v);
    });
    this.changed();
    return true;
  }

  private finishLasso(points: XY[], add: boolean) {
    if (!add) this.clearSelection();
    if (points.length >= 3) {
      const m = this.world();
      this.net.vertices.forEach((p, v) => {
        const w = mapPt(m, p);
        if (pointInPolygon(points, w.x, w.y)) this.selV.add(v);
      });
    }
    this.changed();
  }

  private finishPencil(points: XY[]) {
    if (points.length < 2) return;
    const doc = this.ed.doc;
    const z = this.ed.camera.zoom;
    const net = pencilNetwork(points, 1.5 / z, HIT / z);
    if (!net || !net.segments.length) return;
    let parent = this.ed.pageId;
    for (const n of this.ed.scene.hitPath(points[0]!.x, points[0]!.y)) {
      const id = this.ed.scene.id(n)!;
      const t = doc.type(id);
      if (t === 'FRAME' || t === 'COMPONENT' || t === 'SECTION') parent = id;
    }
    const pw = (parent === this.ed.pageId ? IDENTITY : this.ed.worldMatrix(parent)) as Matrix;
    const local = transformNetwork(net, invert(pw));
    const brush = this.brushMode;
    const id = doc.transact(() => {
      const id = doc.create('VECTOR', parent, {
        name: brush ? 'Brush' : 'Vector',
        transform: [1, 0, 0, 0, 1, 0],
        fills: [],
        strokes: [{ type: 'SOLID', color: brush ? { ...this.brushColor } : { r: 0, g: 0, b: 0 } }],
        strokeWeight: brush ? this.brushWeight : 2,
        strokeAlign: 'CENTER',
        strokeJoin: 'ROUND',
        strokeStartCap: 'ROUND',
        strokeEndCap: 'ROUND',
        // Each stroke has its own seed: scatter and roughness don't repeat.
        ...(brush ? { strokeBrush: { ...this.brush, seed: 1 + Math.floor(Math.random() * 1e6) } } : {}),
      });
      doc.set(id, networkProps(doc, id, local, { shared: true }));
      return id;
    });
    this.ed.select([id]);
  }

  // ---------- Edits ----------

  /** Delete the selected points (neighbors get connected) and segments. */
  deleteSelected(heal = false): boolean {
    if (this.mode !== 'edit' || (!this.selV.size && !this.selS.size)) return false;
    this.edit(() => {
      // Segments are remembered as objects: deleting points shifts indices.
      const segs = new Set([...this.selS].map((k) => this.net.segments[k]).filter((g) => !!g));
      if (this.selV.size) (heal ? healVertices : removeVertices)(this.net, this.selV);
      const drop = new Set<number>();
      this.net.segments.forEach((g, k) => {
        if (segs.has(g)) drop.add(k);
      });
      if (drop.size) removeSegments(this.net, drop);
    });
    this.clearSelection();
    this.penFrom = null;
    this.changed();
    return true;
  }

  /** Ctrl+J — connect two selected points with a segment. */
  private joinSelected(): boolean {
    if (this.selV.size !== 2) return true;
    const [a, b] = [...this.selV] as [number, number];
    if (this.net.segments.some((g) => (g.start === a && g.end === b) || (g.start === b && g.end === a))) return true;
    this.edit(() => connect(this.net, a, b));
    this.changed();
    return true;
  }

  /** Move the selected points with arrow keys (in page coordinates). */
  private nudge(dx: number, dy: number): boolean {
    const vs = this.movingVertices();
    if (!vs.size) return false;
    const m = this.world();
    const inv = invert(m);
    this.edit(() => {
      for (const v of vs) {
        const p = this.net.vertices[v]!;
        const w = mapPt(m, p);
        const q = mapPt(inv, { x: w.x + dx, y: w.y + dy });
        p.x = q.x;
        p.y = q.y;
      }
    });
    return true;
  }

  /** Type of the selected points (null — mixed or nothing selected). */
  selectedType(): PointType | null {
    const adj = adjacency(this.net);
    let type: PointType | null = null;
    for (const v of this.selV) {
      const t = vertexType(this.net, v, adj);
      if (type && t !== type) return null;
      type = t;
    }
    return type;
  }

  get selectedCount() {
    return this.mode === 'edit' ? this.selV.size : 0;
  }

  /** Corner radius of the selected points (null — mixed). */
  selectedRadius(): number | null {
    let r: number | null | undefined;
    for (const v of this.selV) {
      const x = this.net.vertices[v]?.cornerRadius ?? 0;
      if (r !== undefined && r !== x) return null;
      r = x;
    }
    return r ?? 0;
  }

  /** Round the corner at the selected points. */
  setCornerRadius(r: number) {
    if (this.mode !== 'edit' || !this.selV.size) return;
    this.edit(() => {
      for (const v of this.selV) {
        const p = this.net.vertices[v]!;
        if (r > 0) p.cornerRadius = r;
        else delete p.cornerRadius;
      }
    });
  }

  get selectedSegments() {
    return this.mode === 'edit' ? this.selS.size : 0;
  }

  /** Change the type of the selected points. */
  setPointType(type: PointType) {
    if (this.mode !== 'edit' || !this.selV.size) return;
    this.edit(() => {
      for (const v of this.selV) this.setVertexType(v, type);
    });
  }

  private setVertexType(v: number, type: PointType) {
    const net = this.net;
    const ks = adjacency(net)[v] ?? [];
    const p = net.vertices[v]!;
    if (type === 'STRAIGHT') {
      for (const k of ks) setTangent(net, k, v, { x: 0, y: 0 });
      delete p.handleMirroring;
      return;
    }
    p.handleMirroring = type as HandleMirroring;
    if (type === 'NONE' || ks.length !== 2) return;
    // Smooth: handles exist — align them, none — build them from the neighbors.
    const [k1, k2] = ks as [number, number];
    const t1 = tangentAt(net, k1, v);
    const t2 = tangentAt(net, k2, v);
    const other = (k: number) => {
      const g = net.segments[k]!;
      return net.vertices[g.start === v ? g.end : g.start]!;
    };
    const n1 = other(k1);
    const n2 = other(k2);
    let dir: XY;
    let l1: number;
    let l2: number;
    if (len(t1) > 1e-9 || len(t2) > 1e-9) {
      const a = len(t1) > 1e-9 ? t1 : { x: -t2.x, y: -t2.y };
      const b = len(t2) > 1e-9 ? t2 : { x: -t1.x, y: -t1.y };
      dir = { x: b.x - a.x, y: b.y - a.y };
      l1 = len(t1) || len(t2);
      l2 = len(t2) || len(t1);
    } else {
      dir = { x: n2.x - n1.x, y: n2.y - n1.y };
      l1 = Math.hypot(n1.x - p.x, n1.y - p.y) / 3;
      l2 = Math.hypot(n2.x - p.x, n2.y - p.y) / 3;
    }
    const l = len(dir);
    if (l < 1e-9) return;
    if (type === 'ANGLE_AND_LENGTH') l1 = l2 = (l1 + l2) / 2;
    const u = { x: dir.x / l, y: dir.y / l };
    setTangent(net, k1, v, { x: -u.x * l1, y: -u.y * l1 });
    setTangent(net, k2, v, { x: u.x * l2, y: u.y * l2 });
  }

  /** Mirroring: for a point with two segments, the second handle follows the first. */
  private mirror(v: number, k: number, type: PointType) {
    if (type !== 'ANGLE' && type !== 'ANGLE_AND_LENGTH') return;
    const ks = adjacency(this.net)[v] ?? [];
    if (ks.length !== 2) return;
    const k2 = ks[0] === k ? ks[1]! : ks[0]!;
    const t = tangentAt(this.net, k, v);
    const lt = len(t);
    if (lt < 1e-9) return;
    const l = type === 'ANGLE_AND_LENGTH' ? lt : len(tangentAt(this.net, k2, v));
    setTangent(this.net, k2, v, { x: (-t.x / lt) * l, y: (-t.y / lt) * l });
  }

  /** Bending a segment: the curve passes through the point at the same parameter t (handles move together). */
  private bendSegment(k: number, t: number, target: XY) {
    const g = this.net.segments[k];
    if (!g) return;
    const p = segmentPoints(this.net, k);
    let c1 = isStraight(g) ? { x: p[0].x + (p[3].x - p[0].x) / 3, y: p[0].y + (p[3].y - p[0].y) / 3 } : p[1];
    let c2 = isStraight(g) ? { x: p[0].x + ((p[3].x - p[0].x) * 2) / 3, y: p[0].y + ((p[3].y - p[0].y) * 2) / 3 } : p[2];
    const cur = bezierAt([p[0], c1, c2, p[3]], t);
    const kk = 3 * t * (1 - t) || 1e-6;
    const dx = (target.x - cur.x) / kk;
    const dy = (target.y - cur.y) / kk;
    c1 = { x: c1.x + dx, y: c1.y + dy };
    c2 = { x: c2.x + dx, y: c2.y + dy };
    setTangent(this.net, k, g.start, { x: c1.x - p[0].x, y: c1.y - p[0].y });
    setTangent(this.net, k, g.end, { x: c2.x - p[3].x, y: c2.y - p[3].y });
    // Smooth neighboring points stay smooth.
    for (const v of [g.start, g.end]) this.mirror(v, k, vertexType(this.net, v));
  }

  /** Knife: cut along a line (world). */
  private cut(points: XY[]) {
    if (points.length < 2) return;
    const inv = invert(this.world());
    // Hand jitter and intermediate points of a straight line are dropped: a straight cut is one segment.
    const line = simplifyPolyline(points, 1.5 / this.ed.camera.zoom).map((p) => mapPt(inv, p));
    this.ed.doc.beginGroup();
    try {
      this.ensureVectorNow();
      const fills = this.ed.doc.get(this.target!, 'fills') ?? [];
      this.edit(() => cutNetwork(this.net, line, fills.length > 0));
    } finally {
      this.ed.doc.endGroup();
    }
    this.clearSelection();
    this.changed();
  }

  /** Eraser: for filled shapes the trail is subtracted from the shape, for lines — pieces of segments are erased. */
  private erase(points: XY[]) {
    if (!points.length) return;
    const zoom = this.ed.camera.zoom;
    const m = this.world();
    const inv = invert(m);
    const line = (points.length > 2 ? simplifyPolyline(points, 1 / zoom) : points).map((p) => mapPt(inv, p));
    // Radius in layer units (layer matrix scale — averaged).
    const r = this.eraserSize / zoom / (Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])) || 1);
    const doc = this.ed.doc;
    doc.beginGroup();
    try {
      this.ensureVectorNow();
      const filled = (doc.get(this.target!, 'fills') ?? []).some((p) => p.visible !== false);
      this.edit(() => {
        const net = filled && networkFaces(this.net).length ? this.eraseFilled(line, r) : null;
        if (net) this.net = net;
        else eraseNetwork(this.net, line, r);
      });
    } finally {
      doc.endGroup();
    }
    this.clearSelection();
    this.changed();
  }

  /** Filled shape minus the eraser trail (PathOps); null — failed (then segments are cut). */
  private eraseFilled(line: XY[], r: number): VectorNetwork | null {
    const ck = this.ck;
    const fills = networkFillPaths(this.net);
    if (!fills.length) return null;
    const b = new ck.PathBuilder();
    for (const f of fills) {
      const p = ck.Path.MakeFromSVGString(f.data);
      if (!p) continue;
      const pb = new ck.PathBuilder();
      pb.addPath(p);
      pb.setFillType(f.windingRule === 'EVENODD' ? ck.FillType.EvenOdd : ck.FillType.Winding);
      const q = pb.detachAndDelete();
      b.addPath(q);
      q.delete();
      p.delete();
    }
    const shape = b.detachAndDelete();
    const tb = new ck.PathBuilder();
    tb.moveTo(line[0]!.x, line[0]!.y);
    // A point (click without a drag) — a round trail.
    if (line.length === 1) tb.lineTo(line[0]!.x + 0.01, line[0]!.y);
    for (const p of line.slice(1)) tb.lineTo(p.x, p.y);
    const trail = tb.detachAndDelete();
    const area = trail.makeStroked({ width: 2 * r, cap: ck.StrokeCap.Round, join: ck.StrokeJoin.Round, miter_limit: 4 });
    trail.delete();
    // Union with itself — removes self-intersections (otherwise subtraction leaves holes along them).
    const simple = ck.Path.MakeFromOp(shape, shape, ck.PathOp.Union);
    const result = simple && area ? ck.Path.MakeFromOp(simple, area, ck.PathOp.Difference) : null;
    shape.delete();
    simple?.delete();
    area?.delete();
    if (!result) return null;
    const data = result.toSVGString();
    const evenOdd = result.getFillType() === ck.FillType.EvenOdd;
    result.delete();
    if (!data.trim()) return { vertices: [], segments: [] };
    return networkFromSvg(data, evenOdd ? 'EVENODD' : 'NONZERO');
  }

  // ---------- Bucket: highlight ----------

  private updateBucketHover(at: XY) {
    const local = this.toLocal(at);
    const net = this.net;
    const fills = this.ed.doc.get(this.target!, 'fills') ?? [];
    const implicit = !net.regions?.length && fills.length > 0;
    const i = implicit ? -1 : regionIndexAt(net, local.x, local.y);
    if (i >= 0) {
      const polys = net.regions![i]!.loops.map((l) => loopPolygon(net, l)).filter((p): p is XY[] => !!p);
      this.bucketHover = { polygons: polys, remove: true };
    } else {
      const f = faceAt(net, local.x, local.y);
      this.bucketHover = f ? { polygons: f.loops.map((l) => loopPolygon(net, l)).filter((p): p is XY[] => !!p), remove: implicit } : null;
    }
    this.ed.dirty = true;
  }

  // ---------- Drawing over the canvas ----------

  private draw(canvas: Canvas) {
    if (this.mode === 'off') return;
    const ck = this.ck;
    const ed = this.ed;
    // The theme changed the selection color — repaint.
    if (this.accentV !== canvasAccent.version) {
      this.accentV = canvasAccent.version;
      const { r, g, b } = canvasAccent;
      for (const [k, a] of [['line', 1], ['lineSel', 1], ['pointSel', 1], ['handle', 1], ['preview', 1], ['fill', 0.18]] as const) this.paints[k].setColor(ck.Color4f(r, g, b, a));
    }
    const toScreen = (m: Matrix, p: XY) => {
      const w = mapPt(m, p);
      const [x, y] = ed.worldToScreen(w.x, w.y);
      return { x, y };
    };
    const polyline = (pts: XY[], paint: Paint, close = false) => {
      if (pts.length < 2) return;
      const b = new ck.PathBuilder();
      pts.forEach((p, i) => {
        const [x, y] = ed.worldToScreen(p.x, p.y);
        if (i) b.lineTo(x, y);
        else b.moveTo(x, y);
      });
      if (close) b.close();
      const path = b.detachAndDelete();
      canvas.drawPath(path, paint);
      path.delete();
    };
    if (this.mode === 'pencil') {
      if (this.drag?.kind === 'pencil') polyline(this.drag.points, this.paints.line);
      return;
    }
    const m = this.world();
    const net = this.net;
    const square = (p: XY, sel: boolean) => {
      const r = ck.XYWHRect(p.x - 3.5, p.y - 3.5, 7, 7);
      canvas.drawRect(r, sel ? this.paints.pointSel : this.paints.point);
      canvas.drawRect(r, this.paints.handle);
    };
    // Bucket: region under the pointer.
    if (this.sub === 'bucket' && this.bucketHover) {
      for (const poly of this.bucketHover.polygons) polyline(poly.map((p) => mapPt(m, p)), this.bucketHover.remove ? this.paints.unfill : this.paints.fill, true);
    }
    // Segments — as one path (selected ones — as a second, thicker one).
    for (const selected of [false, true]) {
      const b = new ck.PathBuilder();
      let any = false;
      net.segments.forEach((g, k) => {
        if (this.selS.has(k) !== selected) return;
        const p = segmentPoints(net, k).map((q) => toScreen(m, q));
        b.moveTo(p[0]!.x, p[0]!.y);
        if (isStraight(g)) b.lineTo(p[3]!.x, p[3]!.y);
        else b.cubicTo(p[1]!.x, p[1]!.y, p[2]!.x, p[2]!.y, p[3]!.x, p[3]!.y);
        any = true;
      });
      const path = b.detachAndDelete();
      if (any) canvas.drawPath(path, selected ? this.paints.lineSel : this.paints.line);
      path.delete();
    }
    // Pen: preview of the segment to the pointer.
    if (this.sub === 'pen' && this.penFrom !== null && this.cursor && !this.drag) {
      const a = net.vertices[this.penFrom];
      if (a) {
        const pa = toScreen(m, a);
        const c = ed.worldToScreen(this.cursor.x, this.cursor.y);
        const b = new ck.PathBuilder();
        b.moveTo(pa.x, pa.y);
        if (this.penOut) {
          const h1 = toScreen(m, { x: a.x + this.penOut.x, y: a.y + this.penOut.y });
          b.cubicTo(h1.x, h1.y, c[0], c[1], c[0], c[1]);
        } else b.lineTo(c[0], c[1]);
        const path = b.detachAndDelete();
        canvas.drawPath(path, this.paints.preview);
        path.delete();
      }
    }
    // Handles.
    const handles = this.visibleHandles();
    if (this.sub === 'pen' && this.penFrom !== null && this.penOut) {
      const a = net.vertices[this.penFrom];
      if (a) {
        const pa = toScreen(m, a);
        const hp = toScreen(m, { x: a.x + this.penOut.x, y: a.y + this.penOut.y });
        canvas.drawLine(pa.x, pa.y, hp.x, hp.y, this.paints.handle);
        canvas.drawCircle(hp.x, hp.y, 3, this.paints.pointSel);
      }
    }
    for (const { v, k } of handles) {
      const p = net.vertices[v]!;
      const t = tangentAt(net, k, v);
      const a = toScreen(m, p);
      const b = toScreen(m, { x: p.x + t.x, y: p.y + t.y });
      canvas.drawLine(a.x, a.y, b.x, b.y, this.paints.handle);
      canvas.drawCircle(b.x, b.y, 3, this.paints.pointSel);
    }
    net.vertices.forEach((p, v) => square(toScreen(m, p), this.selV.has(v)));
    // Box, lasso, knife.
    const d = this.drag;
    if (d?.kind === 'marquee' && this.screenDist(d.start, d.end) >= 3) {
      polyline(
        [
          { x: d.start.x, y: d.start.y },
          { x: d.end.x, y: d.start.y },
          { x: d.end.x, y: d.end.y },
          { x: d.start.x, y: d.end.y },
        ],
        this.paints.preview,
        true,
      );
    }
    if (d?.kind === 'lasso') polyline(d.points, this.paints.preview, true);
    if (d?.kind === 'knife') polyline(d.points, this.paints.knife);
    // Eraser: a trail as thick as the size and a ring at the pointer.
    if (this.sub === 'eraser') {
      if (d?.kind === 'eraser') {
        this.paints.eraser.setStrokeWidth(this.eraserSize * 2);
        polyline(d.points.length > 1 ? d.points : [d.points[0]!, { x: d.points[0]!.x + 0.01 / ed.camera.zoom, y: d.points[0]!.y }], this.paints.eraser);
      }
      if (this.cursor) {
        const [x, y] = ed.worldToScreen(this.cursor.x, this.cursor.y);
        canvas.drawCircle(x, y, this.eraserSize, this.paints.eraserRing);
      }
    }
  }
}

/** Distance from a point to a polyline. */
function distToPolyline(p: XY, line: readonly XY[]): number {
  if (line.length === 1) return Math.hypot(p.x - line[0]!.x, p.y - line[0]!.y);
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
  }
  return best;
}

/**
 * Eraser over network segments: parts of segments closer than r to the trail are removed, new ends
 * appear at the edges of the erased part (the shape of the remaining parts is the same — de Casteljau
 * subdivision). Regions with touched segments disappear (the path is opened). false — nothing touched.
 */
export function eraseNetwork(net: VectorNetwork, line: readonly XY[], r: number): boolean {
  if (!line.length || r <= 0) return false;
  const lx0 = Math.min(...line.map((p) => p.x)) - r;
  const ly0 = Math.min(...line.map((p) => p.y)) - r;
  const lx1 = Math.max(...line.map((p) => p.x)) + r;
  const ly1 = Math.max(...line.map((p) => p.y)) + r;
  const near = (p: XY) => distToPolyline(p, line) <= r;
  const plan = new Map<number, [number, number][]>();
  const count = net.segments.length;
  for (let k = 0; k < count; k++) {
    const p = segmentPoints(net, k);
    const xs = p.map((q) => q.x);
    const ys = p.map((q) => q.y);
    if (Math.max(...xs) < lx0 || Math.min(...xs) > lx1 || Math.max(...ys) < ly0 || Math.min(...ys) > ly1) continue;
    const len = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y) + Math.hypot(p[2].x - p[1].x, p[2].y - p[1].y) + Math.hypot(p[3].x - p[2].x, p[3].y - p[2].y);
    const n = Math.max(8, Math.min(400, Math.ceil(len / Math.max(0.5, r / 3))));
    // For a straight segment t is a fraction of length (as splitSegment divides it), for a curve — the Bézier parameter.
    const straight = isStraight(net.segments[k]!);
    const at = (t: number) => (straight ? { x: p[0].x + (p[3].x - p[0].x) * t, y: p[0].y + (p[3].y - p[0].y) * t } : bezierAt(p, t));
    // The boundary of the erased part between t0 and t1 — by bisection.
    const edge = (t0: number, t1: number, in0: boolean) => {
      for (let i = 0; i < 14; i++) {
        const m = (t0 + t1) / 2;
        if (near(at(m)) === in0) t0 = m;
        else t1 = m;
      }
      return (t0 + t1) / 2;
    };
    const intervals: [number, number][] = [];
    let prevT = 0;
    let prevIn = near(p[0]);
    let start = prevIn ? 0 : -1;
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      const inside = near(at(t));
      if (inside !== prevIn) {
        const tb = edge(prevT, t, prevIn);
        if (inside) start = tb;
        else {
          intervals.push([start, tb]);
          start = -1;
        }
      }
      prevIn = inside;
      prevT = t;
    }
    if (start >= 0) intervals.push([start, 1]);
    if (intervals.length) plan.set(k, intervals);
  }
  if (!plan.size) return false;
  const drop = new Set<number>();
  for (const [k, intervals] of plan) {
    if (intervals.length === 1 && intervals[0]![0] <= 1e-4 && intervals[0]![1] >= 1 - 1e-4) {
      drop.add(k);
      continue;
    }
    const cuts = [...new Set(intervals.flat().filter((t) => t > 1e-4 && t < 1 - 1e-4))].sort((a, b) => a - b);
    // Splitting from the end: the tail [c, 1] becomes a new segment, k stays the start.
    const pieces: number[] = [];
    let scale = 1;
    for (let i = cuts.length - 1; i >= 0; i--) {
      splitSegment(net, k, cuts[i]! / scale);
      pieces[i + 1] = net.segments.length - 1;
      scale = cuts[i]!;
    }
    pieces[0] = k;
    const bounds = [0, ...cuts, 1];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const mid = (bounds[i]! + bounds[i + 1]!) / 2;
      if (intervals.some(([a, b]) => mid >= a && mid <= b)) drop.add(pieces[i]!);
    }
  }
  removeSegments(net, drop);
  return true;
}

/** All bounded faces of the network become regions (the vector was filled entirely). */
function facesOf(net: VectorNetwork): VectorRegion[] {
  const out: VectorRegion[] = [];
  const seen = new Set<string>();
  // An interior point of each face — the centroid of a triangle formed by adjacent vertices of its polygon.
  const bounds = networkBounds(net);
  if (!bounds) return out;
  const tryAt = (x: number, y: number) => {
    const f = faceAt(net, x, y);
    if (!f) return;
    const key = f.loops.map((l) => [...l].sort((a, b) => a - b).join(',')).join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  // Grid of probes over the box: faces smaller than the step may be missed — they can be filled with the bucket.
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) tryAt(bounds[0] + ((bounds[2] - bounds[0]) * (i + 0.5)) / (steps + 1), bounds[1] + ((bounds[3] - bounds[1]) * (j + 0.5)) / (steps + 1));
  }
  return out;
}

/**
 * Cut the network with polyline line (network coordinates). Intersections become new points; inside filled
 * regions, between adjacent intersections — a segment along the cut line (the region splits in two); for open
 * paths — a break at the intersection point.
 */
export function cutNetwork(net: VectorNetwork, line: readonly XY[], filledWithoutRegions: boolean) {
  // Line intersections with segments: (segment, t on it, distance along the knife).
  const hits: { k: number; t: number; s: number }[] = [];
  let along = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    net.segments.forEach((_, k) => {
      const p = segmentPoints(net, k);
      const n = isStraight(net.segments[k]!) ? 1 : 24;
      let prev = p[0];
      for (let j = 1; j <= n; j++) {
        const q = n === 1 ? p[3] : bezierAt(p, j / n);
        const x = segmentIntersection(a, b, prev, q);
        if (x) hits.push({ k, t: (j - 1 + x.u) / n, s: along + x.t * segLen });
        prev = q;
      }
    });
    along += segLen;
  }
  if (!hits.length) return;
  // Which region is filled at the point (before the cut) — from the old network.
  const before = cloneNetwork(net);
  const filledAt = (x: number, y: number) => {
    if (before.regions?.length) return regionIndexAt(before, x, y);
    if (!filledWithoutRegions) return -1;
    return faceAt(before, x, y) ? 0 : -1;
  };
  // Split segments at intersection points (from the end, so indices and parameters don't shift).
  const byK = new Map<number, { t: number; s: number }[]>();
  for (const h of hits) {
    const list = byK.get(h.k) ?? [];
    list.push(h);
    byK.set(h.k, list);
  }
  const cuts: { v: number; s: number }[] = [];
  for (const [k, list] of byK) {
    list.sort((a, b) => b.t - a.t);
    // t on the original segment; after a split at a larger t, segment [0, t] remains — recompute.
    let scale = 1;
    for (const h of list) {
      const t = h.t / scale;
      if (t <= 1e-4 || t >= 1 - 1e-4) {
        // Right at the end — the end point itself.
        const g = net.segments[k]!;
        cuts.push({ v: t <= 1e-4 ? g.start : g.end, s: h.s });
        continue;
      }
      const v = splitSegment(net, k, t);
      cuts.push({ v, s: h.s });
      scale = h.t;
    }
  }
  cuts.sort((a, b) => a.s - b.s);
  // Segments along the knife between adjacent intersections inside a filled area.
  const at = (s: number): XY => {
    let acc = 0;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i]!;
      const b = line[i + 1]!;
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (acc + l >= s) {
        const u = l ? (s - acc) / l : 0;
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
      }
      acc += l;
    }
    return line[line.length - 1]!;
  };
  const joined = new Set<number>();
  const regionsBefore = before.regions ?? [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!;
    const b = cuts[i + 1]!;
    if (a.v === b.v) continue;
    const mid = at((a.s + b.s) / 2);
    if (filledAt(mid.x, mid.y) < 0) continue;
    // Knife points between intersections become vertices of the cut segment (freehand line).
    const inner = line.filter((_, j) => j > 0 && j < line.length - 1).filter((p) => {
      const sp = projectAlong(line, p);
      return sp > a.s && sp < b.s;
    });
    let from = a.v;
    for (const p of inner) {
      const v = net.vertices.push({ x: p.x, y: p.y }) - 1;
      net.segments.push({ start: from, end: v });
      from = v;
    }
    net.segments.push({ start: from, end: b.v });
    joined.add(a.v).add(b.v);
  }
  // Regions: faces of the new network lying inside the previous filled regions (their fill).
  if (regionsBefore.length || filledWithoutRegions) {
    const regions: VectorRegion[] = [];
    const seen = new Set<string>();
    for (const f of facesOf(net)) {
      const poly = loopPolygon(net, f.loops[0]!);
      if (!poly) continue;
      const c = interiorPoint(poly);
      if (!c) continue;
      const r = filledAt(c.x, c.y);
      if (r < 0) continue;
      const key = f.loops.map((l) => [...l].sort((x, y) => x - y).join(',')).join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const old = regionsBefore[r];
      regions.push(old?.fills ? { ...f, fills: old.fills } : f);
    }
    net.regions = regions;
  }
  // Intersections where the cut didn't add a segment (open path) — a break: the point is split in two.
  for (const c of cuts) {
    if (joined.has(c.v)) continue;
    const ks = adjacency(net)[c.v] ?? [];
    if (ks.length !== 2) continue;
    const p = net.vertices[c.v]!;
    const copy = net.vertices.push({ x: p.x, y: p.y }) - 1;
    const g = net.segments[ks[1]!]!;
    if (g.start === c.v) g.start = copy;
    else g.end = copy;
    // Region loops through this point are no longer closed.
    if (net.regions) net.regions = net.regions.filter((r) => r.loops.every((l) => !l.includes(ks[1]!)));
  }
}

/** Intersection of segments ab and cd: t — fraction on ab, u — on cd. */
function segmentIntersection(a: XY, b: XY, c: XY, d: XY): { t: number; u: number } | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const t = (qp.x * s.y - qp.y * s.x) / den;
  const u = (qp.x * r.y - qp.y * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** Distance along a polyline to a point (the point is one of its vertices). */
function projectAlong(line: readonly XY[], p: XY): number {
  let acc = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === p) return acc;
    if (i + 1 < line.length) acc += Math.hypot(line[i + 1]!.x - line[i]!.x, line[i + 1]!.y - line[i]!.y);
  }
  return acc;
}

/** A point inside a polygon: the midpoint between two intersections of the horizontal line through the box center. */
function interiorPoint(poly: readonly XY[]): XY | null {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  for (const f of [0.5, 0.37, 0.63, 0.25, 0.75]) {
    const y = y0 + (y1 - y0) * f;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1]! - xs[k]! > 1e-6) return { x: (xs[k]! + xs[k + 1]!) / 2, y };
  }
  return null;
}

/** Panel section in path edit mode: tools, type of the selected points, hints. */
export function vectorPointsSection(v: VectorTool): HTMLElement | null {
  if (v.mode !== 'edit') return null;
  const n = v.selectedCount;
  const cur = v.selectedType();
  const types: PointType[] = ['STRAIGHT', 'NONE', 'ANGLE', 'ANGLE_AND_LENGTH'];
  const sel = h(
    'select',
    { title: 'Тип точки: угол, свободные ручки, зеркальный угол, зеркальные угол и длина' },
    ...(cur === null ? [h('option', { value: '', selected: true, disabled: true }, 'Разные')] : []),
    ...types.map((t) => h('option', { value: t, selected: t === cur }, POINT_TYPE_LABEL[t])),
  ) as HTMLSelectElement;
  sel.addEventListener('change', () => v.setPointType(sel.value as PointType));
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  // Corner radius at the selected points (between two straight segments).
  const r = v.selectedRadius();
  const radius = h('input', { type: 'number', min: '0', step: '1', value: r === null ? '' : String(r), placeholder: r === null ? 'Разные' : '0', title: 'Скругление угла в выбранных точках' }) as HTMLInputElement;
  radius.addEventListener('change', () => v.setCornerRadius(Math.max(0, Number(radius.value.replace(',', '.')) || 0)));
  radius.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') radius.blur();
  });
  const hint: Record<VectorSubTool, string> = {
    move: n
      ? `Выбрано точек: ${n}. Протяжка — сдвинуть (на другую точку — слить), стрелки — на 1 px (Shift — 10), Delete — удалить. Alt при протяжке ручки — без зеркала.`
      : 'Щелчок — точка или отрезок, Shift — несколько, протяжка по пустому — рамка. Ctrl: щелчок по точке — угол ⇄ гладкая, протяжка от точки — ручки, протяжка отрезка — изгиб. Двойной щелчок по отрезку — новая точка.',
    pen: 'Щелчок — точка (от выбранного конца), протяжка — ручки (Alt — без зеркала, Shift — шаг 45°). По точке — соединить (развилка, замыкание), по отрезку — новая точка. Esc — закончить контур.',
    bucket: 'Щелчок по области — залить, по залитой — снять заливку.',
    lasso: 'Обведите точки, чтобы выбрать их (Shift — добавить к выбранным).',
    knife: 'Проведите линию через контур: залитые области делятся по ней, открытые контуры расходятся.',
    eraser: `Проведите по контуру: у линий стёртые куски исчезают, у залитых форм след вычитается из формы. Размер — [ и ] (сейчас ${v.eraserSize} px).`,
  };
  return h(
    'div',
    { class: 'section' },
    h('h3', {}, 'Правка вектора'),
    n ? h('div', { class: 'props' }, h('div', { class: 'field wide' }, sel), h('div', { class: 'field', title: 'Скругление угла' }, h('label', {}, '◜'), radius)) : null,
    h('div', { class: 'empty', style: 'padding-top:6px' }, hint[v.sub]),
  );
}

/** “Brush” tool panel: a brush from the set, thickness, color. */
export function brushToolSection(v: VectorTool): HTMLElement {
  const sel = h('select', { title: 'Кисть' }, ...BRUSHES.map((b) => h('option', { value: b.name, selected: b.name === v.brush.name }, b.label))) as HTMLSelectElement;
  sel.addEventListener('change', () => {
    const b = BRUSHES.find((x) => x.name === sel.value)!;
    v.brush = { type: b.type, name: b.name };
  });
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  const weight = h('input', { type: 'number', min: '0.5', max: '200', step: '0.5', value: String(v.brushWeight), title: 'Толщина' }) as HTMLInputElement;
  weight.addEventListener('change', () => {
    const w = Number(weight.value);
    if (w > 0) v.brushWeight = Math.min(200, w);
  });
  weight.addEventListener('keydown', (e) => e.stopPropagation());
  const hex = '#' + [v.brushColor.r, v.brushColor.g, v.brushColor.b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
  const color = h('input', { type: 'color', value: hex, title: 'Цвет' }) as HTMLInputElement;
  color.addEventListener('input', () => {
    const x = color.value;
    v.brushColor = { r: parseInt(x.slice(1, 3), 16) / 255, g: parseInt(x.slice(3, 5), 16) / 255, b: parseInt(x.slice(5, 7), 16) / 255 };
  });
  return h(
    'div',
    { class: 'section' },
    h('h3', {}, 'Кисть'),
    h('div', { class: 'props' }, h('div', { class: 'field wide' }, sel), h('div', { class: 'field' }, h('label', {}, 'Т'), weight), h('div', { class: 'field' }, color)),
    h('div', { class: 'empty', style: 'padding-top:6px' }, 'Проведите линию — мазок кистью. Кисть, толщину и цвет мазка потом можно поменять в обводке.'),
  );
}

/** The node's network as stored in the document (for debugging and tests). */
export function storedNetwork(doc: Editor['doc'], id: string): VectorNetwork | null {
  const ref = doc.get(id, 'vectorNetwork') as { data?: string; blob?: string } | undefined;
  const s = ref?.data ?? (ref?.blob ? doc.blob(ref.blob) : undefined);
  return s ? decodeNetwork(s) : null;
}
