import { describe, expect, it } from 'vitest';
import {
  Document,
  bezierAt,
  cloneNetwork,
  decodeNetwork,
  encodeNetwork,
  faceAt,
  mergeVertices,
  networkBounds,
  networkChains,
  networkFaces,
  networkFillPaths,
  networkFromSvg,
  networkOf,
  networkProps,
  regionIndexAt,
  removeSegments,
  removeVertices,
  segmentPoints,
  splitSegment,
  type VectorNetwork,
} from '../src/index.ts';

/** Square 0…size: 4 vertices, 4 segments, one region. */
function square(size = 10, dx = 0, dy = 0): VectorNetwork {
  return {
    vertices: [
      { x: dx, y: dy },
      { x: dx + size, y: dy },
      { x: dx + size, y: dy + size },
      { x: dx, y: dy + size },
    ],
    segments: [
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 0 },
    ],
    regions: [{ windingRule: 'NONZERO', loops: [[0, 1, 2, 3]] }],
  };
}

describe('vector network: storage', () => {
  it('string round trip: vertices with caps and mirroring, curves, regions with their own fills', () => {
    const net: VectorNetwork = {
      vertices: [
        { x: 0, y: 0, strokeCap: 'ROUND' },
        { x: 10.12345, y: 5, handleMirroring: 'ANGLE_AND_LENGTH' },
        { x: 20, y: 0, cornerRadius: 4, strokeJoin: 'BEVEL' },
      ],
      segments: [
        { start: 0, end: 1, tangentStart: { x: 3, y: -2 }, tangentEnd: { x: -3, y: 0 } },
        { start: 1, end: 2 },
        { start: 2, end: 0 },
      ],
      regions: [{ windingRule: 'EVENODD', loops: [[0, 1, 2]], fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] }],
    };
    const back = decodeNetwork(encodeNetwork(net))!;
    expect(back.vertices[1]).toEqual({ x: 10.123, y: 5, handleMirroring: 'ANGLE_AND_LENGTH' });
    expect(back.vertices[0]!.strokeCap).toBe('ROUND');
    expect(back.vertices[2]).toEqual({ x: 20, y: 0, cornerRadius: 4, strokeJoin: 'BEVEL' });
    expect(back.segments[0]).toEqual({ start: 0, end: 1, tangentStart: { x: 3, y: -2 }, tangentEnd: { x: -3, y: 0 } });
    expect(back.segments[1]).toEqual({ start: 1, end: 2 });
    expect(back.regions).toEqual(net.regions);
    // A corrupted string and a segment with a non-existent vertex — null.
    expect(decodeNetwork('{')).toBeNull();
    expect(decodeNetwork('{"v":[[0,0]],"s":[[0,5]]}')).toBeNull();
  });

  it('from an SVG path: open — no regions, closed — one region, mixed — no regions', () => {
    const open = networkFromSvg('M0 0L10 0L10 10')!;
    expect(open.vertices).toHaveLength(3);
    expect(open.segments).toHaveLength(2);
    expect(open.regions).toBeUndefined();
    const closed = networkFromSvg('M0 0L10 0L10 10L0 10Z', 'EVENODD')!;
    expect(closed.vertices).toHaveLength(4);
    expect(closed.segments).toHaveLength(4);
    expect(closed.regions).toEqual([{ windingRule: 'EVENODD', loops: [[0, 1, 2, 3]] }]);
    // The closing point coincides with the first — the same vertex.
    const repeat = networkFromSvg('M0 0C5 -5 10 -5 10 0L10 10L0 0Z')!;
    expect(repeat.vertices).toHaveLength(3);
    expect(repeat.segments).toHaveLength(3);
    expect(repeat.segments[2]).toEqual({ start: 2, end: 0 });
    expect(networkFromSvg('M0 0L10 0ZM20 20L30 30')!.regions).toBeUndefined();
    // Quadratic becomes cubic with the same ends.
    const q = networkFromSvg('M0 0Q5 10 10 0')!;
    expect(q.segments[0]!.tangentStart!.x).toBeCloseTo(10 / 3);
    expect(q.segments[0]!.tangentStart!.y).toBeCloseTo(20 / 3);
    // Arcs and relative commands are not handled here.
    expect(networkFromSvg('M0 0A5 5 0 0 1 10 0')).toBeNull();
    expect(networkFromSvg('m0 0l10 0')).toBeNull();
  });
});

describe('vector network: contours', () => {
  it('a region is a closed contour; without regions — the whole network', () => {
    expect(networkFillPaths(square())).toEqual([{ windingRule: 'NONZERO', data: 'M0 0L10 0L10 10L0 10Z' }]);
    // The loop is given “against” the segment directions — traversal follows shared vertices.
    const rev = square();
    rev.regions = [{ windingRule: 'NONZERO', loops: [[3, 2, 1, 0]] }];
    expect(networkFillPaths(rev)[0]!.data).toBe('M0 0L0 10L10 10L10 0Z');
    const open = networkFromSvg('M0 0L10 0L10 10')!;
    expect(networkFillPaths(open)).toEqual([{ windingRule: 'NONZERO', data: 'M0 0L10 0L10 10' }]);
  });

  it('centerlines: a fork gives three chains, a loop is closed', () => {
    const y: VectorNetwork = {
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
        { x: 10, y: 30 },
      ],
      segments: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 1, end: 3 },
      ],
    };
    const chains = networkChains(y);
    expect(chains).toHaveLength(3);
    expect(chains.every((c) => !c.closed)).toBe(true);
    const loop = networkChains(square());
    expect(loop).toEqual([{ data: 'M0 0L10 0L10 10L0 10Z', closed: true, startVertex: 0, endVertex: 0, segments: [0, 1, 2, 3] }]);
  });

  it('bounds follow curve extrema', () => {
    // Arc upward: ends at y = 0, the curve apex at y = -7.5.
    const arc: VectorNetwork = {
      vertices: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      segments: [{ start: 0, end: 1, tangentStart: { x: 0, y: -10 }, tangentEnd: { x: 0, y: -10 } }],
    };
    const b = networkBounds(arc)!;
    expect(b[0]).toBe(0);
    expect(b[2]).toBe(20);
    expect(b[1]).toBeCloseTo(-7.5);
    expect(b[3]).toBe(0);
  });
});

describe('vector network: editing', () => {
  it('splitting a segment: same shape, the region loop gets both pieces in order', () => {
    const net = cloneNetwork(square());
    const v = splitSegment(net, 1, 0.5);
    expect(net.vertices[v]).toEqual({ x: 10, y: 5 });
    expect(net.regions![0]!.loops[0]).toEqual([0, 1, 4, 2, 3]);
    expect(networkFillPaths(net)[0]!.data).toBe('M0 0L10 0L10 5L10 10L0 10Z');
    // Curve: the midpoint lies on the original curve, the handles are split.
    const arc: VectorNetwork = {
      vertices: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      segments: [{ start: 0, end: 1, tangentStart: { x: 0, y: -10 }, tangentEnd: { x: 0, y: -10 } }],
    };
    const before = bezierAt(segmentPoints(arc, 0), 0.3);
    const c = cloneNetwork(arc);
    const m = splitSegment(c, 0, 0.3);
    expect(c.vertices[m]!.x).toBeCloseTo(before.x);
    expect(c.vertices[m]!.y).toBeCloseTo(before.y);
    expect(bezierAt(segmentPoints(c, 1), 0.5).y).toBeLessThan(0);
  });

  it('deleting a vertex: in the middle — neighbors are joined (the region loop stays intact), at an end — it goes with its segment', () => {
    const net = cloneNetwork(square());
    removeVertices(net, new Set([1]));
    expect(net.vertices).toHaveLength(3);
    expect(net.segments).toHaveLength(3);
    expect(networkFillPaths(net)[0]!.data).toBe('M0 0L10 10L0 10Z');
    const open = networkFromSvg('M0 0L10 0L20 0')!;
    removeVertices(open, new Set([2]));
    expect(open.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(open.segments).toEqual([{ start: 0, end: 1 }]);
    // The neighbors' handles are kept on the new segment.
    const curve = networkFromSvg('M0 0C0 -5 5 -10 10 -10L20 0')!;
    removeVertices(curve, new Set([1]));
    expect(curve.segments).toEqual([{ start: 0, end: 1, tangentStart: { x: 0, y: -5 }, tangentEnd: { x: 0, y: 0 } }]);
  });

  it('deleting a segment: loops containing it are removed; merging ends closes the path', () => {
    const net = cloneNetwork(square());
    removeSegments(net, new Set([3]));
    expect(net.regions).toBeUndefined();
    expect(net.segments).toHaveLength(3);
    // Ends 3 and 0 merge — a loop again (without a region: the bucket sets it).
    mergeVertices(net, 3, 0);
    expect(net.vertices).toHaveLength(3);
    expect(networkChains(net)[0]!.closed).toBe(true);
  });
});

describe('vector network: faces and paint bucket', () => {
  /** A 20×10 rectangle split in half by a vertical segment. */
  function split(): VectorNetwork {
    return {
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      segments: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
        { start: 3, end: 4 },
        { start: 4, end: 5 },
        { start: 5, end: 0 },
        { start: 1, end: 4 },
      ],
    };
  }

  it('faces: two halves and the outer boundary', () => {
    const faces = networkFaces(split());
    const bounded = faces.filter((f) => f.area > 0).map((f) => [...f.loop].sort((a, b) => a - b));
    expect(bounded).toHaveLength(2);
    expect(bounded).toContainEqual([0, 4, 5, 6]);
    expect(bounded).toContainEqual([1, 2, 3, 6]);
    expect(faces.filter((f) => f.area < 0)).toHaveLength(1);
  });

  it('paint bucket: the face under the point; a miss — nothing', () => {
    const net = split();
    expect([...faceAt(net, 5, 5)!.loops[0]!].sort((a, b) => a - b)).toEqual([0, 4, 5, 6]);
    expect([...faceAt(net, 15, 5)!.loops[0]!].sort((a, b) => a - b)).toEqual([1, 2, 3, 6]);
    expect(faceAt(net, 30, 5)).toBeNull();
    // An open chain gives no faces.
    expect(faceAt(networkFromSvg('M0 0L10 0L10 10')!, 8, 2)).toBeNull();
  });

  it('paint bucket: a ring is the outer loop and a hole (even-odd), inside the hole — only the hole', () => {
    const outer = square(30);
    const inner = square(10, 10, 10);
    const net: VectorNetwork = {
      vertices: [...outer.vertices, ...inner.vertices],
      segments: [...outer.segments, ...inner.segments.map((g) => ({ start: g.start + 4, end: g.end + 4 }))],
    };
    const ring = faceAt(net, 5, 5)!;
    expect(ring.windingRule).toBe('EVENODD');
    expect(ring.loops).toHaveLength(2);
    const hole = faceAt(net, 15, 15)!;
    expect(hole.loops).toHaveLength(1);
    expect([...hole.loops[0]!].sort((a, b) => a - b)).toEqual([4, 5, 6, 7]);
    // Ring fill: a point in the hole is not in the region.
    net.regions = [ring];
    expect(regionIndexAt(net, 5, 5)).toBe(0);
    expect(regionIndexAt(net, 15, 15)).toBe(-1);
  });

  it('whiskers inside a face do not get into the region loop', () => {
    const net = cloneNetwork(square(20));
    net.regions = undefined;
    // A whisker from vertex 0 inward.
    const v = net.vertices.push({ x: 8, y: 8 }) - 1;
    net.segments.push({ start: 0, end: v });
    const r = faceAt(net, 15, 5)!;
    expect([...r.loops[0]!].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

describe('vector network in the document', () => {
  it('networkProps: bounds follow the shape, network and contours relative to the bounds corner; networkOf at the current size', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const id = doc.create('VECTOR', page, { transform: [1, 0, 100, 0, 1, 50], fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] });
    doc.set(id, networkProps(doc, id, square(10, 5, 5)));
    expect(doc.get(id, 'transform')).toEqual([1, 0, 105, 0, 1, 55]);
    expect(doc.get(id, 'width')).toBe(10);
    expect(doc.get(id, 'vectorPaths')).toEqual([{ windingRule: 'NONZERO', data: 'M0 0L10 0L10 10L0 10Z' }]);
    expect(doc.get(id, 'centerPaths')![0]!.data).toBe('M0 0L10 0L10 10L0 10Z');
    expect(networkOf(doc, id)!.vertices[2]).toEqual({ x: 10, y: 10 });
    // Stretched twice in width — the network at its current size.
    doc.set(id, { width: 20 });
    expect(networkOf(doc, id)!.vertices[2]).toEqual({ x: 20, y: 10 });
    // Into the geometry table (shared) — a reference that gets into the snapshot.
    doc.set(id, networkProps(doc, id, networkOf(doc, id)!, { shared: true }));
    const ref = doc.get(id, 'vectorNetwork')!;
    expect(ref.blob).toBeDefined();
    expect(doc.snapshot().blobs?.[ref.blob!]).toBeDefined();
  });

  it('a vector without a network (pre-network, from SVG) gets a network from its contours', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const id = doc.create('VECTOR', page, { width: 10, height: 10, vectorPaths: [{ windingRule: 'EVENODD', data: 'M0 0L10 0L10 10L0 10Z' }] });
    const net = networkOf(doc, id)!;
    expect(net.vertices).toHaveLength(4);
    expect(net.regions).toEqual([{ windingRule: 'EVENODD', loops: [[0, 1, 2, 3]] }]);
    expect(networkOf(doc, page)).toBeNull();
  });
});

describe('vertex corner rounding', () => {
  /** Square 100×100; the vertex (100, 0) has rounding r. */
  const square = (r: number) => {
    const net = networkFromSvg('M0 0L100 0L100 100L0 100Z')!;
    const v = net.vertices.findIndex((p) => p.x === 100 && p.y === 0);
    const out = cloneNetwork(net);
    out.vertices[v]!.cornerRadius = r;
    return out;
  };

  it('the corner between straight lines is cut by an arc of radius r — in fill and stroke', () => {
    const fill = networkFillPaths(square(20))[0]!.data;
    // The side reaches 80, the arc goes to (100, 20); control points are at 0.5523·r from the ends.
    expect(fill).toContain('L80 0C91.046 0 100 8.954 100 20');
    expect(networkChains(square(20))[0]!.data).toContain('C91.046 0 100 8.954 100 20');
  });

  it('radius at most half of the shorter segments; without rounding — the contour as before', () => {
    expect(networkFillPaths(square(500))[0]!.data).toContain('L50 0C77.614 0 100 22.386 100 50');
    expect(networkFillPaths(square(0))[0]!.data).toBe(networkFillPaths(networkFromSvg('M0 0L100 0L100 100L0 100Z')!)[0]!.data);
  });
});
