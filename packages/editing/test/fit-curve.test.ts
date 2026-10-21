import { describe, expect, it } from 'vitest';
import { cornerIndices, fitCurve, simplifyPolyline, type CurvePoint, type Cubic } from '../src/index.ts';

const at = (q: Cubic, t: number): CurvePoint => {
  const u = 1 - t;
  return {
    x: u * u * u * q[0].x + 3 * u * u * t * q[1].x + 3 * u * t * t * q[2].x + t * t * t * q[3].x,
    y: u * u * u * q[0].y + 3 * u * u * t * q[1].y + 3 * u * t * t * q[2].y + t * t * t * q[3].y,
  };
};

/** Largest distance from the points to the curves (brute force over the parameter). */
function deviation(points: CurvePoint[], curves: Cubic[]): number {
  let worst = 0;
  for (const p of points) {
    let best = Infinity;
    for (const q of curves) for (let i = 0; i <= 100; i++) best = Math.min(best, Math.hypot(at(q, i / 100).x - p.x, at(q, i / 100).y - p.y));
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('curve fitting', () => {
  it('a freehand arc becomes a few smooth curves within the error', () => {
    // Semicircle of radius 100 with ±0.5 px jitter.
    const pts: CurvePoint[] = [];
    for (let i = 0; i <= 120; i++) {
      const a = (Math.PI * i) / 120;
      const r = 100 + Math.sin(i * 7.3) * 0.5;
      pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    const curves = fitCurve(pts, 2);
    expect(curves.length).toBeGreaterThan(0);
    expect(curves.length).toBeLessThanOrEqual(4);
    expect(deviation(pts, curves)).toBeLessThan(2.5);
    // Joins are smooth: tangents lie on one line.
    for (let i = 1; i < curves.length; i++) {
      const a = curves[i - 1]!;
      const b = curves[i]!;
      const t1 = { x: a[3].x - a[2].x, y: a[3].y - a[2].y };
      const t2 = { x: b[1].x - b[0].x, y: b[1].y - b[0].y };
      expect(Math.abs(t1.x * t2.y - t1.y * t2.x) / (Math.hypot(t1.x, t1.y) * Math.hypot(t2.x, t2.y))).toBeLessThan(1e-6);
    }
  });

  it('L-shaped corner: the corner point is a curve boundary, the corner stays sharp', () => {
    const pts: CurvePoint[] = [];
    for (let i = 0; i <= 50; i++) pts.push({ x: 0, y: 100 - i * 2 });
    for (let i = 1; i <= 50; i++) pts.push({ x: i * 2, y: 0 });
    const corners = cornerIndices(pts);
    expect(corners).toEqual([50]);
    const curves = fitCurve(pts, 1, corners);
    expect(curves[0]![3]).toEqual({ x: 0, y: 0 });
    expect(deviation(pts, curves)).toBeLessThan(1);
    // A smooth arc produces no corners.
    const arc: CurvePoint[] = [];
    for (let i = 0; i <= 60; i++) arc.push({ x: Math.cos(i / 20) * 100, y: Math.sin(i / 20) * 100 });
    expect(cornerIndices(arc)).toEqual([]);
  });

  it('polyline simplification: nearly collinear points are removed, vertices stay', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0.1 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 10.1, y: 15 },
      { x: 10, y: 20 },
    ];
    expect(simplifyPolyline(pts, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ]);
  });
});
