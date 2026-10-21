import { join } from 'node:path';
import CanvasKitModule, { type CanvasKit } from 'canvaskit-wasm';
import { describe, expect, it } from 'vitest';
import { IMAGE_FILTER_SKSL } from '../src/renderer.ts';

// In the package types (NodeNext) the default export is not callable — at runtime it is a function.
const CanvasKitInit = CanvasKitModule as unknown as (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
const ck = await CanvasKitInit({ locateFile: (f: string) => join('node_modules/canvaskit-wasm/bin', f) });
const effect = ck.RuntimeEffect.Make(IMAGE_FILTER_SKSL)!;

/** Pixel color after adjustment (value order — as in the shader uniforms). */
function filtered(rgb: [number, number, number], f: { exposure?: number; contrast?: number; saturation?: number; highlights?: number; shadows?: number }) {
  const img = ck.MakeImage({ width: 1, height: 1, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }, new Uint8Array([...rgb, 255]), 4)!;
  const child = img.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Nearest, ck.MipmapMode.None);
  const shader = effect.makeShaderWithChildren([f.exposure ?? 0, f.contrast ?? 0, f.saturation ?? 0, 0, 0, f.highlights ?? 0, f.shadows ?? 0], [child]);
  const surface = ck.MakeSurface(1, 1)!;
  const paint = new ck.Paint();
  paint.setShader(shader);
  surface.getCanvas().drawPaint(paint);
  const out = surface.getCanvas().readPixels(0, 0, { width: 1, height: 1, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
  for (const o of [paint, shader, child, img, surface]) o.delete();
  return [...out.slice(0, 3)];
}

describe('image adjustments', () => {
  it('without adjustments the color does not change', () => {
    for (const c of [[0, 0, 0], [40, 90, 200], [255, 255, 255]] as [number, number, number][]) {
      filtered(c, {}).forEach((v, i) => expect(Math.abs(v - c[i]!)).toBeLessThanOrEqual(1));
    }
  });

  it('saturation −1 gives gray, exposure changes brightness in the right direction', () => {
    const [r, g, b] = filtered([200, 120, 40], { saturation: -1 });
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThanOrEqual(1);
    expect(filtered([100, 100, 100], { exposure: 0.5 })[0]).toBeGreaterThan(110);
    expect(filtered([100, 100, 100], { exposure: -0.5 })[0]).toBeLessThan(90);
  });

  it('shadows darken dark tones more than light ones', () => {
    const dark = filtered([60, 60, 60], { shadows: -1 })[0]!;
    const light = filtered([220, 220, 220], { shadows: -1 })[0]!;
    expect(60 - dark).toBeGreaterThan(220 - light);
  });
});
