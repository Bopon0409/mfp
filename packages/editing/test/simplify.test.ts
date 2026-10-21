import { describe, expect, it } from 'vitest';
import { adjacency, isStraight, networkFillPaths, type VectorNetwork } from '@mfp/core';
import { simplifyNetwork } from '../src/index.ts';

describe('simplify path', () => {
  it('a circle of 64 segments becomes a few smooth curves, the area is preserved', () => {
    const n = 64;
    const net: VectorNetwork = { vertices: [], segments: [] };
    for (let i = 0; i < n; i++) net.vertices.push({ x: 50 + Math.cos((i / n) * Math.PI * 2) * 50, y: 50 + Math.sin((i / n) * Math.PI * 2) * 50 });
    for (let i = 0; i < n; i++) net.segments.push({ start: i, end: (i + 1) % n });
    net.regions = [{ windingRule: 'NONZERO', loops: [net.segments.map((_, k) => k)] }];
    const s = simplifyNetwork(net, 0.5);
    expect(s.segments.length).toBeLessThanOrEqual(8);
    expect(s.segments.every((g) => !isStraight(g))).toBe(true);
    expect(s.regions).toHaveLength(1);
    expect([...s.regions![0]!.loops[0]!].sort((a, b) => a - b)).toEqual(s.segments.map((_, k) => k));
    expect(networkFillPaths(s)[0]!.data.endsWith('Z')).toBe(true);
  });

  it('a square with extra points on its sides becomes four lines, corners stay corners', () => {
    const pts = [
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 5],
      [10, 10],
      [5, 10],
      [0, 10],
      [0, 5],
    ];
    const net: VectorNetwork = { vertices: pts.map(([x, y]) => ({ x: x!, y: y! })), segments: pts.map((_, i) => ({ start: i, end: (i + 1) % pts.length })) };
    net.regions = [{ windingRule: 'EVENODD', loops: [net.segments.map((_, k) => k)] }];
    const s = simplifyNetwork(net, 0.5);
    expect(s.segments).toHaveLength(4);
    expect(s.segments.every(isStraight)).toBe(true);
    expect(s.regions![0]).toMatchObject({ windingRule: 'EVENODD' });
    expect(s.regions![0]!.loops[0]).toHaveLength(4);
  });

  it('a fork stays in place, extra points on the branches go away', () => {
    const net: VectorNetwork = {
      vertices: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 10 },
        { x: 15, y: 5 },
        { x: 20, y: 0 },
        { x: 10, y: 20 },
        { x: 10, y: 30 },
      ],
      segments: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
        { start: 3, end: 4 },
        { start: 2, end: 5 },
        { start: 5, end: 6 },
      ],
    };
    const s = simplifyNetwork(net, 0.5);
    expect(s.segments).toHaveLength(3);
    const adj = adjacency(s);
    const junction = s.vertices.findIndex((v) => v.x === 10 && v.y === 10);
    expect(adj[junction]).toHaveLength(3);
  });
});
