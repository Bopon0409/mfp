// Freeform gradient (MFP's own): preset, CSS approximation for swatches and CSS export.
// The renderer draws it (SkSL, inverse distances); CSS cannot do that, so it uses a stack of radial
// gradients from the points to transparent over the average color.

import type { FreeformGradientPaint, RGBA } from '@mfp/core';

const rgba = (c: RGBA, a = 1) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${Math.round(c.a * a * 1000) / 1000})`;

/** New freeform gradient: four corner points derived from a color (warm and cool shades nearby). */
export function defaultFreeform(base: RGBA = { r: 0.95, g: 0.35, b: 0.45, a: 1 }): FreeformGradientPaint['points'] {
  const shift = (dr: number, dg: number, db: number): RGBA => ({ r: Math.min(1, Math.max(0, base.r + dr)), g: Math.min(1, Math.max(0, base.g + dg)), b: Math.min(1, Math.max(0, base.b + db)), a: base.a });
  return [
    { x: 0.15, y: 0.2, color: { ...base } },
    { x: 0.85, y: 0.15, color: shift(-0.4, 0.2, 0.45) },
    { x: 0.8, y: 0.85, color: shift(-0.6, 0.3, -0.1) },
    { x: 0.2, y: 0.8, color: shift(0.05, 0.45, -0.3) },
  ];
}

/** Average color of the points (approximation background, text color). */
export function freeformAverage(points: FreeformGradientPaint['points']): RGBA {
  const n = Math.max(1, points.length);
  const s = points.reduce((a, p) => ({ r: a.r + p.color.r, g: a.g + p.color.g, b: a.b + p.color.b, a: a.a + p.color.a }), { r: 0, g: 0, b: 0, a: 0 });
  return { r: s.r / n, g: s.g / n, b: s.b / n, a: s.a / n };
}

/** CSS background: radial spots of the points over the average color. */
export function freeformCss(p: Pick<FreeformGradientPaint, 'points' | 'opacity'>): string {
  const op = p.opacity ?? 1;
  const spots = p.points.map((q) => `radial-gradient(circle at ${Math.round(q.x * 1000) / 10}% ${Math.round(q.y * 1000) / 10}%, ${rgba(q.color, op)}, ${rgba({ ...q.color, a: 0 })} ${Math.round((q.spread ?? 0.5) * 140)}%)`);
  const avg = freeformAverage(p.points);
  return [...spots, `linear-gradient(${rgba(avg, op)}, ${rgba(avg, op)})`].join(', ');
}
