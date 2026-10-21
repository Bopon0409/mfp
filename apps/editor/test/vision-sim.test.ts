import { describe, expect, it } from 'vitest';
import { simulate, VISION_MATRIX } from '../src/vision-sim.ts';

const dist = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

describe('color vision simulation (MFP-specific)', () => {
  it('red and green converge under deuteranopia and protanopia, not under tritanopia', () => {
    const red = { r: 0.85, g: 0.2, b: 0.2 };
    const green = { r: 0.3, g: 0.6, b: 0.2 };
    const normal = dist(red, green);
    expect(dist(simulate('deuteranopia', red), simulate('deuteranopia', green))).toBeLessThan(normal * 0.5);
    expect(dist(simulate('protanopia', red), simulate('protanopia', green))).toBeLessThan(normal * 0.6);
    expect(dist(simulate('tritanopia', red), simulate('tritanopia', green))).toBeGreaterThan(normal * 0.6);
  });

  it('white and black do not change; achromatopsia — gray of the same luminance', () => {
    for (const m of Object.keys(VISION_MATRIX) as (keyof typeof VISION_MATRIX)[]) {
      const w = simulate(m, { r: 1, g: 1, b: 1 });
      expect(w.r).toBeCloseTo(1, 2);
      expect(w.g).toBeCloseTo(1, 2);
      expect(w.b).toBeCloseTo(1, 2);
      expect(simulate(m, { r: 0, g: 0, b: 0 })).toEqual({ r: 0, g: 0, b: 0 });
    }
    const g = simulate('achromatopsia', { r: 0, g: 0.5, b: 1 });
    expect(g.r).toBeCloseTo(g.g, 9);
    expect(g.g).toBeCloseTo(g.b, 9);
  });
});
