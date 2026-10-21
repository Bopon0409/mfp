import { describe, expect, it } from 'vitest';
import { centerChains, decodeVectorNetwork } from '../src/vector-network.ts';

/** Build a network blob: vertices [x, y], segments [start, end, tangents], regions as loops of segment indices. */
function blob(vertices: [number, number][], segments: [number, number, number[]?, number[]?][], regions: number[][][] = []): Uint8Array {
  const words: [string, number][] = [];
  const u = (v: number) => words.push(['u', v]);
  const f = (v: number) => words.push(['f', v]);
  u(vertices.length);
  u(segments.length);
  u(regions.length);
  for (const [x, y] of vertices) (u(0), f(x), f(y));
  for (const [a, b, ta = [0, 0], tb = [0, 0]] of segments) (u(0), u(a), f(ta[0]!), f(ta[1]!), u(b), f(tb[0]!), f(tb[1]!));
  for (const loops of regions) {
    u(0);
    u(loops.length);
    for (const loop of loops) (u(loop.length), loop.forEach(u));
  }
  const dv = new DataView(new ArrayBuffer(words.length * 4));
  words.forEach(([t, v], i) => (t === 'u' ? dv.setUint32(i * 4, v, true) : dv.setFloat32(i * 4, v, true)));
  return new Uint8Array(dv.buffer);
}

describe('vector network', () => {
  it('an open checkmark is a single open chain', () => {
    const net = decodeVectorNetwork(blob([[0, 0], [5, 5], [10, 0]], [[0, 1], [1, 2]]))!;
    expect(net.vertices).toHaveLength(3);
    const chains = centerChains(net);
    expect(chains).toEqual([{ data: 'M 0 0 L 5 5 L 10 0', closed: false, startVertex: 0, endVertex: 2 }]);
  });

  it('a closed loop has Z; curves go through tangents', () => {
    const net = decodeVectorNetwork(blob([[0, 0], [10, 0], [10, 10]], [[0, 1, [3, 0], [-3, 0]], [1, 2], [2, 0]], [[[0, 1, 2]]]))!;
    expect(net.regions).toEqual([{ style: 0, loops: [[0, 1, 2]] }]);
    const [c] = centerChains(net, 2, 1);
    expect(c!.closed).toBe(true);
    expect(c!.data).toBe('M 0 0 C 6 0 14 0 20 0 L 20 10 L 0 0 Z');
  });

  it('fork: each segment is stroked once', () => {
    // Letter “Y”: three rays from the center.
    const net = decodeVectorNetwork(blob([[5, 5], [0, 0], [10, 0], [5, 10]], [[0, 1], [0, 2], [3, 0]]))!;
    const chains = centerChains(net);
    expect(chains).toHaveLength(3);
    expect(chains.reduce((n, c) => n + (c.data.match(/L/g)?.length ?? 0), 0)).toBe(3);
  });

  it('a broken blob gives null, no exceptions', () => {
    expect(decodeVectorNetwork(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeVectorNetwork(blob([[0, 0]], []).slice(0, 14))).toBeNull();
  });
});
