// Spike A: a synthetic page with N rectangles for render benchmarking.

import type { SceneNode, ScenePage } from '@mfp/io-figma';

export function makeStressPage(count: number): ScenePage {
  const cols = Math.ceil(Math.sqrt(count));
  const size = 20;
  const gap = 6;
  const children: SceneNode[] = [];
  for (let i = 0; i < count; i++) {
    const x = (i % cols) * (size + gap);
    const y = Math.floor(i / cols) * (size + gap);
    const hue = (i * 0.618) % 1;
    children.push({
      key: `stress:${i}`,
      type: 'RECTANGLE',
      name: `rect ${i}`,
      visible: true,
      opacity: 1,
      blendMode: 'PASS_THROUGH',
      transform: [1, 0, x, 0, 1, y],
      size: { x: size, y: size },
      fills: [{ type: 'SOLID', color: hsl(hue, 0.6, 0.55), opacity: 1 }],
      strokes: [],
      fillGeometry: [],
      strokeGeometry: [],
      effects: [],
      clipsContent: false,
      isMask: false,
      maskType: 'ALPHA',
      glyphs: undefined,
      children: [],
    });
  }
  return { key: 'stress', name: `Стресс ${count}`, backgroundColor: { r: 0.12, g: 0.12, b: 0.12, a: 1 }, children };
}

function hsl(h: number, s: number, l: number) {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: f(0), g: f(8), b: f(4), a: 1 };
}
