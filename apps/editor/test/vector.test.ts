import { describe, expect, it } from 'vitest';
import { networkChains, networkFillPaths, type VectorNetwork } from '@mfp/core';
import { cutNetwork, eraseNetwork, pencilNetwork, vertexType, vectorKey } from '../src/vector.ts';

it('vector tool and eraser shortcuts keep their physical keys in Cyrillic', () => {
  expect(vectorKey({ code: 'KeyB', key: 'и' })).toBe('b');
  expect(vectorKey({ code: 'BracketLeft', key: 'х' })).toBe('[');
  expect(vectorKey({ code: 'BracketRight', key: 'ъ' })).toBe(']');
  expect(vectorKey({ code: 'ArrowLeft', key: 'ArrowLeft' })).toBe('arrowleft');
});

/** A 0…10 square with one region. */
function square(): VectorNetwork {
  return {
    vertices: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
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

describe('vector network point type', () => {
  it('corner, mirrored, free; explicit mirroring takes precedence', () => {
    const net: VectorNetwork = {
      vertices: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ],
      segments: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
    };
    expect(vertexType(net, 1)).toBe('STRAIGHT');
    net.segments[0] = { start: 0, end: 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: -3, y: 0 } };
    net.segments[1] = { start: 1, end: 2, tangentStart: { x: 3, y: 0 }, tangentEnd: { x: 0, y: 0 } };
    expect(vertexType(net, 1)).toBe('ANGLE_AND_LENGTH');
    net.segments[1]!.tangentStart = { x: 5, y: 0 };
    expect(vertexType(net, 1)).toBe('ANGLE');
    net.segments[1]!.tangentStart = { x: 3, y: 3 };
    expect(vertexType(net, 1)).toBe('NONE');
    net.vertices[1]!.handleMirroring = 'ANGLE_AND_LENGTH';
    expect(vertexType(net, 1)).toBe('ANGLE_AND_LENGTH');
  });
});

describe('pencil', () => {
  it('a freehand L-shaped corner — two curves and a corner; end near the start — closed', () => {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 40; i++) pts.push({ x: 0, y: 80 - i * 2 });
    for (let i = 1; i <= 40; i++) pts.push({ x: i * 2, y: 0 });
    const net = pencilNetwork(pts, 1, 4)!;
    expect(net.segments.length).toBe(2);
    expect(net.vertices[1]).toMatchObject({ x: 0, y: 0, handleMirroring: 'NONE' });
    // Freehand circle: the end is near the start — a single loop.
    const circle: { x: number; y: number }[] = [];
    for (let i = 0; i <= 64; i++) circle.push({ x: Math.cos((i / 64) * Math.PI * 2) * 50, y: Math.sin((i / 64) * Math.PI * 2) * 50 + (i === 64 ? 1 : 0) });
    const loop = pencilNetwork(circle, 1, 4)!;
    expect(networkChains(loop)).toHaveLength(1);
    expect(networkChains(loop)[0]!.closed).toBe(true);
  });
});

describe('knife', () => {
  it('a filled square cut in half — two regions; a line that misses — nothing', () => {
    const net = square();
    cutNetwork(net, [
      { x: -5, y: 5 },
      { x: 15, y: 5 },
    ], false);
    expect(net.regions).toHaveLength(2);
    // New points on the sides and a cut segment between them.
    expect(net.vertices).toContainEqual({ x: 10, y: 5 });
    expect(net.vertices).toContainEqual({ x: 0, y: 5 });
    expect(networkFillPaths(net)).toHaveLength(2);
    const untouched = square();
    cutNetwork(untouched, [
      { x: 20, y: 0 },
      { x: 30, y: 10 },
    ], false);
    expect(untouched).toEqual(square());
  });

  it('an open path splits at the cut point', () => {
    const net: VectorNetwork = {
      vertices: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      segments: [{ start: 0, end: 1 }],
    };
    cutNetwork(net, [
      { x: 10, y: -5 },
      { x: 10, y: 5 },
    ], false);
    expect(net.segments).toHaveLength(2);
    // Two separate chains: two copies at the cut point.
    expect(networkChains(net)).toHaveLength(2);
    expect(net.vertices.filter((v) => v.x === 10)).toHaveLength(2);
  });

  it('a vector filled entirely (no regions) splits into two filled regions', () => {
    const net = square();
    delete net.regions;
    cutNetwork(net, [
      { x: 5, y: -5 },
      { x: 5, y: 15 },
    ], true);
    expect(net.regions).toHaveLength(2);
  });
});

describe('vector network eraser', () => {
  it('line: the middle erased — two pieces with ends at the edge of the trace', () => {
    const net: VectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }], segments: [{ start: 0, end: 1 }] };
    expect(eraseNetwork(net, [{ x: 50, y: -20 }, { x: 50, y: 20 }], 5)).toBe(true);
    expect(net.segments.length).toBe(2);
    const xs = net.segments.map((g) => [net.vertices[g.start]!.x, net.vertices[g.end]!.x].sort((a, b) => a - b));
    xs.sort((a, b) => a[0]! - b[0]!);
    expect(xs[0]![0]).toBeCloseTo(0, 6);
    expect(xs[0]![1]).toBeCloseTo(45, 2);
    expect(xs[1]![0]).toBeCloseTo(55, 2);
    expect(xs[1]![1]).toBeCloseTo(100, 6);
  });

  it('a segment fully under the eraser is removed along with its vertices; a miss — nothing', () => {
    const net: VectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 200, y: 0 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }] };
    expect(eraseNetwork(net, [{ x: 0, y: 300 }], 5)).toBe(false);
    eraseNetwork(net, [{ x: -5, y: 0 }, { x: 12, y: 0 }], 4);
    expect(net.segments.length).toBe(1);
    expect(net.vertices.length).toBe(2);
    expect(Math.min(...net.vertices.map((v) => v.x))).toBeCloseTo(16, 1);
  });

  it('closed square: a side cut — the path is opened, the region is gone', () => {
    const net: VectorNetwork = {
      vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 0 }],
      regions: [{ windingRule: 'NONZERO', loops: [[0, 1, 2, 3]] }],
    };
    eraseNetwork(net, [{ x: 50, y: -10 }, { x: 50, y: 10 }], 6);
    expect(net.segments.length).toBe(5);
    expect(net.regions).toBeUndefined();
  });

  it('curve: the ends of the remaining pieces are at the radius distance from the trace', () => {
    const net: VectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }], segments: [{ start: 0, end: 1, tangentStart: { x: 30, y: -60 }, tangentEnd: { x: -30, y: -60 } }] };
    const line = [{ x: 50, y: -100 }, { x: 50, y: 50 }];
    eraseNetwork(net, line, 8);
    expect(net.segments.length).toBe(2);
    const ends = net.vertices.filter((v) => Math.abs(v.x - 50) < 20);
    expect(ends.length).toBe(2);
    for (const v of ends) expect(Math.abs(v.x - 50)).toBeCloseTo(8, 1);
  });
});
