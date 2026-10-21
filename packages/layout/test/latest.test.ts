import { beforeAll, expect, it } from 'vitest';
import { computeAutoLayout, loadLayoutEngine, type AutoLayoutFrame } from '../src/index.ts';
const base: AutoLayoutFrame = { version: 'LATEST', direction: 'HORIZONTAL', width: 300, height: 100, gap: 0, padding: { left: 0, right: 0, top: 0, bottom: 0 }, primaryAlign: 'MIN', counterAlign: 'MIN' };
beforeAll(loadLayoutEngine);

it('Latest reserves padding even beyond fixed or max size; Legacy keeps fixed size', () => {
  for (const hugWidth of [false, true]) {
    const frame = { ...base, width: 50, hugWidth, maxWidth: 50, padding: { ...base.padding, left: 30, right: 30 } };
    expect(computeAutoLayout(frame, []).frame.width).toBe(60);
  }
  expect(computeAutoLayout({ ...base, version: 'LEGACY', width: 50, padding: { ...base.padding, left: 30, right: 30 } }, []).frame.width).toBe(50);
});

it('Latest puts a single Between child at start; Around and Evenly remain centered', () => {
  for (const direction of ['HORIZONTAL', 'VERTICAL'] as const) {
    for (const primaryAlign of ['SPACE_BETWEEN', 'SPACE_AROUND', 'SPACE_EVENLY'] as const) {
      const r = computeAutoLayout({ ...base, direction, width: 100, primaryAlign }, [{ width: 20, height: 20 }]);
      expect(direction === 'HORIZONTAL' ? r.children[0]!.x : r.children[0]!.y).toBe(primaryAlign === 'SPACE_BETWEEN' ? 0 : 40);
    }
  }
});

it('Latest distributes equal content areas among Fill children with different padding', () => {
  const r = computeAutoLayout(base, [
    { width: 1, height: 10, grow: true, insets: { top: 0, right: 20, bottom: 0, left: 20 } },
    { width: 1, height: 10, grow: true, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
  ]);
  expect(r.children[0]!.width).toBe(170);
  expect(r.children[1]!.width).toBe(130);
  expect(r.children[1]!.x).toBe(170);
});

it('auto gap never overlaps overflowing children; explicit negative gap still works', () => {
  for (const primaryAlign of ['SPACE_BETWEEN', 'SPACE_AROUND', 'SPACE_EVENLY'] as const) {
    const r = computeAutoLayout({ ...base, width: 30, primaryAlign }, [{ width: 20, height: 10 }, { width: 20, height: 10 }]);
    expect(r.children.map((c) => c!.x)).toEqual([0, 20]);
  }
  const r = computeAutoLayout({ ...base, gap: -10 }, [{ width: 20, height: 10 }, { width: 20, height: 10 }]);
  expect(r.children[1]!.x).toBe(10);
});
