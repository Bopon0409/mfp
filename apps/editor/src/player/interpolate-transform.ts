type Matrix = [number, number, number, number, number, number];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** QR decomposition in MFP order [a, b, tx, c, d, ty]. Signed Y scale
 * preserves reflections; shear is the unnormalized off-diagonal term. */
function decompose(m: Matrix) {
  const sx = Math.hypot(m[0], m[3]);
  if (sx < 1e-12) return { angle: Math.atan2(-m[1], m[4]), sx: 0, sy: Math.hypot(m[1], m[4]), shear: 0 };
  return { angle: Math.atan2(m[3], m[0]), sx, sy: (m[0] * m[4] - m[1] * m[3]) / sx, shear: (m[0] * m[1] + m[3] * m[4]) / sx };
}

/** Rotation follows the shortest arc, rather than shrinking the matrix axes.
 * Opposite determinant signs necessarily cross a singular transform. */
export function interpolateTransform(a: Matrix, b: Matrix, t: number): Matrix {
  if (t === 0) return [...a];
  if (t === 1) return [...b];
  const x = decompose(a), y = decompose(b);
  const delta = Math.atan2(Math.sin(y.angle - x.angle), Math.cos(y.angle - x.angle));
  const angle = x.angle + delta * t;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const sx = lerp(x.sx, y.sx, t), sy = lerp(x.sy, y.sy, t), shear = lerp(x.shear, y.shear, t);
  return [cos * sx, cos * shear - sin * sy, lerp(a[2], b[2], t), sin * sx, sin * shear + cos * sy, lerp(a[5], b[5], t)];
}
