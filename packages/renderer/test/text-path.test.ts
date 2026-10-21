import { join } from 'node:path';
import CanvasKitModule, { type CanvasKit } from 'canvaskit-wasm';
import { describe, expect, it } from 'vitest';
import { graphemes, PathTextMap, textPathScale } from '../src/text-path.ts';

const CanvasKitInit = CanvasKitModule as unknown as (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
const ck = await CanvasKitInit({ locateFile: (f: string) => join('node_modules/canvaskit-wasm/bin', f) });

/** Semicircle of radius 100 centered at (100, 100): left to right over the top. */
const ARC = 'M0 100A100 100 0 0 1 200 100';

describe('text on a path: string ⇄ path', () => {
  it('straight line: offset along it, baseline on the path, below the baseline is lower on screen', () => {
    const m = new PathTextMap(ck, 'M0 0L100 0', 10, 40, 'LEFT', 12);
    expect(m.ok).toBe(true);
    expect(m.length).toBeCloseTo(100, 3);
    const [x, y, a] = m.toLocal(5, 12);
    expect([x, y, a]).toEqual([expect.closeTo(15, 3), expect.closeTo(0, 3), expect.closeTo(0, 5)]);
    expect(m.toLocal(5, 20)[1]).toBeCloseTo(8, 3);
    const [s, d] = m.fromLocal(15, 8);
    expect(s).toBeCloseTo(5, 1);
    expect(d).toBeCloseTo(20, 1);
    m.delete();
  });

  it('arc: a character on the circle, rotated along the tangent; the inverse conversion converges', () => {
    const m = new PathTextMap(ck, ARC, 0, 0, 'LEFT', 0);
    expect(m.length).toBeCloseTo(Math.PI * 100, 0);
    // Middle of the arc — the top point, the tangent is horizontal.
    const [x, y, a] = m.toLocal(m.length / 2, 0);
    expect(x).toBeCloseTo(100, 0);
    expect(y).toBeCloseTo(0, 0);
    expect(a).toBeCloseTo(0, 2);
    // Above the baseline (y < 0) — outside the circle.
    const [ox, oy] = m.toLocal(m.length / 4, -10);
    expect(Math.hypot(ox - 100, oy - 100)).toBeCloseTo(110, 0);
    const [s, d] = m.fromLocal(ox, oy);
    expect(s).toBeCloseTo(m.length / 4, 0);
    expect(d).toBeCloseTo(-10, 0);
    m.delete();
  });

  it('center and right alignment from the middle and from the end of the path', () => {
    const c = new PathTextMap(ck, 'M0 0L100 0', 0, 40, 'CENTER', 0);
    expect(c.start).toBeCloseTo(30, 3);
    const r = new PathTextMap(ck, 'M0 0L100 0', -5, 40, 'RIGHT', 0);
    expect(r.start).toBeCloseTo(55, 3);
    c.delete();
    r.delete();
  });

  it('past the end of an open path — continues along the tangent, a closed one wraps around', () => {
    const open = new PathTextMap(ck, 'M0 0L100 0', 0, 0, 'LEFT', 0);
    expect(open.toLocal(130, 0)[0]).toBeCloseTo(130, 3);
    const closed = new PathTextMap(ck, 'M0 0L100 0L100 100L0 100Z', 0, 0, 'LEFT', 0);
    expect(closed.closed).toBe(true);
    const [x, y] = closed.toLocal(closed.length + 20, 0);
    expect(x).toBeCloseTo(20, 3);
    expect(y).toBeCloseTo(0, 3);
    open.delete();
    closed.delete();
  });

  it('stretched bounds: the path and the line start stretch along with them', () => {
    expect(textPathScale({ width: 200, height: 50, geometrySize: { width: 100, height: 50 } })).toEqual([2, 1]);
    expect(textPathScale({ width: 200, height: 50 })).toEqual([1, 1]);
    const m = new PathTextMap(ck, 'M0 0L100 0', 10, 0, 'LEFT', 0, 2, 1);
    expect(m.length).toBeCloseTo(200, 3);
    expect(m.start).toBeCloseTo(20, 3);
    expect(m.toLocal(0, 0)[0]).toBeCloseTo(20, 3);
    expect(m.svg()).toContain('200');
    m.delete();
  });

  it('an empty or broken path — not ready', () => {
    const m = new PathTextMap(ck, 'не контур', 0, 0, 'LEFT', 0);
    expect(m.ok).toBe(false);
    m.delete();
  });

  it('characters are graphemes (emoji and composite letters as a whole)', () => {
    expect(graphemes('Ёж👍🏽')).toEqual([
      [0, 1],
      [1, 2],
      [2, 6],
    ]);
    expect(graphemes('й')).toEqual([[0, 2]]);
  });
});
