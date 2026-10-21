import { expect, it } from 'vitest';
import type { CanvasKit } from 'canvaskit-wasm';
import { WgslFillCache, wgslUniforms } from '../src/wgsl-fill.ts';
import { GLOW } from '../../io-figma/test/fixtures/glow.ts';

it('packs the uniform layout, logical dimensions, time and unpremultiplied colors', () => {
  const values = wgslUniforms(GLOW, { dotColor: [1, 0.2, 0.1, 0.5], density: [1], wind: [Number.NaN] }, 560, 140, 1.25);
  expect(values.byteLength).toBe(448);
  expect([...values.slice(0, 8)]).toEqual([1.25, 560, 140, 0, 560, 140, 0, 0]);
  const slot = (name: string) => 8 + GLOW.uniforms.findIndex((p) => p.name === name) * 4;
  expect(values[slot('dotColor')]).toBe(1);
  expect(values[slot('dotColor') + 3]).toBe(0.5);
  expect(values[slot('density')]).toBe(1);
  expect(values[slot('wind')]).toBe(0);
  expect(values[slot('spreadWidth')]).toBe(28);
});

it('reports unavailable WebGPU instead of silently exporting a blank shader', async () => {
  const errors: string[] = [];
  const cache = new WgslFillCache({} as CanvasKit, () => {}, (message) => errors.push(message));
  cache.get(GLOW, {}, 560, 140, 0);
  await expect(cache.ready()).rejects.toThrow('WebGPU');
  expect(errors).toHaveLength(1);
  cache.get(GLOW, {}, 560, 140, 1);
  await expect(cache.ready()).rejects.toThrow('WebGPU');
  expect(errors).toHaveLength(1);
  cache.dispose();
});
