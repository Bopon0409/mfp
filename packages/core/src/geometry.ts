// Geometry: working with transformation matrices.

import type { Matrix } from './types.ts';

export const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];

export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[4] - m[1] * m[3];
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const id = 1 / det;
  return [m[4] * id, -m[1] * id, (m[1] * m[5] - m[4] * m[2]) * id, -m[3] * id, m[0] * id, (m[3] * m[2] - m[0] * m[5]) * id];
}

/** Rotation in degrees (counterclockwise is positive, as in the plugin API). */
export function rotationOf(m: Matrix): number {
  return (-Math.atan2(m[3], m[0]) * 180) / Math.PI;
}

/** Matrix with the given rotation (degrees) and the position preserved. */
export function withRotation(m: Matrix, degrees: number): Matrix {
  const rad = (-degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cos, -sin, m[2], sin, cos, m[5]];
}

/**
 * Skew (our own): the linear part of the matrix
 * decomposes as R(θ)·[[sx, −sy·tan k], [0, sy]] — rotation, scale along the layer's axes and skew k
 * along its X axis, in degrees: positive — the top edge moves right relative to the bottom one (like an
 * italic slant; in CSS this is skewX(−k)). Changing the skew does not change rotation or scale.
 */
export function skewOf(m: Matrix): number {
  const th = Math.atan2(m[3], m[0]);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const shear = c * m[1] + s * m[4];
  const sy = -s * m[1] + c * m[4];
  if (Math.abs(sy) < 1e-12) return 0;
  const k = (Math.atan(shear / sy) * 180) / Math.PI;
  return Math.abs(k) < 1e-9 ? 0 : -k;
}

/** Matrix with the given skew (degrees, from −89 to 89); rotation, scale and translation stay the same. */
export function withSkew(m: Matrix, degrees: number): Matrix {
  const th = Math.atan2(m[3], m[0]);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const sx = Math.hypot(m[0], m[3]);
  const sy = -s * m[1] + c * m[4];
  const k = (-Math.max(-89, Math.min(89, degrees)) * Math.PI) / 180;
  const shear = sy * Math.tan(k);
  // L = R·[[sx, shear], [0, sy]]
  return [c * sx, c * shear - s * sy, m[2], s * sx, s * shear + c * sy, m[5]];
}

/** Rotation (degrees, as in rotationOf) preserving scale, mirroring and skew. */
export function withRotationKeepShape(m: Matrix, degrees: number): Matrix {
  const th = Math.atan2(m[3], m[0]);
  const c0 = Math.cos(th);
  const s0 = Math.sin(th);
  // Shape in the layer's axes: U = R(−θ)·L.
  const u = [c0 * m[0] + s0 * m[3], c0 * m[1] + s0 * m[4], -s0 * m[0] + c0 * m[3], -s0 * m[1] + c0 * m[4]];
  const rad = (-degrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c * u[0]! - s * u[2]!, c * u[1]! - s * u[3]!, m[2], s * u[0]! + c * u[2]!, s * u[1]! + c * u[3]!, m[5]];
}
