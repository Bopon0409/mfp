import { describe, expect, it } from 'vitest';
import { distortMatrix, FLAT_DISTORT, layerProjection, mapPoint3 } from '@mfp/core';

describe('free distort (MFP-specific)', () => {
  it('frame corners go exactly to the given points (fractions of the frame), the middle follows perspective', () => {
    const d = [0.1, 0, 0.9, 0.1, 1, 1, 0, 0.8];
    const m = distortMatrix(d, 200, 100)!;
    const corners = [[0, 0], [200, 0], [200, 100], [0, 100]].map(([x, y]) => mapPoint3(m, x!, y!)!);
    expect(corners.flat().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([20, 0, 180, 10, 200, 100, 0, 80]);
    // Trapezoid: the middle of the top side is not halfway between the corners in x — perspective.
    const mid = mapPoint3(m, 100, 0)!;
    expect(mid[1]).toBeGreaterThan(0);
  });

  it('unchanged, inverted or degenerate quadrilateral — no matrix', () => {
    expect(distortMatrix([...FLAT_DISTORT], 100, 100)).toBeNull();
    expect(distortMatrix([1, 0, 0, 0, 1, 1, 0, 1], 100, 100)).toBeNull();
    expect(distortMatrix([0, 0, 0, 0, 0, 0, 0, 0], 100, 100)).toBeNull();
  });

  it('parallelogram — affine; together with 3D rotation — distortion first', () => {
    const m = distortMatrix([0.2, 0, 1.2, 0, 1, 1, 0, 1], 100, 50)!;
    expect([m[6], m[7], m[8]]).toEqual([0, 0, 1]);
    const both = layerProjection({ rotateY: 30, distort: [0.2, 0, 1.2, 0, 1, 1, 0, 1] }, 100, 50)!;
    expect(both).toHaveLength(9);
    expect(layerProjection({}, 100, 50)).toBeNull();
  });
});
