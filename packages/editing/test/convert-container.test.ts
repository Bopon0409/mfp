import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { convertContainer } from '../src/groups.ts';

const setup = () => {
  const doc = new Document();
  const page = doc.create('PAGE', doc.root, { name: 'Страница' });
  const frame = doc.create('FRAME', page, { name: 'Карточка', transform: [1, 0, 40, 0, 1, 30], width: 200, height: 100, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], opacity: 0.5, clipsContent: true });
  const a = doc.create('RECTANGLE', frame, { transform: [1, 0, 10, 0, 1, 10], width: 20, height: 20 });
  const b = doc.create('TEXT', frame, { transform: [1, 0, 50, 0, 1, 10], width: 40, height: 16 });
  return { doc, page, frame, a, b };
};

describe('convertContainer', () => {
  it('frame → group keeps place, children and their order, drops frame-only props', () => {
    const { doc, page, frame, a, b } = setup();
    const g = convertContainer(doc, frame, 'GROUP');
    expect(doc.has(frame)).toBe(false);
    expect(doc.type(g)).toBe('GROUP');
    expect(doc.children(page)).toEqual([g]);
    expect(doc.children(g)).toEqual([a, b]);
    expect(doc.get(g, 'name')).toBe('Карточка');
    // Group bounds follow the children (20..90 × 10..30 inside the former frame); nothing moved on screen.
    expect(doc.get(g, 'transform')).toEqual([1, 0, 50, 0, 1, 40]);
    expect([doc.get(g, 'width'), doc.get(g, 'height')]).toEqual([80, 20]);
    expect(doc.get(g, 'opacity')).toBe(0.5);
    expect(doc.get(a, 'transform')).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it('group → frame has no fill and no clipping (looks the same)', () => {
    const { doc, frame } = setup();
    const g = convertContainer(doc, frame, 'GROUP');
    const f = convertContainer(doc, g, 'FRAME');
    expect(doc.type(f)).toBe('FRAME');
    expect(doc.get(f, 'fills')).toEqual([]);
    expect(doc.get(f, 'clipsContent')).toBe(false);
    expect(doc.children(f)).toHaveLength(2);
  });

  it('frame → section keeps fills, drops rotation', () => {
    const { doc, frame } = setup();
    doc.set(frame, { transform: [0, -1, 40, 1, 0, 30] });
    const s = convertContainer(doc, frame, 'SECTION');
    expect(doc.type(s)).toBe('SECTION');
    expect(doc.get(s, 'transform')).toEqual([1, 0, 40, 0, 1, 30]);
    expect(doc.get(s, 'fills')).toEqual([{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }]);
  });

  it('is one undo step', () => {
    const { doc, page, frame } = setup();
    doc.clearHistory();
    doc.transact(() => convertContainer(doc, frame, 'GROUP'));
    doc.undo();
    expect(doc.children(page)).toEqual([frame]);
    expect(doc.type(frame)).toBe('FRAME');
    expect(doc.children(frame)).toHaveLength(2);
  });
});
