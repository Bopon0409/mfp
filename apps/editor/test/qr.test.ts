import { describe, expect, it } from 'vitest';
import { formatBits, qrMatrix, reedSolomon } from '../src/qr.ts';

// GF(256) for syndrome checks (independent of the encoder's division).
const EXP: number[] = [];
const LOG: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
  }
}
const gmul = (a: number, b: number) => (a && b ? EXP[(LOG[a]! + LOG[b]!) % 255]! : 0);
/** Codeword syndromes (leading coefficient first): all zeros — no errors. */
const syndromes = (cw: number[], n: number) =>
  Array.from({ length: n }, (_, i) => cw.reduce((acc, c) => gmul(acc, EXP[i]!) ^ c, 0));

const BLOCKS_M: Record<number, [number, [number, number][]]> = {
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]], 11: [30, [[1, 50], [4, 51]]], 12: [22, [[6, 36], [2, 37]]],
  13: [22, [[8, 37], [1, 38]]], 14: [24, [[4, 40], [5, 41]]], 15: [24, [[5, 41], [5, 42]]],
};

/** Reverse parsing of the matrix: format (second copy), mask, zigzag, blocks, syndromes, bytes. */
function decode(g: boolean[][]): { text: string; ok: boolean; mask: number } {
  const size = g.length;
  const version = (size - 17) / 4;
  // Second copy of the format: bits 0–7 — row 8 right to left, 8–14 — column 8 from the bottom.
  let f = 0;
  for (let i = 0; i < 8; i++) f |= (g[8]![size - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i++) f |= (g[size - 15 + i]![8] ? 1 : 0) << i;
  const mask = [...Array(8).keys()].find((k) => formatBits(k) === f) ?? -1;
  // Function modules — same as the encoder's (finder patterns, timing, alignment, format, version).
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r0: number, c0: number, h: number, w: number) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) if (r >= 0 && c >= 0 && r < size && c < size) fn[r]![c] = true;
  };
  mark(0, 0, 9, 9);
  mark(0, size - 8, 9, 8);
  mark(size - 8, 0, 8, 9);
  mark(6, 0, 1, size);
  mark(0, 6, size, 1);
  const align: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70] };
  for (const r of align[version]!) for (const c of align[version]!) if (!((r < 9 && c < 9) || (r < 9 && c > size - 10) || (r > size - 10 && c < 9))) mark(r - 2, c - 2, 5, 5);
  if (version >= 7) {
    mark(0, size - 11, 6, 3);
    mark(size - 11, 0, 3, 6);
  }
  const masks = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number) => r % 2 === 0,
    (_r: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const up = ((right + 1) & 2) === 0;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (const c of [right, right - 1]) if (!fn[r]![c]) bits.push(g[r]![c] !== masks[mask]!(r, c) ? 1 : 0);
    }
  }
  const words: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // Reverse interleaving.
  const [ec, groups] = BLOCKS_M[version]!;
  const sizes = groups.flatMap(([n, d]) => new Array<number>(n).fill(d));
  const data: number[][] = sizes.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(...sizes); i++) for (let b = 0; b < sizes.length; b++) if (i < sizes[b]!) data[b]!.push(words[at++]!);
  const ecc: number[][] = sizes.map(() => []);
  for (let i = 0; i < ec; i++) for (let b = 0; b < sizes.length; b++) ecc[b]!.push(words[at++]!);
  const ok = data.every((d, b) => syndromes([...d, ...ecc[b]!], ec).every((s) => s === 0));
  // Data stream: “byte” mode, length, bytes.
  const flat = data.flat().flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (w >> i) & 1));
  const read = (from: number, n: number) => flat.slice(from, from + n).reduce((a, b) => (a << 1) | b, 0);
  const mode = read(0, 4);
  const lenBits = version < 10 ? 8 : 16;
  const len = read(4, lenBits);
  const bytes = Array.from({ length: len }, (_, i) => read(4 + lenBits + i * 8, 8));
  return { text: mode === 4 ? new TextDecoder().decode(new Uint8Array(bytes)) : '', ok, mask };
}

describe('QR code', () => {
  it('Reed–Solomon: the standard\'s example (HELLO WORLD, 1-M)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('format word for error correction M — per the standard\'s table', () => {
    expect(formatBits(0).toString(2).padStart(15, '0')).toBe('101010000010010');
    expect(formatBits(5).toString(2).padStart(15, '0')).toBe('100000011001110');
    expect(formatBits(7).toString(2).padStart(15, '0')).toBe('100101010100000');
  });

  it('finder patterns, timing and the dark module in place', () => {
    const g = qrMatrix('MFP');
    expect(g.length).toBe(21);
    for (const [r, c] of [
      [0, 0],
      [0, 14],
      [14, 0],
    ] as const) {
      expect(g[r + 3]![c + 3]).toBe(true);
      expect(g[r + 1]![c + 1]).toBe(false);
      expect(g[r]![c]).toBe(true);
    }
    for (let i = 8; i < 13; i++) expect(g[6]![i]).toBe(i % 2 === 0);
    expect(g[21 - 8]![8]).toBe(true);
  });

  it('decoding back: text in place, syndromes are zero (versions 1 to 10 and above)', () => {
    for (const [text, version] of [
      ['MFP', 1],
      ['https://mfp.example/#file=0f8e1c2a&link=Ab3&present=1', 4],
      ['Показ прототипа на телефоне: https://mfp.example/#file=0f8e1c2a-7d41-4c5b-9a7e-3b1f2c4d', 7],
      ['https://mfp.example/#file=0f8e1c2a-7d41-4c5b-9a7e-3b1f2c4d5e6f&link=Ab3dEf6hIj9kLmN0pQrStUvWxYz012345&present=1&start=12:34&note=' + 'q'.repeat(64), 10],
    ] as const) {
      const g = qrMatrix(text);
      expect((g.length - 17) / 4).toBeGreaterThanOrEqual(version);
      const r = decode(g);
      expect(r.mask).toBeGreaterThanOrEqual(0);
      expect(r.ok).toBe(true);
      expect(r.text).toBe(text);
    }
  });

  it('text too long — an error', () => {
    expect(() => qrMatrix('x'.repeat(2000))).toThrow();
  });
});
