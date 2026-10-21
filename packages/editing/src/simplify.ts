// Simplify the vector network (“Simplify path”): each chain of
// segments between branches and ends is refitted with curves through points within tolerance (fit-curve),
// sharp corners stay corners, nearly straight pieces become straight. Branches and ends stay in place;
// regions move to the new segments of the same chains.

import { bezierAt, isStraight, loopVertices, networkChains, segmentPoints, type VectorNetwork, type VectorRegion, type VectorSegment } from '@mfp/core';
import { fitCurve, type CurvePoint } from './fit-curve.ts';

type XY = { x: number; y: number };

/** The angle at vertex v between segments k1 (incoming) and k2 (outgoing) is sharper than the threshold — it is a corner. */
function isCorner(net: VectorNetwork, k1: number, k2: number, v: number, minAngle: number): boolean {
  const dir = (k: number) => {
    const g = net.segments[k]!;
    const p = segmentPoints(net, k, g.start !== v);
    let d = { x: p[1].x - p[0].x, y: p[1].y - p[0].y };
    if (Math.hypot(d.x, d.y) < 1e-9) d = { x: p[2].x - p[0].x, y: p[2].y - p[0].y };
    if (Math.hypot(d.x, d.y) < 1e-9) d = { x: p[3].x - p[0].x, y: p[3].y - p[0].y };
    const l = Math.hypot(d.x, d.y) || 1;
    return { x: d.x / l, y: d.y / l };
  };
  const a = dir(k1);
  const b = dir(k2);
  // Smooth — when the exits from v along k1 and along k2 point in opposite directions.
  const cos = -(a.x * b.x + a.y * b.y);
  return Math.acos(Math.max(-1, Math.min(1, cos))) > minAngle;
}

/** A nearly straight curve (control points within tol of the chord) becomes a straight segment. */
function nearlyStraight(c: [XY, XY, XY, XY], tol: number): boolean {
  const dx = c[3].x - c[0].x;
  const dy = c[3].y - c[0].y;
  const l = Math.hypot(dx, dy);
  const dist = (p: XY) => (l > 1e-9 ? Math.abs(dx * (p.y - c[0].y) - dy * (p.x - c[0].x)) / l : Math.hypot(p.x - c[0].x, p.y - c[0].y));
  return dist(c[1]) <= tol && dist(c[2]) <= tol;
}

export function simplifyNetwork(net: VectorNetwork, tolerance: number, minAngle = (25 * Math.PI) / 180): VectorNetwork {
  const chains = networkChains(net);
  const out: VectorNetwork = { vertices: [], segments: [] };
  const kept = new Map<number, number>();
  const keep = (v: number) => {
    let k = kept.get(v);
    if (k === undefined) kept.set(v, (k = out.vertices.push({ ...net.vertices[v]! }) - 1));
    return k;
  };
  /** New segments of each chain (in traversal order) and in which direction the chain passed each old segment. */
  const chainSegs: number[][] = [];
  const segChain = new Map<number, number>();
  const chainFrom = new Map<number, number>();
  chains.forEach((ch, ci) => {
    const pts: CurvePoint[] = [];
    const corners: number[] = [];
    let cur = ch.startVertex;
    pts.push({ x: net.vertices[cur]!.x, y: net.vertices[cur]!.y });
    ch.segments.forEach((k, i) => {
      segChain.set(k, ci);
      chainFrom.set(k, cur);
      const g = net.segments[k]!;
      const rev = g.start !== cur;
      const p = segmentPoints(net, k, rev);
      const n = isStraight(g) ? 1 : 24;
      for (let j = 1; j <= n; j++) pts.push(n === 1 ? { ...p[3] } : bezierAt(p, j / n));
      cur = rev ? g.start : g.end;
      if (i < ch.segments.length - 1 && isCorner(net, k, ch.segments[i + 1]!, cur, minAngle)) corners.push(pts.length - 1);
    });
    const curves = fitCurve(pts, tolerance, corners);
    const segs: number[] = [];
    let prev = keep(ch.startVertex);
    curves.forEach((c, i) => {
      const last = i === curves.length - 1;
      const end = last ? keep(ch.endVertex) : out.vertices.push({ x: c[3].x, y: c[3].y }) - 1;
      const g: VectorSegment = { start: prev, end };
      if (!nearlyStraight(c, tolerance / 4)) {
        g.tangentStart = { x: c[1].x - c[0].x, y: c[1].y - c[0].y };
        g.tangentEnd = { x: c[2].x - c[3].x, y: c[2].y - c[3].y };
      }
      segs.push(out.segments.push(g) - 1);
      prev = end;
    });
    // New vertices inside a chain: smooth joints are mirrored, corners are free.
    for (let i = 0; i + 1 < segs.length; i++) {
      const v = out.segments[segs[i]!]!.end;
      const isCornerHere = corners.some((ci2) => {
        const p = pts[ci2]!;
        const q = out.vertices[v]!;
        return Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9;
      });
      out.vertices[v]!.handleMirroring = isCornerHere ? 'NONE' : 'ANGLE';
    }
    chainSegs.push(segs);
  });
  // Regions: a loop is consecutive chains (whole), each with its new segments.
  if (net.regions?.length) {
    const regions: VectorRegion[] = [];
    for (const r of net.regions) {
      const loops: number[][] = [];
      for (const loop of r.loops) {
        const from = loopVertices(net, loop);
        if (!from) continue;
        const n = loop.length;
        // Start at a chain boundary (a closed chain has no boundary — start at its beginning).
        let start = 0;
        for (let i = 0; i < n; i++) {
          if (segChain.get(loop[(i - 1 + n) % n]!) !== segChain.get(loop[i]!)) {
            start = i;
            break;
          }
        }
        const mapped: number[] = [];
        let i = 0;
        while (i < n) {
          const idx = (start + i) % n;
          const c = segChain.get(loop[idx]!);
          if (c === undefined) break;
          let j = i;
          while (j < n && segChain.get(loop[(start + j) % n]!) === c) j++;
          const forward = chainFrom.get(loop[idx]!) === from[idx];
          const segs = chainSegs[c]!;
          mapped.push(...(forward ? segs : [...segs].reverse()));
          i = j;
        }
        if (mapped.length) loops.push(mapped);
      }
      if (loops.length) regions.push({ ...r, loops });
    }
    if (regions.length) out.regions = regions;
  }
  return out;
}
