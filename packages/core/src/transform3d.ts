// 3D layer rotation (like CSS: perspective(d) translateZ(z) rotateX(a) rotateY(b), origin at the
// layer center). The layer stays a plane: its points map to the screen by a 3×3 projective transform
// (homography). Skia draws it, and bounds, hit testing and export are computed from it.
// Children of a 3D layer lie in its plane (like transform-style: flat). These are not 3D models.

import type { Matrix } from './types.ts';

/** 3×3 matrix by rows: x' = (m0 x + m1 y + m2) / (m6 x + m7 y + m8), y' — by the second row. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface Transform3D {
  /** Tilt around the horizontal axis, degrees (positive — the top moves away from the viewer). */
  rotateX?: number;
  /** Rotation around the vertical axis, degrees (positive — the right edge moves away from the viewer). */
  rotateY?: number;
  /** Distance to the viewer, px: smaller means stronger perspective. */
  perspective?: number;
  /** Offset toward the viewer, px (negative — away from the viewer). */
  translateZ?: number;
}

export const DEFAULT_PERSPECTIVE = 1000;
export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Whether the layer has a 3D transform. */
export const has3d = (p: Transform3D): boolean => !!(p.rotateX || p.rotateY || p.translateZ);

/** 2×3 affine matrix as 3×3. */
export const affine3 = (m: Matrix | readonly number[]): Mat3 => (m.length === 9 ? ([...m] as Mat3) : [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, 0, 0, 1]);

export function mul3(a: readonly number[], b: readonly number[]): Mat3 {
  const A = affine3(a);
  const B = affine3(b);
  const out = new Array(9) as Mat3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = A[r * 3]! * B[c]! + A[r * 3 + 1]! * B[3 + c]! + A[r * 3 + 2]! * B[6 + c]!;
  return out;
}

export function invert3(m: readonly number[]): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = affine3(m);
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/** Point through a matrix (2×3 or 3×3); a point behind the viewer — null. */
export function mapPoint3(m: readonly number[], x: number, y: number): [number, number] | null {
  if (m.length !== 9) return [m[0]! * x + m[1]! * y + m[2]!, m[3]! * x + m[4]! * y + m[5]!];
  const w = m[6]! * x + m[7]! * y + m[8]!;
  if (w <= 1e-9) return null;
  return [(m[0]! * x + m[1]! * y + m[2]!) / w, (m[3]! * x + m[4]! * y + m[5]!) / w];
}

/** Bounds of the rectangle [x0, y0, x1, y1] after the matrix (for a projection — by its corners). */
export function mapRect3(m: readonly number[], r: readonly [number, number, number, number]): [number, number, number, number] {
  let out: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[2], r[3]],
    [r[0], r[3]],
  ] as const) {
    const p = mapPoint3(m, x, y);
    if (!p) continue;
    out = [Math.min(out[0], p[0]), Math.min(out[1], p[1]), Math.max(out[2], p[0]), Math.max(out[3], p[1])];
  }
  return out[0] <= out[2] ? out : [r[0], r[1], r[2], r[3]];
}

/**
 * Projection of a w × h layer in its own coordinates (null — no 3D). Perspective is weakened if a
 * strong one would put a layer corner behind the viewer.
 */
export function perspectiveMatrix(p: Transform3D, w: number, h: number): Mat3 | null {
  if (!has3d(p)) return null;
  const rad = Math.PI / 180;
  const ax = (p.rotateX ?? 0) * rad;
  const ay = (p.rotateY ?? 0) * rad;
  const [sx, cx, sy, cy] = [Math.sin(ax), Math.cos(ax), Math.sin(ay), Math.cos(ay)];
  const tz = p.translateZ ?? 0;
  const [ox, oy] = [w / 2, h / 2];
  // Depth of point (u, v) relative to the center after rotation: z = -cx·sy·u + sx·v + tz.
  const zAt = (u: number, v: number) => -cx * sy * u + sx * v + tz;
  const zMax = Math.max(zAt(-ox, -oy), zAt(ox, -oy), zAt(ox, oy), zAt(-ox, oy));
  const d = Math.max(1, p.perspective ?? DEFAULT_PERSPECTIVE, zMax > 0 ? zMax / 0.9 : 0);
  // (u, v, 1) → (X, Y, W): X = cy·u; Y = sx·sy·u + cx·v; W = 1 − z / d.
  const M: Mat3 = [cy, 0, 0, sx * sy, cx, 0, (cx * sy) / d, -sx / d, 1 - tz / d];
  return mul3(mul3([1, 0, ox, 0, 1, oy, 0, 0, 1], M), [1, 0, -ox, 0, 1, -oy, 0, 0, 1]);
}

/** “Identity” distortion: corners in place (fractions of the bounds). */
export const FLAT_DISTORT: readonly number[] = [0, 0, 1, 0, 1, 1, 0, 1];

/**
 * Free distort (MFP extension): the corners of the layer bounds (top left,
 * top right, bottom right, bottom left) go to the distort points (x, y in turn, as fractions of the
 * layer width and height: the distortion stretches with the layer). The layer stays a plane: the
 * rectangle maps to a quadrilateral by a homography (Heckbert, “square → quadrilateral”).
 * Identity, non-convex or degenerate — null.
 */
export function distortMatrix(distort: readonly number[] | undefined, w: number, h: number): Mat3 | null {
  if (!distort || distort.length !== 8 || !(w > 0) || !(h > 0)) return null;
  if (distort.every((v, i) => v === FLAT_DISTORT[i])) return null;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = distort.map((v, i) => v * (i % 2 ? h : w)) as [number, number, number, number, number, number, number, number];
  // Only a convex quadrilateral with non-zero area (all side turns in the same direction).
  const px = [x0, x1, x2, x3];
  const py = [y0, y1, y2, y3];
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const k = (i + 2) % 4;
    const cross = (px[j]! - px[i]!) * (py[k]! - py[j]!) - (py[j]! - py[i]!) * (px[k]! - px[j]!);
    if (Math.abs(cross) < 1e-9) return null;
    if (sign && Math.sign(cross) !== sign) return null;
    sign = Math.sign(cross);
  }
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  let q: Mat3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) q = [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  else {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-12) return null;
    const g = (dx3 * dy2 - dx2 * dy3) / det;
    const hh = (dx1 * dy3 - dx3 * dy1) / det;
    q = [x1 - x0 + g * x1, x3 - x0 + hh * x3, x0, y1 - y0 + g * y1, y3 - y0 + hh * y3, y0, g, hh, 1];
  }
  const m = mul3(q, [1 / w, 0, 0, 0, 1 / h, 0, 0, 0, 1]);
  // All corners are in front of the “viewer” (w > 0), otherwise the quadrilateral is flipped inside out.
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]] as const) if (m[6] * x + m[7] * y + m[8] <= 1e-9) return null;
  return m;
}

/** Layer projection in its coordinates: distortion, then 3D rotation (null — a flat layer). */
export function layerProjection(p: Transform3D & { distort?: readonly number[] }, w: number, h: number): Mat3 | null {
  const d = distortMatrix(p.distort, w, h);
  const persp = perspectiveMatrix(p, w, h);
  return d && persp ? mul3(persp, d) : (d ?? persp);
}
