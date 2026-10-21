import { describe, expect, it } from 'vitest';
import type { GradientPaint } from '@mfp/core';
import { colorAt, defaultTransform, dragHandle, gradientHandles, sortStops, transformFromHandles } from '../src/gradient.ts';

const paint = (type: GradientPaint['type'], t = defaultTransform(type)): GradientPaint => ({
  type,
  gradientTransform: t,
  gradientStops: [
    { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
    { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
  ],
});

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

describe('gradient handles', () => {
  it('linear by default — top to bottom through the center', () => {
    const [a, b] = gradientHandles(paint('GRADIENT_LINEAR'));
    close(a, [0.5, 0]);
    close(b, [0.5, 1]);
  });

  it('radial by default — layer center and radii to the edges', () => {
    const [a, b, c] = gradientHandles(paint('GRADIENT_RADIAL'));
    close(a, [0.5, 0.5]);
    close(b, [1, 0.5]);
    close(c, [0.5, 1]);
  });

  it('handles → transform → the same handles', () => {
    const t = transformFromHandles('GRADIENT_RADIAL', [0.2, 0.3], [0.9, 0.4], [0.1, 0.8]);
    const [a, b, c] = gradientHandles(paint('GRADIENT_RADIAL', t));
    close(a, [0.2, 0.3]);
    close(b, [0.9, 0.4]);
    close(c, [0.1, 0.8]);
  });

  it('dragging the end of a linear gradient: the width stays perpendicular to the axis in pixels', () => {
    const p = paint('GRADIENT_LINEAR');
    const w = 200;
    const h = 100;
    const t = dragHandle(p, 1, [200, 100], w, h);
    const [a, b, c] = gradientHandles({ ...p, gradientTransform: t }).map(([x, y]) => [x * w, y * h]);
    close(a!, [100, 0]);
    close(b!, [200, 100]);
    const axis = [b![0]! - a![0]!, b![1]! - a![1]!];
    const width = [c![0]! - a![0]!, c![1]! - a![1]!];
    expect(axis[0]! * width[0]! + axis[1]! * width[1]!).toBeCloseTo(0, 6);
  });

  it('dragging the center of a radial gradient moves it entirely', () => {
    const p = paint('GRADIENT_RADIAL');
    const t = dragHandle(p, 0, [60, 30], 100, 100);
    const [a, b, c] = gradientHandles({ ...p, gradientTransform: t });
    close(a, [0.6, 0.3]);
    close(b, [1.1, 0.3]);
    close(c, [0.6, 0.8]);
  });
});

describe('gradient stops', () => {
  it('sorting remembers the selected stop', () => {
    const stops = [
      { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      { position: 0.3, color: { r: 1, g: 0, b: 0, a: 1 } },
    ];
    const r = sortStops(stops, 2);
    expect(r.stops.map((s) => s.position)).toEqual([0, 0.3, 1]);
    expect(r.index).toBe(1);
  });

  it('color in the middle is a blend of the neighboring stops', () => {
    const c = colorAt(paint('GRADIENT_LINEAR').gradientStops, 0.25);
    close([c.r, c.g, c.b, c.a], [0.75, 0, 0.25, 1]);
  });
});

describe('rotateGradient', () => {
  it('turns a gradient 90° clockwise around the layer center; four turns — back', async () => {
    const { rotateGradient, gradientHandles, defaultTransform } = await import('../src/gradient.ts');
    const p = { type: 'GRADIENT_LINEAR' as const, gradientTransform: defaultTransform('GRADIENT_LINEAR'), gradientStops: [] };
    const once = { ...p, gradientTransform: rotateGradient(p) };
    const [a, b] = gradientHandles(once);
    // Top to bottom → right to left.
    expect(a[0]).toBeCloseTo(1);
    expect(a[1]).toBeCloseTo(0.5);
    expect(b[0]).toBeCloseTo(0);
    expect(b[1]).toBeCloseTo(0.5);
    let q = once;
    for (let k = 0; k < 3; k++) q = { ...q, gradientTransform: rotateGradient(q) };
    q.gradientTransform.flat().forEach((v, i) => expect(v).toBeCloseTo(p.gradientTransform.flat()[i]!));
  });
});
