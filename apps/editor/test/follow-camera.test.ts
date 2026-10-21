import { afterEach, expect, it, vi } from 'vitest';
import { FollowCamera } from '../src/follow-camera.ts';

afterEach(() => vi.unstubAllGlobals());

function rig() {
  let camera = { x: 0, y: 0, zoom: 1 };
  let time = 0, id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('performance', { now: () => time });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const follow = new FollowCamera(() => camera, () => [1000, 800], c => { camera = c; });
  return { follow, frames, camera: () => camera, tick(dt: number) {
    time += dt;
    const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(time));
  } };
}

it('smooths updates, retargets without jumping or queuing old packets, and settles exactly', () => {
  const r = rig();
  r.follow.move({ x: 100, y: 0, zoom: 1 });
  expect(r.camera().x).toBe(0);
  r.tick(16); expect(r.camera().x).toBeGreaterThan(0); expect(r.camera().x).toBeLessThan(100);
  const current = r.camera();
  r.follow.move({ x: -100, y: 20, zoom: 1 });
  expect(r.camera()).toEqual(current); expect(r.frames.size).toBe(1);
  for (let i = 0; i < 50; i++) r.tick(16);
  expect(r.camera()).toEqual({ x: -100, y: 20, zoom: 1 }); expect(r.frames.size).toBe(0);
});

it('keeps the world center fixed while zooming and is independent of frame rate', () => {
  const a = rig(); a.follow.move({ x: 250, y: 200, zoom: 2 }); a.tick(32);
  const expected = a.camera();
  const b = rig(); b.follow.move({ x: 250, y: 200, zoom: 2 }); b.tick(16); b.tick(16);
  expect(b.camera().zoom).toBeCloseTo(expected.zoom);
  expect(b.camera().x + 500 / b.camera().zoom).toBeCloseTo(500);
  expect(b.camera().y + 400 / b.camera().zoom).toBeCloseTo(400);
});

it('cancels queued motion on stop and immediately applies page/reduced-motion jumps', () => {
  const r = rig(); r.follow.move({ x: 500, y: 0, zoom: 1 }); r.tick(16);
  r.follow.stop(); const stopped = r.camera(); r.tick(1000); expect(r.camera()).toEqual(stopped);
  r.follow.move({ x: 800, y: 0, zoom: 2 });
  r.follow.move({ x: 20, y: 30, zoom: 1 }, true); r.tick(1000);
  expect(r.camera()).toEqual({ x: 20, y: 30, zoom: 1 }); expect(r.frames.size).toBe(0);
});
