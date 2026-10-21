// ICC profiles for print (our own): parsing a CMYK output profile and converting colors through its tables.
// An honest conversion of a screen color into inks is only possible with a print profile (FOGRA39, SWOP, ISO
// Coated…): it describes which ink mixes produce which color. The person chooses the profile (an .icc file);
// without a profile — an approximate conversion (naiveCmyk), labeled as such.
//
// Tables: lut8 'mft1' and lut16 'mft2' (ICC v2), lutAtoB 'mAB ' and lutBtoA 'mBA ' (ICC v4: curves
// 'curv' / 'para', matrix, CLUT). The screen color is sRGB: linear → XYZ (D50, Bradford adaptation)
// → the profile's PCS (Lab or XYZ) → B2A (relative colorimetric intent by default).

export interface IccProfile {
  version: number;
  /** Device class: 'prtr' — printer, 'mntr' — monitor… */
  deviceClass: string;
  /** Device color space: 'CMYK', 'RGB ' … */
  colorSpace: string;
  pcs: 'Lab ' | 'XYZ ';
  description: string;
  bytes: Uint8Array;
  tags: Map<string, { offset: number; length: number }>;
}

/** Rendering intent: 0 — perceptual, 1 — relative colorimetric, 2 — saturation. */
export type IccIntent = 0 | 1 | 2;

type Fn = (x: number[]) => number[];

const sig = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/** Parse a profile (error — not ICC). */
export function parseIcc(bytes: Uint8Array): IccProfile {
  if (bytes.length < 132 || sig(bytes, 36) !== 'acsp') throw new Error('Это не ICC-профиль');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags = new Map<string, { offset: number; length: number }>();
  const n = dv.getUint32(128);
  for (let i = 0; i < n && 132 + i * 12 + 12 <= bytes.length; i++) {
    const o = 132 + i * 12;
    tags.set(sig(bytes, o), { offset: dv.getUint32(o + 4), length: dv.getUint32(o + 8) });
  }
  const pcs = sig(bytes, 20);
  const p: IccProfile = { version: bytes[8]! + (bytes[9]! >> 4) / 10, deviceClass: sig(bytes, 12), colorSpace: sig(bytes, 16), pcs: pcs === 'XYZ ' ? 'XYZ ' : 'Lab ', description: '', bytes, tags };
  p.description = describe(p);
  return p;
}

/** Profile name: 'desc' (v2) or 'mluc' (v4). */
function describe(p: IccProfile): string {
  const t = p.tags.get('desc');
  if (!t) return '';
  const b = p.bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = sig(b, t.offset);
  if (type === 'desc') {
    const len = dv.getUint32(t.offset + 8);
    return new TextDecoder('latin1').decode(b.subarray(t.offset + 12, t.offset + 12 + Math.max(0, len - 1))).trim();
  }
  if (type === 'mluc') {
    const count = dv.getUint32(t.offset + 8);
    if (!count) return '';
    const len = dv.getUint32(t.offset + 20);
    const off = dv.getUint32(t.offset + 24);
    let s = '';
    for (let i = 0; i < len; i += 2) s += String.fromCharCode(dv.getUint16(t.offset + off + i));
    return s.trim();
  }
  return '';
}

// ---------- Tables ----------

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Tabulated curve (values 0…1): linear interpolation. */
function tableCurve(t: Float64Array): (x: number) => number {
  const n = t.length;
  if (n === 0) return (x) => x;
  if (n === 1) return (x) => Math.pow(x, t[0]!);
  return (x) => {
    const p = clamp01(x) * (n - 1);
    const i = Math.min(n - 2, Math.floor(p));
    return t[i]! + (t[i + 1]! - t[i]!) * (p - i);
  };
}

/** Multidimensional table (CLUT): grid[d] nodes along axis d, out outputs; multilinear interpolation. */
function clut(data: Float64Array, grid: number[], out: number): Fn {
  const dims = grid.length;
  const stride: number[] = new Array(dims);
  let s = out;
  for (let d = dims - 1; d >= 0; d--) {
    stride[d] = s;
    s *= grid[d]!;
  }
  return (x) => {
    const base: number[] = [];
    const frac: number[] = [];
    for (let d = 0; d < dims; d++) {
      const p = clamp01(x[d] ?? 0) * (grid[d]! - 1);
      const i = Math.min(grid[d]! - 2, Math.max(0, Math.floor(p)));
      base.push(grid[d]! > 1 ? i : 0);
      frac.push(grid[d]! > 1 ? p - i : 0);
    }
    const res = new Array(out).fill(0);
    // 2^dims corners (3 inputs — 8, 4 inputs — 16).
    for (let corner = 0; corner < 1 << dims; corner++) {
      let w = 1;
      let idx = 0;
      for (let d = 0; d < dims; d++) {
        const bit = (corner >> (dims - 1 - d)) & 1;
        w *= bit ? frac[d]! : 1 - frac[d]!;
        idx += (base[d]! + bit) * stride[d]!;
      }
      if (!w) continue;
      for (let o = 0; o < out; o++) res[o] += w * data[idx + o]!;
    }
    return res;
  };
}

/** lut8 / lut16 (ICC v2): [matrix — for XYZ] → input curves → CLUT → output curves. */
function readMft(b: Uint8Array, o: number, sixteen: boolean, xyzIn: boolean): Fn {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const inCh = b[o + 8]!;
  const outCh = b[o + 9]!;
  const g = b[o + 10]!;
  const m: number[] = [];
  for (let i = 0; i < 9; i++) m.push(dv.getInt32(o + 12 + i * 4) / 65536);
  let p = o + 48;
  const inEntries = sixteen ? dv.getUint16(o + 48) : 256;
  const outEntries = sixteen ? dv.getUint16(o + 50) : 256;
  if (sixteen) p = o + 52;
  const read = (count: number) => {
    const t = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      t[i] = sixteen ? dv.getUint16(p) / 65535 : b[p]! / 255;
      p += sixteen ? 2 : 1;
    }
    return t;
  };
  const inCurves = Array.from({ length: inCh }, () => tableCurve(read(inEntries)));
  const table = clut(read(g ** inCh * outCh), new Array(inCh).fill(g), outCh);
  const outCurves = Array.from({ length: outCh }, () => tableCurve(read(outEntries)));
  const identity = m.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-6);
  return (x) => {
    let v = x;
    if (xyzIn && inCh === 3 && !identity) v = [m[0]! * x[0]! + m[1]! * x[1]! + m[2]! * x[2]!, m[3]! * x[0]! + m[4]! * x[1]! + m[5]! * x[2]!, m[6]! * x[0]! + m[7]! * x[1]! + m[8]! * x[2]!];
    const a = v.map((c, i) => inCurves[i]!(c));
    return table(a).map((c, i) => outCurves[i]!(clamp01(c)));
  };
}

/** 'curv' / 'para' curves in sequence (each aligned to 4 bytes). */
function readCurves(b: Uint8Array, o: number, count: number): ((x: number) => number)[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: ((x: number) => number)[] = [];
  let p = o;
  for (let i = 0; i < count; i++) {
    const type = sig(b, p);
    if (type === 'curv') {
      const n = dv.getUint32(p + 8);
      const t = new Float64Array(n);
      for (let k = 0; k < n; k++) t[k] = dv.getUint16(p + 12 + k * 2) / (n === 1 ? 256 : 65535);
      out.push(tableCurve(t));
      p += 12 + n * 2;
    } else if (type === 'para') {
      const fn = dv.getUint16(p + 8);
      const nParams = [1, 3, 4, 5, 7][fn] ?? 1;
      const a = Array.from({ length: nParams }, (_, k) => dv.getInt32(p + 12 + k * 4) / 65536);
      const [g = 1, A = 1, B = 0, C = 0, D = 0, E = 0, F = 0] = a;
      const curve = (x: number): number => {
        switch (fn) {
          case 0:
            return Math.pow(x, g);
          case 1:
            return x >= -B / A ? Math.pow(A * x + B, g) : 0;
          case 2:
            return x >= -B / A ? Math.pow(A * x + B, g) + C : C;
          case 3:
            return x >= D ? Math.pow(A * x + B, g) : C * x;
          default:
            return x >= D ? Math.pow(A * x + B, g) + E : C * x + F;
        }
      };
      out.push((x) => clamp01(curve(clamp01(x))));
      p += 12 + nParams * 4;
    } else throw new Error(`Кривая ${type} не поддерживается`);
    p = (p + 3) & ~3;
  }
  return out;
}

/** lutAtoB 'mAB ' / lutBtoA 'mBA ' (ICC v4). */
function readMab(b: Uint8Array, o: number, aToB: boolean): Fn {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const inCh = b[o + 8]!;
  const outCh = b[o + 9]!;
  const [offB, offM, offMC, offCLUT, offA] = [12, 16, 20, 24, 28].map((k) => dv.getUint32(o + k));
  // 3×3 matrix and offset (only between the B and M curves, on the PCS side).
  const matrix = offM
    ? (() => {
        const e = Array.from({ length: 12 }, (_, k) => dv.getInt32(o + offM + k * 4) / 65536);
        return (x: number[]) => [e[0]! * x[0]! + e[1]! * x[1]! + e[2]! * x[2]! + e[9]!, e[3]! * x[0]! + e[4]! * x[1]! + e[5]! * x[2]! + e[10]!, e[6]! * x[0]! + e[7]! * x[1]! + e[8]! * x[2]! + e[11]!].map(clamp01);
      })()
    : null;
  const pcsCh = aToB ? outCh : inCh;
  const devCh = aToB ? inCh : outCh;
  const B = offB ? readCurves(b, o + offB, pcsCh) : null;
  const M = offMC ? readCurves(b, o + offMC, pcsCh) : null;
  const A = offA ? readCurves(b, o + offA, devCh) : null;
  let table: Fn | null = null;
  if (offCLUT) {
    const c = o + offCLUT;
    const gridIn = aToB ? inCh : inCh;
    const grid = Array.from({ length: gridIn }, (_, k) => b[c + k]!);
    const precision = b[c + 16]!;
    const count = grid.reduce((s, x) => s * x, 1) * outCh;
    const data = new Float64Array(count);
    for (let k = 0; k < count; k++) data[k] = precision === 2 ? dv.getUint16(c + 20 + k * 2) / 65535 : b[c + 20 + k]! / 255;
    table = clut(data, grid, outCh);
  }
  const curves = (cs: ((x: number) => number)[] | null, x: number[]) => (cs ? x.map((v, k) => cs[k]!(v)) : x);
  return aToB
    ? (x) => {
        let v = curves(A, x);
        if (table) v = table(v);
        v = curves(M, v);
        if (matrix) v = matrix(v);
        return curves(B, v);
      }
    : (x) => {
        let v = curves(B, x);
        if (matrix) v = matrix(v);
        v = curves(M, v);
        if (table) v = table(v);
        return curves(A, v);
      };
}

/** Tag transform (A2Bn or B2An): values 0…1 in the profile's PCS encoding. */
function lutOf(p: IccProfile, tag: string): { fn: Fn; legacy16: boolean; eight: boolean } | null {
  const t = p.tags.get(tag);
  if (!t) return null;
  const type = sig(p.bytes, t.offset);
  const xyzIn = p.pcs === 'XYZ ' && tag.startsWith('B2A');
  if (type === 'mft2') return { fn: readMft(p.bytes, t.offset, true, xyzIn), legacy16: true, eight: false };
  if (type === 'mft1') return { fn: readMft(p.bytes, t.offset, false, xyzIn), legacy16: false, eight: true };
  if (type === 'mBA ' || type === 'mAB ') return { fn: readMab(p.bytes, t.offset, type === 'mAB '), legacy16: false, eight: false };
  return null;
}

// ---------- Color ----------

const D50 = [0.9642, 1, 0.8249];

/** sRGB (0…1) → XYZ D50 (sRGB matrix with Bradford adaptation). */
export function srgbToXyzD50(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  return [0.4360747 * R + 0.3850649 * G + 0.1430804 * B, 0.2225045 * R + 0.7168786 * G + 0.0606169 * B, 0.0139322 * R + 0.0971045 * G + 0.7141733 * B];
}

export function xyzToLab([x, y, z]: readonly number[]): [number, number, number] {
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x! / D50[0]!), f(y! / D50[1]!), f(z! / D50[2]!)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Lab → PCS values 0…1 in the table's encoding (v2 lut16 — the “legacy” L encoding 0xFF00). */
function encodeLab([L, a, b]: readonly number[], legacy16: boolean): number[] {
  if (legacy16) return [clamp01((L! * 0xff00) / 100 / 65535), clamp01(((a! + 128) * 256) / 65535), clamp01(((b! + 128) * 256) / 65535)];
  return [clamp01(L! / 100), clamp01((a! + 128) / 255), clamp01((b! + 128) / 255)];
}

function decodeLab(v: readonly number[], legacy16: boolean): [number, number, number] {
  if (legacy16) return [(v[0]! * 65535 * 100) / 0xff00, (v[1]! * 65535) / 256 - 128, (v[2]! * 65535) / 256 - 128];
  return [v[0]! * 100, v[1]! * 255 - 128, v[2]! * 255 - 128];
}

/** XYZ → PCS values 0…1 (u1Fixed15: 1.0 = 0x8000). */
const encodeXyz = (xyz: readonly number[]) => xyz.map((c) => clamp01((c * 32768) / 65535));

/**
 * sRGB → CMYK conversion through a print profile (null — the profile has no B2A table for this intent or is not
 * CMYK). Values 0…1.
 */
export function iccCmyk(p: IccProfile, intent: IccIntent = 1): ((r: number, g: number, b: number) => [number, number, number, number]) | null {
  if (p.colorSpace !== 'CMYK') return null;
  const lut = lutOf(p, `B2A${intent}`) ?? lutOf(p, 'B2A0');
  if (!lut) return null;
  return (r, g, b) => {
    const xyz = srgbToXyzD50(r, g, b);
    const pcs = p.pcs === 'XYZ ' ? encodeXyz(xyz) : encodeLab(xyzToLab(xyz), lut.legacy16);
    const out = lut.fn(pcs);
    return [clamp01(out[0]!), clamp01(out[1]!), clamp01(out[2]!), clamp01(out[3]!)];
  };
}

/** Reverse CMYK → Lab conversion through the profile (for tests and swatches). */
export function iccCmykToLab(p: IccProfile, intent: IccIntent = 1): ((cmyk: readonly number[]) => [number, number, number]) | null {
  const lut = lutOf(p, `A2B${intent}`) ?? lutOf(p, 'A2B0');
  if (!lut || p.pcs !== 'Lab ') return null;
  return (cmyk) => decodeLab(lut.fn([...cmyk]), lut.legacy16);
}

/**
 * Approximate conversion without a profile: black from the darkest component (the “naive” way
 * many programs compute it). For print — only as a draft: colors on paper will differ.
 */
export function naiveCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1 - 1e-6) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
}


/**
 * Conversion for images: an n³-node table and trilinear interpolation with no extra per-pixel objects.
 * at — a single color (0…1); pixels — RGBA (8-bit) → CMYK (8-bit, 4 bytes per pixel).
 */
export function cmykTable(fn: (r: number, g: number, b: number) => [number, number, number, number], n = 33): { at(r: number, g: number, b: number): [number, number, number, number]; pixels(rgba: Uint8Array): Uint8Array } {
  const data = new Float32Array(n * n * n * 4);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) data.set(fn(i / (n - 1), j / (n - 1), k / (n - 1)), ((i * n + j) * n + k) * 4);
  const s1 = n * n * 4;
  const s2 = n * 4;
  const idx = new Int32Array(256);
  const fr = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const p = (v / 255) * (n - 1);
    const i = Math.min(n - 2, Math.floor(p));
    idx[v] = i;
    fr[v] = p - i;
  }
  const out4 = new Float32Array(4);
  const interp = (ri: number, rf: number, gi: number, gf: number, bi: number, bf: number) => {
    const o = ri * s1 + gi * s2 + bi * 4;
    for (let c = 0; c < 4; c++) {
      const c000 = data[o + c]!;
      const c001 = data[o + 4 + c]!;
      const c010 = data[o + s2 + c]!;
      const c011 = data[o + s2 + 4 + c]!;
      const c100 = data[o + s1 + c]!;
      const c101 = data[o + s1 + 4 + c]!;
      const c110 = data[o + s1 + s2 + c]!;
      const c111 = data[o + s1 + s2 + 4 + c]!;
      const c00 = c000 + (c001 - c000) * bf;
      const c01 = c010 + (c011 - c010) * bf;
      const c10 = c100 + (c101 - c100) * bf;
      const c11 = c110 + (c111 - c110) * bf;
      const c0 = c00 + (c01 - c00) * gf;
      const c1 = c10 + (c11 - c10) * gf;
      out4[c] = c0 + (c1 - c0) * rf;
    }
  };
  const split = (v: number): [number, number] => {
    const p = clamp01(v) * (n - 1);
    const i = Math.min(n - 2, Math.floor(p));
    return [i, p - i];
  };
  return {
    at(r, g, b) {
      const [ri, rf] = split(r);
      const [gi, gf] = split(g);
      const [bi, bf] = split(b);
      interp(ri, rf, gi, gf, bi, bf);
      return [out4[0]!, out4[1]!, out4[2]!, out4[3]!];
    },
    pixels(rgba) {
      const count = rgba.length >> 2;
      const out = new Uint8Array(count * 4);
      for (let p = 0, q = 0; p < count; p++, q += 4) {
        const r = rgba[q]!;
        const g = rgba[q + 1]!;
        const b = rgba[q + 2]!;
        interp(idx[r]!, fr[r]!, idx[g]!, fr[g]!, idx[b]!, fr[b]!);
        out[q] = Math.round(out4[0]! * 255);
        out[q + 1] = Math.round(out4[1]! * 255);
        out[q + 2] = Math.round(out4[2]! * 255);
        out[q + 3] = Math.round(out4[3]! * 255);
      }
      return out;
    },
  };
}
