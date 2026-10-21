import { beforeAll, describe, expect, it } from 'vitest';
import { loadLayoutEngine } from '../src/autolayout.ts';
import { computeGridLayout, type GridFrame } from '../src/grid.ts';

const base: GridFrame = {
  width: 320,
  height: 200,
  padding: { top: 10, right: 10, bottom: 10, left: 10 },
  rowGap: 20,
  columnGap: 20,
  rows: [{ type: 'FLEX', value: 1 }, { type: 'FLEX', value: 1 }],
  columns: [{ type: 'FLEX', value: 1 }, { type: 'FLEX', value: 1 }, { type: 'FLEX', value: 1 }],
};
const cell = { width: 40, height: 30 };

describe('grid in auto layout', () => {
  beforeAll(() => loadLayoutEngine());

  it('fills cells in order, fractions split free space equally', () => {
    const r = computeGridLayout(base, [cell, cell, cell, cell]);
    // Columns: (320 - 20 - 2·20) / 3 = 86.67; rows: (200 - 20 - 20) / 2 = 80.
    expect(r.children.map((b) => [Math.round(b!.x), Math.round(b!.y)])).toEqual([
      [10, 10],
      [117, 10],
      [223, 10],
      [10, 110],
    ]);
    expect(r.cells[3]).toEqual({ row: 1, column: 0 });
    expect(r.columns.length).toBe(3);
  });

  it('cell and span: fill two columns', () => {
    const r = computeGridLayout(base, [{ ...cell, row: 1, column: 1, columnSpan: 2, fillWidth: true }]);
    const b = r.children[0]!;
    expect([Math.round(b.x), Math.round(b.y), Math.round(b.width)]).toEqual([117, 110, 193]);
  });

  it('fixed and hug tracks', () => {
    const r = computeGridLayout({ ...base, columns: [{ type: 'FIXED', value: 100 }, { type: 'HUG' }, { type: 'FLEX', value: 1 }] }, [cell, { width: 70, height: 30 }, cell]);
    expect(r.children.map((b) => Math.round(b!.x))).toEqual([10, 130, 220]);
  });

  it('hug — the frame size follows the grid', () => {
    const r = computeGridLayout({ ...base, hugWidth: true, hugHeight: true, columns: [{ type: 'HUG' }, { type: 'HUG' }], rows: [{ type: 'HUG' }] }, [cell, cell]);
    expect([r.frame.width, r.frame.height]).toEqual([10 + 40 + 20 + 40 + 10, 10 + 30 + 10]);
  });
});
