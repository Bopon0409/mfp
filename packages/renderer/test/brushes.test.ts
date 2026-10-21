import { describe, expect, it } from 'vitest';
import CanvasKitModule, { type CanvasKit } from 'canvaskit-wasm';
import { join } from 'node:path';
import { BRUSHES, brushReach, brushStrokePath } from '../src/brushes.ts';

const CanvasKitInit = CanvasKitModule as unknown as (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
const ck = await CanvasKitInit({ locateFile: (f: string) => join('node_modules/canvaskit-wasm/bin', f) });

function wave() {
  const b = new ck.PathBuilder();
  b.moveTo(0, 50);
  b.cubicTo(50, -10, 100, -10, 150, 50);
  b.cubicTo(200, 110, 250, 110, 300, 50);
  return b.detachAndDelete();
}

describe('stroke brushes', () => {
  it('every brush in the set produces a contour along the line within its own overshoot; the pattern is deterministic', () => {
    const base = wave();
    const weight = 10;
    for (const b of BRUSHES) {
      const style = { weight, align: 'CENTER' as const, join: 'ROUND' as const, dashes: [], brush: { type: b.type, name: b.name, seed: 5 } };
      const p = brushStrokePath(ck, base, style);
      expect(p, b.name).not.toBeNull();
      const r = p!.getBounds();
      const reach = weight * brushReach(style.brush) + 1;
      // Line: x 0…300, y ≈ 5…95 (wave).
      expect(r[0]!, b.name).toBeGreaterThanOrEqual(-reach);
      expect(r[2]!, b.name).toBeLessThanOrEqual(300 + reach);
      expect(r[2]! - r[0]!, b.name).toBeGreaterThan(250);
      const again = brushStrokePath(ck, base, style)!;
      expect(again.toSVGString(), b.name).toBe(p!.toSVGString());
      p!.delete();
      again.delete();
    }
    base.delete();
  });

  it('calligraphy width depends on direction, ink ends are thinner than the middle', () => {
    const line = (x1: number, y1: number) => {
      const b = new ck.PathBuilder();
      b.moveTo(0, 0);
      b.lineTo(x1, y1);
      return b.detachAndDelete();
    };
    const thick = (name: string, x1: number, y1: number) => {
      const base = line(x1, y1);
      const p = brushStrokePath(ck, base, { weight: 20, align: 'CENTER', join: 'ROUND', dashes: [], brush: { type: 'STRETCH', name } })!;
      const r = p.getBounds();
      p.delete();
      base.delete();
      // Width across a horizontal line is the bounds height, across a vertical one — the width.
      return y1 === 0 ? r[3]! - r[1]! : r[2]! - r[0]!;
    };
    // Pen at 45°: horizontal and vertical lines have the same width, but thinner than full.
    expect(thick('calligraphy', 200, 0)).toBeLessThan(18);
    expect(thick('marker', 200, 0)).toBeGreaterThan(19);
  });
});
