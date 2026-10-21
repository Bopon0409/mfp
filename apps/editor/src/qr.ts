// QR code (ISO/IEC 18004, model 2): byte mode, error correction M, versions 1–20 — for a link to the
// prototype presentation on a phone. No dependencies: Reed–Solomon over GF(256), patterns, masks with
// penalties, format and version with BCH.

/** Correction M: [total codewords, EC words per block, [blocks, data] of group 1, [blocks, data] of group 2]. */
const BLOCKS_M: [number, number, [number, number], [number, number]?][] = [
  [26, 10, [1, 16]],
  [44, 16, [1, 28]],
  [70, 26, [1, 44]],
  [100, 18, [2, 32]],
  [134, 24, [2, 43]],
  [172, 16, [4, 27]],
  [196, 18, [4, 31]],
  [242, 22, [2, 38], [2, 39]],
  [292, 22, [3, 36], [2, 37]],
  [346, 26, [4, 43], [1, 44]],
  [404, 30, [1, 50], [4, 51]],
  [466, 22, [6, 36], [2, 37]],
  [532, 22, [8, 37], [1, 38]],
  [581, 24, [4, 40], [5, 41]],
  [655, 24, [5, 41], [5, 42]],
  [733, 28, [7, 45], [3, 46]],
  [815, 28, [10, 46], [1, 47]],
  [901, 26, [9, 43], [4, 44]],
  [991, 26, [3, 44], [11, 45]],
  [1085, 26, [3, 41], [13, 42]],
];

/** Alignment pattern centers by version (from version 2). */
const ALIGN: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
];

// ---------- GF(256), x⁸ + x⁴ + x³ + x² + 1 ----------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

/** Reed–Solomon generator polynomial of degree n (leading coefficient first, omitted). */
function generator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = next[j]! ^ g[j]!;
      next[j + 1] = next[j + 1]! ^ mul(g[j]!, EXP[i]!);
    }
    g = next;
  }
  return g.slice(1);
}

/** EC words of a data block. */
export function reedSolomon(data: number[], n: number): number[] {
  const g = generator(n);
  const rem = new Array<number>(n).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0]!;
    rem.shift();
    rem.push(0);
    for (let i = 0; i < n; i++) rem[i] = rem[i]! ^ mul(g[i]!, factor);
  }
  return rem;
}

/** BCH remainder (for format and version). */
function bch(value: number, poly: number, bits: number): number {
  let v = value << bits;
  const top = 31 - Math.clz32(poly);
  for (let i = 31 - Math.clz32(v); i >= top; i--) if ((v >> i) & 1) v ^= poly << (i - top);
  return v;
}

/** Format word: correction M (00) and the mask, with BCH and mask 0x5412. */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  return ((data << 10) | bch(data, 0x537, 10)) ^ 0x5412;
}

/** QR code matrix of a text (true — dark module). Text that is too long — error. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  // Version — the smallest one that fits.
  let version = 0;
  for (let v = 1; v <= BLOCKS_M.length; v++) {
    const [total, ec, g1, g2] = BLOCKS_M[v - 1]!;
    const dataWords = total - ec * (g1[0] + (g2?.[0] ?? 0));
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataWords * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('Слишком длинный текст для QR-кода');
  const [total, ec, g1, g2] = BLOCKS_M[version - 1]!;
  const dataWords = total - ec * (g1[0] + (g2?.[0] ?? 0));

  // Data stream: “byte” mode, length, bytes, terminator, padding.
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataWords * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let k = 0; words.length < dataWords; k++) words.push(k % 2 ? 0x11 : 0xec);

  // Blocks and EC words; interleaving.
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, size] of [g1, ...(g2 ? [g2] : [])]) {
    for (let i = 0; i < count; i++) {
      blocks.push(words.slice(at, at + size));
      at += size;
    }
  }
  const ecc = blocks.map((b) => reedSolomon(b, ec));
  const stream: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) stream.push(b[i]!);
  for (let i = 0; i < ec; i++) for (const e of ecc) stream.push(e[i]!);

  // Patterns.
  const size = version * 4 + 17;
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, v: boolean) => {
    m[r]![c] = v;
    fn[r]![c] = true;
  };
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const centers = ALIGN[version - 1]!;
  for (const r of centers)
    for (const c of centers) {
      // The three corners with finder patterns — no alignment patterns (on the timing lines — there are).
      if ((r < 9 && c < 9) || (r < 9 && c > size - 10) || (r > size - 10 && c < 9)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  // Dark module and format areas (filled after the mask is chosen).
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!fn[8]![i]) set(8, i, false);
    if (!fn[i]![8]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false);
    set(size - 1 - i, 8, false);
  }
  // Version (from 7): 18 bits in two 6×3 blocks.
  if (version >= 7) {
    const v = (version << 12) | bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const bit = ((v >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // Data: zigzag over column pairs bottom-up and top-down, skipping patterns.
  let bit = 0;
  const dataBits = stream.flatMap((w) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (w >> i) & 1));
  for (let right = size - 1, up = true; right >= 1; right -= 2, up = !up) {
    if (right === 6) right = 5;
    for (let k = 0; k < size; k++) {
      const r = up ? size - 1 - k : k;
      for (const c of [right, right - 1]) {
        if (fn[r]![c]) continue;
        m[r]![c] = (dataBits[bit++] ?? 0) === 1;
      }
    }
  }

  // Mask with the lowest penalty.
  const MASKS: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const withMask = (k: number): boolean[][] => {
    const out = m.map((row, r) => row.map((v, c) => (fn[r]![c] ? !!v : !!v !== MASKS[k]!(r, c))));
    // Format word: next to the top-left finder pattern, and a copy along the edges.
    const f = formatBits(k);
    const bit = (i: number) => ((f >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) out[i]![8] = bit(i);
    out[7]![8] = bit(6);
    out[8]![8] = bit(7);
    out[8]![7] = bit(8);
    for (let i = 9; i < 15; i++) out[8]![14 - i] = bit(i);
    for (let i = 0; i < 8; i++) out[8]![size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) out[size - 15 + i]![8] = bit(i);
    out[size - 8]![8] = true;
    return out;
  };
  const penalty = (g: boolean[][]): number => {
    let p = 0;
    const n = g.length;
    // Five or more in a row of the same color.
    for (let r = 0; r < n; r++)
      for (const line of [g[r]!, g.map((row) => row[r]!)]) {
        let run = 1;
        for (let i = 1; i <= n; i++) {
          if (i < n && line[i] === line[i - 1]) run++;
          else {
            if (run >= 5) p += run - 2;
            run = 1;
          }
        }
      }
    // 2×2 squares.
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (g[r]![c] === g[r]![c + 1] && g[r]![c] === g[r + 1]![c] && g[r]![c] === g[r + 1]![c + 1]) p += 3;
    // Finder-like pattern (1:1:3:1:1 with light margins).
    const pat = [true, false, true, true, true, false, true, false, false, false, false];
    const rev = [...pat].reverse();
    for (let r = 0; r < n; r++)
      for (let c = 0; c + 11 <= n; c++)
        for (const q of [pat, rev]) {
          if (q.every((v, i) => g[r]![c + i] === v)) p += 40;
          if (q.every((v, i) => g[c + i]![r] === v)) p += 40;
        }
    // Share of dark modules.
    let dark = 0;
    for (const row of g) for (const v of row) if (v) dark++;
    p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
    return p;
  };
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const g = withMask(k);
    const score = penalty(g);
    if (score < bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best!;
}

/** QR code as SVG markup (quiet zone — 4 modules). */
export function qrSvg(text: string, px = 200): string {
  const g = qrMatrix(text);
  const n = g.length + 8;
  let d = '';
  g.forEach((row, r) => row.forEach((v, c) => v && (d += `M${c + 4} ${r + 4}h1v1h-1z`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
