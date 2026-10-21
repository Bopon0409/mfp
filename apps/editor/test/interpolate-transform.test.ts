import { expect, it } from 'vitest';
import { interpolateTransform } from '../src/player/interpolate-transform.ts';

type M = Parameters<typeof interpolateTransform>[0];
const rotation = (degrees: number, sx = 1, sy = 1): M => {
  const a = degrees * Math.PI / 180;
  return [Math.cos(a) * sx, -Math.sin(a) * sy, 0, Math.sin(a) * sx, Math.cos(a) * sy, 0];
};
const det = (m: M) => m[0] * m[4] - m[1] * m[3];
it('keeps the shape full-sized through a half turn', () => {
  const m = interpolateTransform(rotation(0), rotation(180), 0.5);
  expect(m[0]).toBeCloseTo(0); expect(m[3]).toBeCloseTo(1);
  expect(det(m)).toBeCloseTo(1);
  for (let t = 0; t <= 1; t += 0.1) expect(det(interpolateTransform(rotation(0), rotation(180), t))).toBeCloseTo(1);
});
it('crosses the angle boundary along the short arc in both directions', () => {
  for (const [a, b] of [[170, -170], [-170, 170]]) {
    const m = interpolateTransform(rotation(a!), rotation(b!), 0.5);
    expect(m[0]).toBeCloseTo(-1); expect(m[3]).toBeCloseTo(0);
    expect(det(m)).toBeCloseTo(1);
  }
});
it('interpolates translation and nonuniform scales independently of rotation', () => {
  const a = rotation(0, 2, 4), b = rotation(90, 4, 8); b[2] = 100; b[5] = -20;
  const m = interpolateTransform(a, b, 0.5);
  expect(m[2]).toBe(50); expect(m[5]).toBe(-10);
  expect(Math.hypot(m[0], m[3])).toBeCloseTo(3);
  expect(Math.hypot(m[1], m[4])).toBeCloseTo(6);
  expect(det(m)).toBeCloseTo(18);
  expect(interpolateTransform(a, b, 0)).toEqual(a);
  expect(interpolateTransform(a, b, 1)).toEqual(b);
});
it('preserves stationary shear/reflection and handles zero scale without NaN', () => {
  for (const m of [[2, 3, 5, 1, -4, 6], [0, 0, 0, 0, 0, 0], [0, 2, 0, 0, 3, 0]] as M[]) {
    interpolateTransform(m, m, 0.5).forEach((v, i) => expect(v).toBeCloseTo(m[i]!));
    expect(interpolateTransform(m, rotation(90), 0.5).every(Number.isFinite)).toBe(true);
  }
});
