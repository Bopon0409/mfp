import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import CanvasKitModule, { type CanvasKit } from 'canvaskit-wasm/full';
import { describe, expect, it } from 'vitest';
import { Document, mediaHashes } from '@mfp/core';
import { CoreScene } from '../src/core-scene.ts';
import { SceneRenderer } from '../src/renderer.ts';
import { LottieLibrary, isLottieBytes, parseLottie } from '../src/lottie.ts';

const CanvasKitInit = CanvasKitModule as unknown as (opts: { locateFile: (f: string) => string }) => Promise<CanvasKit>;
const ck = await CanvasKitInit({ locateFile: (f: string) => join('node_modules/canvaskit-wasm/bin/full', f) });

/** A red 20×20 square (40×40 canvas, 2 s at 10 fps) moves left to right: center x 10 → 30. */
const SLIDE = {
  v: '5.7.4', fr: 10, ip: 0, op: 20, w: 40, h: 40, nm: 'slide', assets: [],
  layers: [{
    ty: 4, ind: 1, nm: 'box', ip: 0, op: 20, st: 0, sr: 1, ao: 0, bm: 0,
    ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
      p: { a: 1, k: [{ t: 0, s: [10, 20, 0], i: { x: 1, y: 1 }, o: { x: 0, y: 0 } }, { t: 20, s: [30, 20, 0] }] } },
    shapes: [
      { ty: 'rc', d: 1, s: { a: 0, k: [20, 20] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
      { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1 },
    ],
  }],
};
const json = strToU8(JSON.stringify(SLIDE));

describe('Lottie', () => {
  it('recognizes Bodymovin JSON and dotLottie, nothing else', () => {
    expect(isLottieBytes(json)).toBe(true);
    const dot = zipSync({ 'manifest.json': strToU8(JSON.stringify({ animations: [{ id: 'main' }] })), 'animations/main.json': json });
    expect(isLottieBytes(dot)).toBe(true);
    expect(parseLottie(dot)).toMatchObject({ width: 40, height: 40, duration: 2, fps: 10 });
    expect(isLottieBytes(strToU8('{"format":"mfp"}'))).toBe(false);
    expect(isLottieBytes(zipSync({ 'document.json': strToU8('{}') }))).toBe(false);
  });

  it('the animation file goes into the document media (saved in .mfp)', () => {
    expect([...mediaHashes({ fills: [{ type: 'LOTTIE', scaleMode: 'FIT', lottieHash: 'abc' }] })]).toEqual(['abc']);
  });

  it('the fill draws the frame at the current time: the square moves, fitted to the layer', async () => {
    const lib = new LottieLibrary(ck, () => ({ readImage: async () => json }));
    await lib.preload(['ab']);
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    // 80×40 layer, a 40×40 animation fitted in the center: layer x = 20 + 2·animation x.
    doc.create('RECTANGLE', page, { width: 80, height: 40, fills: [{ type: 'LOTTIE', scaleMode: 'FIT', lottieHash: 'ab' }] });
    const scene = new CoreScene(doc, page);
    const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined });
    renderer.setLotties(lib);
    scene.attach(renderer);
    const at = (t: number) => {
      renderer.lottieTime = t;
      const surface = ck.MakeSurface(80, 40)!;
      const canvas = surface.getCanvas();
      canvas.clear(ck.WHITE);
      renderer.render(canvas, scene.page.children, [0, 0, 80, 40], 1);
      const px = canvas.readPixels(0, 0, { width: 80, height: 40, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
      surface.delete();
      const red = (x: number) => px[(20 * 80 + x) * 4]! > 200 && px[(20 * 80 + x) * 4 + 1]! < 60;
      return [...Array(80).keys()].filter(red);
    };
    // t = 0: square centered at x=10 (20…40 in the layer); t = 1 s — midway (x=20 → 30…50).
    const start = at(0);
    expect(start[0]).toBe(20);
    expect(start.at(-1)).toBe(39);
    const mid = at(1);
    expect(mid[0]).toBe(30);
    expect(mid.at(-1)).toBe(49);
    expect(renderer.frameNodes.size).toBe(1);
    renderer.dispose();
    lib.dispose();
  });
});
