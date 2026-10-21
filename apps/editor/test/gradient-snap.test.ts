import { expect, it } from 'vitest';
import { snapGradientPoint } from '../src/gradient-snap.ts';
import type { Pt } from '../src/gradient.ts';
const screen = (p: Pt): Pt => p;
it('snaps to center, edges, corners and other handle axes', () => {
  expect(snapGradientPoint([48, 4], 100, 100, screen).point).toEqual([50, 0]);
  expect(snapGradientPoint([97, 96], 100, 100, screen).point).toEqual([100, 100]);
  expect(snapGradientPoint([22, 71], 100, 100, screen, [[20, 70]]).point).toEqual([20, 70]);
  expect(snapGradientPoint([30, 30], 100, 100, screen).guides).toEqual([]);
});
it('measures tolerance after zoom and rotation', () => {
  const rotated = ([x, y]: Pt): Pt => [-y * 4, x * 4];
  expect(snapGradientPoint([48, 30], 100, 100, rotated).point).toEqual([48, 30]);
  expect(snapGradientPoint([49, 30], 100, 100, rotated).point).toEqual([50, 30]);
});
it('retains constrained angle instead of snapping each axis independently', () => {
  const r = snapGradientPoint([48, 48], 100, 100, screen, [], { origin: [0, 0], direction: [1, 1] });
  expect(r.point).toEqual([50, 50]);
  expect(r.guides).toHaveLength(2);
});
