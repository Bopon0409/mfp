// AVIF export (our own): the frame is compressed by the browser's AV1 encoder
// (WebCodecs), we build the HEIF/MIAF container ourselves. Color — full-range BT.709, sRGB: at quality
// 95 and above — 4:4:4 (AV1 High profile: text and icon edges without color fringing), below — 4:2:0 (smaller
// file, like WebP); transparency is a separate image (auxl / auxC “alpha”), as in libavif.
// Quality 0–100 — as in avifenc: quantizer = (100 − q) · 63 / 100.

import { Bytes, box, concat, full } from './mp4.ts';

// ---------- OBUs and the AV1 sequence header ----------

export interface Obu {
  type: number;
  /** Whole OBU: header, size, data. */
  start: number;
  end: number;
  /** Data without header and size. */
  payload: number;
}

function leb128(d: Uint8Array, at: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const b = d[at + i]!;
    v += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) return [v, i + 1];
  }
  throw new Error('AV1: длина OBU длиннее 8 байт');
}

/** Frame OBUs (low overhead format: each has a size field). */
export function parseObus(d: Uint8Array): Obu[] {
  const out: Obu[] = [];
  let at = 0;
  while (at < d.length) {
    const h = d[at]!;
    const type = (h >> 3) & 15;
    const ext = (h >> 2) & 1;
    const hasSize = (h >> 1) & 1;
    let p = at + 1 + ext;
    let size: number;
    if (hasSize) {
      const [v, n] = leb128(d, p);
      size = v;
      p += n;
    } else size = d.length - p;
    if (p + size > d.length) throw new Error('AV1: OBU обрезан');
    out.push({ type, start: at, end: p + size, payload: p });
    at = p + size;
  }
  return out;
}

const OBU_SEQUENCE_HEADER = 1;
const OBU_TEMPORAL_DELIMITER = 2;
const OBU_PADDING = 15;

/** AVIF image data: frame OBUs without temporal delimiters and padding (as in an ISO BMFF sample). */
export function imageObus(chunk: Uint8Array): { data: Uint8Array; sequenceHeader: Uint8Array } {
  const obus = parseObus(chunk);
  const keep = obus.filter((o) => o.type !== OBU_TEMPORAL_DELIMITER && o.type !== OBU_PADDING);
  const seq = obus.find((o) => o.type === OBU_SEQUENCE_HEADER);
  if (!seq) throw new Error('AV1: в кадре нет заголовка последовательности');
  return { data: concat(keep.map((o) => chunk.subarray(o.start, o.end))), sequenceHeader: chunk.slice(seq.start, seq.end) };
}

class Bits {
  private pos = 0;
  private d: Uint8Array;
  constructor(d: Uint8Array) {
    this.d = d;
  }
  f(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.d[this.pos >> 3];
      if (byte === undefined) throw new Error('AV1: заголовок последовательности обрезан');
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  uvlc(): number {
    let zeros = 0;
    while (!this.f(1)) zeros++;
    return zeros >= 32 ? 2 ** 32 - 1 : this.f(zeros) + 2 ** zeros - 1;
  }
}

/** Parameters for av1C — from the sequence header (AV1 specification, 5.5). */
export interface Av1Config {
  profile: number;
  level: number;
  tier: number;
  highBitdepth: number;
  twelveBit: number;
  monochrome: number;
  subsamplingX: number;
  subsamplingY: number;
  chromaSamplePosition: number;
  maxWidth: number;
  maxHeight: number;
}

export function parseSequenceHeader(payload: Uint8Array): Av1Config {
  const r = new Bits(payload);
  const profile = r.f(3);
  r.f(1); // still_picture
  const reduced = r.f(1);
  let level = 0;
  let tier = 0;
  if (reduced) level = r.f(5);
  else {
    let decoderModelInfo = 0;
    let bufferDelayLength = 0;
    if (r.f(1)) {
      // timing_info
      r.f(32);
      r.f(32);
      if (r.f(1)) r.uvlc();
      decoderModelInfo = r.f(1);
      if (decoderModelInfo) {
        bufferDelayLength = r.f(5) + 1;
        r.f(32);
        r.f(5);
        r.f(5);
      }
    }
    const initialDisplayDelay = r.f(1);
    const points = r.f(5) + 1;
    for (let i = 0; i < points; i++) {
      r.f(12); // operating_point_idc
      const lvl = r.f(5);
      const t = lvl > 7 ? r.f(1) : 0;
      if (i === 0) [level, tier] = [lvl, t];
      if (decoderModelInfo && r.f(1)) {
        r.f(bufferDelayLength);
        r.f(bufferDelayLength);
        r.f(1);
      }
      if (initialDisplayDelay && r.f(1)) r.f(4);
    }
  }
  const wBits = r.f(4) + 1;
  const hBits = r.f(4) + 1;
  const maxWidth = r.f(wBits) + 1;
  const maxHeight = r.f(hBits) + 1;
  if (!reduced && r.f(1)) {
    // frame_id_numbers_present
    r.f(4);
    r.f(3);
  }
  r.f(1); // use_128x128_superblock
  r.f(1); // enable_filter_intra
  r.f(1); // enable_intra_edge_filter
  if (!reduced) {
    r.f(1); // interintra_compound
    r.f(1); // masked_compound
    r.f(1); // warped_motion
    r.f(1); // dual_filter
    const orderHint = r.f(1);
    if (orderHint) {
      r.f(1); // jnt_comp
      r.f(1); // ref_frame_mvs
    }
    const chooseSct = r.f(1);
    const forceSct = chooseSct ? 2 : r.f(1);
    if (forceSct > 0 && !r.f(1)) r.f(1); // choose_integer_mv / force_integer_mv
    if (orderHint) r.f(3);
  }
  r.f(1); // superres
  r.f(1); // cdef
  r.f(1); // restoration
  // color_config
  const highBitdepth = r.f(1);
  const twelveBit = profile === 2 && highBitdepth ? r.f(1) : 0;
  const monochrome = profile === 1 ? 0 : r.f(1);
  let [cp, tc, mc] = [2, 2, 2];
  if (r.f(1)) [cp, tc, mc] = [r.f(8), r.f(8), r.f(8)];
  let [sx, sy, csp] = [1, 1, 0];
  if (monochrome) r.f(1);
  else if (cp === 1 && tc === 13 && mc === 0) [sx, sy] = [0, 0];
  else {
    r.f(1); // color_range
    if (profile === 0) [sx, sy] = [1, 1];
    else if (profile === 1) [sx, sy] = [0, 0];
    else if (twelveBit) {
      sx = r.f(1);
      sy = sx ? r.f(1) : 0;
    } else [sx, sy] = [1, 0];
    if (sx && sy) csp = r.f(2);
  }
  return { profile, level, tier, highBitdepth, twelveBit, monochrome, subsamplingX: sx, subsamplingY: sy, chromaSamplePosition: csp, maxWidth, maxHeight };
}

/** av1C box: 4 bytes of parameters and the sequence header itself. */
export function av1C(sequenceHeaderObu: Uint8Array): Uint8Array {
  const [obu] = parseObus(sequenceHeaderObu);
  if (!obu || obu.type !== OBU_SEQUENCE_HEADER) throw new Error('AV1: ожидался заголовок последовательности');
  const c = parseSequenceHeader(sequenceHeaderObu.subarray(obu.payload, obu.end));
  const head = new Bytes()
    .u8(0x81)
    .u8((c.profile << 5) | c.level)
    .u8((c.tier << 7) | (c.highBitdepth << 6) | (c.twelveBit << 5) | (c.monochrome << 4) | (c.subsamplingX << 3) | (c.subsamplingY << 2) | c.chromaSamplePosition)
    .u8(0)
    .done();
  return box('av1C', head, sequenceHeaderObu);
}

// ---------- Container ----------

export interface AvifImage {
  /** Image OBUs (without temporal delimiters). */
  data: Uint8Array;
  /** Sequence header (whole OBU) — for av1C. */
  sequenceHeader: Uint8Array;
}

/** AVIF file: image 1 — color, 2 — transparency (auxl). */
export function muxAvif(width: number, height: number, color: AvifImage, alpha?: AvifImage | null): Uint8Array {
  const ftyp = box('ftyp', new Bytes().str('avif').u32(0).str('avif').str('mif1').str('miaf').done());
  const ispe = full('ispe', 0, 0, new Bytes().u32(width).u32(height).done());
  const pixi = (n: number) => full('pixi', 0, 0, new Bytes().u8(n).zeros(0).done(), Uint8Array.from(Array(n).fill(8)));
  // sRGB: BT.709 primaries, sRGB transfer (13), BT.709 matrix, full range.
  const colr = box('colr', new Bytes().str('nclx').u16(1).u16(13).u16(1).u8(0x80).done());
  const auxC = full('auxC', 0, 0, new Bytes().str('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha').u8(0).done());
  const meta = (colorAt: number, alphaAt: number) => {
    const hdlr = full('hdlr', 0, 0, new Bytes().u32(0).str('pict').zeros(12).u8(0).done());
    const pitm = full('pitm', 0, 0, new Bytes().u16(1).done());
    // iloc v0: offset and length — 4 bytes each, no base offset.
    const loc = new Bytes().u8(0x44).u8(0).u16(alpha ? 2 : 1);
    loc.u16(1).u16(0).u16(1).u32(colorAt).u32(color.data.length);
    if (alpha) loc.u16(2).u16(0).u16(1).u32(alphaAt).u32(alpha.data.length);
    const iloc = full('iloc', 0, 0, loc.done());
    const infe = (id: number, name: string) => full('infe', 2, 0, new Bytes().u16(id).u16(0).str('av01').str(name).u8(0).done());
    const iinf = full('iinf', 0, 0, new Bytes().u16(alpha ? 2 : 1).done(), infe(1, 'Color'), ...(alpha ? [infe(2, 'Alpha')] : []));
    const iref = alpha ? [full('iref', 0, 0, box('auxl', new Bytes().u16(2).u16(1).u16(1).done()))] : [];
    // Properties (numbered from 1): ispe, pixi 3, color av1C, colr; for transparency — pixi 1, av1C, auxC.
    const props = [ispe, pixi(3), av1C(color.sequenceHeader), colr, ...(alpha ? [pixi(1), av1C(alpha.sequenceHeader), auxC] : [])];
    const assoc = new Bytes().u32(alpha ? 2 : 1);
    assoc.u16(1).u8(4).u8(1).u8(2).u8(0x80 | 3).u8(4);
    if (alpha) assoc.u16(2).u8(4).u8(1).u8(5).u8(0x80 | 6).u8(0x80 | 7);
    const iprp = box('iprp', box('ipco', ...props), full('ipma', 0, 0, assoc.done()));
    return full('meta', 0, 0, hdlr, pitm, iloc, iinf, ...iref, iprp);
  };
  // Offsets are from the start of the file; the meta length doesn't depend on them (fixed-length fields).
  const at = ftyp.length + meta(0, 0).length + 8;
  return concat([ftyp, meta(at, at + color.data.length), box('mdat', color.data, ...(alpha ? [alpha.data] : []))]);
}

// ---------- Pixels → YUV ----------

/** RGBA (non-premultiplied) → Y, U, V planes 4:4:4, BT.709, full range. */
export function yuv444(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i] = Math.round(y);
    out[n + i] = Math.max(0, Math.min(255, Math.round((b - y) / 1.8556 + 128)));
    out[2 * n + i] = Math.max(0, Math.min(255, Math.round((r - y) / 1.5748 + 128)));
  }
  return out;
}

/** RGBA → I420 (4:2:0): luma of every pixel, chroma — average over a 2×2 square (at the edge — whatever exists). */
export function yuv420(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  const out = new Uint8Array(n + 2 * cw * ch);
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
    ys[i] = y;
    out[i] = Math.round(y);
  }
  for (let cy = 0; cy < ch; cy++)
    for (let cx = 0; cx < cw; cx++) {
      let u = 0;
      let v = 0;
      let k = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const x = cx * 2 + dx;
          const y = cy * 2 + dy;
          if (x >= w || y >= h) continue;
          const i = y * w + x;
          u += (rgba[i * 4 + 2]! - ys[i]!) / 1.8556;
          v += (rgba[i * 4]! - ys[i]!) / 1.5748;
          k++;
        }
      out[n + cy * cw + cx] = Math.max(0, Math.min(255, Math.round(u / k + 128)));
      out[n + cw * ch + cy * cw + cx] = Math.max(0, Math.min(255, Math.round(v / k + 128)));
    }
  return out;
}

/** Transparency → I420: luma — alpha, chroma — neutral. null — the image is opaque. */
export function alphaI420(rgba: Uint8Array, w: number, h: number): Uint8Array | null {
  const n = w * h;
  let opaque = true;
  for (let i = 0; i < n; i++)
    if (rgba[i * 4 + 3]! < 255) {
      opaque = false;
      break;
    }
  if (opaque) return null;
  const c = Math.ceil(w / 2) * Math.ceil(h / 2);
  const out = new Uint8Array(n + 2 * c).fill(128, n);
  for (let i = 0; i < n; i++) out[i] = rgba[i * 4 + 3]!;
  return out;
}

/** Quality 0–100 → AV1 quantizer 0–63 (as in avifenc). */
export const avifQuantizer = (quality: number) => Math.max(0, Math.min(63, Math.round(((100 - quality) * 63) / 100)));

/** AV1 level by area (2.0 … 6.0; larger — “unconstrained”). */
function level(w: number, h: number): string {
  const area = w * h;
  const idx = area <= 147456 ? 0 : area <= 665856 ? 4 : area <= 2359296 ? 8 : area <= 8912896 ? 12 : area <= 35651584 ? 16 : 31;
  return String(idx).padStart(2, '0');
}

const SRGB_FULL: VideoColorSpaceInit = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true };

async function encodeFrame(codec: string, format: VideoPixelFormat, data: Uint8Array, w: number, h: number, quantizer: number): Promise<AvifImage> {
  let out: Uint8Array | null = null;
  let failed: unknown = null;
  const enc = new VideoEncoder({
    output: (chunk) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      out = d;
    },
    error: (e) => (failed = e),
  });
  enc.configure({ codec, width: w, height: h, bitrateMode: 'quantizer', latencyMode: 'quality' } as VideoEncoderConfig);
  const frame = new VideoFrame(data, { format, codedWidth: w, codedHeight: h, timestamp: 0, colorSpace: SRGB_FULL });
  try {
    enc.encode(frame, { keyFrame: true, av1: { quantizer } } as VideoEncoderEncodeOptions);
  } finally {
    frame.close();
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  if (!out) throw new Error('AVIF: кодировщик не выдал кадр');
  return imageObus(out);
}

/** Whether an AV1 encoder is available (WebCodecs; the page is in a secure context). */
export const avifSupported = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

/** RGBA (non-premultiplied) → AVIF file. quality — 0–100 (100 — nearly lossless). */
export async function encodeAvif(rgba: Uint8Array, w: number, h: number, quality = 80, chroma: '444' | '420' = quality >= 95 ? '444' : '420'): Promise<Uint8Array> {
  if (!avifSupported()) throw new Error('AVIF: здесь нет кодировщика AV1 (WebCodecs)');
  const lv = level(w, h);
  const color = chroma === '444' ? await encodeFrame(`av01.1.${lv}M.08`, 'I444', yuv444(rgba, w, h), w, h, avifQuantizer(quality)) : await encodeFrame(`av01.0.${lv}M.08`, 'I420', yuv420(rgba, w, h), w, h, avifQuantizer(quality));
  const a = alphaI420(rgba, w, h);
  // Transparency — nearly lossless: errors at the edges are more visible than in color.
  const alpha = a ? await encodeFrame(`av01.0.${lv}M.08`, 'I420', a, w, h, avifQuantizer(Math.max(quality, 92))) : null;
  return muxAvif(w, h, color, alpha);
}
