import { bezierAt, isStraight, networkChains, segmentPoints, type VectorNetwork, type Props } from '@mfp/core';

function segmentLength(net: VectorNetwork, k: number, reversed: boolean, t: number): number {
  const points = segmentPoints(net, k, reversed);
  if (isStraight(net.segments[k]!)) return Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y) * t;
  const length = (a: number, b: number, depth: number): number => {
    const p = bezierAt(points, a), q = bezierAt(points, b), m = bezierAt(points, (a + b) / 2);
    const chord = Math.hypot(q.x - p.x, q.y - p.y);
    const poly = Math.hypot(m.x - p.x, m.y - p.y) + Math.hypot(q.x - m.x, q.y - m.y);
    if (depth >= 16 || (depth >= 3 && poly - chord < 0.00001)) return poly;
    return length(a, (a + b) / 2, depth + 1) + length((a + b) / 2, b, depth + 1);
  };
  return length(0, t, 0);
}

/** Convert the API's segment/position to the editor's contour/arc-length offset.
 * Keep the full chain, so closed paths wrap and open paths retain their start. */
export function textPathFromStart(net: VectorNetwork, segment: number, position: number): NonNullable<Props['textPath']> {
  if (!Number.isInteger(segment) || segment < 0 || segment >= net.segments.length) throw new Error('textPathStartData.segment: invalid segment index');
  if (!Number.isFinite(position) || position < 0 || position > 1) throw new Error('textPathStartData.position: expected a number from 0 to 1');
  const chain = networkChains(net).find((c) => c.segments.includes(segment));
  if (!chain) throw new Error('Text path has no contour');
  let vertex = chain.startVertex;
  let offset = 0;
  for (const k of chain.segments) {
    const g = net.segments[k]!;
    const reversed = g.start !== vertex;
    const t = k === segment ? (reversed ? 1 - position : position) : 1;
    offset += segmentLength(net, k, reversed, t);
    if (k === segment) break;
    vertex = reversed ? g.start : g.end;
  }
  return { data: chain.data, offset, startData: { segment, position } };
}

/** Older editor-created paths saved only an arc-length offset. Infer their API
 * starting point without changing the document simply by reading a property. */
export function textPathStartFromOffset(net: VectorNetwork, offset: number): { segment: number; position: number } {
  const chain = networkChains(net)[0];
  if (!chain?.segments.length) return { segment: 0, position: 0 };
  let vertex = chain.startVertex;
  let length = 0;
  const ranges = chain.segments.map((segment) => {
    const g = net.segments[segment]!;
    const reverse = g.start !== vertex;
    vertex = reverse ? g.start : g.end;
    const start = length;
    length += segmentLength(net, segment, reverse, 1);
    return { segment, reverse, start, end: length };
  });
  const total = ranges.at(-1)!.end;
  const at = chain.closed && total > 0 ? ((offset % total) + total) % total : Math.max(0, Math.min(total, offset));
  const range = ranges.find((r) => r.end >= at) ?? ranges.at(-1)!;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const s = range.start + segmentLength(net, range.segment, range.reverse, mid);
    if (s < at) lo = mid; else hi = mid;
  }
  return { segment: range.segment, position: range.reverse ? 1 - (lo + hi) / 2 : (lo + hi) / 2 };
}
