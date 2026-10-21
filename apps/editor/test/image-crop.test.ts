import { describe, expect, it } from 'vitest';
import { cropRect, cropTransform, placedRect } from '../src/image-crop.ts';
import type { ImagePaint } from '@mfp/core';

const image = (scaleMode: ImagePaint['scaleMode'], imageTransform?: ImagePaint['imageTransform']): ImagePaint => ({ type: 'IMAGE', scaleMode, imageHash: 'h', imageTransform, opacity: 1, visible: true });

describe('image crop', () => {
  it('image rectangle ⇄ imageTransform (layer → image coordinates)', () => {
    const r = { x: -50, y: -25, w: 400, h: 300 };
    const t = cropTransform(r, 300, 200);
    expect(t).toEqual([
      [0.75, 0, 0.125],
      [0, 2 / 3, 25 / 300],
    ]);
    const back = cropRect(t, 300, 200);
    expect(back.x).toBeCloseTo(-50);
    expect(back.y).toBeCloseTo(-25);
    expect(back.w).toBeCloseTo(400);
    expect(back.h).toBeCloseTo(300);
    // Layer point (0, 0) — in the image at (50, 25) of (400, 300): normalized (0.125, 0.0833).
    expect(t[0][2]).toBeCloseTo(50 / 400);
    expect(t[1][2]).toBeCloseTo(25 / 300);
  });

  it('entering crop without a jump: “Fill” acts as cover, “Fit” as contain', () => {
    // A square image in a 200×100 layer.
    expect(placedRect(image('FILL'), 200, 100, 1)).toEqual({ x: 0, y: -50, w: 200, h: 200 });
    expect(placedRect(image('FIT'), 200, 100, 1)).toEqual({ x: 50, y: 0, w: 100, h: 100 });
    // Already cropped — by its own matrix.
    const t = cropTransform({ x: 10, y: 20, w: 300, h: 150 }, 200, 100);
    const r = placedRect(image('CROP', t), 200, 100, 1);
    expect(r.x).toBeCloseTo(10);
    expect(r.w).toBeCloseTo(300);
  });
});
