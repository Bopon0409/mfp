import type { Pt } from './gradient.ts';

export type GradientGuide = [Pt, Pt];
/** Snap in layer coordinates, measuring tolerance in screen pixels (also for rotated layers). */
export function snapGradientPoint(point: Pt, w: number, h: number, screen: (p: Pt) => Pt,
  others: Pt[] = [], constraint?: { origin: Pt; direction: Pt }) {
  const xs = [...new Set([0, w / 2, w, ...others.map(p => p[0])])];
  const ys = [...new Set([0, h / 2, h, ...others.map(p => p[1])])];
  const distance = (a: Pt, b: Pt) => { const u = screen(a), v = screen(b); return Math.hypot(u[0] - v[0], u[1] - v[1]); };
  let to: Pt = [...point];
  if (constraint) {
    const { origin: o, direction: d } = constraint;
    const candidates: Pt[] = [];
    if (Math.abs(d[0]) > 1e-8) for (const x of xs) candidates.push([x, o[1] + (x - o[0]) * d[1] / d[0]]);
    if (Math.abs(d[1]) > 1e-8) for (const y of ys) candidates.push([o[0] + (y - o[1]) * d[0] / d[1], y]);
    let best = 6;
    for (const p of candidates) { const n = distance(point, p); if (n <= best && distance(o, p) > 0.01) { best = n; to = p; } }
  } else {
    let bestX = 6, bestY = 6;
    for (const x of xs) { const n = distance(point, [x, point[1]]); if (n <= bestX) { bestX = n; to[0] = x; } }
    for (const y of ys) { const n = distance(point, [point[0], y]); if (n <= bestY) { bestY = n; to[1] = y; } }
  }
  const guides: GradientGuide[] = [];
  for (const x of xs) if (Math.abs(to[0] - x) < 1e-7) guides.push([[x, Math.min(0, to[1])], [x, Math.max(h, to[1])]]);
  for (const y of ys) if (Math.abs(to[1] - y) < 1e-7) guides.push([[Math.min(0, to[0]), y], [Math.max(w, to[0]), y]]);
  return { point: to, guides };
}
