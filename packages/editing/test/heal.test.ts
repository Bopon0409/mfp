import { expect, it } from 'vitest';
import { bezierAt, cloneNetwork, loopVertices, segmentPoints, splitSegment, type VectorNetwork } from '@mfp/core';
import { healVertices } from '../src/heal.ts';

it('heals a subdivided cubic while preserving endpoints and curve shape', () => {
  const net: VectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }], segments: [{ start: 0, end: 1, tangentStart: { x: 0, y: 100 }, tangentEnd: { x: 0, y: 100 } }] };
  const original = segmentPoints(net, 0);
  const a = splitSegment(net, 0, 0.5);
  const b = splitSegment(net, 0, 0.5);
  healVertices(net, new Set([a, b]));
  expect(net.vertices).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  expect(net.segments).toHaveLength(1);
  const result = segmentPoints(net, 0);
  for (let i = 0; i <= 20; i++) {
    const p = bezierAt(original, i / 20), q = bezierAt(result, i / 20);
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1);
  }
});

function polygon(): VectorNetwork {
  return { vertices: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 4 }, { start: 4, end: 5 }, { start: 5, end: 0 }],
    regions: [{ windingRule: 'EVENODD', loops: [[0, 1, 2, 3, 4, 5]], fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] }],
  };
}

it('heals consecutive points without losing a region or its fill', () => {
  const net = polygon();
  healVertices(net, new Set([1, 2]));
  expect(net.vertices).toHaveLength(4);
  expect(net.segments).toHaveLength(4);
  expect(loopVertices(net, net.regions![0]!.loops[0]!)).toHaveLength(4);
  expect(net.regions![0]!.fills![0]).toMatchObject({ color: { r: 1, g: 0, b: 0 } });
});

it('point selection order and reversed segment directions do not affect topology', () => {
  for (const order of [[1, 2], [2, 1]]) {
    const net = polygon();
    net.segments = net.segments.map((s) => ({ start: s.end, end: s.start }));
    healVertices(net, new Set(order));
    expect(net.segments).toHaveLength(4);
    expect(loopVertices(net, net.regions![0]!.loops[0]!)).toHaveLength(4);
  }
});

it('deleting a branch never creates arbitrary connections between surviving arms', () => {
  const net: VectorNetwork = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 10 }], segments: [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 1, end: 3 }] };
  healVertices(net, new Set([1]));
  expect(net.segments).toHaveLength(0);
  expect(net.vertices).toHaveLength(3);
});

it('unselected segments are unchanged; empty and total selections remain valid', () => {
  const net = polygon(), before = cloneNetwork(net);
  healVertices(net, new Set());
  expect(net).toEqual(before);
  const unchanged = net.segments[3];
  healVertices(net, new Set([1]));
  expect(net.segments).toContain(unchanged);
  healVertices(net, new Set(net.vertices.map((_, i) => i)));
  expect(net.vertices).toEqual([]);
  expect(net.segments).toEqual([]);
  expect(net.regions).toEqual([]);
});
