// Image vectorization:
// 1. Colors: k-means in OKLab (initial centers via k-means++ with a fixed seed, so the result
//    is reproducible); exact colors if there are no more than k of them.
// 2. Blobs smaller than minArea merge with their most frequent neighbor; anti-aliasing fringes (thin
//    regions of a color that mixes two others) dissolve into those two; the background (the most common
//    color along the image edge that touches the edge) is optionally removed.
// 3. Region boundaries are traced along pixel edges (filled side on the right); stairs are smoothed via
//    edge midpoints; real corners (two long edges) stay corners.
// 4. Curves: fitCurve (Schneider) with breaks at corners (cornerIndices).
// Layers are “Overlay” by default: colors from bottom to top by decreasing area, the lower shape includes
// the regions of the upper ones, so there are no gaps between colors. “Adjacent”: each color only its own shape.

import { cornerIndices, fitCurve, type CurvePoint } from './fit-curve.ts';

export interface VectorizeOptions {
  /** Number of colors (2–24). */
  colors: number;
  /** Detail 0…1: 0 — smooth and coarse, 1 — precise, with small details. */
  detail: number;
  /** Remove background: the most common color along the image edge (its regions touching the edge). */
  removeBackground?: boolean;
  /** Layers overlaid without gaps (default) or adjacent. */
  stacked?: boolean;
}

export interface VectorLayer {
  /** Layer color (0…1). */
  color: { r: number; g: number; b: number };
  /** SVG path in image pixels (M, L, C, Z); fill rule is even-odd. */
  d: string;
  /** Number of pixels of this color. */
  area: number;
}

const NONE = 255;

/** Vectorize an rgba image (w × h): layers from bottom to top. */
export function vectorize(rgba: ArrayLike<number>, w: number, h: number, opts: VectorizeOptions): VectorLayer[] {
  const k = Math.max(2, Math.min(24, Math.round(opts.colors)));
  const detail = Math.max(0, Math.min(1, opts.detail));
  const { labels, palette } = quantize(rgba, w, h, k);
  if (!palette.length) return [];
  const minArea = Math.max(2, Math.round((1 - detail) ** 2 * 0.002 * w * h));
  despeckle(labels, w, h, minArea);
  dissolveFringes(rgba, labels, palette, w, h);
  despeckle(labels, w, h, minArea);
  if (opts.removeBackground) removeBackground(labels, w, h);
  const area: number[] = palette.map(() => 0);
  for (let i = 0; i < labels.length; i++) if (labels[i] !== NONE) area[labels[i]!]!++;
  const order = palette.map((_, i) => i).filter((i) => area[i]! > 0).sort((a, b) => area[b]! - area[a]!);
  const rank = new Uint8Array(palette.length).fill(NONE);
  order.forEach((l, r) => (rank[l] = r));
  const stacked = opts.stacked !== false;
  const mask = new Uint8Array(w * h);
  const out: VectorLayer[] = [];
  order.forEach((l, r) => {
    for (let i = 0; i < mask.length; i++) {
      const x = labels[i]!;
      mask[i] = x !== NONE && (stacked ? rank[x]! >= r : x === l) ? 1 : 0;
    }
    const d = traceMask(mask, w, h)
      .map((loop) => loopPath(loop, detail))
      .join('');
    if (d) out.push({ color: palette[l]!, d, area: area[l]! });
  });
  return out;
}

// ---------- Colors ----------

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0…255) → OKLab. */
function oklab(r: number, g: number, b: number): [number, number, number] {
  const lr = LINEAR[r]!;
  const lg = LINEAR[g]!;
  const lb = LINEAR[b]!;
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** Deterministic generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Image colors: color index per pixel (NONE — transparent) and the palette (0…1). */
export function quantize(rgba: ArrayLike<number>, w: number, h: number, k: number): { labels: Uint8Array; palette: { r: number; g: number; b: number }[] } {
  const n = w * h;
  const labels = new Uint8Array(n).fill(NONE);
  // Pixel colors are converted once per distinct color.
  const index = new Map<number, number>();
  const lab: number[] = [];
  const rgb: number[] = [];
  const colorOf = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3]! < 128) continue;
    const key = (rgba[i * 4]! << 16) | (rgba[i * 4 + 1]! << 8) | rgba[i * 4 + 2]!;
    let c = index.get(key);
    if (c === undefined) {
      c = lab.length / 3;
      index.set(key, c);
      lab.push(...oklab(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!));
      rgb.push(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!);
    }
    colorOf[i] = c;
  }
  const colors = lab.length / 3;
  if (!colors) return { labels, palette: [] };
  // Pixel count per color is its weight in k-means.
  const weight = new Float64Array(colors);
  for (let i = 0; i < n; i++) if (colorOf[i]! >= 0) weight[colorOf[i]!]!++;
  let centers: number[][];
  if (colors <= k) centers = Array.from({ length: colors }, (_, c) => [lab[c * 3]!, lab[c * 3 + 1]!, lab[c * 3 + 2]!]);
  else {
    // Color sample for k-means (the most frequent ones are always included).
    const all = Array.from({ length: colors }, (_, c) => c);
    const sample = colors > 6000 ? all.sort((a, b) => weight[b]! - weight[a]!).slice(0, 6000) : all;
    const d2 = (c: number, p: number[]) => {
      const x = lab[c * 3]! - p[0]!;
      const y = lab[c * 3 + 1]! - p[1]!;
      const z = lab[c * 3 + 2]! - p[2]!;
      return x * x + y * y + z * z;
    };
    const rnd = random(7);
    // k-means++: the first is the most frequent color, the next ones with probability proportional to squared distance × weight.
    const first = sample.reduce((a, b) => (weight[b]! > weight[a]! ? b : a), sample[0]!);
    centers = [[lab[first * 3]!, lab[first * 3 + 1]!, lab[first * 3 + 2]!]];
    const best = new Float64Array(sample.length).fill(Infinity);
    while (centers.length < k) {
      const c = centers[centers.length - 1]!;
      let sum = 0;
      for (let j = 0; j < sample.length; j++) {
        best[j] = Math.min(best[j]!, d2(sample[j]!, c));
        sum += best[j]! * weight[sample[j]!]!;
      }
      if (sum <= 1e-12) break;
      let t = rnd() * sum;
      let pick = sample[sample.length - 1]!;
      for (let j = 0; j < sample.length; j++) {
        t -= best[j]! * weight[sample[j]!]!;
        if (t <= 0) {
          pick = sample[j]!;
          break;
        }
      }
      centers.push([lab[pick * 3]!, lab[pick * 3 + 1]!, lab[pick * 3 + 2]!]);
    }
    // Lloyd iterations over the weighted sample.
    for (let it = 0; it < 16; it++) {
      const sums = centers.map(() => [0, 0, 0, 0]);
      for (const c of sample) {
        const j = nearest(lab, c, centers);
        const s = sums[j]!;
        const wgt = weight[c]!;
        s[0]! += lab[c * 3]! * wgt;
        s[1]! += lab[c * 3 + 1]! * wgt;
        s[2]! += lab[c * 3 + 2]! * wgt;
        s[3]! += wgt;
      }
      let moved = 0;
      centers = centers.map((p, j) => {
        const s = sums[j]!;
        if (!s[3]) return p;
        const q = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
        moved = Math.max(moved, Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!));
        return q;
      });
      if (moved < 1e-4) break;
    }
  }
  // Each color gets the nearest center; the center color is the mean of its pixels (in sRGB).
  const of = new Int32Array(colors);
  for (let c = 0; c < colors; c++) of[c] = colors <= k ? c : nearest(lab, c, centers);
  const sum = centers.map(() => [0, 0, 0, 0]);
  for (let c = 0; c < colors; c++) {
    const s = sum[of[c]!]!;
    const wgt = weight[c]!;
    s[0]! += rgb[c * 3]! * wgt;
    s[1]! += rgb[c * 3 + 1]! * wgt;
    s[2]! += rgb[c * 3 + 2]! * wgt;
    s[3]! += wgt;
  }
  // Drop empty centers, renumber sequentially.
  const remap = new Int32Array(centers.length).fill(-1);
  const palette: { r: number; g: number; b: number }[] = [];
  sum.forEach((s, j) => {
    if (!s[3]) return;
    remap[j] = palette.length;
    palette.push({ r: s[0]! / s[3]! / 255, g: s[1]! / s[3]! / 255, b: s[2]! / s[3]! / 255 });
  });
  for (let i = 0; i < n; i++) if (colorOf[i]! >= 0) labels[i] = remap[of[colorOf[i]!]!]!;
  return { labels, palette };
}

function nearest(lab: number[], c: number, centers: number[][]): number {
  let best = 0;
  let bd = Infinity;
  for (let j = 0; j < centers.length; j++) {
    const p = centers[j]!;
    const x = lab[c * 3]! - p[0]!;
    const y = lab[c * 3 + 1]! - p[1]!;
    const z = lab[c * 3 + 2]! - p[2]!;
    const d = x * x + y * y + z * z;
    if (d < bd) {
      bd = d;
      best = j;
    }
  }
  return best;
}

// ---------- Blobs and background ----------

/**
 * Anti-aliasing fringes: the color is almost a mix of two other palette colors and the region is thin
 * (more than half of its pixels lie on a boundary). Such pixels get whichever of the two colors is
 * closer to their actual color, so thin strips along shape edges do not become separate layers.
 */
export function dissolveFringes(rgba: ArrayLike<number>, labels: Uint8Array, palette: { r: number; g: number; b: number }[], w: number, h: number) {
  const k = palette.length;
  if (k < 3) return;
  const area = new Float64Array(k);
  const edge = new Float64Array(k);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    if (l === NONE) continue;
    area[l]!++;
    const x = i % w;
    const y = (i - x) / w;
    if ((x > 0 && labels[i - 1] !== l) || (x < w - 1 && labels[i + 1] !== l) || (y > 0 && labels[i - w] !== l) || (y < h - 1 && labels[i + w] !== l)) edge[l]!++;
  }
  const col = palette.map((c) => [c.r, c.g, c.b]);
  /** The two “parent” paints whose mix produces color l (or null). */
  const parents = (l: number, skip: ReadonlySet<number>): [number, number] | null => {
    let best: [number, number] | null = null;
    let bestD = 0.06;
    for (let i = 0; i < k; i++)
      for (let j = i + 1; j < k; j++) {
        if (i === l || j === l || !area[i] || !area[j] || skip.has(i) || skip.has(j)) continue;
        const a = col[i]!;
        const b = col[j]!;
        const c = col[l]!;
        const ab = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
        const len2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2;
        if (len2 < 1e-6) continue;
        const t = ((c[0]! - a[0]!) * ab[0]! + (c[1]! - a[1]!) * ab[1]! + (c[2]! - a[2]!) * ab[2]!) / len2;
        if (t < 0.08 || t > 0.92) continue;
        const d = Math.hypot(a[0]! + ab[0]! * t - c[0]!, a[1]! + ab[1]! * t - c[1]!, a[2]! + ab[2]! * t - c[2]!);
        if (d < bestD) {
          bestD = d;
          best = [i, j];
        }
      }
    return best;
  };
  // Candidates are thin mixes; parents come from the other colors (a fringe does not dissolve into a fringe).
  const fringe = new Set<number>();
  for (let l = 0; l < k; l++) if (area[l] && edge[l]! / area[l]! >= 0.5 && parents(l, new Set())) fringe.add(l);
  const into = new Map<number, [number, number]>();
  for (const l of fringe) {
    const p = parents(l, fringe);
    if (p) into.set(l, p);
  }
  if (!into.size) return;
  for (let i = 0; i < labels.length; i++) {
    const p = into.get(labels[i]!);
    if (!p) continue;
    const r = rgba[i * 4]! / 255;
    const g = rgba[i * 4 + 1]! / 255;
    const b = rgba[i * 4 + 2]! / 255;
    const d = (c: number[]) => (c[0]! - r) ** 2 + (c[1]! - g) ** 2 + (c[2]! - b) ** 2;
    labels[i] = d(col[p[0]]!) <= d(col[p[1]]!) ? p[0] : p[1];
  }
}

/** Regions (4-connectivity) smaller than minArea take the color of the most frequent neighbor (transparent holes too). */
export function despeckle(labels: Uint8Array, w: number, h: number, minArea: number) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const members = new Int32Array(n);
  const counts = new Map<number, number>();
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const lab = labels[s]!;
    let size = 0;
    const visit = (j: number) => {
      if (seen[j] || labels[j] !== lab) return;
      seen[j] = 1;
      members[size++] = j;
    };
    visit(s);
    for (let q = 0; q < size; q++) {
      const i = members[q]!;
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    if (size >= minArea) continue;
    counts.clear();
    let edge = false;
    for (let q = 0; q < size; q++) {
      const i = members[q]!;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || labels[j] === lab) continue;
        counts.set(labels[j]!, (counts.get(labels[j]!) ?? 0) + 1);
      }
    }
    // Transparency at the image edge is background, not a hole: do not fill it.
    if (lab === NONE && edge) continue;
    let to = -1;
    let most = 0;
    for (const [l, c] of counts) {
      if (c <= most) continue;
      most = c;
      to = l;
    }
    if (to < 0) continue;
    for (let q = 0; q < size; q++) labels[members[q]!] = to;
  }
}

/** Background: the most common edge color (at least a third of the edge); its regions touching the edge become transparent. */
export function removeBackground(labels: Uint8Array, w: number, h: number) {
  const counts = new Map<number, number>();
  let total = 0;
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  for (const i of border) {
    total++;
    if (labels[i] !== NONE) counts.set(labels[i]!, (counts.get(labels[i]!) ?? 0) + 1);
  }
  let bg = -1;
  let most = 0;
  for (const [l, c] of counts) {
    if (c <= most) continue;
    most = c;
    bg = l;
  }
  if (bg < 0 || most < total / 3) return;
  const stack: number[] = border.filter((i) => labels[i] === bg);
  for (const i of stack) labels[i] = NONE;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || labels[j] !== bg) continue;
      labels[j] = NONE;
      stack.push(j);
    }
  }
}

// ---------- Paths ----------

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * Mask boundaries along pixel edges: closed loops of grid vertices (x, y pairs), filled side on the right
 * in travel direction (outer loops clockwise with the y axis pointing down, holes counterclockwise). At a
 * “saddle” (two pixels touching at a corner) turn right: such pixels belong to different regions.
 */
export function traceMask(mask: Uint8Array, w: number, h: number): number[][] {
  const W1 = w + 1;
  const first = new Int8Array(W1 * (h + 1)).fill(-1);
  const second = new Int8Array(W1 * (h + 1)).fill(-1);
  const add = (x: number, y: number, dir: number) => {
    const v = y * W1 + x;
    if (first[v]! < 0) first[v] = dir;
    else second[v] = dir;
  };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!inside(x, y - 1)) add(x, y, 0);
      if (!inside(x + 1, y)) add(x + 1, y, 1);
      if (!inside(x, y + 1)) add(x + 1, y + 1, 2);
      if (!inside(x - 1, y)) add(x, y + 1, 3);
    }
  /** Take an outgoing edge of a vertex: after entering via in, try right first, then left. */
  const take = (v: number, incoming: number): number => {
    const a = first[v]!;
    const b = second[v]!;
    let pick = a;
    if (b >= 0 && incoming >= 0 && b === (incoming + 1) % 4) pick = b;
    else if (a < 0) pick = b;
    if (pick === a) {
      first[v] = b;
      second[v] = -1;
    } else second[v] = -1;
    return pick;
  };
  const loops: number[][] = [];
  for (let v0 = 0; v0 < first.length; v0++) {
    while (first[v0]! >= 0) {
      const loop: number[] = [];
      let x = v0 % W1;
      let y = (v0 - x) / W1;
      let dir = take(v0, -1);
      for (let guard = 0; guard < 4 * (w + 1) * (h + 1); guard++) {
        loop.push(x, y);
        x += DX[dir]!;
        y += DY[dir]!;
        const v = y * W1 + x;
        if (v === v0) break;
        const next = take(v, dir);
        if (next < 0) break;
        dir = next;
      }
      if (loop.length >= 8) loops.push(loop);
    }
  }
  return loops;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Pixel-edge loop → SVG path: edge midpoints (stairs become slopes); at corners between
 * two long edges, the corner itself; curves with breaks at corners. Small loops become polylines.
 */
export function loopPath(loop: readonly number[], detail: number): string {
  const n = loop.length / 2;
  // Moves: direction and length (cyclic).
  const runs: { x: number; y: number; dir: number; len: number }[] = [];
  for (let i = 0; i < n; i++) {
    const x = loop[i * 2]!;
    const y = loop[i * 2 + 1]!;
    const nx = loop[((i + 1) % n) * 2]!;
    const ny = loop[((i + 1) % n) * 2 + 1]!;
    const dir = nx > x ? 0 : ny > y ? 1 : nx < x ? 2 : 3;
    const last = runs[runs.length - 1];
    if (last && last.dir === dir) last.len++;
    else runs.push({ x, y, dir, len: 1 });
  }
  if (runs.length > 1 && runs[0]!.dir === runs[runs.length - 1]!.dir) {
    const tail = runs.pop()!;
    runs[0] = { x: tail.x, y: tail.y, dir: tail.dir, len: tail.len + runs[0]!.len };
  }
  if (n < 12 || runs.length < 3) {
    // Small loops become a polygon through the corners.
    return `M${runs.map((r) => `${r2(r.x)} ${r2(r.y)}`).join('L')}Z`;
  }
  const pts: CurvePoint[] = [];
  runs.forEach((r, i) => {
    const prev = runs[(i + runs.length - 1) % runs.length]!;
    // A corner between two long edges (3 px or more) stays a corner; shorter ones are a curve step.
    if (r.len >= 3 && prev.len >= 3) pts.push({ x: r.x, y: r.y });
    for (let k = 0; k < r.len; k++) pts.push({ x: r.x + DX[r.dir]! * (k + 0.5), y: r.y + DY[r.dir]! * (k + 0.5) });
  });
  const minAngle = ((70 - detail * 15) * Math.PI) / 180;
  const reach = 2.5;
  let corners = cornerIndices(pts, minAngle, reach);
  // The seam is placed at a corner (if any), so the curves on either side do not smooth it.
  let start = corners[0] ?? 0;
  if (!corners.length) {
    const half = Math.floor(pts.length / 2);
    const rotated = [...pts.slice(half), ...pts.slice(0, half)];
    const c2 = cornerIndices(rotated, minAngle, reach);
    if (c2.length) start = (c2[0]! + half) % pts.length;
  }
  let ring = [...pts.slice(start), ...pts.slice(0, start)];
  corners = cornerIndices(ring, minAngle, reach);
  // Smooth stair jitter (uneven step after scaling and smoothing): neighbors
  // [1, 2, 1] / 4 cyclically, corners stay in place. Less detail means more passes.
  const fixed = new Set([0, ...corners]);
  for (let pass = Math.round(3 - detail * 2); pass > 0; pass--) {
    const m = ring.length;
    ring = ring.map((p, i) => {
      if (fixed.has(i)) return p;
      const a = ring[(i + m - 1) % m]!;
      const b = ring[(i + 1) % m]!;
      return { x: (a.x + 2 * p.x + b.x) / 4, y: (a.y + 2 * p.y + b.y) / 4 };
    });
  }
  const error = 1.6 - detail * 1.2;
  const curves = fitCurve([...ring, ring[0]!], error, corners);
  if (!curves.length) return '';
  let d = `M${r2(curves[0]![0].x)} ${r2(curves[0]![0].y)}`;
  for (const c of curves) d += `C${r2(c[1].x)} ${r2(c[1].y)} ${r2(c[2].x)} ${r2(c[2].y)} ${r2(c[3].x)} ${r2(c[3].y)}`;
  return `${d}Z`;
}
