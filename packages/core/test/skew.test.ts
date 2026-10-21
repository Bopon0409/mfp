import { describe, expect, it } from 'vitest';
import { rotationOf, skewOf, withRotationKeepShape, withSkew, type Matrix } from '@mfp/core';

const apply = (m: Matrix, x: number, y: number) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];

describe('layer skew (MFP-specific)', () => {
  it('positive — top edge shifts right relative to the bottom; rotation and scale are unchanged', () => {
    const m = withSkew([1, 0, 0, 0, 1, 0], 45);
    // The top (y = 0) stays in place, the bottom (y = 100) moves 100 left: the top is “to the right” of the bottom.
    expect(apply(m, 0, 0)).toEqual([0, 0]);
    expect(apply(m, 0, 100)[0]).toBeCloseTo(-100, 9);
    expect(skewOf(m)).toBeCloseTo(45, 9);
    expect(rotationOf(m)).toBeCloseTo(0, 9);
  });

  it('skewing a rotated and stretched layer: rotation angle and X-axis length stay the same', () => {
    const r = (30 * Math.PI) / 180;
    const base: Matrix = [2 * Math.cos(r), -Math.sin(r), 5, 2 * Math.sin(r), Math.cos(r), 7];
    const m = withSkew(base, -20);
    expect(skewOf(m)).toBeCloseTo(-20, 9);
    expect(Math.atan2(m[3], m[0])).toBeCloseTo(r, 9);
    expect(Math.hypot(m[0], m[3])).toBeCloseTo(2, 9);
    expect([m[2], m[5]]).toEqual([5, 7]);
    expect(skewOf(withSkew(m, 0))).toBe(0);
  });

  it('rotating a skewed layer keeps the skew; without skew — 0', () => {
    const m = withRotationKeepShape(withSkew([1, 0, 0, 0, 1, 0], 15), 90);
    expect(rotationOf(m)).toBeCloseTo(90, 9);
    expect(skewOf(m)).toBeCloseTo(15, 9);
    expect(skewOf([1, 0, 0, 0, 1, 0])).toBe(0);
  });
});
