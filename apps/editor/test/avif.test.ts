import { describe, expect, it } from 'vitest';
import { alphaI420, av1C, avifQuantizer, imageObus, muxAvif, parseObus, parseSequenceHeader, yuv420, yuv444 } from '../src/avif.ts';

// Sequence headers produced by Edge's AV1 encoder (WebCodecs) for a 33×17 frame:
// profile 1 (I444) and profile 0 (I420), BT.709 / sRGB, full range.
const SEQ_444 = Uint8Array.from([10, 12, 32, 0, 0, 2, 164, 16, 0, 105, 1, 13, 1, 144]);
const SEQ_420 = Uint8Array.from([10, 12, 0, 0, 0, 2, 164, 16, 0, 104, 128, 134, 128, 194]);
const TD = Uint8Array.from([0x12, 0x00]);
const FRAME = Uint8Array.from([0x32, 0x03, 1, 2, 3]);
const cat = (...a: Uint8Array[]) => Uint8Array.from(a.flatMap((x) => [...x]));

/** Top-level ISO BMFF boxes (or inside data): type, data start, end. */
function boxes(d: Uint8Array, from = 0, to = d.length): { type: string; start: number; end: number }[] {
  const out = [];
  let at = from;
  while (at < to) {
    const size = ((d[at]! << 24) >>> 0) + (d[at + 1]! << 16) + (d[at + 2]! << 8) + d[at + 3]!;
    out.push({ type: String.fromCharCode(...d.subarray(at + 4, at + 8)), start: at + 8, end: at + size });
    at += size;
  }
  return out;
}
const u32 = (d: Uint8Array, at: number) => ((d[at]! << 24) >>> 0) + (d[at + 1]! << 16) + (d[at + 2]! << 8) + d[at + 3]!;
const u16 = (d: Uint8Array, at: number) => (d[at]! << 8) + d[at + 1]!;

describe('AVIF', () => {
  it('AV1 sequence header: profile, size, chroma subsampling', () => {
    const a = parseSequenceHeader(SEQ_444.subarray(2));
    expect(a).toMatchObject({ profile: 1, maxWidth: 33, maxHeight: 17, subsamplingX: 0, subsamplingY: 0, highBitdepth: 0, monochrome: 0 });
    const b = parseSequenceHeader(SEQ_420.subarray(2));
    expect(b).toMatchObject({ profile: 0, maxWidth: 33, maxHeight: 17, subsamplingX: 1, subsamplingY: 1, chromaSamplePosition: 0 });
  });

  it('frame OBUs: temporal delimiter removed, sequence header found', () => {
    const chunk = cat(TD, SEQ_444, FRAME);
    expect(parseObus(chunk).map((o) => o.type)).toEqual([2, 1, 6]);
    const img = imageObus(chunk);
    expect([...img.data]).toEqual([...SEQ_444, ...FRAME]);
    expect([...img.sequenceHeader]).toEqual([...SEQ_444]);
  });

  it('av1C: parameters from the header and the header itself', () => {
    const c = av1C(SEQ_444);
    expect(String.fromCharCode(...c.subarray(4, 8))).toBe('av1C');
    expect([...c.subarray(8, 12)]).toEqual([0x81, 1 << 5, 0, 0]);
    expect([...c.subarray(12)]).toEqual([...SEQ_444]);
    expect(av1C(SEQ_420)[10]).toBe(0b00001100);
  });

  it('container: iloc offsets point to the color and alpha data in mdat', () => {
    const color = { data: cat(SEQ_444, FRAME), sequenceHeader: SEQ_444 };
    const alpha = { data: cat(SEQ_420, FRAME, FRAME), sequenceHeader: SEQ_420 };
    const file = muxAvif(33, 17, color, alpha);
    const top = boxes(file);
    expect(top.map((b) => b.type)).toEqual(['ftyp', 'meta', 'mdat']);
    expect(String.fromCharCode(...file.subarray(8, 12))).toBe('avif');
    const meta = top[1]!;
    const inner = boxes(file, meta.start + 4, meta.end);
    expect(inner.map((b) => b.type)).toEqual(['hdlr', 'pitm', 'iloc', 'iinf', 'iref', 'iprp']);
    const iloc = inner.find((b) => b.type === 'iloc')!;
    const items = u16(file, iloc.start + 6);
    expect(items).toBe(2);
    const read = (i: number) => {
      const at = iloc.start + 8 + i * 14;
      return { id: u16(file, at), offset: u32(file, at + 6), length: u32(file, at + 10) };
    };
    const c = read(0);
    const a = read(1);
    expect([...file.subarray(c.offset, c.offset + c.length)]).toEqual([...color.data]);
    expect([...file.subarray(a.offset, a.offset + a.length)]).toEqual([...alpha.data]);
    // Alpha — an auxiliary image for the color one (auxl 2 → 1).
    const iref = inner.find((b) => b.type === 'iref')!;
    const auxl = boxes(file, iref.start + 4, iref.end)[0]!;
    expect(auxl.type).toBe('auxl');
    expect([u16(file, auxl.start), u16(file, auxl.start + 2), u16(file, auxl.start + 4)]).toEqual([2, 1, 1]);
    // Properties: ispe with the size, colr nclx sRGB full range, auxC “alpha”.
    const iprp = inner.find((b) => b.type === 'iprp')!;
    const ipco = boxes(file, iprp.start, iprp.end)[0]!;
    const props = boxes(file, ipco.start, ipco.end);
    expect(props.map((p) => p.type)).toEqual(['ispe', 'pixi', 'av1C', 'colr', 'pixi', 'av1C', 'auxC']);
    expect([u32(file, props[0]!.start + 4), u32(file, props[0]!.start + 8)]).toEqual([33, 17]);
    expect([...file.subarray(props[3]!.start, props[3]!.end)]).toEqual([110, 99, 108, 120, 0, 1, 0, 13, 0, 1, 0x80]);
    expect(new TextDecoder().decode(file.subarray(props[6]!.start + 4, props[6]!.end - 1))).toBe('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha');
    // Without alpha — a single image.
    expect(boxes(muxAvif(33, 17, color)).length).toBe(3);
  });

  it('pixels: full-range YUV BT.709, alpha as a separate plane', () => {
    const px = Uint8Array.from([255, 255, 255, 255, 255, 0, 0, 255, 0, 0, 0, 128]);
    const y = yuv444(px, 3, 1);
    expect([y[0], y[3], y[6]]).toEqual([255, 128, 128]);
    expect(y[1]).toBe(54);
    expect(y[1 + 6]).toBe(255);
    const a = alphaI420(px, 3, 1)!;
    expect([...a.subarray(0, 3)]).toEqual([255, 255, 128]);
    expect([...a.subarray(3)]).toEqual([128, 128, 128, 128]);
    expect(alphaI420(Uint8Array.from([1, 2, 3, 255]), 1, 1)).toBeNull();
  });

  it('4:2:0: color is the average over a 2×2 square, at an odd edge — over what is available', () => {
    // 3×1: red, red | blue.
    const px = Uint8Array.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
    const y = yuv420(px, 3, 1);
    expect(y.length).toBe(3 + 2 * 2);
    const full = yuv444(px, 3, 1);
    expect([...y.subarray(0, 3)]).toEqual([...full.subarray(0, 3)]);
    // U of the first square — like red, of the second — like blue.
    expect(y[3]).toBe(full[3]);
    expect(y[4]).toBe(full[5]);
    expect(y[5]).toBe(full[6]);
    expect(y[6]).toBe(full[8]);
  });

  it('quality → quantizer, as in avifenc', () => {
    expect([avifQuantizer(100), avifQuantizer(80), avifQuantizer(50), avifQuantizer(0)]).toEqual([0, 13, 32, 63]);
  });
});
