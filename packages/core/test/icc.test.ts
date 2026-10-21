import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cmykTable, iccCmyk, iccCmykToLab, naiveCmyk, parseIcc, srgbToXyzD50, xyzToLab } from '@mfp/core';

/** Synthetic v2 print profile: Lab → CMYK via a 2×2×2 lut16 table (C = 1 − L, M = a, Y = b, K = 1 − L). */
function profile(): Uint8Array {
  const tagStart = 132 + 12;
  const lut: number[] = [];
  const u8 = (v: number) => lut.push(v & 0xff);
  const u16 = (v: number) => lut.push((v >> 8) & 0xff, v & 0xff);
  const s15 = (v: number) => {
    const x = Math.round(v * 65536) >>> 0;
    lut.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  };
  'mft2'.split('').forEach((c) => u8(c.charCodeAt(0)));
  for (let i = 0; i < 4; i++) u8(0);
  u8(3);
  u8(4);
  u8(2);
  u8(0);
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach(s15);
  u16(2);
  u16(2);
  for (let c = 0; c < 3; c++) {
    u16(0);
    u16(65535);
  }
  for (let L = 0; L < 2; L++) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) [1 - L, a, b, 1 - L].forEach((v) => u16(v * 65535));
  for (let c = 0; c < 4; c++) {
    u16(0);
    u16(65535);
  }
  const size = tagStart + lut.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  out[8] = 2;
  out.set([...'prtr'].map((c) => c.charCodeAt(0)), 12);
  out.set([...'CMYK'].map((c) => c.charCodeAt(0)), 16);
  out.set([...'Lab '].map((c) => c.charCodeAt(0)), 20);
  out.set([...'acsp'].map((c) => c.charCodeAt(0)), 36);
  dv.setUint32(128, 1);
  out.set([...'B2A1'].map((c) => c.charCodeAt(0)), 132);
  dv.setUint32(136, tagStart);
  dv.setUint32(140, lut.length);
  out.set(lut, tagStart);
  return out;
}

describe('CMYK via a print profile', () => {
  it('parsing and conversion via lut16: Lab in the legacy 16-bit encoding (L 100 = 0xFF00)', () => {
    const p = parseIcc(profile());
    expect([p.colorSpace, p.pcs, p.deviceClass]).toEqual(['CMYK', 'Lab ', 'prtr']);
    const to = iccCmyk(p)!;
    const white = to(1, 1, 1);
    expect(white[0]).toBeCloseTo(1 - 0xff00 / 65535, 4);
    expect(white[1]).toBeCloseTo(0x8000 / 65535, 3);
    expect(white[3]).toBeCloseTo(white[0], 6);
    const black = to(0, 0, 0);
    expect(black[0]).toBeCloseTo(1, 6);
    expect(black[3]).toBeCloseTo(1, 6);
    // The image table gives the same as the full path.
    const fast = cmykTable(to);
    for (const [r, g, b] of [[0.2, 0.5, 0.9], [1, 0.4, 0], [0.33, 0.33, 0.33]] as const) {
      const a = to(r, g, b);
      const q = fast.at(r, g, b);
      for (let i = 0; i < 4; i++) expect(q[i]).toBeCloseTo(a[i]!, 2);
    }
    const px = fast.pixels(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]));
    expect([...px.slice(4)]).toEqual([255, 128, 128, 255]);
  });

  it('not ICC or not a print profile — an error or null', () => {
    expect(() => parseIcc(new Uint8Array(200))).toThrow();
  });

  it('approximate: black — K, gray — K, pure colors — without K', () => {
    expect(naiveCmyk(0, 0, 0)).toEqual([0, 0, 0, 1]);
    expect(naiveCmyk(1, 1, 1)).toEqual([0, 0, 0, 0]);
    expect(naiveCmyk(0.5, 0.5, 0.5).map((v) => +v.toFixed(3))).toEqual([0, 0, 0, 0.5]);
    expect(naiveCmyk(0, 1, 1)).toEqual([1, 0, 0, 0]);
  });

  // Windows system profile (if present): a round trip is close to the original color.
  const rswop = 'C:/Windows/System32/spool/drivers/color/RSWOP.icm';
  it.skipIf(!existsSync(rswop))('system SWOP profile: round trip — ΔE < 8 for in-gamut colors', () => {
    const p = parseIcc(new Uint8Array(readFileSync(rswop)));
    const to = iccCmyk(p)!;
    const back = iccCmykToLab(p)!;
    for (const [r, g, b] of [[0.5, 0.5, 0.5], [0.2, 0.6, 0.3], [0.9, 0.75, 0.65], [0.85, 0.15, 0.15]] as const) {
      const lab = xyzToLab(srgbToXyzD50(r, g, b));
      const lab2 = back(to(r, g, b));
      expect(Math.hypot(lab[0] - lab2[0], lab[1] - lab2[1], lab[2] - lab2[2])).toBeLessThan(8);
    }
    expect(back([0, 0, 0, 0])[0]).toBeGreaterThan(99);
  });
});
