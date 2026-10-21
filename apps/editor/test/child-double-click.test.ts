import { expect, it, vi } from 'vitest';
import { Tools } from '../src/tools.ts';

it.each(['TEXT', 'VECTOR'])('entering a container selects its %s child before editing it', type => {
  const ed = {
    selection: ['parent'],
    doc: { type: () => type },
    screenToWorld: (x: number, y: number) => [x, y],
    select(ids: string[]) { this.selection = ids; },
  };
  const editText = vi.fn(), editVector = vi.fn();
  // Exercise the real double-click handler without browser pointer plumbing.
  const tools = Object.assign(Object.create(Tools.prototype), {
    ed, local: () => [40, 40], handleAt: () => -1, pick: () => 'child',
    onEditText: editText, onEditVector: editVector,
  });
  tools.dblclick({});
  expect(ed.selection).toEqual(['child']);
  expect(editText).not.toHaveBeenCalled();
  expect(editVector).not.toHaveBeenCalled();
  tools.dblclick({});
  expect(type === 'TEXT' ? editText : editVector).toHaveBeenCalledTimes(1);
});
