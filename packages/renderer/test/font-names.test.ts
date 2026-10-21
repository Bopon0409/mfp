import { describe, expect, it } from 'vitest';
import { fontAxes, fontNames } from '../src/font-names.ts';

/** Minimal TrueType with an fvar table: axes [tag, min, default, max, hidden]. */
function fvarFont(axes: [string, number, number, number, boolean?][]): Uint8Array {
  const tableOffset = 12 + 16;
  const length = 16 + axes.length * 20;
  const out = new Uint8Array(tableOffset + length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, 1);
  v.setUint32(12, 0x66766172); // 'fvar'
  v.setUint32(20, tableOffset);
  v.setUint32(24, length);
  v.setUint16(tableOffset, 1);
  v.setUint16(tableOffset + 4, 16);
  v.setUint16(tableOffset + 8, axes.length);
  v.setUint16(tableOffset + 10, 20);
  axes.forEach(([tag, min, def, max, hidden], i) => {
    const at = tableOffset + 16 + i * 20;
    for (let k = 0; k < 4; k++) out[at + k] = tag.charCodeAt(k);
    v.setInt32(at + 4, Math.round(min * 65536));
    v.setInt32(at + 8, Math.round(def * 65536));
    v.setInt32(at + 12, Math.round(max * 65536));
    v.setUint16(at + 16, hidden ? 1 : 0);
  });
  return out;
}

/** Minimal TrueType: header and a single name table with Windows records (UTF-16BE). */
function sfnt(names: Record<number, string>, tag = 0x00010000): Uint8Array {
  const entries = Object.entries(names).map(([id, text]) => {
    const bytes: number[] = [];
    for (const ch of text) {
      const c = ch.charCodeAt(0);
      bytes.push(c >> 8, c & 0xff);
    }
    return { id: Number(id), bytes };
  });
  const nameHeader = 6 + entries.length * 12;
  const stringsLength = entries.reduce((n, e) => n + e.bytes.length, 0);
  const nameOffset = 12 + 16;
  const out = new Uint8Array(nameOffset + nameHeader + stringsLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, tag);
  v.setUint16(4, 1);
  v.setUint32(12, 0x6e616d65);
  v.setUint32(20, nameOffset);
  v.setUint32(24, nameHeader + stringsLength);
  v.setUint16(nameOffset + 2, entries.length);
  v.setUint16(nameOffset + 4, nameHeader);
  let at = 0;
  entries.forEach((e, i) => {
    const rec = nameOffset + 6 + i * 12;
    v.setUint16(rec, 3);
    v.setUint16(rec + 2, 1);
    v.setUint16(rec + 4, 0x409);
    v.setUint16(rec + 6, e.id);
    v.setUint16(rec + 8, e.bytes.length);
    v.setUint16(rec + 10, at);
    out.set(e.bytes, nameOffset + nameHeader + at);
    at += e.bytes.length;
  });
  return out;
}

describe('variable font axes (fvar)', () => {
  it('tags, limits and defaults; hidden axes excluded', () => {
    const axes = fontAxes(
      fvarFont([
        ['wght', 100, 400, 900],
        ['slnt', -10, 0, 0],
        ['XTRA', 323, 468, 603, true],
      ]),
    );
    expect(axes).toEqual([
      { tag: 'wght', min: 100, max: 900, default: 400, step: 1 },
      { tag: 'slnt', min: -10, max: 0, default: 0, step: 0.1 },
    ]);
  });

  it('without fvar — not variable', () => {
    expect(fontAxes(sfnt({ 1: 'Inter', 2: 'Regular' }))).toBeNull();
  });
});

describe('font names from the file', () => {
  it('family and style from the name table', () => {
    expect(fontNames(sfnt({ 1: 'Proxima Nova', 2: 'Bold' }))).toEqual({ family: 'Proxima Nova', style: 'Bold' });
  });

  it('typographic names take precedence over legacy ones (a family with more than four styles)', () => {
    expect(fontNames(sfnt({ 1: 'Inter Display SemiBold', 2: 'Regular', 16: 'Inter Display', 17: 'SemiBold' }, 0x4f54544f))).toEqual({
      family: 'Inter Display',
      style: 'SemiBold',
    });
  });

  it('not a font, or WOFF2 — null', () => {
    expect(fontNames(new TextEncoder().encode('wOF2 не разбираем'))).toBeNull();
    expect(fontNames(new Uint8Array(4))).toBeNull();
  });
});
