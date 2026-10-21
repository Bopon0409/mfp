import { join } from 'node:path';
import CanvasKitModule, { type CanvasKit } from 'canvaskit-wasm';
import { expect, it, vi } from 'vitest';
import { Document } from '@mfp/core';
import { CoreScene, SceneRenderer } from '@mfp/renderer';
import { interpolateTransform } from '../src/player/interpolate-transform.ts';
import { interpolateFills } from '../src/player/interpolate-fills.ts';
import { Player } from '../src/player/player.ts';

const ck = await (CanvasKitModule as unknown as (o: { locateFile: (f: string) => string }) => Promise<CanvasKit>)({ locateFile: f => join('node_modules/canvaskit-wasm/bin', f) });

it('resizes a frame without shrinking its child and restores endpoints on restart', () => {
  const doc = new Document({ clientId: 1 }); const page = doc.create('PAGE', doc.root);
  const frame = doc.create('FRAME', page, { width: 240, height: 120, clipsContent: true, fills: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }] });
  const child = doc.create('RECTANGLE', frame, { width: 20, height: 20, transform: [1, 0, 10, 0, 1, 10], fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }] });
  const scene = new CoreScene(doc, page), parentNode = scene.node(frame)!, childNode = scene.node(child)!;
  const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined }); scene.attach(renderer);
  // Exercise the real transition lifecycle without a DOM/WebGL constructor.
  const player = Object.create(Player.prototype) as Player;
  const begin = vi.fn();
  Object.assign(player, { layers: new Map(), timelines: new Map(), session: { begin } });
  const anim: Parameters<Player['applyLerps']>[0] = { kind: 'screen', start: 0, dur: 1000, ease: x => x, transition: null, lerps: [
    player['lerpFor'](parentNode, [1, 0, 0, 0, 1, 0], 1, parentNode.fills, [120, 60]),
    player['lerpFor'](childNode, [1, 0, 10, 0, 1, 10], 1, childNode.fills, [20, 20]),
  ] };
  player['anims'] = [anim];
  const surface = ck.MakeSurface(256, 128)!;
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      player['applyLerps'](anim, 0.5);
      const canvas = surface.getCanvas(); canvas.clear(ck.WHITE);
      renderer.render(canvas, scene.page.children, [0, 0, 256, 128], 1); surface.flush();
      const px = canvas.readPixels(0, 0, { width: 256, height: 128, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
      const at = (x: number, y: number) => [...px.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 3)];
      expect(at(11, 11)).toEqual([0, 0, 255]); expect(at(29, 29)).toEqual([0, 0, 255]);
      expect(at(175, 85)).toEqual([128, 128, 128]); expect(at(185, 85)).toEqual([255, 255, 255]);
    }
    parentNode.visible = false; anim.hidden = [parentNode];
    const imageDelete = vi.fn(); anim.image = { img: { delete: imageDelete } as never, layer: frame, m: [1, 0, 0, 0, 1, 0], w: 1, h: 1 };
    player.restart();
    expect(parentNode.transform).toEqual([1, 0, 0, 0, 1, 0]);
    expect(childNode.transform).toEqual([1, 0, 10, 0, 1, 10]);
    expect(parentNode.visible).toBe(true); expect(player['anims']).toEqual([]);
    expect(imageDelete).toHaveBeenCalledOnce(); expect(begin).toHaveBeenCalledOnce();
  } finally { surface.delete(); renderer.dispose(); }
});

it('renders a full-sized rectangle and blended gradient in the middle of a half turn', () => {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const id = doc.create('RECTANGLE', page, { width: 20, height: 10, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] });
  const scene = new CoreScene(doc, page);
  const renderer = new SceneRenderer(ck, scene.blobs, { get: () => undefined }); scene.attach(renderer);
  const sn = scene.node(id)!;
  sn.transform = interpolateTransform([1, 0, 22, 0, 1, 27], [-1, 0, 42, 0, -1, 37], 0.5);
  const gradient = (r: number, b: number) => ({ type: 'GRADIENT_LINEAR', transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, stops: [0, 1].map(position => ({ position, color: { r, g: 0, b, a: 1 } })) });
  sn.fills = interpolateFills([gradient(1, 0)], [gradient(0, 1)], 0.5);
  const surface = ck.MakeSurface(64, 64)!;
  try {
    const canvas = surface.getCanvas(); canvas.clear(ck.WHITE);
    renderer.render(canvas, scene.page.children, [0, 0, 64, 64], 1); surface.flush();
    const px = canvas.readPixels(0, 0, { width: 64, height: 64, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
    let purple = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]! >= 126 && px[i]! <= 129 && px[i + 1]! === 0 && px[i + 2]! >= 126 && px[i + 2]! <= 129) purple++;
    expect(purple).toBeGreaterThanOrEqual(180);
    expect(purple).toBeLessThanOrEqual(220);
  } finally { surface.delete(); renderer.dispose(); }
});

it.each([1, 0.5])('dissolves image pixels with premultiplied alpha=%s over white', alpha => {
  const images = [ck.MakeSurface(2, 2)!, ck.MakeSurface(2, 2)!];
  images[0]!.getCanvas().clear(ck.Color4f(1, 0, 0, alpha));
  images[1]!.getCanvas().clear(ck.Color4f(0, 0, 1, alpha));
  const bitmaps = images.map(s => s.makeImageSnapshot());
  const doc = new Document({ clientId: 1 }); const page = doc.create('PAGE', doc.root);
  const id = doc.create('RECTANGLE', page, { width: 20, height: 20 });
  const scene = new CoreScene(doc, page);
  const renderer = new SceneRenderer(ck, scene.blobs, { get: hash => bitmaps[hash === '01' ? 0 : 1] }); scene.attach(renderer);
  const paint = (hash: number) => ({ type: 'IMAGE', imageScaleMode: 'FILL', image: { hash: new Uint8Array([hash]) } });
  const surface = ck.MakeSurface(20, 20)!;
  try {
    const sn = scene.node(id)!;
    for (const t of [0, 0.5, 1]) {
      sn.fills = interpolateFills([paint(1)], [paint(2)], t);
      const canvas = surface.getCanvas(); canvas.clear(ck.WHITE);
      renderer.render(canvas, scene.page.children, [0, 0, 20, 20], 1); surface.flush();
      const px = canvas.readPixels(10, 10, { width: 1, height: 1, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
      const expected = [255 * (1 - alpha * t), 255 * (1 - alpha), 255 * (1 - alpha * (1 - t)), 255];
      expected.forEach((v, i) => expect(Math.abs(px[i]! - v)).toBeLessThanOrEqual(2));
      renderer.forgetFills(sn.fills);
    }
  } finally { surface.delete(); renderer.dispose(); bitmaps.forEach(i => i.delete()); images.forEach(s => s.delete()); }
});
