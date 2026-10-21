// GIF encoder (GIF89a) for animation export: one shared palette for all frames (median cut over
// sampled pixels), ordered dithering (Bayer 4×4: no flicker between frames), transparency as a
// separate color, looping via the NETSCAPE2.0 extension, LZW compression.

export interface GifFrame {
  /** RGBA pixels (not premultiplied), width × height. */
  rgba: Uint8Array;
  /** Frame duration in hundredths of a second (browsers treat values below 2 as 10). */
  delay: number;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v / 16 - 0.5) * 12);

export function encodeGif(frames: GifFrame[], width: number, height: number, loop: boolean): Uint8Array {
  const transparent = frames.some((f) => hasTransparency(f.rgba));
  const palette = buildPalette(frames, transparent ? 255 : 256);
  // Transparent is the last palette index.
  const tIndex = transparent ? 255 : -1;
  const out = new ByteWriter();
  out.str('GIF89a');
  out.u16(width);
  out.u16(height);
  out.byte(0xf7); // shared palette, 8 bits per channel, 256 colors
  out.byte(0);
  out.byte(0);
  for (let i = 0; i < 256; i++) {
    const c = palette[i] ?? [0, 0, 0];
    out.byte(c[0]);
    out.byte(c[1]);
    out.byte(c[2]);
  }
  if (loop) {
    out.bytes([0x21, 0xff, 0x0b]);
    out.str('NETSCAPE2.0');
    out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
  }
  const nearest = paletteLookup(palette, transparent ? 255 : 256);
  const indices = new Uint8Array(width * height);
  for (const f of frames) {
    for (let y = 0, p = 0; y < height; y++) {
      for (let x = 0; x < width; x++, p++) {
        const o = p * 4;
        if (transparent && f.rgba[o + 3]! < 128) {
          indices[p] = tIndex;
          continue;
        }
        const d = BAYER[(y & 3) * 4 + (x & 3)]!;
        indices[p] = nearest(f.rgba[o]! + d, f.rgba[o + 1]! + d, f.rgba[o + 2]! + d);
      }
    }
    // Graphic control: disposal method (clear for transparent), delay, transparent color.
    out.bytes([0x21, 0xf9, 0x04, ((transparent ? 2 : 1) << 2) | (transparent ? 1 : 0)]);
    out.u16(Math.max(2, Math.round(f.delay)));
    out.byte(transparent ? tIndex : 0);
    out.byte(0);
    out.byte(0x2c);
    out.u16(0);
    out.u16(0);
    out.u16(width);
    out.u16(height);
    out.byte(0);
    lzw(indices, 8, out);
  }
  out.byte(0x3b);
  return out.result();
}

function hasTransparency(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! < 128) return true;
  return false;
}

/** Median cut palette: color boxes are split along their longest channel. */
function buildPalette(frames: GifFrame[], size: number): [number, number, number][] {
  const total = frames.reduce((s, f) => s + f.rgba.length / 4, 0);
  const step = Math.max(1, Math.floor(total / 250_000));
  const samples: number[] = [];
  let k = 0;
  for (const f of frames) {
    for (let i = 0; i < f.rgba.length; i += 4, k++) {
      if (k % step || f.rgba[i + 3]! < 128) continue;
      samples.push((f.rgba[i]! << 16) | (f.rgba[i + 1]! << 8) | f.rgba[i + 2]!);
    }
  }
  if (!samples.length) return [[0, 0, 0]];
  const ch = (c: number, j: number) => (c >> (16 - 8 * j)) & 255;
  type Box = { colors: number[]; range: number; channel: number };
  const box = (colors: number[]): Box => {
    let best = 0;
    let channel = 0;
    for (let j = 0; j < 3; j++) {
      let lo = 255;
      let hi = 0;
      for (const c of colors) {
        const v = ch(c, j);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > best) [best, channel] = [hi - lo, j];
    }
    return { colors, range: best, channel };
  };
  const boxes = [box(samples)];
  while (boxes.length < size) {
    // Split the box with the largest spread (weighted by color count).
    let bi = -1;
    let score = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]!;
      const s = b.range * Math.sqrt(b.colors.length);
      if (b.colors.length > 1 && b.range > 0 && s > score) [bi, score] = [i, s];
    }
    if (bi < 0) break;
    const b = boxes[bi]!;
    b.colors.sort((x, y) => ch(x, b.channel) - ch(y, b.channel));
    const mid = b.colors.length >> 1;
    boxes.splice(bi, 1, box(b.colors.slice(0, mid)), box(b.colors.slice(mid)));
  }
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    for (const c of b.colors) {
      r += ch(c, 0);
      g += ch(c, 1);
      bl += ch(c, 2);
    }
    const n = b.colors.length;
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}

/** Nearest palette color (cached at 6 bits per channel). */
function paletteLookup(palette: [number, number, number][], count: number) {
  const cache = new Int16Array(1 << 18).fill(-1);
  const n = Math.min(count, palette.length);
  return (r: number, g: number, b: number) => {
    const ri = Math.max(0, Math.min(255, r | 0));
    const gi = Math.max(0, Math.min(255, g | 0));
    const bi = Math.max(0, Math.min(255, b | 0));
    const key = ((ri >> 2) << 12) | ((gi >> 2) << 6) | (bi >> 2);
    const hit = cache[key]!;
    if (hit >= 0) return hit;
    let best = 0;
    let dist = Infinity;
    for (let i = 0; i < n; i++) {
      const c = palette[i]!;
      const d = (c[0] - ri) ** 2 * 2 + (c[1] - gi) ** 2 * 4 + (c[2] - bi) ** 2 * 3;
      if (d < dist) [best, dist] = [i, d];
    }
    cache[key] = best;
    return best;
  };
}

/** LZW compression (as in GIF: variable-length codes, clear at 4096), in 255-byte blocks. */
function lzw(indices: Uint8Array, minCodeSize: number, out: ByteWriter) {
  out.byte(minCodeSize);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const dict = new Map<number, number>();
  const block: number[] = [];
  let acc = 0;
  let bits = 0;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      block.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
      if (block.length === 255) {
        out.byte(255);
        out.bytes(block);
        block.length = 0;
      }
    }
  };
  emit(clear);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i]!;
    const key = (prefix << 8) | c;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict.clear();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    }
    prefix = c;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) block.push(acc & 255);
  if (block.length) {
    out.byte(block.length);
    out.bytes(block);
  }
  out.byte(0);
}

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  private n = 0;

  private grow(k: number) {
    if (this.n + k <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }

  byte(v: number) {
    this.grow(1);
    this.buf[this.n++] = v & 255;
  }

  bytes(v: ArrayLike<number>) {
    this.grow(v.length);
    for (let i = 0; i < v.length; i++) this.buf[this.n++] = v[i]! & 255;
  }

  u16(v: number) {
    this.byte(v);
    this.byte(v >> 8);
  }

  str(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}
