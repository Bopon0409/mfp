import { describe, expect, it } from 'vitest';
import { invert3, mapPoint3, mapRect3, mul3, perspectiveMatrix } from '@mfp/core';

describe('3D rotation: projection of a flat layer', () => {
  it('no rotation — no projection', () => {
    expect(perspectiveMatrix({}, 100, 100)).toBeNull();
    expect(perspectiveMatrix({ perspective: 500 }, 100, 100)).toBeNull();
  });

  it('like CSS: perspective(1000px) rotateY(45deg), origin at the center', () => {
    const m = perspectiveMatrix({ rotateY: 45 }, 200, 200)!;
    const [x, y] = mapPoint3(m, 200, 0)!;
    // The right edge is farther: x = 100 + 70.71 / 1.0707, y = 100 − 100 / 1.0707.
    expect(x).toBeCloseTo(100 + (100 * Math.SQRT1_2) / (1 + Math.SQRT1_2 / 10), 3);
    expect(y).toBeCloseTo(100 - 100 / (1 + Math.SQRT1_2 / 10), 3);
    // The middle stays in place.
    expect(mapPoint3(m, 100, 100)![0]).toBeCloseTo(100, 6);
  });

  it('tilt around X: the top moves away from the viewer (narrower than the bottom)', () => {
    const m = perspectiveMatrix({ rotateX: 30, perspective: 300 }, 100, 100)!;
    const top = mapPoint3(m, 100, 0)![0] - mapPoint3(m, 0, 0)![0];
    const bottom = mapPoint3(m, 100, 100)![0] - mapPoint3(m, 0, 100)![0];
    expect(top).toBeLessThan(bottom);
  });

  it('moving toward the viewer enlarges', () => {
    const m = perspectiveMatrix({ translateZ: 500 }, 100, 100)!;
    const r = mapRect3(m, [0, 0, 100, 100]);
    expect(r[2] - r[0]).toBeCloseTo(200, 6);
  });

  it('a corner does not go behind the viewer: perspective is weakened', () => {
    const m = perspectiveMatrix({ rotateY: -80, perspective: 10 }, 400, 400)!;
    for (const [x, y] of [[0, 0], [400, 0], [400, 400], [0, 400]] as const) expect(mapPoint3(m, x, y)).not.toBeNull();
  });

  it('inverse matrix', () => {
    const m = mul3([2, 0, 10, 0, 1, 5], perspectiveMatrix({ rotateX: 20, rotateY: -35 }, 80, 60)!);
    const p = mapPoint3(m, 13, 27)!;
    const q = mapPoint3(invert3(m)!, p[0], p[1])!;
    expect(q[0]).toBeCloseTo(13, 6);
    expect(q[1]).toBeCloseTo(27, 6);
  });
});
