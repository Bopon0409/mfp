import { describe, expect, it } from 'vitest';
import { Document, type SolidPaint } from '@mfp/core';
import { invertColors, joinTexts, naturalCompare, reverseOrder, sortByName, sortByPosition, textPartProps, textPieces, textStats } from '../src/index.ts';

function page() {
  const doc = new Document({ clientId: 1 });
  const p = doc.create('PAGE', doc.root);
  return { doc, p };
}
/** Child names from top to bottom (as in the layer list). */
const topDownNames = (doc: Document, parent: string) => [...doc.children(parent)].reverse().map((id) => doc.get(id, 'name'));

describe('layer order (user requests)', () => {
  it('by name in natural order, reverse order; unselected layers stay in place', () => {
    const { doc, p } = page();
    const mk = (name: string) => doc.create('RECTANGLE', p, { name });
    const [s10, keep, s2, s1] = [mk('Экран 10'), mk('Фон'), mk('Экран 2'), mk('Экран 1')];
    expect(topDownNames(doc, p)).toEqual(['Экран 1', 'Экран 2', 'Фон', 'Экран 10']);
    doc.transact(() => sortByName(doc, [s10, s2, s1], true));
    // Descending (Z to A) from the top; the background stays in place.
    expect(topDownNames(doc, p)).toEqual(['Экран 10', 'Экран 2', 'Фон', 'Экран 1']);
    doc.transact(() => sortByName(doc, [s10, s2, s1]));
    expect(topDownNames(doc, p)).toEqual(['Экран 1', 'Экран 2', 'Фон', 'Экран 10']);
    doc.transact(() => reverseOrder(doc, [s10, s2, s1, keep]));
    expect(topDownNames(doc, p)).toEqual(['Экран 10', 'Фон', 'Экран 2', 'Экран 1']);
    expect(naturalCompare('a2', 'a10')).toBeLessThan(0);
  });

  it('by position: higher on the canvas comes first in the list, then further left', () => {
    const { doc, p } = page();
    const at = { a: [100, 0], b: [0, 0], c: [0, 50] } as Record<string, [number, number]>;
    const ids = Object.keys(at).map((name) => doc.create('RECTANGLE', p, { name }));
    doc.transact(() => sortByPosition(doc, ids, (id) => at[doc.get(id, 'name')!]!));
    expect(topDownNames(doc, p)).toEqual(['b', 'a', 'c']);
  });
});

describe('split and join text (user request)', () => {
  it('lines and words become pieces; each part keeps the styling of its runs', () => {
    expect(textPieces('Цена\n$19.99 /month', 'lines')).toEqual([[0, 4], [5, 18]]);
    expect(textPieces('Цена  $19.99', 'words')).toEqual([[0, 4], [6, 12]]);
    const { doc, p } = page();
    const t = doc.create('TEXT', p, { characters: 'Купить сейчас', fontSize: 20, textRuns: [{ length: 7, style: { fontSize: 30 } }, { length: 6, style: {} }] });
    const part = textPartProps(doc, t, 7, 13);
    expect(part.characters).toBe('сейчас');
    expect(part.textRuns).toEqual([{ length: 6, style: {} }]);
    const first = textPartProps(doc, t, 0, 6);
    expect(first.textRuns).toEqual([{ length: 6, style: { fontSize: 30 } }]);
  });

  it('join: text separated by line breaks, each one\'s styling preserved, the others deleted', () => {
    const { doc, p } = page();
    const a = doc.create('TEXT', p, { characters: 'Заголовок', fontSize: 32 });
    const b = doc.create('TEXT', p, { characters: 'подпись', fontSize: 14 });
    const kept = doc.transact(() => joinTexts(doc, [a, b]));
    expect(kept).toBe(a);
    expect(doc.has(b)).toBe(false);
    expect(doc.get(a, 'characters')).toBe('Заголовок\nподпись');
    const runs = doc.get(a, 'textRuns')!;
    expect(runs.map((r) => [r.length, r.style.fontSize])).toEqual([[9, 32], [1, 14], [7, 14]]);
  });

  it('counter: words and characters excluding line breaks', () => {
    expect(textStats('Два слова\nи ещё')).toEqual({ words: 4, chars: 14, charsNoSpaces: 12 });
  });
});

describe('invert colors (user request)', () => {
  it('solids, gradients and shadows across the whole subtree; colors from variables are left alone', () => {
    const { doc, p } = page();
    const f = doc.create('FRAME', p, { fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] });
    const r = doc.create('RECTANGLE', f, {
      fills: [
        { type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.6 } },
        { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'x' } } },
      ],
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, radius: 4, visible: true, blendMode: 'NORMAL' }],
    });
    const n = doc.transact(() => invertColors(doc, [f]));
    expect(n).toBe(3);
    expect((doc.get(f, 'fills')![0] as SolidPaint).color).toEqual({ r: 0, g: 0, b: 0 });
    const c = (doc.get(r, 'fills')![0] as SolidPaint).color;
    expect([c.r, c.g, c.b].map((v) => Math.round(v * 10) / 10)).toEqual([0.8, 0.6, 0.4]);
    expect((doc.get(r, 'fills')![1] as SolidPaint).color).toEqual({ r: 0, g: 0, b: 0 });
    expect((doc.get(r, 'effects')![0] as { color: { r: number; a: number } }).color).toMatchObject({ r: 1, a: 0.5 });
  });

  it('lightness only: white ↔ black, the hue of colored fills is preserved', () => {
    const { doc, p } = page();
    const r = doc.create('RECTANGLE', p, { fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }, { type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.8 } }] });
    doc.transact(() => invertColors(doc, [r], 'lightness'));
    const [w, blue] = doc.get(r, 'fills')!.map((x) => (x as SolidPaint).color);
    expect(w!.r + w!.g + w!.b).toBeLessThan(0.05);
    // Blue stays blue (b is the largest component), but lighter.
    expect(blue!.b).toBeGreaterThan(blue!.r);
    expect(blue!.b).toBeGreaterThan(0.8);
  });
});
