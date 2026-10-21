import { describe, expect, it } from 'vitest';
import { Document, alias, bindPaintVariable, createCollection, createStyle, createVariable, type Paint } from '@mfp/core';
import { recolorUses, selectionColors } from '@mfp/editing';

const solid = (r: number, g: number, b: number, opacity = 1): Paint => ({ type: 'SOLID', color: { r, g, b }, opacity, visible: true });

describe('selection colors', () => {
  it('own colors, style and variable on separate rows; editing a color changes it everywhere', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Стр' });
    const ids = doc.transact(() => {
      const frame = doc.create('FRAME', page, { name: 'Карточка', fills: [solid(1, 1, 1)] });
      const a = doc.create('RECTANGLE', frame, { fills: [solid(1, 0, 0)], strokes: [solid(1, 1, 1)] });
      const b = doc.create('RECTANGLE', frame, { fills: [solid(1, 0, 0), solid(1, 0, 0, 0.5)] });
      const t = doc.create('TEXT', frame, { characters: 'Привет', fills: [solid(0, 0, 0)], textRuns: [{ length: 3, style: { fills: [solid(1, 0, 0)] } }, { length: 3, style: {} }] });
      const style = createStyle(doc, 'PAINT', 'Бренд', { fills: [solid(0, 0.5, 1)] });
      const c = doc.create('RECTANGLE', frame, { fills: [solid(0, 0.5, 1)], fillStyleId: style });
      const coll = createCollection(doc, 'Тема');
      const v = createVariable(doc, 'Акцент', coll, 'COLOR', { r: 0, g: 1, b: 0, a: 1 });
      const d = doc.create('RECTANGLE', frame, { fills: [solid(0, 1, 0)] });
      bindPaintVariable(doc, d, 'fills', 0, v);
      const hidden = doc.create('RECTANGLE', frame, { fills: [solid(0.3, 0.3, 0.3)], visible: false });
      return { frame, a, b, t, style, c, v, d, hidden };
    });
    const colors = selectionColors(doc, [ids.frame])!;
    // White (frame + stroke a), red (a, b, a piece of text), red 50%, text black, style, variable. A hidden layer contributes no colors.
    expect(colors.map((g) => `${g.kind}:${g.uses.length}`)).toEqual(['color:2', 'color:3', 'color:1', 'color:1', 'style:1', 'variable:1']);
    expect(colors[4]!.ref).toBe(ids.style);
    expect(colors[5]!.ref).toBe(ids.v);
    const red = colors[1]!;
    expect(red.uses).toContainEqual({ id: ids.t, key: 'fills', index: 0, run: 0 });
    doc.transact(() => recolorUses(doc, red.uses, { r: 0, g: 0, b: 1 }));
    expect((doc.get(ids.a, 'fills')![0] as Extract<Paint, { type: 'SOLID' }>).color).toEqual({ r: 0, g: 0, b: 1 });
    expect((doc.get(ids.b, 'fills')![0] as Extract<Paint, { type: 'SOLID' }>).color).toEqual({ r: 0, g: 0, b: 1 });
    // Semi-transparent red is its own row, untouched.
    expect((doc.get(ids.b, 'fills')![1] as Extract<Paint, { type: 'SOLID' }>).color).toEqual({ r: 1, g: 0, b: 0 });
    const runFill = doc.get(ids.t, 'textRuns')![0]!.style.fills![0] as Extract<Paint, { type: 'SOLID' }>;
    expect(runFill.color).toEqual({ r: 0, g: 0, b: 1 });
    // Now blue is one row instead of red; stroke a and the white frame are untouched.
    const after = selectionColors(doc, [ids.frame])!;
    expect(after.find((g) => g.kind === 'color' && g.color.b === 1 && g.color.r === 0 && g.color.g === 0)!.uses.length).toBe(3);
    expect((doc.get(ids.a, 'strokes')![0] as Extract<Paint, { type: 'SOLID' }>).color).toEqual({ r: 1, g: 1, b: 1 });
    void alias;
  });

  it('more than limit layers — null, like getSelectionColors in the plugin API', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Стр' });
    const frame = doc.transact(() => {
      const f = doc.create('FRAME', page, { fills: [] });
      for (let i = 0; i < 12; i++) doc.create('RECTANGLE', f, { fills: [solid(i / 12, 0, 0)] });
      return f;
    });
    expect(selectionColors(doc, [frame], 10)).toBeNull();
    expect(selectionColors(doc, [frame], 100)!.length).toBe(12);
  });
});
