import { describe, expect, it } from 'vitest';
import { reorderPlan, type Arrangement } from '../src/smart.ts';

describe('smart selection: reordering in a row', () => {
  // Three layers horizontally: widths 40, 60, 20; gap 10; row start — 100.
  const arr: Arrangement = {
    axis: 'x',
    gap: 10,
    items: [
      { id: 'a', b: [100, 0, 140, 30] },
      { id: 'b', b: [150, 0, 210, 30] },
      { id: 'c', b: [220, 0, 240, 30] },
    ],
  };
  it('first to the end: the rest shift toward the start, spacing unchanged', () => {
    const p = reorderPlan(arr, 0, 260);
    expect(p.order).toEqual([1, 2, 0]);
    expect(p.starts).toEqual([200, 100, 170]);
  });
  it('without crossing centers — order unchanged', () => {
    const p = reorderPlan(arr, 1, 185);
    expect(p.order).toEqual([0, 1, 2]);
    expect(p.starts).toEqual([100, 150, 220]);
  });
  it('last to the middle', () => {
    const p = reorderPlan(arr, 2, 170);
    expect(p.order).toEqual([0, 2, 1]);
    expect(p.starts).toEqual([100, 180, 150]);
  });
});
