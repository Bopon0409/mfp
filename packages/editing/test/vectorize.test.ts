import { describe, expect, it } from 'vitest';
import { traceMask, vectorize } from '../src/vectorize.ts';

/** Image w × h: pixel color is fn(x, y) → [r, g, b] (or null for transparent). */
function image(w: number, h: number, fn: (x: number, y: number) => [number, number, number] | null): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = fn(x + 0.5, y + 0.5);
      if (!c) continue;
      out.set([...c, 255], (y * w + x) * 4);
    }
  return out;
}

/** Points on the path curves (M, L, C, Z): 8 per curve. */
function sample(d: string): [number, number][] {
  const out: [number, number][] = [];
  const t = d.match(/[MLCZ]|-?\d+(\.\d+)?/g) ?? [];
  let i = 0;
  let cur: [number, number] = [0, 0];
  const n = () => Number(t[i++]);
  while (i < t.length) {
    const c = t[i++];
    if (c === 'M' || c === 'L') out.push((cur = [n(), n()]));
    else if (c === 'C') {
      const p: [number, number][] = [cur, [n(), n()], [n(), n()], [n(), n()]];
      for (let k = 1; k <= 8; k++) {
        const u = k / 8;
        const v = 1 - u;
        const at = (a: 0 | 1) => v * v * v * p[0]![a] + 3 * v * v * u * p[1]![a] + 3 * v * u * u * p[2]![a] + u * u * u * p[3]![a];
        out.push([at(0), at(1)]);
      }
      cur = p[3]!;
    }
  }
  return out;
}

/** Path bounds from points on the curves (not the anchor points). */
function bounds(d: string): [number, number, number, number] {
  const pts = sample(d);
  const r = (v: number) => Math.round(v * 100) / 100;
  return [r(Math.min(...pts.map((p) => p[0]))), r(Math.min(...pts.map((p) => p[1]))), r(Math.max(...pts.map((p) => p[0]))), r(Math.max(...pts.map((p) => p[1])))];
}

describe('image vectorization', () => {
  it('mask tracing: pixels touching at a corner are two regions; a ring is an outer contour and a hole', () => {
    expect(traceMask(new Uint8Array([1, 0, 0, 1]), 2, 2)).toHaveLength(2);
    const ring = new Uint8Array(25);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) ring[y * 5 + x] = x === 2 && y === 2 ? 0 : 1;
    const loops = traceMask(ring, 5, 5);
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => l.length / 2).sort((a, b) => a - b)).toEqual([4, 20]);
  });

  it('circle and rectangle on white: background removed, two colors, the circle as curves exactly in place', () => {
    const W = 200;
    const H = 120;
    const px = image(W, H, (x, y) => (Math.hypot(x - 60, y - 60) < 40 ? [230, 30, 30] : x > 120 && x < 180 && y > 20 && y < 100 ? [20, 60, 220] : [255, 255, 255]));
    const layers = vectorize(px, W, H, { colors: 3, detail: 0.5, removeBackground: true, stacked: false });
    expect(layers).toHaveLength(2);
    const red = layers.find((l) => l.color.r > 0.8)!;
    const blue = layers.find((l) => l.color.b > 0.8)!;
    expect(red.d).toContain('C');
    // All points of the circle path lie on the circle (± one and a half pixels).
    const worst = Math.max(...sample(red.d).map(([x, y]) => Math.abs(Math.hypot(x - 60, y - 60) - 40)));
    expect(worst).toBeLessThan(1.5);
    // Rectangle: sharp corners exactly at the corners.
    expect(bounds(blue.d)).toEqual([120, 20, 180, 100]);
    // Overlay: the lower (larger) layer also includes the region of the upper one.
    const stacked = vectorize(px, W, H, { colors: 3, detail: 0.5, removeBackground: true });
    expect(bounds(stacked[0]!.d)[2]).toBe(180);
  });

  it('transparent stays transparent; the result is reproducible', () => {
    const px = image(40, 40, (x) => (x < 20 ? [0, 0, 0] : null));
    const a = vectorize(px, 40, 40, { colors: 4, detail: 0.5 });
    expect(a).toHaveLength(1);
    expect(bounds(a[0]!.d)).toEqual([0, 0, 20, 40]);
    expect(vectorize(px, 40, 40, { colors: 4, detail: 0.5 })).toEqual(a);
  });
});
