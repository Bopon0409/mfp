// Gradient handles: gradientTransform (as in the plugin API) maps normalized
// layer coordinates (0…1) to gradient space; handles are points of that space in layer
// coordinates: for linear — start (0, 0.5), end (1, 0.5) and width (0, 1); for the others — center
// (0.5, 0.5) and two radii (1, 0.5) and (0.5, 1).

import type { GradientPaint } from '@mfp/core';

export type Pt = [number, number];
type T2 = GradientPaint['gradientTransform'];

export const LINEAR_POINTS: [Pt, Pt, Pt] = [
  [0, 0.5],
  [1, 0.5],
  [0, 1],
];
export const RADIAL_POINTS: [Pt, Pt, Pt] = [
  [0.5, 0.5],
  [1, 0.5],
  [0.5, 1],
];

export const pointsOf = (type: GradientPaint['type']) => (type === 'GRADIENT_LINEAR' ? LINEAR_POINTS : RADIAL_POINTS);

/**
 * gradientTransform from three handles. The gradient-space handles (q0, q1, q2) map to
 * layer points (p0, p1, p2): solve for the inverse transform and invert it.
 */
export function transformFromHandles(type: GradientPaint['type'], p0: Pt, p1: Pt, p2: Pt): T2 {
  const [q0, q1, q2] = pointsOf(type);
  // M · q = p: M = P · Q⁻¹ (in 3×3 homogeneous coordinates).
  const Q = [q0[0], q1[0], q2[0], q0[1], q1[1], q2[1], 1, 1, 1];
  const P = [p0[0], p1[0], p2[0], p0[1], p1[1], p2[1]];
  const det = Q[0]! * (Q[4]! * Q[8]! - Q[5]! * Q[7]!) - Q[1]! * (Q[3]! * Q[8]! - Q[5]! * Q[6]!) + Q[2]! * (Q[3]! * Q[7]! - Q[4]! * Q[6]!);
  const inv = [
    (Q[4]! * Q[8]! - Q[5]! * Q[7]!) / det,
    (Q[2]! * Q[7]! - Q[1]! * Q[8]!) / det,
    (Q[1]! * Q[5]! - Q[2]! * Q[4]!) / det,
    (Q[5]! * Q[6]! - Q[3]! * Q[8]!) / det,
    (Q[0]! * Q[8]! - Q[2]! * Q[6]!) / det,
    (Q[2]! * Q[3]! - Q[0]! * Q[5]!) / det,
    (Q[3]! * Q[7]! - Q[4]! * Q[6]!) / det,
    (Q[1]! * Q[6]! - Q[0]! * Q[7]!) / det,
    (Q[0]! * Q[4]! - Q[1]! * Q[3]!) / det,
  ];
  const M = [0, 1].flatMap((r) => [0, 1, 2].map((c) => P[r * 3]! * inv[c]! + P[r * 3 + 1]! * inv[3 + c]! + P[r * 3 + 2]! * inv[6 + c]!));
  const det2 = M[0]! * M[4]! - M[1]! * M[3]! || 1e-9;
  return [
    [M[4]! / det2, -M[1]! / det2, (M[1]! * M[5]! - M[2]! * M[4]!) / det2],
    [-M[3]! / det2, M[0]! / det2, (M[2]! * M[3]! - M[0]! * M[5]!) / det2],
  ];
}
