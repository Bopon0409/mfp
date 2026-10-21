import { describe, expect, it } from 'vitest';
import { Snapper } from '../src/snap.ts';
import type { Editor } from '../src/editor.ts';

it('resize holds a captured edge until the release distance and resets on bypass', () => {
  const s = new Snapper([[100, 0, 200, 100]]);
  expect(s.snapResizePoint(107, 200, 8, true, false).dx).toBe(-7);
  expect(s.snapResizePoint(111, 200, 8, true, false).dx).toBe(-11);
  expect(s.snapResizePoint(113, 200, 8, true, false).dx).toBe(0);
  s.snapResizePoint(107, 200, 8, true, false);
  s.releaseResize();
  expect(s.snapResizePoint(111, 200, 8, true, false).dx).toBe(0);
});

it('resizing a frame can snap to visible children, but moving it cannot', () => {
  const ed = {
    pageId: 'page',
    doc: { parent: () => 'page', children: (id: string) => id === 'page' ? ['frame'] : ['child'], get: () => undefined },
    viewportRect: () => [0, 0, 500, 500],
    selectionBounds: () => [20, 30, 120, 130],
  } as unknown as Editor;
  expect(Snapper.forResize(ed, ['frame']).snapResizePoint(123, 200, 8, true, false).dx).toBe(-3);
  expect(Snapper.forNodes(ed, ['frame']).snapPoint(123, 200, 8, true, false).dx).toBe(0);
});

describe('snapping', () => {
  const s = new Snapper([
    [0, 0, 100, 100],
    [300, 50, 400, 150],
  ]);

  it('an edge snaps to the nearest edge within the threshold', () => {
    const r = s.snapRect([104, 203, 154, 253], 6);
    expect(r.dx).toBe(-4); // left edge → right edge of the first (100)
    expect(r.dy).toBe(0);
    expect(r.guides).toContainEqual([100, 0, 100, 253]);
  });

  it('center snaps to center', () => {
    const r = s.snapRect([22, 500, 82, 560], 6); // center 52 → 50
    expect(r.dx).toBe(-2);
  });

  it('beyond the threshold — no snapping', () => {
    const r = s.snapRect([120, 220, 160, 260], 6);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [], spacings: [] });
  });

  it('a point — only along the allowed axes', () => {
    const r = s.snapPoint(297, 52, 6, true, false);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(0);
  });
});

describe('equal spacing', () => {
  // Row: 0–40, 60–100 (gap 20); dragging a third 40-wide layer to x≈123.
  const row = new Snapper([], [
    [0, 0, 40, 40],
    [60, 0, 100, 40],
  ]);

  it('continues a row with the same spacing and gives markers', () => {
    const r = row.snapRect([123, 0, 163, 40], 6);
    expect(r.dx).toBe(-3);
    expect(r.spacings?.map((s) => s.label)).toEqual(['20', '20']);
  });

  it('between two neighbors — in the middle', () => {
    const r = new Snapper([], [
      [0, 0, 40, 40],
      [140, 0, 180, 40],
    ]).snapRect([67, 0, 107, 40], 6); // in the middle — x = 70, gaps of 30
    expect(r.dx).toBe(3);
    expect(r.spacings?.map((s) => s.label)).toEqual(['30', '30']);
  });
});
