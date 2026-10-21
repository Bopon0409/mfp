import { describe, expect, it } from 'vitest';
import { arcOrder, arcPlaces } from '../src/index.ts';

const round = (v: number) => Math.round(v * 1000) / 1000;

describe('along an arc or circle (MFP-specific)', () => {
  it('full circle: equal shares, first at the top, clockwise', () => {
    const p = arcPlaces(4, { cx: 100, cy: 100, radius: 50, start: -90, sweep: 360, rotate: false });
    expect(p.map((q) => [round(q.x), round(q.y)])).toEqual([[100, 50], [150, 100], [100, 150], [50, 100]]);
    expect(p[0]!.rotation).toBeUndefined();
  });

  it('arc: ends inclusive; rotation with the top facing outward', () => {
    const p = arcPlaces(3, { cx: 0, cy: 0, radius: 10, start: -180, sweep: 180, rotate: true });
    expect(p.map((q) => q.angle)).toEqual([-180, -90, 0]);
    // Top: no rotation; right: 90° clockwise (−90); left: +90.
    expect(p.map((q) => q.rotation)).toEqual([90, 0, -90]);
  });

  it('order is by angle around the center, starting from the top', () => {
    const items = [{ id: 'left', x: -1, y: 0 }, { id: 'top', x: 0, y: -1 }, { id: 'bottom', x: 0, y: 1 }, { id: 'right', x: 1, y: 0 }];
    expect(arcOrder(items, 0, 0).map((i) => i.id)).toEqual(['top', 'right', 'bottom', 'left']);
  });
});
