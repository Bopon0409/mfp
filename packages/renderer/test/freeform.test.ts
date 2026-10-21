import { join } from 'node:path';
import CanvasKitModule, { type CanvasKit } from 'canvaskit-wasm';
import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { CoreScene } from '../src/core-scene.ts';
import { SceneRenderer } from '../src/renderer.ts';

const CanvasKitInit = CanvasKitModule as unknown as (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
const ck = await CanvasKitInit({ locateFile: (f: string) => join('node_modules/canvaskit-wasm/bin', f) });

function draw(points: { x: number; y: number; color: { r: number; g: number; b: number; a: number }; spread?: number }[]) {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  doc.create('RECTANGLE', page, { width: 100, height: 100, fills: [{ type: 'GRADIENT_FREEFORM', points }] });
  const scene = new CoreScene(doc, page);
  const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
  scene.attach(renderer);
  const surface = ck.MakeSurface(100, 100)!;
  const canvas = surface.getCanvas();
  canvas.clear(ck.WHITE);
  renderer.render(canvas, scene.page.children, [0, 0, 100, 100], 1);
  const px = canvas.readPixels(0, 0, { width: 100, height: 100, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
  surface.delete();
  renderer.dispose();
  return (x: number, y: number) => [...px.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)];
}

describe('freeform gradient (MFP-specific)', () => {
  it('at a point — its color, between points — a blend; positions are fractions of the bounds', () => {
    const at = draw([
      { x: 0.1, y: 0.1, color: { r: 1, g: 0, b: 0, a: 1 } },
      { x: 0.9, y: 0.9, color: { r: 0, g: 0, b: 1, a: 1 } },
    ]);
    const near = at(10, 10);
    expect(near[0]).toBeGreaterThan(240);
    expect(near[2]).toBeLessThan(15);
    const far = at(90, 90);
    expect(far[2]).toBeGreaterThan(240);
    // Middle of the diagonal — equal parts red and blue.
    const mid = at(50, 50);
    expect(Math.abs(mid[0]! - mid[2]!)).toBeLessThan(12);
    expect(mid[0]).toBeGreaterThan(90);
  });

  it('point strength: a strong point\'s color takes up more space', () => {
    const weak = draw([
      { x: 0, y: 0.5, color: { r: 1, g: 0, b: 0, a: 1 }, spread: 0.2 },
      { x: 1, y: 0.5, color: { r: 0, g: 0, b: 1, a: 1 }, spread: 0.5 },
    ]);
    const strong = draw([
      { x: 0, y: 0.5, color: { r: 1, g: 0, b: 0, a: 1 }, spread: 1 },
      { x: 1, y: 0.5, color: { r: 0, g: 0, b: 1, a: 1 }, spread: 0.5 },
    ]);
    expect(strong(50, 50)[0]!).toBeGreaterThan(weak(50, 50)[0]! + 40);
  });
});
