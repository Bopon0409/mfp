import { describe, expect, it } from 'vitest';
import type { Op } from '@mfp/core';
import { opImages } from '../src/collab.ts';

describe('files to the server during collaboration', () => {
  it('images, videos, Lottie, 3D models and sounds from edits all go to the server', () => {
    const ops = [
      { op: 'create', id: '1:1', type: 'RECTANGLE', parent: '0:1', props: { fills: [{ type: 'MODEL3D', scaleMode: 'FIT', modelHash: 'model' }, { type: 'IMAGE', scaleMode: 'FILL', imageHash: 'image' }] } },
      { op: 'set', id: '1:2', props: { fills: [{ type: 'VIDEO', scaleMode: 'FILL', videoHash: 'video' }], strokes: [{ type: 'LOTTIE', scaleMode: 'FIT', lottieHash: 'lottie' }] } },
      { op: 'set', id: '1:3', props: { reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'SOUND', soundHash: 'sound' }] }] } },
      { op: 'delete', id: '1:4' },
    ] as unknown as Op[];
    expect(opImages(ops).sort()).toEqual(['image', 'lottie', 'model', 'sound', 'video']);
  });
});
