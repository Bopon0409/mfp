import { beforeAll, describe, expect, it } from 'vitest';
import { computeAutoLayout, loadLayoutEngine, type AutoLayoutFrame } from '../src/index.ts';

const base: AutoLayoutFrame = {
  direction: 'HORIZONTAL',
  width: 300,
  height: 100,
  gap: 10,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  primaryAlign: 'MIN',
  counterAlign: 'MIN',
};

beforeAll(async () => {
  await loadLayoutEngine();
});

describe('auto layout (layout rules)', () => {
  it('lays out in a row with gap and padding', () => {
    const r = computeAutoLayout({ ...base, padding: { left: 20, right: 0, top: 5, bottom: 0 } }, [
      { width: 50, height: 20 },
      { width: 30, height: 40 },
    ]);
    expect(r.children).toEqual([
      { x: 20, y: 5, width: 50, height: 20 },
      { x: 80, y: 5, width: 30, height: 40 },
    ]);
  });

  it('does not round positions to pixels (fill split into three)', () => {
    const r = computeAutoLayout({ ...base, width: 500, gap: 0 }, [
      { width: 1, height: 10, grow: true },
      { width: 1, height: 10, grow: true },
      { width: 1, height: 10, grow: true },
    ]);
    expect(r.children[1]!.x).toBeCloseTo(166.667, 2);
    expect(r.children[1]!.width).toBeCloseTo(166.667, 2);
  });

  it('“space between” with a single child centers it', () => {
    const r = computeAutoLayout({ ...base, width: 50, height: 50, primaryAlign: 'SPACE_BETWEEN', counterAlign: 'CENTER', padding: { left: 16, right: 16, top: 6, bottom: 6 } }, [
      { width: 24, height: 24 },
    ]);
    expect(r.children[0]).toEqual({ x: 13, y: 13, width: 24, height: 24 });
  });

  it('padding larger than the frame: alignment with negative free space', () => {
    const r = computeAutoLayout({ ...base, width: 28, height: 28, primaryAlign: 'CENTER', counterAlign: 'CENTER', padding: { left: 32, right: 32, top: 12, bottom: 12 } }, [
      { width: 12, height: 12 },
    ]);
    expect(r.frame.width).toBe(28);
    expect(r.children[0]).toEqual({ x: 8, y: 8, width: 12, height: 12 });
  });

  it('wrap: rows packed to the start, row gap defaults to the main gap', () => {
    const r = computeAutoLayout({ ...base, width: 230, height: 500, gap: 14, wrap: true }, [
      { width: 100, height: 50 },
      { width: 100, height: 50 },
      { width: 100, height: 50 },
    ]);
    expect(r.children.map((c) => [c!.x, c!.y])).toEqual([
      [0, 0],
      [114, 0],
      [0, 64],
    ]);
  });

  it('negative gap: children overlap each other', () => {
    const r = computeAutoLayout({ ...base, gap: -10 }, [
      { width: 40, height: 40 },
      { width: 40, height: 40 },
      { width: 40, height: 40 },
    ]);
    expect(r.children.map((c) => c!.x)).toEqual([0, 30, 60]);
  });

  it('hidden and absolute children do not take part in the layout', () => {
    const r = computeAutoLayout(base, [
      { width: 40, height: 40 },
      { width: 40, height: 40, visible: false },
      { width: 40, height: 40, absolute: true },
      { width: 40, height: 40 },
    ]);
    expect(r.children[1]).toBeNull();
    expect(r.children[2]).toBeNull();
    expect(r.children[3]!.x).toBe(50);
  });

  it('“hug”: frame size follows the content', () => {
    const r = computeAutoLayout({ ...base, hugWidth: true, hugHeight: true, padding: { left: 8, right: 8, top: 4, bottom: 4 } }, [
      { width: 50, height: 20 },
      { width: 30, height: 30 },
    ]);
    expect(r.frame).toMatchObject({ width: 8 + 50 + 10 + 30 + 8, height: 4 + 30 + 4 });
  });

  it('stretch on the cross axis and fill on the main axis', () => {
    const r = computeAutoLayout({ ...base, width: 200, height: 60, gap: 0 }, [
      { width: 50, height: 10, stretch: true },
      { width: 10, height: 20, grow: true },
    ]);
    expect(r.children[0]).toEqual({ x: 0, y: 0, width: 50, height: 60 });
    expect(r.children[1]).toEqual({ x: 50, y: 0, width: 150, height: 20 });
  });
});

describe('text baseline alignment', () => {
  it('row: baselines on one level, a shape by its bottom; hug height grows', () => {
    const r = computeAutoLayout({ ...base, hugHeight: true, padding: { left: 0, right: 0, top: 10, bottom: 10 }, counterAlign: 'BASELINE' }, [
      { width: 50, height: 40, baseline: 30 },
      { width: 30, height: 20, baseline: 16 },
      { width: 10, height: 10 },
    ]);
    expect(r.children.map((b) => b!.y)).toEqual([10, 24, 30]);
    // Baselines: 10 + 30 = 24 + 16 = 40; the shape's bottom is at 40; the lowest is the first (down to 50).
    expect(r.frame.height).toBe(60);
  });

  it('wrap: each row aligns to its own baselines, lower rows shift', () => {
    const r = computeAutoLayout({ ...base, width: 100, hugHeight: true, wrap: true, gap: 0, counterGap: 0, counterAlign: 'BASELINE' }, [
      { width: 60, height: 20, baseline: 18 },
      { width: 60, height: 30, baseline: 10 },
    ]);
    // One per row: each row has its own baseline; the second does not overlap the first.
    expect(r.children[0]!.y).toBe(0);
    expect(r.children[1]!.y).toBe(20);
    expect(r.frame.height).toBe(50);
  });

  it('a column with baseline alignment behaves like top alignment', () => {
    const r = computeAutoLayout({ ...base, direction: 'VERTICAL', counterAlign: 'BASELINE' }, [{ width: 50, height: 20, baseline: 10 }]);
    expect(r.children[0]!.x).toBe(0);
  });
});
