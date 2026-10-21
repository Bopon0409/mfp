// Layer animation → Lottie properties (bodymovin 5.x): keyframes with Bézier curves from the tracks. A single track —
// its keyframes as is (springs — sampled per frame); a property built from several tracks (position — from x and
// width) — sampled per frame with thinning. Lottie time is in frames (fr — frames per second).
//
// Position and rotation follow the animation pose (animation.ts): the box center stays in place, rotation and scale
// are around it: anchor = (w/2, h/2), position = (x + w/2, y + h/2), Lottie rotation = −rotation (ours is
// positive counterclockwise, Lottie's — clockwise). A layer without position tracks — decomposition of
// its matrix (translation, rotation, scale; skew is not carried over).

import { DEFAULT_KEY_EASING, animatedValue, type AnimProperty, type AnimTrack } from './animation.ts';
import type { Document } from './document.ts';
import { EASING_BEZIER, isSpring } from './prototype.ts';
import type { Easing, Matrix, RGBA } from './types.ts';

export interface LottieKeyframe {
  /** Frame. */
  t: number;
  /** Value at the start of the segment. */
  s: number[];
  /** Curve handles of the segment up to the next keyframe (the last one has none). */
  o?: { x: number[]; y: number[] };
  i?: { x: number[]; y: number[] };
  /** Hold until the next keyframe (HOLD). */
  h?: 1;
}

export type LottieProp = { a: 0; k: number | number[] } | { a: 1; k: LottieKeyframe[] };

export interface LottieTransform {
  a: LottieProp;
  p: LottieProp | { s: true; x: LottieProp; y: LottieProp };
  r: LottieProp;
  s: LottieProp;
  o: LottieProp;
}

/** Animation properties the layer position depends on. */
export const TRANSFORM_TRACKS: readonly AnimProperty[] = ['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'width', 'height'];

const LINEAR: [number, number, number, number] = [0, 0, 1, 1];

export function trackOf(doc: Document, id: string, property: AnimProperty): AnimTrack | undefined {
  return doc.get(id, 'animation')?.find((tr) => tr.property === property && tr.keys.length > 0);
}

/** Segment curve as cubic-bezier (x1, y1, x2, y2); a spring — null. */
export function bezierOf(easing: Easing | undefined): [number, number, number, number] | null {
  const e = easing ?? DEFAULT_KEY_EASING;
  if (isSpring(e)) return null;
  const b = e.easingFunctionCubicBezier;
  return b ? [b.x1, b.y1, b.x2, b.y2] : (EASING_BEZIER[e.type] ?? LINEAR);
}

const handles = (b: [number, number, number, number], n: number) => ({
  o: { x: Array<number>(n).fill(b[0]), y: Array<number>(n).fill(b[1]) },
  i: { x: Array<number>(n).fill(b[2]), y: Array<number>(n).fill(b[3]) },
});

/** Keyframes of a single track: property value f(t) at keyframe times, curves from the keyframes; springs — per frame. */
function trackKeyframes(tr: AnimTrack, f: (t: number) => number[], fr: number): LottieKeyframe[] {
  const out: LottieKeyframe[] = [];
  const keys = tr.keys;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = f(k.t);
    if (i === keys.length - 1) {
      out.push({ t: k.t * fr, s: v });
      break;
    }
    if (k.easing?.type === 'HOLD') {
      out.push({ t: k.t * fr, s: v, h: 1 });
      continue;
    }
    const b = bezierOf(k.easing);
    if (b) {
      out.push({ t: k.t * fr, s: v, ...handles(b, v.length) });
      continue;
    }
    // Spring: values per frame, straight lines between them.
    const next = keys[i + 1]!.t;
    const n = Math.max(1, Math.ceil((next - k.t) * fr - 1e-6));
    for (let j = 0; j < n; j++) {
      const t = k.t + j / fr;
      out.push({ t: t * fr, s: f(t), ...handles(LINEAR, v.length) });
    }
  }
  return out;
}

/** Per frame from the first keyframe to the last; points on the straight line between neighbors are dropped. */
function bakedKeyframes(tracks: AnimTrack[], f: (t: number) => number[], fr: number): LottieKeyframe[] {
  const t0 = Math.min(...tracks.map((tr) => tr.keys[0]!.t));
  const t1 = Math.max(...tracks.map((tr) => tr.keys[tr.keys.length - 1]!.t));
  const n = Math.max(1, Math.ceil((t1 - t0) * fr - 1e-6));
  const pts: { t: number; v: number[] }[] = [];
  for (let j = 0; j <= n; j++) {
    const t = Math.min(t1, t0 + j / fr);
    pts.push({ t, v: f(t) });
  }
  const keep = [pts[0]!];
  for (let j = 1; j < pts.length - 1; j++) {
    const a = keep[keep.length - 1]!;
    const b = pts[j + 1]!;
    const c = pts[j]!;
    const u = (c.t - a.t) / Math.max(1e-9, b.t - a.t);
    if (c.v.some((v, d) => Math.abs(a.v[d]! + (b.v[d]! - a.v[d]!) * u - v) > 1e-3)) keep.push(c);
  }
  keep.push(pts[pts.length - 1]!);
  return keep.map((p, i) => (i < keep.length - 1 ? { t: p.t * fr, s: p.v, ...handles(LINEAR, p.v.length) } : { t: p.t * fr, s: p.v }));
}

/**
 * Lottie property from the layer's deps tracks: f(t) — value at time t (seconds). No tracks — constant
 * (scalar — a number, otherwise an array); one — its keyframes; several — per frame.
 */
export function lottieProp(doc: Document, id: string, deps: readonly AnimProperty[], f: (t: number) => number[], fr: number, scalar = false): LottieProp {
  const tracks = deps.map((p) => trackOf(doc, id, p)).filter((x): x is AnimTrack => !!x);
  if (!tracks.length) {
    const v = f(0);
    return { a: 0, k: scalar ? v[0]! : v };
  }
  return { a: 1, k: tracks.length === 1 ? trackKeyframes(tracks[0]!, f, fr) : bakedKeyframes(tracks, f, fr) };
}

const num = (doc: Document, id: string, p: AnimProperty, t: number) => animatedValue(doc, id, p, t) as number;

/**
 * Layer position in parent coordinates (Lottie): offset — shift of the parent's origin within its
 * composition, origin — where the layer's origin is in its own composition (nested frames with
 * margin around the edges). Opacity — 0…100.
 */
export function lottieTransform(doc: Document, id: string, fr: number, offset: [number, number] = [0, 0], origin: [number, number] = [0, 0]): LottieTransform {
  const o = lottieProp(doc, id, ['opacity'], (t) => [100 * num(doc, id, 'opacity', t)], fr, true);
  if (TRANSFORM_TRACKS.some((p) => trackOf(doc, id, p))) {
    const v = (p: AnimProperty, t: number) => num(doc, id, p, t);
    return {
      a: lottieProp(doc, id, ['width', 'height'], (t) => [v('width', t) / 2 + origin[0], v('height', t) / 2 + origin[1]], fr),
      p: {
        s: true,
        x: lottieProp(doc, id, ['x', 'width'], (t) => [v('x', t) + v('width', t) / 2 + offset[0]], fr, true),
        y: lottieProp(doc, id, ['y', 'height'], (t) => [v('y', t) + v('height', t) / 2 + offset[1]], fr, true),
      },
      r: lottieProp(doc, id, ['rotation'], (t) => [-v('rotation', t)], fr, true),
      s: lottieProp(doc, id, ['scale', 'scaleX', 'scaleY'], (t) => [100 * v('scale', t) * v('scaleX', t), 100 * v('scale', t) * v('scaleY', t)], fr),
      o,
    };
  }
  const d = decompose((doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix);
  return {
    a: { a: 0, k: [origin[0], origin[1]] },
    p: { a: 0, k: [d.x + offset[0], d.y + offset[1]] },
    r: { a: 0, k: d.rotation },
    s: { a: 0, k: [100 * d.sx, 100 * d.sy] },
    o,
  };
}

/** Matrix → translation, rotation (degrees, clockwise on screen), per-axis scale and skew. */
export function decompose(m: Matrix): { x: number; y: number; rotation: number; sx: number; sy: number; skew: number } {
  const rot = Math.atan2(m[3], m[0]);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  return { x: m[2], y: m[5], rotation: (rot * 180) / Math.PI, sx: Math.hypot(m[0], m[3]), sy: -sin * m[1] + cos * m[4], skew: cos * m[1] + sin * m[4] };
}

/**
 * Lottie rectangle (rc): size, center and corner radius from the width, height and corner radius tracks.
 * inset — inward offset (inside stroke — half the weight; outside — negative).
 */
export function lottieRect(doc: Document, id: string, fr: number, origin: [number, number] = [0, 0], inset = 0) {
  const v = (p: AnimProperty, t: number) => num(doc, id, p, t);
  return {
    s: lottieProp(doc, id, ['width', 'height'], (t) => [Math.max(0, v('width', t) - 2 * inset), Math.max(0, v('height', t) - 2 * inset)], fr),
    p: lottieProp(doc, id, ['width', 'height'], (t) => [v('width', t) / 2 + origin[0], v('height', t) / 2 + origin[1]], fr),
    r: lottieProp(doc, id, ['cornerRadius'], (t) => [Math.max(0, v('cornerRadius', t) - inset)], fr, true),
  };
}

/** Path scale from the width and height tracks (the path is defined at the layer's normal size), %. */
export function lottieSizeScale(doc: Document, id: string, fr: number): LottieProp {
  const w0 = Math.max(1e-6, doc.get(id, 'width') ?? 1);
  const h0 = Math.max(1e-6, doc.get(id, 'height') ?? 1);
  return lottieProp(doc, id, ['width', 'height'], (t) => [(100 * num(doc, id, 'width', t)) / w0, (100 * num(doc, id, 'height', t)) / h0], fr);
}

/** Fill color (c, 0…1) and its opacity (o, 0…100) from the color track; without a track — color. */
export function lottieFillColor(doc: Document, id: string, fr: number, color: RGBA, opacity: number): { c: LottieProp; o: LottieProp } {
  if (!trackOf(doc, id, 'fill')) return { c: { a: 0, k: [color.r, color.g, color.b, 1] }, o: { a: 0, k: 100 * opacity } };
  const c = (t: number) => animatedValue(doc, id, 'fill', t) as RGBA;
  return {
    c: lottieProp(doc, id, ['fill'], (t) => [c(t).r, c(t).g, c(t).b, 1], fr),
    o: lottieProp(doc, id, ['fill'], (t) => [100 * c(t).a], fr, true),
  };
}

/** Color (c) and opacity (o, 0…100) from the color track of property (fill, stroke, fill.N…); without it — color. */
export function lottieColor(doc: Document, id: string, property: AnimProperty, fr: number, color: RGBA, opacity: number): { c: LottieProp; o: LottieProp } {
  if (!trackOf(doc, id, property)) return { c: { a: 0, k: [color.r, color.g, color.b, 1] }, o: { a: 0, k: 100 * opacity } };
  const c = (t: number) => animatedValue(doc, id, property, t) as RGBA;
  return {
    c: lottieProp(doc, id, [property], (t) => [c(t).r, c(t).g, c(t).b, 1], fr),
    o: lottieProp(doc, id, [property], (t) => [100 * c(t).a], fr, true),
  };
}

/** Number from the property track (without one — the current value), multiplied by k. */
export function lottieNumber(doc: Document, id: string, property: AnimProperty, fr: number, k = 1): LottieProp {
  return lottieProp(doc, id, [property], (t) => [k * num(doc, id, property, t)], fr, true);
}

/** Lottie property value at a frame (for tests): the Bézier curve parameter for a time is found by bisection. */
export function lottieValueAt(p: LottieProp, frame: number): number[] {
  if (p.a === 0) return typeof p.k === 'number' ? [p.k] : p.k;
  const k = p.k;
  if (frame <= k[0]!.t) return k[0]!.s;
  const last = k[k.length - 1]!;
  if (frame >= last.t) return last.s;
  let i = 0;
  while (i < k.length - 2 && frame >= k[i + 1]!.t) i++;
  const a = k[i]!;
  const b = k[i + 1]!;
  const u = (frame - a.t) / Math.max(1e-9, b.t - a.t);
  return a.s.map((v, d) => {
    const x1 = a.o!.x[d] ?? a.o!.x[0]!;
    const y1 = a.o!.y[d] ?? a.o!.y[0]!;
    const x2 = a.i!.x[d] ?? a.i!.x[0]!;
    const y2 = a.i!.y[d] ?? a.i!.y[0]!;
    const bz = (p1: number, p2: number, s: number) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (bz(x1, x2, mid) < u) lo = mid;
      else hi = mid;
    }
    return v + (b.s[d]! - v) * bz(y1, y2, (lo + hi) / 2);
  });
}
