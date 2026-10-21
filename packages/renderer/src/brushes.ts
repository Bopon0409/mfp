// Stroke brushes (Draw; our own artwork). Stretch: the brush shape along the centerline:
// a weight profile along the length (tapering to the ends), a rough edge, fibers with gaps;
// scatter: stamps along the line (dots, stars, confetti, leaves) with random size,
// rotation and cross offset; dynamic: a centerline with a wave and a living weight. Randomness
// uses a fixed seed, so the drawing does not change between redraws. The result is a fill path
// (filled with the stroke paints), as with variable weight.

import type { CanvasKit, ContourMeasure, Path, PathBuilder } from 'canvaskit-wasm';
import type { SceneStrokeStyle } from '@mfp/io-figma';

export type BrushType = 'STRETCH' | 'SCATTER' | 'DYNAMIC';

/** Stroke brush (model: strokeBrush; in the scene: strokeStyle.brush). */
export type BrushStyle = NonNullable<SceneStrokeStyle['brush']>;

/** Brush set: name, type, label. */
export const BRUSHES: { name: string; type: BrushType; label: string }[] = [
  { name: 'ink', type: 'STRETCH', label: 'Тушь' },
  { name: 'marker', type: 'STRETCH', label: 'Маркер' },
  { name: 'bristle', type: 'STRETCH', label: 'Кисть' },
  { name: 'pencil', type: 'STRETCH', label: 'Карандаш' },
  { name: 'calligraphy', type: 'STRETCH', label: 'Каллиграфия' },
  { name: 'dots', type: 'SCATTER', label: 'Точки' },
  { name: 'stars', type: 'SCATTER', label: 'Звёзды' },
  { name: 'confetti', type: 'SCATTER', label: 'Конфетти' },
  { name: 'leaves', type: 'SCATTER', label: 'Листья' },
  { name: 'dynamic', type: 'DYNAMIC', label: 'Динамика' },
];

/** How far a brush stroke extends beyond the line (fraction of the weight): scatter includes stamps and offset. */
export function brushReach(b: BrushStyle): number {
  if (b.type === 'SCATTER') return 0.6 + (b.scatter ?? SCATTER_DEFAULTS[b.name]?.scatter ?? 0.5);
  if (b.type === 'DYNAMIC') return 0.6 + (b.wiggle ?? 0.5);
  return 0.6;
}

// ---------- Randomness ----------

/** mulberry32 generator: numbers 0…1 from a seed. */
function random(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Number 0…1 at an integer point (hash). */
function hash(i: number, seed: number): number {
  let h = Math.imul(i ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth noise 0…1 along the line (values at integer points, cosine interpolation). */
function noise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const k = (1 - Math.cos(f * Math.PI)) / 2;
  return hash(i, seed) * (1 - k) + hash(i + 1, seed) * k;
}

// ---------- Centerline paths ----------

interface Contour {
  m: ContourMeasure;
  len: number;
  closed: boolean;
}

function contours(ck: CanvasKit, base: Path): Contour[] {
  const out: Contour[] = [];
  const iter = new ck.ContourMeasureIter(base, false, 4);
  for (let m = iter.next(); m; m = iter.next()) {
    const len = m.length();
    if (len > 0) out.push({ m, len, closed: m.isClosed() });
    else m.delete();
  }
  iter.delete();
  return out;
}

/** Point and tangent at distance d (cyclic for a closed path). */
function at(c: Contour, d: number): { x: number; y: number; tx: number; ty: number } {
  const p = c.m.getPosTan(c.closed ? ((d % c.len) + c.len) % c.len : Math.max(0, Math.min(c.len, d)));
  return { x: p[0]!, y: p[1]!, tx: p[2]!, ty: p[3]! };
}

// ---------- Stretch ----------

interface Strand {
  /** Cross position of the fiber center (−1…1 of half the weight) and its weight (fraction of the full weight). */
  center: number;
  width: number;
  /** Gaps: fraction of the length in gaps (0 — solid) and their length (fraction of the weight). */
  gaps?: number;
  gapScale?: number;
}

interface Stretch {
  /** Weight along the length (u — length fraction, s — distance, px). */
  profile(u: number, s: number, closed: boolean): number;
  /** Edge roughness (fraction of the weight) and its step (fraction of the weight). */
  rough: number;
  roughScale: number;
  strands: Strand[];
  /** Weight multiplier by direction (calligraphy). */
  angle?: (tx: number, ty: number) => number;
}

const taper = (u: number, start: number, end: number, closed: boolean) => (closed ? 1 : Math.min(1, u / start) ** 0.7 * Math.min(1, (1 - u) / end) ** 0.7);

const STRETCH: Record<string, Stretch> = {
  ink: {
    profile: (u, s, closed) => taper(u, 0.12, 0.2, closed) * (0.85 + 0.3 * noise(s / 40, 7)),
    rough: 0.05,
    roughScale: 1.5,
    strands: [{ center: 0, width: 1 }],
  },
  marker: {
    profile: (u, _s, closed) => taper(u, 0.015, 0.015, closed),
    rough: 0.035,
    roughScale: 0.8,
    strands: [{ center: 0, width: 1 }],
  },
  bristle: {
    profile: (u, _s, closed) => taper(u, 0.05, 0.3, closed),
    rough: 0.08,
    roughScale: 0.7,
    strands: [-0.78, -0.48, -0.17, 0.14, 0.45, 0.76].map((center, i) => ({ center, width: 0.24 + 0.08 * hash(i, 3), gaps: 0.18 + 0.1 * hash(i, 5), gapScale: 3 + 2 * hash(i, 9) })),
  },
  pencil: {
    profile: (u, _s, closed) => taper(u, 0.02, 0.04, closed),
    rough: 0.25,
    roughScale: 0.3,
    // Graphite: a solid middle and ragged edges of short strokes.
    strands: [
      { center: -0.62, width: 0.34, gaps: 0.22, gapScale: 0.25 },
      { center: -0.2, width: 0.5, gaps: 0.06, gapScale: 0.3 },
      { center: 0.2, width: 0.5, gaps: 0.06, gapScale: 0.35 },
      { center: 0.62, width: 0.34, gaps: 0.22, gapScale: 0.22 },
    ],
  },
  calligraphy: {
    profile: (u, _s, closed) => taper(u, 0.03, 0.05, closed),
    rough: 0.02,
    roughScale: 1,
    strands: [{ center: 0, width: 1 }],
    // Nib at 45°: thin along the nib, thick across it.
    angle: (tx, ty) => 0.14 + 0.86 * Math.abs(Math.sin(Math.atan2(ty, tx) - Math.PI / 4)),
  },
};

function stretchPath(ck: CanvasKit, b: PathBuilder, cs: Contour[], weight: number, kind: Stretch, seed: number) {
  const half = weight / 2;
  const step = Math.max(0.6, Math.min(3, weight / 5));
  cs.forEach((c, ci) => {
    // Closed: overlaps onto the start (no seam).
    const len = c.closed ? c.len + step : c.len;
    const n = Math.max(4, Math.ceil(len / step));
    kind.strands.forEach((st, si) => {
      const sd = seed + ci * 101 + si * 17;
      let left: number[][] = [];
      let right: number[][] = [];
      const flush = () => {
        if (left.length > 1) {
          left.forEach(([x, y], k) => (k ? b.lineTo(x!, y!) : b.moveTo(x!, y!)));
          for (let k = right.length - 1; k >= 0; k--) b.lineTo(right[k]![0]!, right[k]![1]!);
          b.close();
        }
        left = [];
        right = [];
      };
      for (let i = 0; i <= n; i++) {
        const s = (len * i) / n;
        const u = Math.min(1, s / c.len);
        // Fiber gap: noise above the threshold (for this brush, more often toward the tail).
        if (st.gaps && noise(s / (weight * (st.gapScale ?? 2)), sd + 5) < st.gaps * (0.6 + 0.8 * u)) {
          flush();
          continue;
        }
        const p = at(c, s);
        let w = half * kind.profile(u, s, c.closed);
        if (kind.angle) w *= kind.angle(p.tx, p.ty);
        if (w <= 0.01) {
          flush();
          continue;
        }
        const r1 = 1 + kind.rough * (noise(s / (weight * kind.roughScale), sd) * 2 - 1);
        const r2 = 1 + kind.rough * (noise(s / (weight * kind.roughScale), sd + 3) * 2 - 1);
        // Normal pointing left in travel direction (y axis down).
        const nx = p.ty;
        const ny = -p.tx;
        // Half the weight is 1: a fiber of width width (fraction of the full weight) is center ± width.
        const a = (st.center + st.width) * w * r1;
        const d = (st.center - st.width) * w * r2;
        left.push([p.x + nx * a, p.y + ny * a]);
        right.push([p.x + nx * d, p.y + ny * d]);
      }
      flush();
    });
  });
}

// ---------- Scatter ----------

const SCATTER_DEFAULTS: Record<string, { spacing: number; scatter: number; sizeJitter: number; rotationJitter: number }> = {
  dots: { spacing: 1.3, scatter: 0.6, sizeJitter: 0.6, rotationJitter: 0 },
  stars: { spacing: 1.9, scatter: 0.3, sizeJitter: 0.45, rotationJitter: 0.25 },
  confetti: { spacing: 1.2, scatter: 0.7, sizeJitter: 0.4, rotationJitter: 1 },
  leaves: { spacing: 1.1, scatter: 0.35, sizeJitter: 0.35, rotationJitter: 0.12 },
};

/** Stamp (size 1, centered at zero): add to b with translation, rotation and scale. */
function stamp(ck: CanvasKit, b: PathBuilder, name: string, x: number, y: number, angle: number, size: number, side: number) {
  const cos = Math.cos(angle) * size;
  const sin = Math.sin(angle) * size;
  const T = (px: number, py: number): [number, number] => [x + px * cos - py * sin, y + px * sin + py * cos];
  const poly = (pts: [number, number][]) => {
    pts.forEach(([px, py], k) => {
      const [qx, qy] = T(px, py);
      if (k) b.lineTo(qx, qy);
      else b.moveTo(qx, qy);
    });
    b.close();
  };
  switch (name) {
    case 'stars': {
      const pts: [number, number][] = [];
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? 0.2 : 0.5;
        const a = (Math.PI * k) / 5 - Math.PI / 2;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      poly(pts);
      break;
    }
    case 'confetti':
      poly([
        [-0.45, -0.22],
        [0.45, -0.22],
        [0.45, 0.22],
        [-0.45, 0.22],
      ]);
      break;
    case 'leaves': {
      // Leaf: two arcs from the stem to the tip, tilted to its own side of the line.
      const pts: [number, number][] = [];
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        pts.push([t - 0.5, -Math.sin(t * Math.PI) * 0.26 * side]);
      }
      for (let k = 11; k >= 1; k--) {
        const t = k / 12;
        pts.push([t - 0.5, Math.sin(t * Math.PI) * 0.12 * side]);
      }
      poly(pts);
      break;
    }
    default: {
      const pts: [number, number][] = [];
      for (let k = 0; k < 16; k++) pts.push([Math.cos((Math.PI * k) / 8) * 0.5, Math.sin((Math.PI * k) / 8) * 0.5]);
      poly(pts);
    }
  }
}

function scatterPath(ck: CanvasKit, b: PathBuilder, cs: Contour[], weight: number, brush: BrushStyle) {
  const d = SCATTER_DEFAULTS[brush.name] ?? SCATTER_DEFAULTS.dots!;
  const spacing = Math.max(0.2, brush.spacing ?? d.spacing) * weight;
  const scatter = (brush.scatter ?? d.scatter) * weight;
  const sizeJitter = Math.max(0, Math.min(1, brush.sizeJitter ?? d.sizeJitter));
  const rotJitter = Math.max(0, Math.min(1, brush.rotationJitter ?? d.rotationJitter));
  const rnd = random(brush.seed ?? 1);
  let k = 0;
  for (const c of cs) {
    const count = Math.max(1, Math.floor(c.len / spacing) + (c.closed ? 0 : 1));
    const stepLen = c.closed ? c.len / count : count > 1 ? c.len / (count - 1) : 0;
    for (let i = 0; i < count; i++, k++) {
      const p = at(c, i * stepLen);
      const size = weight * (1 - sizeJitter * rnd());
      const off = (rnd() * 2 - 1) * scatter;
      const side = brush.name === 'leaves' ? (k % 2 ? 1 : -1) : 1;
      // Leaves go to their own side, the rest randomly across.
      const across = brush.name === 'leaves' ? side * (0.35 * weight + Math.abs(off) * 0.5) : off;
      const along = Math.atan2(p.ty, p.tx);
      const angle = along + (rnd() * 2 - 1) * Math.PI * rotJitter + (brush.name === 'leaves' ? side * 0.6 : 0);
      stamp(ck, b, brush.name, p.x + p.ty * across, p.y - p.tx * across, angle, size, side);
    }
  }
}

// ---------- Dynamic ----------

function dynamicPath(ck: CanvasKit, b: PathBuilder, cs: Contour[], weight: number, brush: BrushStyle) {
  const half = weight / 2;
  const freq = Math.max(0.05, brush.frequency ?? 2) / 100;
  const amp = (brush.wiggle ?? 0.5) * weight;
  const seed = brush.seed ?? 1;
  const step = Math.max(0.6, Math.min(3, weight / 5));
  cs.forEach((c, ci) => {
    const len = c.closed ? c.len + step : c.len;
    const n = Math.max(4, Math.ceil(len / step));
    const left: number[][] = [];
    const right: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const s = (len * i) / n;
      const u = Math.min(1, s / c.len);
      const p = at(c, s);
      // The wave is noise with a period of 100 / frequency px; the weight varies slightly faster.
      const shift = amp * (noise(s * freq, seed + ci) * 2 - 1);
      const w = half * (0.75 + 0.5 * noise(s * freq * 1.7 + 0.5, seed + ci + 31)) * taper(u, 0.06, 0.08, c.closed);
      const nx = p.ty;
      const ny = -p.tx;
      left.push([p.x + nx * (shift + w), p.y + ny * (shift + w)]);
      right.push([p.x + nx * (shift - w), p.y + ny * (shift - w)]);
    }
    left.forEach(([x, y], k) => (k ? b.lineTo(x!, y!) : b.moveTo(x!, y!)));
    for (let k = right.length - 1; k >= 0; k--) b.lineTo(right[k]![0]!, right[k]![1]!);
    b.close();
  });
}

/** Brush stroke along centerline base: a fill path; null — nothing to draw. */
export function brushStrokePath(ck: CanvasKit, base: Path, s: SceneStrokeStyle): Path | null {
  const brush = s.brush;
  if (!brush || s.weight <= 0) return null;
  const cs = contours(ck, base);
  if (!cs.length) return null;
  const b = new ck.PathBuilder();
  if (brush.type === 'SCATTER') scatterPath(ck, b, cs, s.weight, brush);
  else if (brush.type === 'DYNAMIC') dynamicPath(ck, b, cs, s.weight, brush);
  else stretchPath(ck, b, cs, s.weight, STRETCH[brush.name] ?? STRETCH.ink!, brush.seed ?? 1);
  for (const c of cs) c.m.delete();
  b.setFillType(ck.FillType.Winding);
  const raw = b.detachAndDelete();
  // Loops and overlaps are resolved by a union with itself.
  const clean = ck.Path.MakeFromOp(raw, raw, ck.PathOp.Union);
  if (clean) {
    raw.delete();
    return clean;
  }
  return raw;
}
