import { join } from 'node:path';
import CanvasKitModule, { type CanvasKit, type Image } from 'canvaskit-wasm';
import { describe, expect, it } from 'vitest';
import { Document, mediaHashes } from '@mfp/core';
import { CoreScene } from '../src/core-scene.ts';
import { SceneRenderer, type ModelSource, type ModelView } from '../src/renderer.ts';

const CanvasKitInit = CanvasKitModule as unknown as (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
const ck = await CanvasKitInit({ locateFile: (f: string) => join('node_modules/canvaskit-wasm/bin', f) });

/** Stub source: the frame is solid blue at the requested size; records the requests. */
class FakeModels implements ModelSource {
  calls: { view: ModelView; w: number; h: number; time: number | null }[] = [];
  ready = true;
  frame(_hash: string, _key: object, view: ModelView, w: number, h: number, time: number | null): Image | undefined {
    this.calls.push({ view, w, h, time });
    if (!this.ready) return undefined;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < px.length; i += 4) px.set([0, 0, 255, 255], i);
    return ck.MakeImage({ width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }, px, w * 4) ?? undefined;
  }
}

function draw(models: FakeModels, time: number | null = null) {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  doc.create('RECTANGLE', page, { width: 40, height: 20, transform: [1, 0, 0, 0, 1, 10], fills: [{ type: 'MODEL3D', scaleMode: 'FILL', modelHash: 'ab', camera: { yaw: 10, pitch: 20, zoom: 2 }, clip: 'Run', pose: 0.5, lighting: 'SOFT' }] });
  const scene = new CoreScene(doc, page);
  const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
  renderer.setModels(models);
  renderer.modelTime = time;
  scene.attach(renderer);
  const surface = ck.MakeSurface(40, 40)!;
  const canvas = surface.getCanvas();
  canvas.clear(ck.WHITE);
  renderer.render(canvas, scene.page.children, [0, 0, 40, 40], 1);
  const px = canvas.readPixels(0, 0, { width: 40, height: 40, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
  surface.delete();
  renderer.dispose();
  return (x: number, y: number) => [...px.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 3)];
}

describe('3D model in a fill', () => {
  it('source frame follows the layer bounds; camera angle, clip, frame, light and mode come from the fill', () => {
    const models = new FakeModels();
    const at = draw(models);
    expect(at(20, 20)).toEqual([0, 0, 255]);
    expect(at(20, 5)).toEqual([255, 255, 255]);
    const c = models.calls[0]!;
    expect(c.view).toEqual({ camera: { yaw: 10, pitch: 20, zoom: 2 }, clip: 'Run', pose: 0.5, lighting: 'SOFT', fill: true });
    // Frame size — a power-of-two step by the longer side, with the layer's proportions (2 : 1).
    expect(c.w / c.h).toBeCloseTo(2, 1);
    expect(c.time).toBeNull();
  });

  it('while the model loads — a placeholder; the export time is passed to the source', () => {
    const models = new FakeModels();
    models.ready = false;
    const at = draw(models, 1.25);
    expect(at(20, 20)).not.toEqual([0, 0, 255]);
    expect(models.calls[0]!.time).toBe(1.25);
  });

  it('the model file goes into the document media (saved in .mfp)', () => {
    expect([...mediaHashes({ fills: [{ type: 'MODEL3D', scaleMode: 'FIT', modelHash: 'cafe' }] })]).toEqual(['cafe']);
  });
});

describe('3D model: clip frame from timeline keys', () => {
  it('“clip frame” keys take time from the layer pose, not from the timeline clock', () => {
    const models = new FakeModels();
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    doc.create('RECTANGLE', page, { width: 40, height: 40, fills: [{ type: 'MODEL3D', scaleMode: 'FIT', modelHash: 'ab', pose: 0.75 }], animation: [{ property: 'modelTime', keys: [{ t: 0, value: 0.75 }] }] });
    const scene = new CoreScene(doc, page);
    const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
    renderer.setModels(models);
    renderer.modelTime = 3;
    scene.attach(renderer);
    const surface = ck.MakeSurface(40, 40)!;
    renderer.render(surface.getCanvas(), scene.page.children, [0, 0, 40, 40], 1);
    surface.delete();
    renderer.dispose();
    expect(models.calls[0]!.view.keyed).toBe(true);
    expect(models.calls[0]!.time).toBe(0.75);
  });
});
