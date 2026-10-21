import { describe, expect, it } from 'vitest';
import type { FigPaint } from '@mfp/io-figma';
import { interpolateFills } from '../src/player/interpolate-fills.ts';

it.each(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND'])('interpolates %s stops, transform and opacity without modifying endpoints', type => {
  const a: FigPaint[] = [{ type, opacity: 0.2, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 0.2 } }, { position: 1, color: { r: 0, g: 0, b: 0 } }] }];
  const b = structuredClone(a); b[0]!.opacity = 0.8; b[0]!.transform!.m02 = 1;
  b[0]!.stops![0] = { position: 0.4, color: { r: 0, g: 0, b: 1, a: 0.8 } };
  const before = JSON.stringify([a, b]);
  const mid = interpolateFills(a, b, 0.5)[0]!;
  expect(mid.opacity).toBeCloseTo(0.5); expect(mid.transform!.m02).toBe(0.5);
  expect(mid.stops![0]).toEqual({ position: 0.2, color: { r: 0.5, g: 0, b: 0.5, a: 0.5 } });
  expect(interpolateFills(a, b, 0)).toEqual(a); expect(interpolateFills(a, b, 1)).toEqual(b);
  expect(JSON.stringify([a, b])).toBe(before);
});
it('animates opacity of an unchanged image without replacing its bytes', () => {
  const a: FigPaint = { type: 'IMAGE', image: { hash: new Uint8Array([1, 2]) }, opacity: 0 };
  expect(interpolateFills([a], [{ ...a, opacity: 1 }], 0.5)[0]!.opacity).toBe(0.5);
});
it('keeps exact endpoints for incompatible fills and empty stacks', () => {
  const a: FigPaint[] = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
  const b: FigPaint[] = [{ type: 'IMAGE', image: { hash: new Uint8Array([3]) } }];
  expect(interpolateFills(a, b, 0)).toEqual(a);
  expect(interpolateFills(a, b, 1)).toEqual(b);
  expect(interpolateFills(a, [], 0)).toEqual(a);
  expect(interpolateFills(a, [], 1)).toEqual([]);
});

describe('3D model in a morph transition', () => {
  const model = (hash: number, yaw: number, zoom: number, pose = 0) => ({ type: 'MODEL3D', model: { hash: Uint8Array.of(hash), camera: { yaw, pitch: 10, zoom }, pose } });
  it('the same model — view angle and clip frame change smoothly; a different model — switches at once', () => {
    const mid = interpolateFills([model(1, 0, 1, 0)], [model(1, 90, 2, 1)], 0.5)[0]!;
    expect(mid.model?.camera).toEqual({ yaw: 45, pitch: 10, zoom: 1.5 });
    expect(mid.model?.pose).toBeCloseTo(0.5);
    const other = interpolateFills([model(1, 0, 1)], [model(2, 90, 2)], 0.5)[0]!;
    expect(other.model?.camera?.yaw).toBe(90);
  });
});
