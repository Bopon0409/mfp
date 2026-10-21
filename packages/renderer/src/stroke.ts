// Our own stroke (not a ready outline from the file): the fillable stroke outline from the node's
// shape — width, position (inside, center, outside), joins and miter limit, dashes, caps and
// arrows on open paths, per-side widths for rectangles.

import type { CanvasKit, ContourMeasure, Path, StrokeJoin } from 'canvaskit-wasm';
import type { SceneStrokeStyle } from '@mfp/io-figma';

type Pt = [number, number];

/** Path contours (CanvasKit commands) and whether each is closed. */
export function contoursOf(ck: CanvasKit, path: Path): { cmds: number[]; closed: boolean }[] {
  const cmds = path.toCmds();
  const out: { cmds: number[]; closed: boolean }[] = [];
  let cur: { cmds: number[]; closed: boolean } | null = null;
  for (let i = 0; i < cmds.length; ) {
    const verb = cmds[i]!;
    const n = verb === ck.MOVE_VERB || verb === ck.LINE_VERB ? 2 : verb === ck.QUAD_VERB ? 4 : verb === ck.CONIC_VERB ? 5 : verb === ck.CUBIC_VERB ? 6 : 0;
    if (verb === ck.MOVE_VERB || !cur) out.push((cur = { cmds: [], closed: false }));
    for (let k = 0; k <= n; k++) cur.cmds.push(cmds[i + k]!);
    if (verb === ck.CLOSE_VERB) cur.closed = true;
    i += 1 + n;
  }
  return out;
}

/** Size of arrows and end shapes relative to stroke width. */
export const capSize = (w: number) => ({
  arm: 3 * w + 5,
  side: 3 * w + 6,
  radius: 1.5 * w + 2.5,
  diamond: 1.5 * w + 3.5,
});

/** How far the cap extends past the path point (for node bounds). */
export function capExtent(cap: string | undefined, w: number): number {
  if (!cap || cap === 'NONE') return 0;
  if (cap === 'ROUND' || cap === 'SQUARE') return w / 2;
  const s = capSize(w);
  return Math.max(s.arm, s.side, s.radius, s.diamond) + w;
}

/**
 * End shape: point p, d — outward direction (unit), w — width. trim — how much to shorten
 * the line so it doesn't poke out from behind the tip of a filled arrow.
 */
function capShape(ck: CanvasKit, cap: string, p: Pt, d: Pt, w: number, join: StrokeJoin, miter: number): { path: Path | null; trim: number } {
  const n: Pt = [-d[1], d[0]];
  const at = (u: number, v: number): number[] => [p[0] + d[0] * u + n[0] * v, p[1] + d[1] * u + n[1] * v];
  const poly = (pts: number[][], close = true) => {
    const b = new ck.PathBuilder();
    b.addPolygon(pts.flat(), close);
    return b.detachAndDelete();
  };
  const s = capSize(w);
  switch (cap) {
    case 'ROUND': {
      const b = new ck.PathBuilder();
      b.addCircle(p[0], p[1], w / 2);
      return { path: b.detachAndDelete(), trim: 0 };
    }
    case 'SQUARE':
      return { path: poly([at(0, -w / 2), at(w / 2, -w / 2), at(w / 2, w / 2), at(0, w / 2)]), trim: 0 };
    case 'ARROW_LINES': {
      // Two strokes at ±40° back from the tip, same width.
      const a = (40 * Math.PI) / 180;
      const chevron = poly([at(-s.arm * Math.cos(a), s.arm * Math.sin(a)), at(0, 0), at(-s.arm * Math.cos(a), -s.arm * Math.sin(a))], false);
      const stroked = chevron.makeStroked({ width: w, join, cap: ck.StrokeCap.Butt, miter_limit: Math.max(miter, 4) });
      chevron.delete();
      return { path: stroked, trim: 0 };
    }
    case 'ARROW_EQUILATERAL': {
      // Filled triangle, tip at the end of the path.
      const h = (s.side * Math.sqrt(3)) / 2;
      return { path: poly([at(0, 0), at(-h, s.side / 2), at(-h, -s.side / 2)]), trim: h * 0.8 };
    }
    case 'TRIANGLE_FILLED': {
      // Reversed triangle: base at the end of the path, tip pointing back.
      const h = (s.side * Math.sqrt(3)) / 2;
      return { path: poly([at(0, s.side / 2), at(0, -s.side / 2), at(-h, 0)]), trim: 0 };
    }
    case 'CIRCLE_FILLED': {
      const b = new ck.PathBuilder();
      b.addCircle(p[0], p[1], s.radius);
      return { path: b.detachAndDelete(), trim: 0 };
    }
    case 'DIAMOND_FILLED':
      return { path: poly([at(s.diamond, 0), at(0, s.diamond), at(-s.diamond, 0), at(0, -s.diamond)]), trim: 0 };
    default:
      return { path: null, trim: 0 };
  }
}

/** Union paths (PathOps); the source paths are freed. */
function unionAll(ck: CanvasKit, paths: Path[]): Path | null {
  let acc: Path | null = null;
  for (const p of paths) {
    if (!acc) {
      acc = p;
      continue;
    }
    const u: Path | null = ck.Path.MakeFromOp(acc, p, ck.PathOp.Union);
    acc.delete();
    p.delete();
    acc = u;
  }
  return acc;
}

/** Left and right width at point u (fraction of length): smooth between width points, beyond the outer ones — as at them. */
export function widthAt(points: readonly { position: number; ascent: number; descent: number }[], u: number): [number, number] {
  const pts = [...points].sort((a, b) => a.position - b.position);
  if (!pts.length) return [0, 0];
  if (u <= pts[0]!.position) return [pts[0]!.ascent, pts[0]!.descent];
  const last = pts[pts.length - 1]!;
  if (u >= last.position) return [last.ascent, last.descent];
  let i = 0;
  while (i < pts.length - 2 && u > pts[i + 1]!.position) i++;
  const a = pts[i]!;
  const b = pts[i + 1]!;
  const t = (u - a.position) / Math.max(1e-9, b.position - a.position);
  // Smooth transition: the derivative at the points is zero.
  const k = t * t * (3 - 2 * t);
  return [a.ascent + (b.ascent - a.ascent) * k, a.descent + (b.descent - a.descent) * k];
}

/**
 * Variable-width stroke: along centerline base (contours in sequence, point positions are fractions
 * of their total length) — ascent on the left, descent on the right; ends of open contours — round or
 * flat, closed ones — a ring. The “inside / outside” position is not considered (Draw).
 */
export function variableStrokePath(ck: CanvasKit, base: Path, s: SceneStrokeStyle): Path | null {
  const widths = s.widths ?? [];
  if (!widths.length) return null;
  const measures: { m: ContourMeasure; closed: boolean; len: number }[] = [];
  const iter = new ck.ContourMeasureIter(base, false, 4);
  for (let m = iter.next(); m; m = iter.next()) {
    const len = m.length();
    if (len > 0) measures.push({ m, closed: m.isClosed(), len });
    else m.delete();
  }
  iter.delete();
  const total = measures.reduce((a, c) => a + c.len, 0);
  if (!total) return null;
  const round = (s.startCap ?? 'NONE') === 'ROUND' || (s.endCap ?? 'NONE') === 'ROUND';
  const b = new ck.PathBuilder();
  let before = 0;
  for (const { m, closed, len } of measures) {
    const n = Math.max(8, Math.min(4000, Math.ceil(len / 1.5)));
    const left: number[][] = [];
    const right: number[][] = [];
    for (let i = 0; i <= n; i++) {
      if (closed && i === n) break;
      const d = (len * i) / n;
      const p = m.getPosTan(d);
      const [asc, desc] = widthAt(widths, (before + d) / total);
      // Normal to the left along the path direction (y axis down).
      const nx = p[3]!;
      const ny = -p[2]!;
      left.push([p[0]! + nx * asc, p[1]! + ny * asc]);
      right.push([p[0]! - nx * desc, p[1]! - ny * desc]);
    }
    const line = (pts: number[][]) => pts.forEach(([x, y], k) => (k ? b.lineTo(x!, y!) : b.moveTo(x!, y!)));
    if (closed) {
      line(left);
      b.close();
      line(right.reverse());
      b.close();
    } else {
      // End and start: a semicircle (round caps) or a straight cut.
      const cap = (from: number[], to: number[], center: number[]) => {
        if (!round) return b.lineTo(to[0]!, to[1]!);
        const r = Math.hypot(from[0]! - center[0]!, from[1]! - center[1]!);
        const a0 = Math.atan2(from[1]! - center[1]!, from[0]! - center[0]!);
        for (let k = 1; k <= 12; k++) {
          const a = a0 - (Math.PI * k) / 12;
          b.lineTo(center[0]! + Math.cos(a) * r, center[1]! + Math.sin(a) * r);
        }
        b.lineTo(to[0]!, to[1]!);
      };
      const p0 = m.getPosTan(0);
      const p1 = m.getPosTan(len);
      line(left);
      cap(left[left.length - 1]!, right[right.length - 1]!, [p1[0]!, p1[1]!]);
      for (let k = right.length - 2; k >= 0; k--) b.lineTo(right[k]![0]!, right[k]![1]!);
      cap(right[0]!, left[0]!, [p0[0]!, p0[1]!]);
      b.close();
    }
    before += len;
    m.delete();
  }
  b.setFillType(ck.FillType.Winding);
  const raw = b.detachAndDelete();
  // Loops at sharp turns are removed by unioning with itself (makeSimplified is missing from our
  // CanvasKit build, even though it is in the types).
  const clean = ck.Path.MakeFromOp(raw, raw, ck.PathOp.Union);
  if (clean) {
    raw.delete();
    return clean;
  }
  return raw;
}

/**
 * Stroke outline of base (node coordinates). shape — base is the node's closed shape: the “inside” /
 * “outside” position trims the stroke by the shape; open paths are always stroked centered.
 */
/** clip — shape for “inside” and “outside” (vector network fill regions); absent — the path itself. */
export function strokePath(ck: CanvasKit, base: Path, s: SceneStrokeStyle, shape: boolean, clip?: Path | null): Path | null {
  const join = s.join === 'ROUND' ? ck.StrokeJoin.Round : s.join === 'BEVEL' ? ck.StrokeJoin.Bevel : ck.StrokeJoin.Miter;
  const miter = s.miterLimit ?? 4;
  const start = s.startCap ?? 'NONE';
  const end = s.endCap ?? 'NONE';
  // Uniform round or square caps — via Skia (also for dash segments).
  const same = start === end && (start === 'NONE' || start === 'ROUND' || start === 'SQUARE');
  const nativeCap = same && start === 'ROUND' ? ck.StrokeCap.Round : same && start === 'SQUARE' ? ck.StrokeCap.Square : ck.StrokeCap.Butt;
  const parts = contoursOf(ck, base);
  const closedAll = parts.length > 0 && parts.every((c) => c.closed);
  const align = shape && closedAll ? s.align : 'CENTER';
  let line: Path = base;
  const extras: Path[] = [];
  if (!same && parts.some((c) => !c.closed)) {
    // Ends of open paths: shapes separately, the paths themselves shortened for the arrows.
    const b = new ck.PathBuilder();
    for (const c of parts) {
      const p = ck.Path.MakeFromCmds(c.cmds);
      if (!p) continue;
      if (c.closed) {
        b.addPath(p);
        p.delete();
        continue;
      }
      const iter = new ck.ContourMeasureIter(p, false, 1);
      const m = iter.next();
      if (!m || m.length() <= 0) {
        b.addPath(p);
        m?.delete();
        iter.delete();
        p.delete();
        continue;
      }
      const len = m.length();
      const p0 = m.getPosTan(0);
      const p1 = m.getPosTan(len);
      const a = capShape(ck, start, [p0[0]!, p0[1]!], [-p0[2]!, -p0[3]!], s.weight, join, miter);
      const z = capShape(ck, end, [p1[0]!, p1[1]!], [p1[2]!, p1[3]!], s.weight, join, miter);
      const t0 = Math.min(a.trim, len / 2);
      const t1 = Math.min(z.trim, len / 2);
      const seg = t0 || t1 ? m.getSegment(t0, len - t1, true) : null;
      b.addPath(seg ?? p);
      seg?.delete();
      m.delete();
      iter.delete();
      p.delete();
      if (a.path) extras.push(a.path);
      if (z.path) extras.push(z.path);
    }
    line = b.detachAndDelete();
  }
  let dashed: Path | null = null;
  if (s.dashes.length >= 2 && s.dashes.every((d) => d >= 0) && s.dashes.some((d) => d > 0)) dashed = line.makeDashed(s.dashes[0]!, s.dashes[1]!, 0);
  const src = dashed ?? line;
  const stroked = src.makeStroked({ width: align === 'CENTER' ? s.weight : s.weight * 2, join, cap: nativeCap, miter_limit: miter });
  dashed?.delete();
  if (line !== base) line.delete();
  let out: Path | null = stroked;
  if (stroked && align !== 'CENTER') {
    out = ck.Path.MakeFromOp(stroked, clip ?? base, align === 'INSIDE' ? ck.PathOp.Intersect : ck.PathOp.Difference);
    stroked.delete();
  }
  if (!extras.length) return out;
  return unionAll(ck, out ? [out, ...extras] : extras);
}

/**
 * Per-side stroke (rectangles and frames): between the outer and inner borders, corners —
 * as with CSS borders: the inner radius is smaller by the width of the adjacent sides.
 */
export function sideStrokePath(ck: CanvasKit, w: number, h: number, sides: [number, number, number, number], radii: [number, number, number, number], align: SceneStrokeStyle['align']): Path {
  const [t, r, b, l] = sides;
  const out = align === 'OUTSIDE' ? 1 : align === 'CENTER' ? 0.5 : 0;
  const inn = 1 - out;
  const [tl, tr, br, bl] = radii;
  const grow = (rad: number, dx: number, dy: number, k: number): Pt => (rad > 0 ? [Math.max(0, rad + dx * k), Math.max(0, rad + dy * k)] : [0, 0]);
  const rrect = (x0: number, y0: number, x1: number, y1: number, c: Pt[]) => Float32Array.of(x0, y0, x1, y1, ...c.flat());
  const pb = new ck.PathBuilder();
  pb.addRRect(rrect(-l * out, -t * out, w + r * out, h + b * out, [grow(tl, l, t, out), grow(tr, r, t, out), grow(br, r, b, out), grow(bl, l, b, out)]));
  const x0 = l * inn;
  const y0 = t * inn;
  const x1 = w - r * inn;
  const y1 = h - b * inn;
  if (x1 > x0 && y1 > y0) pb.addRRect(rrect(x0, y0, x1, y1, [grow(tl, l, t, -inn), grow(tr, r, t, -inn), grow(br, r, b, -inn), grow(bl, l, b, -inn)]), true);
  pb.setFillType(ck.FillType.EvenOdd);
  return pb.detachAndDelete();
}

/** How far a per-side stroke extends beyond the node bounds (for bounds). */
export function sidesOutset(sides: [number, number, number, number], align: SceneStrokeStyle['align']): number {
  const k = align === 'OUTSIDE' ? 1 : align === 'CENTER' ? 0.5 : 0;
  return Math.max(...sides) * k;
}
