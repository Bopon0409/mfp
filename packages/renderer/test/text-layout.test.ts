import { join } from 'node:path';
import CanvasKitModule, { type CanvasKit } from 'canvaskit-wasm';
import { describe, expect, it } from 'vitest';
import type { Props } from '@mfp/core';
import { FontLibrary } from '../src/fonts.ts';
import { layoutText, scaledSpec, textLayoutOf } from '../src/text.ts';

// Layout needs a real font: Inter from the Fontsource catalog. No network — the tests are skipped.
const CanvasKitInit = CanvasKitModule as unknown as (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
const ck = await CanvasKitInit({ locateFile: (f: string) => join('node_modules/canvaskit-wasm/bin', f) });
const fonts = new FontLibrary(ck);
const online = (await Promise.race([Promise.all([fonts.ensure({ family: 'Inter', style: 'Regular' }), fonts.ensure({ family: 'Inter', style: 'Bold' })]), new Promise<boolean[]>((r) => setTimeout(() => r([false]), 15000))])).every(Boolean);

const lay = (p: Props, width?: number, height?: number) => layoutText(ck, fonts, { ...textLayoutOf(p), color: { r: 0, g: 0, b: 0, a: 1 }, width, height });

describe.skipIf(!online)('text layout', () => {
  it('hanging punctuation: a line with a quote is shifted by the quote width, letters align to the edge', () => {
    const t = lay({ characters: '«Цитата» и ещё немного текста для переноса', fontSize: 20, hangingPunctuation: true }, 160);
    const first = t.lines()[0]!;
    expect(first.x).toBeLessThan(-3);
    // Caret after the quote — at the box edge.
    expect(Math.abs(t.caret(1).x)).toBeLessThan(0.5);
    // Lines without a hanging character — no offset.
    expect(t.lines()[1]!.x).toBeCloseTo(0, 1);
    t.delete();
  });

  it('hanging bullets: item text at the edge, the bullet beyond it', () => {
    const plain = lay({ characters: 'Пункт', fontSize: 16, listType: 'UNORDERED', textRuns: [{ length: 5, style: { listType: 'UNORDERED' } }] }, 300);
    const hang = lay({ characters: 'Пункт', fontSize: 16, listType: 'UNORDERED', hangingList: true, textRuns: [{ length: 5, style: { listType: 'UNORDERED' } }] }, 300);
    expect(plain.blocks[0]!.x).toBeGreaterThan(0);
    expect(hang.blocks[0]!.x).toBe(0);
    expect(hang.blocks[0]!.marker!.x).toBeLessThan(0);
    plain.delete();
    hang.delete();
  });

  it('variable font axes: an axis weight is wider than regular; while files load — the regular style', async () => {
    const font = { family: 'Inter', style: 'Regular' };
    let ready = fonts.ensureVariable(font);
    const until = Date.now() + 15000;
    while (ready === undefined && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      ready = fonts.ensureVariable(font);
    }
    if (!ready) return; // no network — nothing to check
    const plain = lay({ characters: 'Вариативный', fontSize: 30 });
    const heavy = lay({ characters: 'Вариативный', fontSize: 30, fontVariations: [{ axis: 'wght', value: 900 }] });
    expect(heavy.width).toBeGreaterThan(plain.width + 5);
    plain.delete();
    heavy.delete();
  }, 20000);

  it('runs with their own style are wider than regular ones', () => {
    const plain = lay({ characters: 'Привет мир', fontSize: 20 });
    const bold = lay({ characters: 'Привет мир', fontSize: 20, textRuns: [{ length: 6, style: { fontName: { family: 'Inter', style: 'Bold' } } }] });
    expect(bold.width).toBeGreaterThan(plain.width + 1);
    plain.delete();
    bold.delete();
  });

  it('lists: indent, a bullet on every item, numbering per level', () => {
    const t = lay({ characters: 'Пункт\nЕщё\nВложенный', fontSize: 16, listType: 'ORDERED', textRuns: [{ length: 10, style: {} }, { length: 9, style: { indentation: 1 } }] }, 300);
    expect(t.blocks).toHaveLength(3);
    expect(t.blocks.every((b) => b.marker)).toBe(true);
    expect(t.blocks[0]!.x).toBeGreaterThan(0);
    expect(t.blocks[2]!.x).toBeGreaterThan(t.blocks[0]!.x);
    t.delete();
  });

  it('vertical trim: line height equals cap height', () => {
    const t = lay({ characters: 'Кнопка', fontSize: 20, leadingTrim: 'CAP_HEIGHT' });
    expect(t.height).toBeCloseTo(fonts.capHeight({ family: 'Inter', style: 'Regular' }) * 20, 1);
    expect(t.lines()[0]!.baseline).toBeCloseTo(t.height, 1);
    t.delete();
  });

  it('max lines — with an ellipsis', () => {
    const long = 'Очень длинный текст, который не помещается в одну строку узкого блока';
    const t = lay({ characters: long, fontSize: 14, maxLines: 1, textTruncation: 'ENDING' }, 120);
    expect(t.lines()).toHaveLength(1);
    t.delete();
    // Fixed height: as many lines as fit.
    const fixed = lay({ characters: long, fontSize: 14, textTruncation: 'ENDING', textAutoResize: 'NONE' }, 120, 36);
    expect(fixed.lines().length).toBeLessThanOrEqual(2);
    fixed.delete();
  });

  it('caret and character under a point are consistent', () => {
    const t = lay({ characters: 'Абв где\nжзи', fontSize: 20 }, 200);
    for (const i of [0, 3, 5, 8, 10]) {
      const c = t.caret(i);
      expect(t.indexAt(c.x + 0.5, c.y + c.height / 2)).toBe(i);
    }
    const [a, b] = t.wordAt(5);
    expect([a, b]).toEqual([4, 7]);
    expect(t.rects(0, 11).length).toBeGreaterThanOrEqual(2);
    t.delete();
  });
});

describe.skipIf(!online)('font files', () => {
  const get = async (ext: string) => (await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-700-normal.${ext}`)).arrayBuffer();

  it('WOFF: name and metrics from decompressed tables', async () => {
    const { fontNames, fontMetrics } = await import('../src/font-names.ts');
    const data = await get('woff');
    expect(fontNames(data)?.family).toBe('Inter');
    expect(fontMetrics(data)?.capHeight).toBeGreaterThan(0.6);
  });

  it('WOFF2: family from CanvasKit, style from the file name', async () => {
    const lib = new FontLibrary(ck);
    const font = await lib.addFile(await get('woff2'), 'Inter-Bold.woff2');
    expect(font).toEqual({ family: 'Inter', style: 'Bold' });
  });
});

describe.skipIf(!online)('fit text into a box (MFP-specific)', () => {
  const long = 'Длинный заголовок карточки товара, который не помещается в отведённое место';
  const black = { r: 0, g: 0, b: 0, a: 1 };
  it('doesn\'t fit — the largest font size that fits', () => {
    const p: Props = { characters: long, fontSize: 32, textAutoResize: 'NONE', textFit: 'SHRINK', width: 200, height: 80 };
    const fixed = lay({ ...p, textFit: 'NONE' }, 200, 80);
    const fit = lay(p, 200, 80);
    expect(fixed.height).toBeGreaterThan(80);
    expect(fit.fitScale).toBeLessThan(1);
    expect(fit.height).toBeLessThanOrEqual(80.5);
    // Almost a tight fit: 5 % larger no longer fits.
    const bigger = layoutText(ck, fonts, scaledSpec({ ...textLayoutOf(p), color: black, width: 200, height: 80 }, fit.fitScale * 1.05));
    expect(bigger.height).toBeGreaterThan(80.5);
    for (const t of [fixed, fit, bigger]) t.delete();
  });

  it('fits — as is; minimum font size is the limit; auto height has no fitting', () => {
    const short = lay({ characters: 'Коротко', fontSize: 20, textAutoResize: 'NONE', textFit: 'SHRINK' }, 200, 80);
    expect(short.fitScale).toBe(1);
    const floor = lay({ characters: long.repeat(6), fontSize: 32, textAutoResize: 'NONE', textFit: 'SHRINK', textFitMinSize: 16 }, 200, 40);
    expect(floor.fitScale).toBeCloseTo(0.5, 9);
    expect(textLayoutOf({ characters: long, textAutoResize: 'HEIGHT', textFit: 'SHRINK' }).fit).toBeUndefined();
    short.delete();
    floor.delete();
  });
});
