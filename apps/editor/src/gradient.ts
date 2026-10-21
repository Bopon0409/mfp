// Gradient handles. gradientTransform (as in the plugin API) maps normalized layer
// coordinates (0…1) into gradient space; the handles are points of that space in layer
// coordinates: for linear, start (0; 0.5), end (1; 0.5) and width (0; 1); for the rest, center
// (0.5; 0.5) and two radii (1; 0.5) and (0.5; 1).

import type { ColorStop, GradientPaint } from '@mfp/core';
import { pointsOf, transformFromHandles, type Pt } from '@mfp/editing';

export { LINEAR_POINTS, RADIAL_POINTS, pointsOf, transformFromHandles, type Pt } from '@mfp/editing';
type T2 = GradientPaint['gradientTransform'];

/** Inverse transform: from gradient space to normalized layer coordinates. */
function inverse(t: T2): [number, number, number, number, number, number] {
  const [[a, b, c], [d, e, f]] = t;
  const det = a * e - b * d || 1e-9;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}

const apply = (m: number[], [x, y]: Pt): Pt => [m[0]! * x + m[1]! * y + m[2]!, m[3]! * x + m[4]! * y + m[5]!];

/** A gradient-space point in normalized layer coordinates (for the radius outline on the canvas). */
export function toLayer(p: GradientPaint, q: Pt): Pt {
  return apply(inverse(p.gradientTransform), q);
}

/** Gradient handles in normalized layer coordinates. */
export function gradientHandles(p: GradientPaint): [Pt, Pt, Pt] {
  const m = inverse(p.gradientTransform);
  const [a, b, c] = pointsOf(p.type);
  return [apply(m, a), apply(m, b), apply(m, c)];
}

/**
 * Handle i was dragged to point to (layer coordinates in pixels; w, h are the layer size). The linear
 * width and the second radius stay perpendicular to the main axis.
 */
export function dragHandle(p: GradientPaint, i: number, to: Pt, w: number, h: number): T2 {
  // Compute in pixels so perpendiculars are real perpendiculars.
  const px = (q: Pt): Pt => [q[0] * w, q[1] * h];
  const nx = (q: Pt): Pt => [q[0] / Math.max(1e-9, w), q[1] / Math.max(1e-9, h)];
  let [a, b, c] = gradientHandles(p).map(px) as [Pt, Pt, Pt];
  const len = (v: Pt) => Math.hypot(v[0], v[1]);
  const perp = (v: Pt, l: number): Pt => {
    const k = l / (len(v) || 1);
    return [-v[1] * k, v[0] * k];
  };
  if (p.type === 'GRADIENT_LINEAR') {
    // Width: perpendicular to the axis from the start, same length as before.
    const wl = len([c[0] - a[0], c[1] - a[1]]) || len([b[0] - a[0], b[1] - a[1]]);
    if (i === 0) a = to;
    else if (i === 1) b = to;
    else return transformFromHandles(p.type, nx(a), nx(b), nx(to));
    const pv = perp([b[0] - a[0], b[1] - a[1]], wl);
    c = [a[0] + pv[0], a[1] + pv[1]];
  } else {
    // Center moves everything; the main radius moves freely, the second stays perpendicular to it.
    if (i === 0) {
      const d: Pt = [to[0] - a[0], to[1] - a[1]];
      a = to;
      b = [b[0] + d[0], b[1] + d[1]];
      c = [c[0] + d[0], c[1] + d[1]];
    } else if (i === 1) {
      const r2 = len([c[0] - a[0], c[1] - a[1]]);
      b = to;
      const pv = perp([b[0] - a[0], b[1] - a[1]], r2);
      c = [a[0] + pv[0], a[1] + pv[1]];
    } else {
      const axis: Pt = [b[0] - a[0], b[1] - a[1]];
      const pv = perp(axis, 1);
      const l = (to[0] - a[0]) * pv[0] + (to[1] - a[1]) * pv[1];
      c = [a[0] + pv[0] * l, a[1] + pv[1] * l];
    }
  }
  return transformFromHandles(p.type, nx(a), nx(b), nx(c));
}

/**
 * Stops in ascending position order (the renderer and the .fig format expect that) and the new index
 * of stop i, so the selected stop stays selected after being dragged past its neighbor.
 */
export function sortStops(stops: readonly ColorStop[], i: number): { stops: ColorStop[]; index: number } {
  const order = stops.map((s, k) => ({ s, k })).sort((a, b) => a.s.position - b.s.position || a.k - b.k);
  return { stops: order.map((o) => o.s), index: Math.max(0, order.findIndex((o) => o.k === i)) };
}

/** Gradient color at t (0…1), for a new stop on the strip. */
export function colorAt(stops: readonly ColorStop[], t: number): ColorStop['color'] {
  const s = [...stops].sort((x, y) => x.position - y.position);
  if (!s.length) return { r: 0, g: 0, b: 0, a: 1 };
  if (t <= s[0]!.position) return { ...s[0]!.color };
  for (let i = 1; i < s.length; i++) {
    const p = s[i - 1]!;
    const q = s[i]!;
    if (t <= q.position) {
      const k = (t - p.position) / (q.position - p.position || 1);
      return { r: p.color.r + (q.color.r - p.color.r) * k, g: p.color.g + (q.color.g - p.color.g) * k, b: p.color.b + (q.color.b - p.color.b) * k, a: p.color.a + (q.color.a - p.color.a) * k };
    }
  }
  return { ...s[s.length - 1]!.color };
}

/** Rotate the gradient 90° clockwise around the layer center (the “Rotate” button). */
export function rotateGradient(p: GradientPaint): T2 {
  const turn = ([x, y]: Pt): Pt => [1 - y, x];
  const [a, b, c] = gradientHandles(p);
  return transformFromHandles(p.type, turn(a), turn(b), turn(c));
}

/** Default placement of a new gradient: linear runs top to bottom, the rest are centered on the layer. */
export function defaultTransform(type: GradientPaint['type']): T2 {
  if (type === 'GRADIENT_LINEAR') return transformFromHandles(type, [0.5, 0], [0.5, 1], [0, 0]);
  return [
    [1, 0, 0],
    [0, 1, 0],
  ];
}
