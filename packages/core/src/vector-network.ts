// Vector network: vertices, segments with tangents,
// regions (loops of segments) with their own fills. For a vector it is the source of truth for editing;
// fill paths (vectorPaths) and center lines for the stroke (centerPaths) are derived,
// networkProps() writes them all together.
//
// In the document it is a compact JSON string (right in the property or as a geometry table key):
//   {"v":[[x,y],[x,y,{"m":"ANGLE","c":"ROUND","j":"BEVEL","r":4}]],
//    "s":[[a,b],[a,b,tsx,tsy,tex,tey]],
//    "r":[{"w":"E","l":[[0,1,2]],"f":[…fills…]}]}
// Coordinates are in the node's space at geometrySize (as for paths).
//
// A network without regions is filled as a whole (open chains as if closed): that is how paths were
// drawn before networks, and how .fig files store them while the network has no regions of its own.
//
// Vertex rounding (cornerRadius) cuts the corner between two straight segments with an arc — in fill
// paths and stroke center lines; the radius is smaller if the segments are short (at most half of them).

import type { Document } from './document.ts';
import { deepFreeze } from './intern.ts';
import type { HandleMirroring, Matrix, Props, StrokeCap, VectorNetwork, VectorPath, VectorRegion, VectorSegment, VectorVertex } from './types.ts';

export interface XY {
  x: number;
  y: number;
}
type Rect = [number, number, number, number];

const ZERO: XY = { x: 0, y: 0 };
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const num = (v: number) => String(r3(v));

// ---------- Storage ----------

/** Network → compact string (numbers to thousandths). */
export function encodeNetwork(net: VectorNetwork): string {
  const v = net.vertices.map((p) => {
    const extra: Record<string, unknown> = {};
    if (p.handleMirroring) extra.m = p.handleMirroring;
    if (p.strokeCap && p.strokeCap !== 'NONE') extra.c = p.strokeCap;
    if (p.strokeJoin) extra.j = p.strokeJoin;
    if (p.cornerRadius) extra.r = p.cornerRadius;
    return Object.keys(extra).length ? [r3(p.x), r3(p.y), extra] : [r3(p.x), r3(p.y)];
  });
  const s = net.segments.map((g) => (isStraight(g) ? [g.start, g.end] : [g.start, g.end, r3(g.tangentStart?.x ?? 0), r3(g.tangentStart?.y ?? 0), r3(g.tangentEnd?.x ?? 0), r3(g.tangentEnd?.y ?? 0)]));
  const out: Record<string, unknown> = { v, s };
  if (net.regions?.length) {
    out.r = net.regions.map((r) => ({ w: r.windingRule === 'EVENODD' ? 'E' : 'N', l: r.loops, ...(r.fills ? { f: r.fills } : {}), ...(r.fillStyleId ? { fs: r.fillStyleId } : {}) }));
  }
  return JSON.stringify(out);
}

const CACHE = new Map<string, VectorNetwork>();
const CACHE_MAX = 1024;

/** String → network (frozen, from cache; for editing use cloneNetwork). null — corrupted. */
export function decodeNetwork(s: string): VectorNetwork | null {
  const hit = CACHE.get(s);
  if (hit) return hit;
  let net: VectorNetwork;
  try {
    const o = JSON.parse(s) as { v?: unknown[]; s?: unknown[]; r?: { w?: string; l?: number[][]; f?: unknown; fs?: string }[] };
    const vertices: VectorVertex[] = (o.v ?? []).map((raw) => {
      const a = raw as [number, number, Record<string, unknown>?];
      const v: VectorVertex = { x: Number(a[0]) || 0, y: Number(a[1]) || 0 };
      const e = a[2];
      if (e) {
        if (typeof e.m === 'string') v.handleMirroring = e.m as HandleMirroring;
        if (typeof e.c === 'string') v.strokeCap = e.c as StrokeCap;
        if (typeof e.j === 'string') v.strokeJoin = e.j as VectorVertex['strokeJoin'];
        if (typeof e.r === 'number') v.cornerRadius = e.r;
      }
      return v;
    });
    const segments: VectorSegment[] = (o.s ?? []).map((raw) => {
      const a = raw as number[];
      const g: VectorSegment = { start: a[0]!, end: a[1]! };
      if (a.length >= 6) {
        g.tangentStart = { x: a[2]!, y: a[3]! };
        g.tangentEnd = { x: a[4]!, y: a[5]! };
      }
      return g;
    });
    if (segments.some((g) => !(g.start >= 0 && g.start < vertices.length && g.end >= 0 && g.end < vertices.length))) return null;
    net = { vertices, segments };
    if (o.r?.length) {
      net.regions = o.r
        .map((r) => {
          const region: VectorRegion = { windingRule: r.w === 'E' ? 'EVENODD' : 'NONZERO', loops: (r.l ?? []).filter((l) => l.every((k) => k >= 0 && k < segments.length)) };
          if (Array.isArray(r.f)) region.fills = r.f as VectorRegion['fills'];
          if (typeof r.fs === 'string') region.fillStyleId = r.fs;
          return region;
        })
        .filter((r) => r.loops.length);
    }
  } catch {
    return null;
  }
  deepFreeze(net);
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value!);
  CACHE.set(s, net);
  return net;
}

/** Mutable copy of a network. */
export function cloneNetwork(net: VectorNetwork): VectorNetwork {
  return {
    vertices: net.vertices.map((v) => ({ ...v })),
    segments: net.segments.map((g) => ({ start: g.start, end: g.end, ...(g.tangentStart ? { tangentStart: { ...g.tangentStart } } : {}), ...(g.tangentEnd ? { tangentEnd: { ...g.tangentEnd } } : {}) })),
    ...(net.regions ? { regions: net.regions.map((r) => ({ ...r, loops: r.loops.map((l) => [...l]) })) } : {}),
  };
}

// ---------- Geometry ----------

export function isStraight(g: VectorSegment): boolean {
  return !(g.tangentStart?.x || g.tangentStart?.y || g.tangentEnd?.x || g.tangentEnd?.y);
}

/** Segment control points (cubic curve): from start to end, reverse — backwards. */
export function segmentPoints(net: VectorNetwork, k: number, reverse = false): [XY, XY, XY, XY] {
  const g = net.segments[k]!;
  const a = net.vertices[g.start]!;
  const b = net.vertices[g.end]!;
  const ts = g.tangentStart ?? ZERO;
  const te = g.tangentEnd ?? ZERO;
  const p: [XY, XY, XY, XY] = [
    { x: a.x, y: a.y },
    { x: a.x + ts.x, y: a.y + ts.y },
    { x: b.x + te.x, y: b.y + te.y },
    { x: b.x, y: b.y },
  ];
  return reverse ? [p[3], p[2], p[1], p[0]] : p;
}

/** Curve point at parameter t. */
export function bezierAt(p: readonly [XY, XY, XY, XY], t: number): XY {
  const u = 1 - t;
  return {
    x: u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x,
    y: u * u * u * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t * t * t * p[3].y,
  };
}

/** SVG command for segment k in traversal direction (reverse — from end to start). */
function segmentCommand(net: VectorNetwork, k: number, reverse: boolean): string {
  const g = net.segments[k]!;
  const p = segmentPoints(net, k, reverse);
  if (isStraight(g)) return `L${num(p[3].x)} ${num(p[3].y)}`;
  return `C${num(p[1].x)} ${num(p[1].y)} ${num(p[2].x)} ${num(p[2].y)} ${num(p[3].x)} ${num(p[3].y)}`;
}

/** Region loop as a closed SVG path (direction follows the shared vertices of adjacent segments). */
export function loopPath(net: VectorNetwork, loop: readonly number[]): string | null {
  const start = loopStart(net, loop);
  if (start === null) return null;
  let cur = start;
  const steps: Step[] = [];
  for (const k of loop) {
    const g = net.segments[k]!;
    const forward = g.start === cur;
    steps.push({ k, reverse: !forward, end: forward ? g.end : g.start });
    cur = forward ? g.end : g.start;
  }
  return stepsPath(net, start, steps, true);
}

/** Traversal step: segment k (reverse — from end to start) and the vertex it leads to. */
interface Step {
  k: number;
  reverse: boolean;
  end: number;
}

/**
 * Path traversing segments from vertex start (closed — closed path). At vertices with rounding between
 * two straight segments the corner is cut with an arc of radius cornerRadius (a cubic curve); a segment
 * gives at most half its length on each side to the rounding.
 */
function stepsPath(net: VectorNetwork, start: number, steps: readonly Step[], closed: boolean): string {
  const n = steps.length;
  const junction = (i: number) => (i + 1 < n ? i + 1 : closed ? 0 : -1);
  const rounded = steps.some((st, i) => (net.vertices[st.end]!.cornerRadius ?? 0) > 0 && junction(i) >= 0);
  if (!rounded) {
    const v0 = net.vertices[start]!;
    const parts = [`M${num(v0.x)} ${num(v0.y)}`];
    for (const st of steps) parts.push(segmentCommand(net, st.k, st.reverse));
    if (closed) closePath(parts, net.segments[steps[n - 1]!.k]!);
    return parts.join('');
  }
  const curves = steps.map((st) => segmentPoints(net, st.k, st.reverse));
  const straight = steps.map((st) => isStraight(net.segments[st.k]!));
  const from = curves.map((c) => c[0]);
  const to = curves.map((c) => c[3]);
  const arcs: ([XY, XY, XY] | null)[] = steps.map(() => null);
  for (let i = 0; i < n; i++) {
    const j = junction(i);
    const r = net.vertices[steps[i]!.end]!.cornerRadius ?? 0;
    if (j < 0 || !(r > 0) || !straight[i] || !straight[j]) continue;
    const a = curves[i]![0];
    const v = curves[i]![3];
    const b = curves[j]![3];
    const l1 = Math.hypot(v.x - a.x, v.y - a.y);
    const l2 = Math.hypot(b.x - v.x, b.y - v.y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const u1 = { x: (v.x - a.x) / l1, y: (v.y - a.y) / l1 };
    const u2 = { x: (b.x - v.x) / l2, y: (b.y - v.y) / l2 };
    // Angle between segments at a vertex; nearly straight or a U-turn — no rounding.
    const theta = Math.acos(Math.max(-1, Math.min(1, -(u1.x * u2.x + u1.y * u2.y))));
    if (theta < 1e-3 || Math.PI - theta < 1e-3) continue;
    const t = Math.tan(theta / 2);
    const d = Math.min(r / t, l1 / 2, l2 / 2);
    const k = (4 / 3) * Math.tan((Math.PI - theta) / 4) * d * t;
    const p1 = { x: v.x - u1.x * d, y: v.y - u1.y * d };
    const p2 = { x: v.x + u2.x * d, y: v.y + u2.y * d };
    to[i] = p1;
    from[j] = p2;
    arcs[i] = [{ x: p1.x + u1.x * k, y: p1.y + u1.y * k }, { x: p2.x - u2.x * k, y: p2.y - u2.y * k }, p2];
  }
  const parts = [`M${num(from[0]!.x)} ${num(from[0]!.y)}`];
  for (let i = 0; i < n; i++) {
    const c = curves[i]!;
    if (straight[i]) parts.push(`L${num(to[i]!.x)} ${num(to[i]!.y)}`);
    else parts.push(`C${num(c[1].x)} ${num(c[1].y)} ${num(c[2].x)} ${num(c[2].y)} ${num(c[3].x)} ${num(c[3].y)}`);
    const arc = arcs[i];
    if (arc) parts.push(`C${num(arc[0].x)} ${num(arc[0].y)} ${num(arc[1].x)} ${num(arc[1].y)} ${num(arc[2].x)} ${num(arc[2].y)}`);
  }
  if (closed) {
    // Z itself draws the last straight segment back to the start.
    if (parts.length > 2 && straight[n - 1] && !arcs[n - 1]) parts.pop();
    parts.push('Z');
  }
  return parts.join('');
}

/** Close the path: Z itself draws the last straight segment back to the start. */
function closePath(parts: string[], last: VectorSegment) {
  if (parts.length > 2 && isStraight(last)) parts.pop();
  parts.push('Z');
}

/** From which vertex the loop enters each of its segments (null — the loop is broken). */
export function loopVertices(net: VectorNetwork, loop: readonly number[]): number[] | null {
  const start = loopStart(net, loop);
  if (start === null) return null;
  const out: number[] = [];
  let cur = start;
  for (const k of loop) {
    const g = net.segments[k]!;
    out.push(cur);
    cur = g.start === cur ? g.end : g.start;
  }
  return out;
}

/** The vertex where the loop traversal starts (null — the loop is broken). */
function loopStart(net: VectorNetwork, loop: readonly number[]): number | null {
  if (!loop.length) return null;
  const first = net.segments[loop[0]!];
  if (!first) return null;
  let cur: number;
  if (loop.length === 1) cur = first.start;
  else {
    const second = net.segments[loop[1]!];
    if (!second) return null;
    cur = first.end === second.start || first.end === second.end ? first.start : first.end;
  }
  const start = cur;
  for (const k of loop) {
    const g = net.segments[k];
    if (!g || (g.start !== cur && g.end !== cur)) return null;
    cur = g.start === cur ? g.end : g.start;
  }
  return cur === start ? start : null;
}

/** Stroke chain: SVG path and the vertices at its ends. */
export interface NetworkChain {
  data: string;
  closed: boolean;
  startVertex: number;
  endVertex: number;
  segments: number[];
}

/**
 * Center lines: each segment once, segments joined into chains between vertices where other than
 * two segments meet (ends and branches); loops of only “pass-through” vertices are closed (Z).
 */
export function networkChains(net: VectorNetwork): NetworkChain[] {
  const { vertices, segments } = net;
  const adj = adjacency(net);
  const used = new Uint8Array(segments.length);
  const walk = (from: number, first: number): NetworkChain => {
    const steps: Step[] = [];
    let cur = from;
    let k: number | undefined = first;
    while (k !== undefined) {
      used[k] = 1;
      const g = segments[k]!;
      const forward = g.start === cur;
      cur = forward ? g.end : g.start;
      steps.push({ k, reverse: !forward, end: cur });
      if (cur === from && adj[cur]!.length === 2) break;
      k = adj[cur]!.length === 2 ? adj[cur]!.find((x) => !used[x]) : undefined;
    }
    const closed = cur === from && adj[from]!.length === 2;
    return { data: stepsPath(net, from, steps, closed), closed, startVertex: from, endVertex: cur, segments: steps.map((st) => st.k) };
  };
  const out: NetworkChain[] = [];
  vertices.forEach((_, v) => {
    if (adj[v]!.length === 2) return;
    for (const k of adj[v]!) if (!used[k]) out.push(walk(v, k));
  });
  segments.forEach((g, k) => {
    if (!used[k]) out.push(walk(g.start, k));
  });
  return out;
}

/** Segments at each vertex (a single-segment loop is not counted twice). */
export function adjacency(net: VectorNetwork): number[][] {
  const adj: number[][] = net.vertices.map(() => []);
  net.segments.forEach((g, k) => {
    adj[g.start]?.push(k);
    if (g.end !== g.start) adj[g.end]?.push(k);
  });
  return adj;
}

/** Fill paths: by region (own fills are on the path), without regions — the whole network. */
export function networkFillPaths(net: VectorNetwork): { windingRule: 'NONZERO' | 'EVENODD'; data: string; fills?: VectorRegion['fills'] }[] {
  if (net.regions?.length) {
    const out: { windingRule: 'NONZERO' | 'EVENODD'; data: string; fills?: VectorRegion['fills'] }[] = [];
    for (const r of net.regions) {
      const data = r.loops.map((l) => loopPath(net, l)).filter((d): d is string => !!d).join('');
      if (data) out.push({ windingRule: r.windingRule, data, ...(r.fills ? { fills: r.fills } : {}) });
    }
    return out;
  }
  const data = networkChains(net).map((c) => c.data).join('');
  return data ? [{ windingRule: 'NONZERO', data }] : [];
}

/** Exact network bounds (curve extrema); null — empty. */
export function networkBounds(net: VectorNetwork): Rect | null {
  if (!net.vertices.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p: XY) => {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  };
  for (const v of net.vertices) add(v);
  net.segments.forEach((g, k) => {
    if (isStraight(g)) return;
    const p = segmentPoints(net, k);
    for (const t of cubicExtrema(p)) add(bezierAt(p, t));
  });
  return [x0, y0, x1, y1];
}

/** Parameters t in (0, 1) where the cubic curve has an extremum in x or y. */
function cubicExtrema(p: readonly [XY, XY, XY, XY]): number[] {
  const out: number[] = [];
  for (const axis of ['x', 'y'] as const) {
    const p0 = p[0][axis];
    const p1 = p[1][axis];
    const p2 = p[2][axis];
    const p3 = p[3][axis];
    // Derivative / 3 = a t² + b t + c.
    const a = p3 - 3 * p2 + 3 * p1 - p0;
    const b = 2 * (p2 - 2 * p1 + p0);
    const c = p1 - p0;
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) out.push(-c / b);
    } else {
      const d = b * b - 4 * a * c;
      if (d >= 0) {
        const q = Math.sqrt(d);
        out.push((-b + q) / (2 * a), (-b - q) / (2 * a));
      }
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

/** Network in another coordinate system: vertices by the full matrix, tangents by the linear part. */
export function transformNetwork(net: VectorNetwork, m: Matrix): VectorNetwork {
  const lin = (t: XY | undefined) => t && { x: m[0] * t.x + m[1] * t.y, y: m[3] * t.x + m[4] * t.y };
  return {
    vertices: net.vertices.map((v) => ({ ...v, x: m[0] * v.x + m[1] * v.y + m[2], y: m[3] * v.x + m[4] * v.y + m[5] })),
    segments: net.segments.map((g) => ({ start: g.start, end: g.end, ...(g.tangentStart ? { tangentStart: lin(g.tangentStart) } : {}), ...(g.tangentEnd ? { tangentEnd: lin(g.tangentEnd) } : {}) })),
    ...(net.regions ? { regions: net.regions.map((r) => ({ ...r, loops: r.loops.map((l) => [...l]) })) } : {}),
  };
}

// ---------- Network from paths (pre-network vectors, SVG) ----------

/**
 * Network from an SVG path (absolute M, L, Q, C, Z — all our paths are written this way). Closed
 * subpaths are loops of one region (if there are no open ones; otherwise — no regions, fill of the whole
 * network, as such a path was drawn). null — the path contains something that cannot be parsed here.
 */
export function networkFromSvg(data: string, windingRule: 'NONZERO' | 'EVENODD' = 'NONZERO'): VectorNetwork | null {
  // Only absolute M, L, Q, C and Z (z): anything else (arcs, H, V, relative) is not handled here.
  if (/[^MLQCZz\d\s,.+\-eE]/.test(data)) return null;
  const tokens = data.match(/[MLQCZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const net: VectorNetwork = { vertices: [], segments: [] };
  const loops: number[][] = [];
  let open = false;
  let i = 0;
  let cmd = '';
  let first = -1;
  let cur = -1;
  let segs: number[] = [];
  const n = () => Number(tokens[i++]);
  const vertex = (x: number, y: number) => net.vertices.push({ x, y }) - 1;
  const finishOpen = () => {
    if (cur >= 0 && segs.length) open = true;
  };
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (/[A-Za-z]/.test(tok)) {
      cmd = tok.toUpperCase();
      i++;
    } else if (cmd === 'M') cmd = 'L';
    if (cmd === 'M') {
      finishOpen();
      first = cur = vertex(n(), n());
      segs = [];
    } else if (cmd === 'Z') {
      if (cur < 0) continue;
      const a = net.vertices[cur]!;
      const f = net.vertices[first]!;
      if (cur !== first && Math.abs(a.x - f.x) < 1e-6 && Math.abs(a.y - f.y) < 1e-6 && segs.length) {
        // The closing point coincides with the first one — it is the first point.
        const last = net.segments[segs[segs.length - 1]!]!;
        last.end = first;
        net.vertices.pop();
      } else if (cur !== first) segs.push(net.segments.push({ start: cur, end: first }) - 1);
      if (segs.length) loops.push(segs);
      segs = [];
      cur = first;
    } else if (cur < 0) return null;
    else if (cmd === 'L') {
      const v = vertex(n(), n());
      segs.push(net.segments.push({ start: cur, end: v }) - 1);
      cur = v;
    } else if (cmd === 'C' || cmd === 'Q') {
      const a = net.vertices[cur]!;
      let c1: XY;
      let c2: XY;
      let p: XY;
      if (cmd === 'C') {
        c1 = { x: n(), y: n() };
        c2 = { x: n(), y: n() };
        p = { x: n(), y: n() };
      } else {
        const q = { x: n(), y: n() };
        p = { x: n(), y: n() };
        c1 = { x: a.x + (2 / 3) * (q.x - a.x), y: a.y + (2 / 3) * (q.y - a.y) };
        c2 = { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) };
      }
      const v = vertex(p.x, p.y);
      segs.push(net.segments.push({ start: cur, end: v, tangentStart: { x: c1.x - a.x, y: c1.y - a.y }, tangentEnd: { x: c2.x - p.x, y: c2.y - p.y } }) - 1);
      cur = v;
    } else return null;
  }
  if (net.vertices.some((v) => !Number.isFinite(v.x) || !Number.isFinite(v.y))) return null;
  finishOpen();
  // Lone points without segments (M with no continuation) are dropped.
  const used = new Set<number>();
  for (const g of net.segments) used.add(g.start).add(g.end);
  if (used.size !== net.vertices.length) {
    const map = new Map<number, number>();
    const vertices: VectorVertex[] = [];
    net.vertices.forEach((v, k) => {
      if (used.has(k)) map.set(k, vertices.push(v) - 1);
    });
    net.vertices = vertices;
    for (const g of net.segments) {
      g.start = map.get(g.start)!;
      g.end = map.get(g.end)!;
    }
  }
  if (loops.length && !open) net.regions = [{ windingRule, loops }];
  return net;
}

/** Several networks as one (vertex and segment indices are shifted). */
export function mergeNetworks(nets: readonly VectorNetwork[]): VectorNetwork {
  const out: VectorNetwork = { vertices: [], segments: [] };
  const regions: VectorRegion[] = [];
  for (const n of nets) {
    const vo = out.vertices.length;
    const so = out.segments.length;
    out.vertices.push(...n.vertices.map((v) => ({ ...v })));
    out.segments.push(...n.segments.map((g) => ({ ...g, start: g.start + vo, end: g.end + vo })));
    for (const r of n.regions ?? []) regions.push({ ...r, loops: r.loops.map((l) => l.map((k) => k + so)) });
  }
  if (regions.length) out.regions = regions;
  return out;
}

// ---------- Vector network in the document ----------

/** The vector's network string (property or geometry table). */
function networkString(doc: Document, id: string): string | undefined {
  const ref = doc.get(id, 'vectorNetwork') as { blob?: string; data?: string } | undefined;
  if (!ref) return undefined;
  return ref.data ?? (ref.blob ? doc.blob(ref.blob) : undefined);
}

/**
 * The vector's network at its current size (as the renderer draws it: coordinates computed at
 * geometrySize). No network (an old vector or from SVG) — from its paths; not a vector — null.
 */
export function networkOf(doc: Document, id: string): VectorNetwork | null {
  const s = networkString(doc, id);
  let net = s ? decodeNetwork(s) : null;
  if (!net) {
    if (doc.type(id) !== 'VECTOR') return null;
    // Center lines (import: network chains) are more accurate than the fill path — they contain open paths.
    const center = doc.get(id, 'centerPaths') ?? [];
    const src = center.length ? center : (doc.get(id, 'vectorPaths') ?? []);
    const data = src.map((p) => (p.blob ? doc.blob(p.blob) : p.data) ?? '').join(' ');
    net = networkFromSvg(data, src[0]?.windingRule ?? 'NONZERO');
    if (!net) return null;
  }
  const gs = doc.get(id, 'geometrySize');
  const w = doc.get(id, 'width') ?? 0;
  const h = doc.get(id, 'height') ?? 0;
  if (gs && (gs.width !== w || gs.height !== h)) {
    const sx = gs.width > 0 ? w / gs.width : 1;
    const sy = gs.height > 0 ? h / gs.height : 1;
    if (sx !== 1 || sy !== 1) return transformNetwork(net, [sx, 0, 0, 0, sy, 0]);
  }
  return net;
}

/** Whether the vector has its own network (not just paths). */
export function hasNetwork(doc: Document, id: string): boolean {
  return !!doc.get(id, 'vectorNetwork');
}

/**
 * Vector properties from a network (node coordinates): bounds follow the shape (everything stays in
 * place on screen), fill paths by region and center lines are rebuilt, the prepared import stroke is
 * dropped. shared — the network and paths go into the geometry table (identical ones share one entry);
 * otherwise directly into properties (editing by dragging: the geometry table only grows).
 */
export function networkProps(doc: Document, id: string, net: VectorNetwork, opts: { shared?: boolean } = {}): Props {
  const b = networkBounds(net) ?? [0, 0, 0, 0];
  const local = b[0] || b[1] ? transformNetwork(net, [1, 0, -b[0], 0, 1, -b[1]]) : net;
  const t = (doc.get(id, 'transform') ?? IDENTITY) as Matrix;
  const w = Math.max(0, b[2] - b[0]);
  const h = Math.max(0, b[3] - b[1]);
  const ref = (data: string): { blob: string } | { data: string } => (opts.shared ? { blob: doc.putBlob(data) } : { data });
  const fills: VectorPath[] = networkFillPaths(local).map((p) => ({ windingRule: p.windingRule, ...ref(p.data), ...(p.fills ? { fills: p.fills } : {}) }));
  const chains = networkChains(local).map((c) => c.data).join('');
  return {
    // Shift the node origin to the bounds corner (in parent coordinates — via the linear part).
    transform: [t[0], t[1], t[2] + t[0] * b[0] + t[1] * b[1], t[3], t[4], t[5] + t[3] * b[0] + t[4] * b[1]],
    width: w,
    height: h,
    geometrySize: { width: w, height: h },
    vectorNetwork: ref(encodeNetwork(local)) as Props['vectorNetwork'],
    vectorPaths: fills,
    centerPaths: chains ? [{ windingRule: 'NONZERO', ...ref(chains) }] : undefined,
    strokePaths: undefined,
  };
}

// ---------- Editing ----------

/** Exit direction of segment k from vertex v (the tangent, or for a straight one — toward the other end). */
function leaving(net: VectorNetwork, k: number, v: number): XY {
  const g = net.segments[k]!;
  const p = segmentPoints(net, k, g.start !== v);
  const d = { x: p[1].x - p[0].x, y: p[1].y - p[0].y };
  if (Math.hypot(d.x, d.y) > 1e-9) return d;
  const e = { x: p[2].x - p[0].x, y: p[2].y - p[0].y };
  if (Math.hypot(e.x, e.y) > 1e-9) return e;
  return { x: p[3].x - p[0].x, y: p[3].y - p[0].y };
}

/**
 * Split segment k at parameter t (de Casteljau — the shape does not change): a new vertex and a second
 * segment; region loops containing this segment get both. Returns the index of the new vertex.
 */
export function splitSegment(net: VectorNetwork, k: number, t: number): number {
  const g = net.segments[k]!;
  const p = segmentPoints(net, k);
  const lerp = (a: XY, b: XY): XY => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const v = net.vertices.push({ ...lerp(p[0], p[3]) }) - 1;
  const end = g.end;
  if (isStraight(g)) {
    g.end = v;
    net.segments.push({ start: v, end });
  } else {
    const p01 = lerp(p[0], p[1]);
    const p12 = lerp(p[1], p[2]);
    const p23 = lerp(p[2], p[3]);
    const p012 = lerp(p01, p12);
    const p123 = lerp(p12, p23);
    const m = lerp(p012, p123);
    net.vertices[v] = { x: m.x, y: m.y, handleMirroring: 'ANGLE_AND_LENGTH' };
    g.end = v;
    g.tangentStart = { x: p01.x - p[0].x, y: p01.y - p[0].y };
    g.tangentEnd = { x: p012.x - m.x, y: p012.y - m.y };
    net.segments.push({ start: v, end, tangentStart: { x: p123.x - m.x, y: p123.y - m.y }, tangentEnd: { x: p23.x - p[3].x, y: p23.y - p[3].y } });
  }
  const k2 = net.segments.length - 1;
  // In loops: k → k, k2 in traversal order.
  for (const r of net.regions ?? []) {
    r.loops = r.loops.map((loop) => {
      const i = loop.indexOf(k);
      if (i < 0) return loop;
      // Direction: the next loop segment shares a vertex with k2 (going start → v → end) or with k.
      const next = loop[(i + 1) % loop.length]!;
      const n = net.segments[next]!;
      const forward = loop.length === 1 ? true : n.start === end || n.end === end;
      const out = [...loop];
      out.splice(i, 1, ...(forward ? [k, k2] : [k2, k]));
      return out;
    });
  }
  return v;
}

/**
 * Delete segments (indices): loops containing them are dropped (a region without loops too), vertices
 * without segments are dropped, indices are shifted.
 */
export function removeSegments(net: VectorNetwork, drop: ReadonlySet<number>): void {
  if (!drop.size) return;
  const map = new Map<number, number>();
  const segments: VectorSegment[] = [];
  net.segments.forEach((g, k) => {
    if (!drop.has(k)) map.set(k, segments.push(g) - 1);
  });
  net.segments = segments;
  if (net.regions) {
    net.regions = net.regions
      .map((r) => ({ ...r, loops: r.loops.filter((l) => l.every((k) => map.has(k))).map((l) => l.map((k) => map.get(k)!)) }))
      .filter((r) => r.loops.length);
    if (!net.regions.length) delete net.regions;
  }
  removeLooseVertices(net);
}

/** Drop vertices without segments (indices in segments are shifted). */
export function removeLooseVertices(net: VectorNetwork): void {
  const used = new Set<number>();
  for (const g of net.segments) used.add(g.start).add(g.end);
  if (used.size === net.vertices.length) return;
  const map = new Map<number, number>();
  const vertices: VectorVertex[] = [];
  net.vertices.forEach((v, k) => {
    if (used.has(k)) map.set(k, vertices.push(v) - 1);
  });
  net.vertices = vertices;
  for (const g of net.segments) {
    g.start = map.get(g.start)!;
    g.end = map.get(g.end)!;
  }
}

/**
 * Delete vertices. For a vertex with exactly two segments, the neighbors are joined by one
 * segment (with the outer handles — the shape stays close to the original), region loops are kept; for
 * ends and branches their segments are removed too.
 */
export function removeVertices(net: VectorNetwork, drop: ReadonlySet<number>): void {
  const adj = adjacency(net);
  const segDrop = new Set<number>();
  for (const v of drop) {
    const ks = adj[v]!.filter((k) => !segDrop.has(k));
    if (ks.length === 2 && net.segments[ks[0]!]!.start !== net.segments[ks[0]!]!.end) {
      const [k1, k2] = ks as [number, number];
      const g1 = net.segments[k1]!;
      const g2 = net.segments[k2]!;
      // Neighbors: a — the other end of k1, b — the other end of k2.
      const a = g1.start === v ? g1.end : g1.start;
      const b = g2.start === v ? g2.end : g2.start;
      if (a === b || drop.has(a) || drop.has(b)) {
        segDrop.add(k1).add(k2);
        continue;
      }
      const ta = g1.start === a ? g1.tangentStart : g1.tangentEnd;
      const tb = g2.start === b ? g2.tangentStart : g2.tangentEnd;
      // k1 becomes the segment a → b, k2 is dropped; loops: remove k2 (k1 replaces it).
      net.segments[k1] = { start: a, end: b, ...(ta || tb ? { tangentStart: ta ? { ...ta } : { x: 0, y: 0 }, tangentEnd: tb ? { ...tb } : { x: 0, y: 0 } } : {}) };
      for (const r of net.regions ?? []) r.loops = r.loops.map((l) => l.filter((k) => k !== k2));
      segDrop.add(k2);
      // Links changed: b now has k1 instead of k2.
      adj[b] = adj[b]!.map((k) => (k === k2 ? k1 : k));
      adj[v] = [];
    } else for (const k of ks) segDrop.add(k);
  }
  // The vertices themselves go away as “vertices without segments”.
  for (const v of drop) {
    for (const k of adj[v] ?? []) segDrop.add(k);
  }
  removeSegments(net, segDrop);
  removeLooseVertices(net);
}

/** Connect vertices a and b with a segment (a branch if they already have segments). */
export function connect(net: VectorNetwork, a: number, b: number, tangentStart?: XY, tangentEnd?: XY): number {
  const g: VectorSegment = { start: a, end: b };
  if (tangentStart || tangentEnd) {
    g.tangentStart = tangentStart ?? { x: 0, y: 0 };
    g.tangentEnd = tangentEnd ?? { x: 0, y: 0 };
  }
  return net.segments.push(g) - 1;
}

/** Merge vertex from into to (the ends join into one point; loops are kept). */
export function mergeVertices(net: VectorNetwork, from: number, to: number): void {
  if (from === to) return;
  for (const g of net.segments) {
    if (g.start === from) g.start = to;
    if (g.end === from) g.end = to;
  }
  // A segment that became a point (from and to were connected directly) is dropped.
  const drop = new Set<number>();
  net.segments.forEach((g, k) => {
    if (g.start === g.end && isStraight(g)) drop.add(k);
  });
  removeSegments(net, drop);
  removeLooseVertices(net);
}

// ---------- Faces: region fill (paint bucket) ----------

/** Curve as a polyline (for areas and point hit testing). */
function flatten(net: VectorNetwork, k: number, reverse: boolean, out: XY[]) {
  const g = net.segments[k]!;
  const p = segmentPoints(net, k, reverse);
  if (isStraight(g)) {
    out.push(p[3]);
    return;
  }
  const n = 16;
  for (let i = 1; i <= n; i++) out.push(bezierAt(p, i / n));
}

/** Loop as a polygon (null — broken). */
export function loopPolygon(net: VectorNetwork, loop: readonly number[]): XY[] | null {
  const start = loopStart(net, loop);
  if (start === null) return null;
  const pts: XY[] = [{ ...net.vertices[start]! }];
  let cur = start;
  for (const k of loop) {
    const g = net.segments[k]!;
    const forward = g.start === cur;
    flatten(net, k, !forward, pts);
    cur = forward ? g.end : g.start;
  }
  pts.pop();
  return pts;
}

/** Signed area (y axis down: clockwise on screen is positive). */
export function polygonArea(pts: readonly XY[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Point inside a polygon (even-odd). */
export function pointInPolygon(pts: readonly XY[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Faces of the network's planar graph. Half-edges at each vertex are sorted by exit angle; the next
 * half-edge of a face is the one preceding, by angle, the reverse of the incoming one. Then bounded faces
 * have positive area (on screen, y axis down — clockwise), outer boundaries of components have
 * negative area. Segment intersections without a shared vertex are not considered.
 */
export function networkFaces(net: VectorNetwork): { loop: number[]; polygon: XY[]; area: number }[] {
  // Half-edge: segment k and direction (rev — from end to start).
  type Half = { k: number; rev: boolean; angle: number };
  const around: Half[][] = net.vertices.map(() => []);
  net.segments.forEach((g, k) => {
    for (const rev of [false, true]) {
      const p = segmentPoints(net, k, rev);
      let d = { x: p[1].x - p[0].x, y: p[1].y - p[0].y };
      if (Math.hypot(d.x, d.y) < 1e-9) d = { x: p[2].x - p[0].x, y: p[2].y - p[0].y };
      if (Math.hypot(d.x, d.y) < 1e-9) d = { x: p[3].x - p[0].x, y: p[3].y - p[0].y };
      around[rev ? g.end : g.start]!.push({ k, rev, angle: Math.atan2(d.y, d.x) });
    }
  });
  for (const list of around) list.sort((x, y) => x.angle - y.angle);
  const id = (h: { k: number; rev: boolean }) => h.k * 2 + (h.rev ? 1 : 0);
  const seen = new Set<number>();
  const faces: { loop: number[]; polygon: XY[]; area: number }[] = [];
  for (const list of around) {
    for (const start of list) {
      if (seen.has(id(start))) continue;
      const loop: number[] = [];
      let h: Half = start;
      for (let guard = 0; guard <= net.segments.length * 2; guard++) {
        seen.add(id(h));
        loop.push(h.k);
        const g = net.segments[h.k]!;
        const to = h.rev ? g.start : g.end;
        const at = around[to]!;
        const twin = at.findIndex((x) => x.k === h.k && x.rev !== h.rev);
        h = at[(twin - 1 + at.length) % at.length]!;
        if (seen.has(id(h))) break;
      }
      const polygon = loopPolygon(net, loop);
      if (!polygon || polygon.length < 3) continue;
      faces.push({ loop, polygon, area: polygonArea(polygon) });
    }
  }
  return faces;
}

/** Face loop without “whiskers”: segments traversed there and back are dropped (the loop stays closed). */
function withoutSpikes(loop: readonly number[]): number[] {
  const count = new Map<number, number>();
  for (const k of loop) count.set(k, (count.get(k) ?? 0) + 1);
  return loop.filter((k) => count.get(k) === 1);
}

/**
 * Region under a point (network coordinates) for the paint bucket fill: the smallest bounded face
 * containing the point, and holes — outer boundaries of other components inside it (not containing the
 * point). null — a miss.
 */
export function faceAt(net: VectorNetwork, x: number, y: number): VectorRegion | null {
  const faces = networkFaces(net);
  const bounded = faces.filter((f) => f.area > 1e-6);
  // Faces are traversed “clockwise”; bounded ones are positive, outer ones negative.
  let best: (typeof faces)[number] | null = null;
  for (const f of bounded) if (pointInPolygon(f.polygon, x, y) && (!best || f.area < best.area)) best = f;
  if (!best) return null;
  const outer = faces.filter((f) => f.area < -1e-6);
  const own = new Set(best.loop);
  // Outer boundaries of other components inside the face, without the point; a hole in a hole is no longer a hole of this face.
  const inside = outer.filter((o) => {
    if (o.loop.some((k) => own.has(k))) return false; // boundary of the same component
    const p = o.polygon[0]!;
    return pointInPolygon(best!.polygon, p.x, p.y) && !pointInPolygon(o.polygon, x, y);
  });
  const holes = inside
    .filter((o) => !inside.some((q) => q !== o && Math.abs(q.area) > Math.abs(o.area) && pointInPolygon(q.polygon, o.polygon[0]!.x, o.polygon[0]!.y)))
    .map((o) => withoutSpikes(o.loop));
  const loops = [withoutSpikes(best.loop), ...holes].filter((l) => l.length);
  return loops.length ? { windingRule: holes.length ? 'EVENODD' : 'NONZERO', loops } : null;
}

/** Index of the network region containing the point (by its loops and fill rule); -1 — none. */
export function regionIndexAt(net: VectorNetwork, x: number, y: number): number {
  const regions = net.regions ?? [];
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]!;
    let winding = 0;
    let parity = false;
    for (const l of r.loops) {
      const poly = loopPolygon(net, l);
      if (!poly || !pointInPolygon(poly, x, y)) continue;
      parity = !parity;
      winding += polygonArea(poly) > 0 ? 1 : -1;
    }
    if (r.windingRule === 'EVENODD' ? parity : winding !== 0) return i;
  }
  return -1;
}

/** Whether the loops are the same (same set of segments). */
export function sameLoop(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((k) => s.has(k));
}

/** Exit direction of a segment from a vertex (for choosing handles and angles). */
export { leaving as segmentDirection };
