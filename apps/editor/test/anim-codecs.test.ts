import { describe, expect, it } from 'vitest';
import { encodeGif } from '../src/gif.ts';
import { parseSvgPath } from '../src/lottie-export.ts';

/** GIF parsing (for checks): palette, frames (LZW), delays, loop. */
function decodeGif(b: Uint8Array) {
  let o = 6;
  const u16 = () => b[o++]! | (b[o++]! << 8);
  const w = u16();
  const h = u16();
  const flags = b[o++]!;
  o += 2;
  const palette: number[][] = [];
  if (flags & 0x80) for (let i = 0; i < 2 << (flags & 7); i++) palette.push([b[o++]!, b[o++]!, b[o++]!]);
  const frames: { indices: Uint8Array; delay: number; transparent: number | null }[] = [];
  let loop = false;
  let gce = { delay: 0, transparent: null as number | null };
  while (o < b.length) {
    const t = b[o++]!;
    if (t === 0x3b) break;
    if (t === 0x21) {
      const label = b[o++]!;
      const blocks: number[] = [];
      for (let n = b[o++]!; n; n = b[o++]!) {
        blocks.push(...b.subarray(o, o + n));
        o += n;
      }
      if (label === 0xf9) gce = { delay: blocks[1]! | (blocks[2]! << 8), transparent: blocks[0]! & 1 ? blocks[3]! : null };
      if (label === 0xff && String.fromCharCode(...blocks.slice(0, 11)) === 'NETSCAPE2.0') loop = true;
      continue;
    }
    // Frame: descriptor, then LZW.
    o += 9;
    const min = b[o++]!;
    const data: number[] = [];
    for (let n = b[o++]!; n; n = b[o++]!) {
      data.push(...b.subarray(o, o + n));
      o += n;
    }
    const clear = 1 << min;
    let size = min + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = [];
      for (let i = 0; i < clear; i++) dict.push([i]);
      dict.push([], []);
      size = min + 1;
    };
    reset();
    const out: number[] = [];
    let bit = 0;
    let prev: number[] | null = null;
    for (;;) {
      let code = 0;
      for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
      if (code === clear) {
        reset();
        prev = null;
        continue;
      }
      if (code === clear + 1) break;
      const entry: number[] = code < dict.length ? dict[code]! : [...prev!, prev![0]!];
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]!]);
      prev = entry;
      if (dict.length === 1 << size && size < 12) size++;
    }
    frames.push({ indices: Uint8Array.from(out), ...gce });
  }
  return { w, h, palette, frames, loop };
}

function frame(w: number, h: number, color: (x: number, y: number) => [number, number, number, number]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(color(x, y), (y * w + x) * 4);
  return rgba;
}

describe('GIF', () => {
  it('frames, palette, delay and loop read back', () => {
    const w = 37;
    const h = 23;
    // A long frame with repeats — the LZW dictionary overflows and resets.
    const a = frame(w, h, (x) => (x < 18 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const b = frame(w, h, (x, y) => ((x + y) % 3 ? [0, 200, 0, 255] : [250, 250, 250, 255]));
    const big = frame(200, 120, (x, y) => [(x * 7) & 255, (y * 5) & 255, ((x ^ y) * 3) & 255, 255]);
    const gif = decodeGif(encodeGif([{ rgba: a, delay: 4 }, { rgba: b, delay: 4 }], w, h, true));
    expect([gif.w, gif.h, gif.loop, gif.frames.length]).toEqual([w, h, true, 2]);
    expect(gif.frames[0]!.delay).toBe(4);
    const color = (f: number, x: number, y: number) => gif.palette[gif.frames[f]!.indices[y * w + x]!]!;
    const near = (c: number[], d: number[]) => c.every((v, i) => Math.abs(v - d[i]!) < 24);
    expect(near(color(0, 2, 2), [255, 0, 0])).toBe(true);
    expect(near(color(0, 30, 20), [0, 0, 255])).toBe(true);
    expect(near(color(1, 1, 0), [0, 200, 0])).toBe(true);
    expect(near(color(1, 0, 0), [250, 250, 250])).toBe(true);
    const g2 = decodeGif(encodeGif([{ rgba: big, delay: 2 }], 200, 120, false));
    expect(g2.loop).toBe(false);
    expect(g2.frames[0]!.indices.length).toBe(200 * 120);
  });

  it('transparency — its own index and frame clearing', () => {
    const rgba = frame(10, 10, (x) => (x < 5 ? [0, 0, 0, 0] : [255, 128, 0, 255]));
    const gif = decodeGif(encodeGif([{ rgba, delay: 10 }], 10, 10, false));
    const f = gif.frames[0]!;
    expect(f.transparent).toBe(255);
    expect(f.indices[0]).toBe(255);
    expect(f.indices[7]).not.toBe(255);
  });
});

describe('SVG paths → Lottie', () => {
  it('lines, curves, relative commands, closing', () => {
    const [p] = parseSvgPath('M10 10 L 30 10 C 40 10 40 30 30 30 l -20 0 z');
    expect(p!.c).toBe(true);
    expect(p!.v).toEqual([[10, 10], [30, 10], [30, 30], [10, 30]]);
    // Curve handles — relative to vertices.
    expect(p!.o[1]).toEqual([10, 0]);
    expect(p!.i[2]).toEqual([10, 0]);
    const two = parseSvgPath('M0 0H10V10Z M20 20 Q 30 20 30 30');
    expect(two.length).toBe(2);
    expect(two[1]!.c).toBe(false);
    expect(two[1]!.o[0]![0]).toBeCloseTo(20 / 3, 3);
  });
});
