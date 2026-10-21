// Vector network from .fig (vectorData.vectorNetworkBlob): vertices, segments, regions.
// Needed to rebuild the stroke (weight, caps, dashes) and edit the path: the file's prebuilt
// geometry is already filled outlines, with no centerlines in it.
//
// Blob format (little-endian, coordinates in vectorData.normalizedSize):
//   u32 vertex count, u32 segment count, u32 region count;
//   vertex: u32 style, f32 x, f32 y;
//   segment: u32 style, u32 start, f32 tx, f32 ty, u32 end, f32 tx, f32 ty
//            (tangents relative to their vertices; zero means a straight segment);
//   region: u32 style, u32 loop count, loop: u32 n and n segment indices.

export interface FigVectorNetwork {
  vertices: { x: number; y: number; style: number }[];
  segments: { start: number; end: number; ts: [number, number]; te: [number, number]; style: number }[];
  regions: { style: number; loops: number[][] }[];
}

export function decodeVectorNetwork(bytes: Uint8Array): FigVectorNetwork | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 0;
  const has = (n: number) => i + n <= bytes.length;
  const u = () => {
    const v = dv.getUint32(i, true);
    i += 4;
    return v;
  };
  const f = () => {
    const v = dv.getFloat32(i, true);
    i += 4;
    return v;
  };
  if (!has(12)) return null;
  const nv = u();
  const ns = u();
  const nr = u();
  if (!has(nv * 12 + ns * 28)) return null;
  const vertices: FigVectorNetwork['vertices'] = [];
  for (let k = 0; k < nv; k++) {
    const style = u();
    vertices.push({ style, x: f(), y: f() });
  }
  const segments: FigVectorNetwork['segments'] = [];
  for (let k = 0; k < ns; k++) {
    const style = u();
    const start = u();
    const ts: [number, number] = [f(), f()];
    const end = u();
    const te: [number, number] = [f(), f()];
    if (start >= nv || end >= nv) return null;
    segments.push({ style, start, end, ts, te });
  }
  const regions: FigVectorNetwork['regions'] = [];
  for (let k = 0; k < nr; k++) {
    if (!has(8)) return null;
    const style = u();
    const nl = u();
    const loops: number[][] = [];
    for (let l = 0; l < nl; l++) {
      if (!has(4)) return null;
      const n = u();
      if (!has(n * 4)) return null;
      const loop: number[] = [];
      for (let m = 0; m < n; m++) loop.push(u());
      loops.push(loop);
    }
    regions.push({ style, loops });
  }
  return { vertices, segments, regions };
}

const num = (v: number) => String(Math.round(v * 1000) / 1000);

/** Stroke chain: SVG path and the vertices at its ends (for arrows and round caps). */
export interface CenterChain {
  data: string;
  closed: boolean;
  startVertex: number;
  endVertex: number;
}

/**
 * Centerlines for the stroke: each segment once, segments stitched into chains between
 * vertices where other than two segments meet (ends and forks); loops made only of “pass-through”
 * vertices are closed (Z). sx, sy — scale from normalizedSize to the node size.
 */
export function centerChains(net: FigVectorNetwork, sx = 1, sy = 1): CenterChain[] {
  const { vertices, segments } = net;
  const adj: number[][] = vertices.map(() => []);
  segments.forEach((s, k) => {
    adj[s.start]!.push(k);
    if (s.end !== s.start) adj[s.end]!.push(k);
  });
  const used = new Uint8Array(segments.length);
  const pt = (v: number) => `${num(vertices[v]!.x * sx)} ${num(vertices[v]!.y * sy)}`;
  /** Segment k from vertex from: path command and the vertex at the other end. */
  const step = (k: number, from: number): [string, number] => {
    const s = segments[k]!;
    const forward = s.start === from;
    const a = forward ? s.start : s.end;
    const b = forward ? s.end : s.start;
    const ta = forward ? s.ts : s.te;
    const tb = forward ? s.te : s.ts;
    const va = vertices[a]!;
    const vb = vertices[b]!;
    if (!ta[0] && !ta[1] && !tb[0] && !tb[1]) return [`L ${pt(b)}`, b];
    const c1 = `${num((va.x + ta[0]) * sx)} ${num((va.y + ta[1]) * sy)}`;
    const c2 = `${num((vb.x + tb[0]) * sx)} ${num((vb.y + tb[1]) * sy)}`;
    return [`C ${c1} ${c2} ${pt(b)}`, b];
  };
  const walk = (from: number, first: number): CenterChain => {
    const parts = [`M ${pt(from)}`];
    let cur = from;
    let k: number | undefined = first;
    while (k !== undefined) {
      used[k] = 1;
      const [cmd, next] = step(k, cur);
      parts.push(cmd);
      cur = next;
      if (cur === from && adj[cur]!.length === 2) break;
      k = adj[cur]!.length === 2 ? adj[cur]!.find((x) => !used[x]) : undefined;
    }
    const closed = cur === from && adj[from]!.length === 2;
    if (closed) parts.push('Z');
    return { data: parts.join(' '), closed, startVertex: from, endVertex: cur };
  };
  const out: CenterChain[] = [];
  // First, from ends and forks.
  vertices.forEach((_, v) => {
    if (adj[v]!.length === 2) return;
    for (const k of adj[v]!) if (!used[k]) out.push(walk(v, k));
  });
  // What remains are loops where every vertex has two segments.
  segments.forEach((s, k) => {
    if (!used[k]) out.push(walk(s.start, k));
  });
  return out;
}
