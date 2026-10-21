import { describe, expect, it } from 'vitest';
import { MIXED, normalizeRuns, paragraphSpan, rangeValue, spliceRuns, styleAt, styleRange, stripRuns, textSegments, type TextRun } from '../src/index.ts';

const bold = { fontName: { family: 'Inter', style: 'Bold' } };
const red = { fills: [{ type: 'SOLID' as const, color: { r: 1, g: 0, b: 0 } }] };

describe('range styles', () => {
  it('normalization: text length, merging neighbors, no empty tail', () => {
    const runs: TextRun[] = [
      { length: 2, style: bold },
      { length: 3, style: bold },
      { length: 0, style: red },
      { length: 4, style: {} },
    ];
    expect(normalizeRuns(runs, 20)).toEqual([{ length: 5, style: bold }]);
    expect(normalizeRuns(runs, 3)).toEqual([{ length: 3, style: bold }]);
    expect(normalizeRuns([{ length: 5, style: {} }], 5)).toEqual([]);
  });

  it('a range style splits runs and merges identical ones', () => {
    // “TheRed, sun”: “sun” in bold, then “Red” in red.
    let runs = styleRange([], 11, 8, 11, bold);
    expect(runs).toEqual([
      { length: 8, style: {} },
      { length: 3, style: bold },
    ]);
    runs = styleRange(runs, 11, 3, 6, red);
    expect(textSegments(runs, 11).map((s) => [s.start, s.end, Object.keys(s.style)])).toEqual([
      [0, 3, []],
      [3, 6, ['fills']],
      [6, 8, []],
      [8, 11, ['fontName']],
    ]);
    // Remove the difference — as the node again.
    expect(styleRange(runs, 11, 0, 11, { fills: undefined, fontName: undefined })).toEqual([]);
  });

  it('insertion takes the style of the character before it, at the start — of the first character', () => {
    const runs = styleRange([], 6, 3, 6, bold); // “abcDEF”
    expect(spliceRuns(runs, 6, 6, 0, 2)).toEqual([
      { length: 3, style: {} },
      { length: 5, style: bold },
    ]);
    expect(spliceRuns(runs, 6, 3, 0, 1)).toEqual([
      { length: 4, style: {} },
      { length: 3, style: bold },
    ]);
    const allBold = styleRange([], 3, 0, 3, bold);
    expect(spliceRuns(allBold, 3, 0, 0, 2)).toEqual([{ length: 5, style: bold }]);
  });

  it('deleting and replacing a range', () => {
    const runs = styleRange([], 10, 2, 8, bold);
    // Delete [4, 9): the bold tail gets shorter, the regular tail is kept.
    expect(spliceRuns(runs, 10, 4, 5, 0)).toEqual([
      { length: 2, style: {} },
      { length: 2, style: bold },
    ]);
    // Replace [0, 4) with two characters in their own style.
    expect(spliceRuns(runs, 10, 0, 4, 2, red)[0]).toEqual({ length: 2, style: red });
  });

  it('value over a range: single or MIXED; at the caret — of the character before it', () => {
    const base = { fontSize: 12 };
    const runs = styleRange([], 10, 5, 10, { fontSize: 20 });
    expect(rangeValue(base, runs, 10, 0, 5, 'fontSize')).toBe(12);
    expect(rangeValue(base, runs, 10, 5, 10, 'fontSize')).toBe(20);
    expect(rangeValue(base, runs, 10, 3, 7, 'fontSize')).toBe(MIXED);
    expect(rangeValue(base, runs, 10, 6, 6, 'fontSize')).toBe(20);
    expect(rangeValue(base, runs, 10, 5, 5, 'fontSize')).toBe(12);
  });

  it('character style and removing a key from the whole text', () => {
    const runs = styleRange(styleRange([], 6, 0, 3, bold), 6, 2, 6, red);
    expect(styleAt(runs, 2)).toEqual({ ...bold, ...red });
    expect(styleAt(runs, 99)).toEqual({});
    expect(stripRuns(runs, 6, ['fills'])).toEqual([{ length: 3, style: bold }]);
  });

  it('paragraph boundaries', () => {
    const t = 'four\ntwo\nsix';
    expect(paragraphSpan(t, 6, 6)).toEqual([5, 8]);
    expect(paragraphSpan(t, 2, 6)).toEqual([0, 8]);
    expect(paragraphSpan(t, 5, 9)).toEqual([5, 8]); // selection up to and including the line break
    expect(paragraphSpan(t, 9, 12)).toEqual([9, 12]);
  });
});
