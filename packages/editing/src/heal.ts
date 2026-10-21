import { adjacency, bezierAt, isStraight, loopVertices, segmentPoints, type VectorNetwork, type VectorSegment } from '@mfp/core';
import { fitSingleCurve, type CurvePoint } from './fit-curve.ts';

/** Remove selected degree-two runs, fitting a single curve between surviving endpoints.
 * Branches and terminal vertices are removed without inventing new connections.
 */
export function healVertices(net: VectorNetwork, drop: ReadonlySet<number>): void {
  if (!drop.size) return;
  const adj = adjacency(net);
  const processed = new Set<number>();
  const replacements = new Map<number, { old: number[]; segment: VectorSegment }>();
  for (let a = 0; a < net.vertices.length; a++) {
    if (drop.has(a)) continue;
    for (const first of adj[a]!) {
      if (processed.has(first)) continue;
      const g = net.segments[first]!;
      const next = g.start === a ? g.end : g.start;
      if (!drop.has(next)) continue;
      let v = a, k = first;
      const old: number[] = [];
      const points: CurvePoint[] = [{ ...net.vertices[a]! }];
      let startDirection: CurvePoint | undefined, endDirection: CurvePoint | undefined;
      let b = -1;
      while (!processed.has(k)) {
        processed.add(k); old.push(k);
        const edge = net.segments[k]!;
        const p = segmentPoints(net, k, edge.start !== v);
        startDirection ??= { x: p[1].x - p[0].x, y: p[1].y - p[0].y };
        endDirection = { x: p[2].x - p[3].x, y: p[2].y - p[3].y };
        // Sample straight edges too: unequal original segment lengths must not bias fitting.
        const samples = isStraight(edge) ? 8 : 24;
        for (let i = 1; i <= samples; i++) points.push(bezierAt(p, i / samples));
        v = edge.start === v ? edge.end : edge.start;
        if (!drop.has(v)) { b = v; break; }
        if (adj[v]!.length !== 2) break;
        k = adj[v]!.find((s) => s !== k)!;
      }
      if (b < 0 || b === a) continue;
      const c = fitSingleCurve(points, startDirection, endDirection);
      if (!c) continue;
      replacements.set(old.reduce((a, b) => Math.min(a, b)), { old, segment: { start: a, end: b,
        tangentStart: { x: c[1].x - c[0].x, y: c[1].y - c[0].y },
        tangentEnd: { x: c[2].x - c[3].x, y: c[2].y - c[3].y },
      } });
    }
  }
  const segments: VectorSegment[] = [];
  const map = new Map<number, number>();
  net.segments.forEach((g, k) => {
    const r = replacements.get(k);
    if (r) {
      const index = segments.push(r.segment) - 1;
      for (const s of r.old) map.set(s, index);
    } else if (!processed.has(k) && !drop.has(g.start) && !drop.has(g.end)) map.set(k, segments.push(g) - 1);
  });
  const vertices = new Map<number, number>();
  net.vertices = net.vertices.filter((_, i) => {
    if (drop.has(i)) return false;
    vertices.set(i, vertices.size); return true;
  });
  net.segments = segments;
  for (const g of segments) { g.start = vertices.get(g.start)!; g.end = vertices.get(g.end)!; }
  if (net.regions) net.regions = net.regions.map((r) => ({ ...r, loops: r.loops.flatMap((l) => {
    if (l.some((k) => !map.has(k))) return [];
    const mapped = l.map((k) => map.get(k)!);
    const clean = mapped.filter((k, i) => i === 0 || k !== mapped[i - 1]);
    if (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
    return loopVertices(net, clean) ? [clean] : [];
  }) })).filter((r) => r.loops.length);
}
