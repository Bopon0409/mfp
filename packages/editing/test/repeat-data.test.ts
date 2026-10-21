import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { createRepeatGrid, fillTargets, hexColor, parseCsv, parseData, repeatGridsToSync, setRepeatGrid, syncRepeatGrid } from '../src/index.ts';

function card() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const comp = doc.create('COMPONENT', page, { name: 'Карточка', width: 100, height: 60, transform: [1, 0, 40, 0, 1, 30] });
  const title = doc.create('TEXT', comp, { name: 'name', characters: 'Название', width: 80, height: 20 });
  const price = doc.create('TEXT', comp, { name: '#Price', characters: '0 ₽', width: 80, height: 20, transform: [1, 0, 0, 0, 1, 24] });
  const dot = doc.create('ELLIPSE', comp, { name: '{color}', width: 10, height: 10, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] });
  return { doc, page, comp, title, price, dot };
}

describe('grid repeat (MFP-specific)', () => {
  it('3 × 2 in place of a component: the sample first, the rest are instances on a grid, bounds fit tightly', () => {
    const { doc, comp } = card();
    const grid = doc.transact(() => createRepeatGrid(doc, comp, { columns: 3, rows: 2, gapX: 10, gapY: 20 }));
    const kids = doc.children(grid);
    expect(kids.length).toBe(6);
    expect(kids[0]).toBe(comp);
    expect(kids.slice(1).every((k) => doc.type(k) === 'INSTANCE' && doc.get(k, 'componentId') === comp)).toBe(true);
    expect(kids.map((k) => [doc.get(k, 'transform')![2], doc.get(k, 'transform')![5]])).toEqual([[0, 0], [110, 0], [220, 0], [0, 80], [110, 80], [220, 80]]);
    expect([doc.get(grid, 'width'), doc.get(grid, 'height')]).toEqual([320, 140]);
    expect(doc.get(grid, 'transform')).toEqual([1, 0, 40, 0, 1, 30]);
  });

  it('stretched bounds — as many columns and rows as fit; shrunk — extra cells removed', () => {
    const { doc, comp } = card();
    const grid = doc.transact(() => createRepeatGrid(doc, comp, { columns: 2, rows: 1, gapX: 10, gapY: 10 }));
    doc.transact(() => doc.set(grid, { width: 470, height: 140 }));
    const ops = [{ op: 'set', id: grid, props: { width: 470, height: 140 } }];
    for (const [id, fromSize] of repeatGridsToSync(doc, ops)) doc.transact(() => syncRepeatGrid(doc, id, fromSize));
    expect(doc.get(grid, 'repeatGrid')).toMatchObject({ columns: 4, rows: 2 });
    expect(doc.children(grid).length).toBe(8);
    expect(doc.get(grid, 'width')).toBe(430);
    doc.transact(() => setRepeatGrid(doc, grid, { columns: 1, rows: 1 }));
    expect(doc.children(grid)).toEqual([comp]);
  });

  it('the sample got bigger — the grid is rebuilt for the new cell size', () => {
    const { doc, comp } = card();
    const grid = doc.transact(() => createRepeatGrid(doc, comp, { columns: 2, rows: 1, gapX: 0, gapY: 0 }));
    doc.transact(() => doc.set(comp, { width: 150 }));
    const sync = repeatGridsToSync(doc, [{ op: 'set', id: comp, props: { width: 150 } }]);
    expect([...sync]).toEqual([[grid, false]]);
    doc.transact(() => syncRepeatGrid(doc, grid, false));
    expect(doc.get(doc.children(grid)[1]!, 'transform')![2]).toBe(150);
    expect(doc.get(grid, 'width')).toBe(300);
  });
});

describe('data from CSV and JSON (MFP-specific)', () => {
  it('CSV: quotes, “""”, line break inside quotes, semicolon', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual({ columns: ['a', 'b'], rows: [{ a: 'x, y', b: 'he said "hi"' }] });
    expect(parseCsv('name;price\r\n"Кофе\nсо сливками";250\r\n')).toEqual({ columns: ['name', 'price'], rows: [{ name: 'Кофе\nсо сливками', price: '250' }] });
    expect(parseCsv('a\tb\n1\t2')?.rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('JSON: an array of objects or an object with an array; numbers and null as strings', () => {
    expect(parseData('[{"name":"A","price":10},{"name":"B","price":null}]')).toEqual({ columns: ['name', 'price'], rows: [{ name: 'A', price: '10' }, { name: 'B', price: '' }] });
    expect(parseData('{"items":[{"x":1}]}')?.rows).toEqual([{ x: '1' }]);
    expect(parseData('{нет')).toBeNull();
    expect(hexColor('#0f08')).toEqual({ r: 0, g: 1, b: 0, a: 0x88 / 255 });
  });

  it('filling cells: text by layer name (#, {}, case), shape color, “/hide”; a single undo step', () => {
    const { doc, comp } = card();
    const grid = doc.transact(() => createRepeatGrid(doc, comp, { columns: 2, rows: 1 }));
    const table = parseData('name,price,color\nКофе,250 ₽,#ff0000\nЧай,/hide,#00ff00\nЛишняя,1,#000')!;
    const res = doc.transact(() => fillTargets(doc, doc.children(grid), table));
    expect(res.matched).toEqual(['name', 'price', 'color']);
    const [a, b] = doc.children(grid).map((cell) => doc.children(cell));
    expect(doc.get(a![0]!, 'characters')).toBe('Кофе');
    expect(doc.get(a![1]!, 'characters')).toBe('250 ₽');
    expect(doc.get(a![2]!, 'fills')![0]).toMatchObject({ type: 'SOLID', color: { r: 1, g: 0, b: 0 } });
    expect(doc.get(b![0]!, 'characters')).toBe('Чай');
    expect(doc.get(b![1]!, 'visible')).toBe(false);
    doc.undo();
    expect(doc.get(a![0]!, 'characters')).toBe('Название');
  });
});
