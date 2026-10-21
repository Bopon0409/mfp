// Vectors with regions in a .fig: how many networks have branches and how many regions have their own fills.
// node scripts/vector-regions.ts <file.fig…>
// Needed to check vector network import on real files.

import { open } from 'node:fs/promises';
import { decodeFigKiwi, decodeVectorNetwork, openFig, type ByteSource } from '@mfp/io-figma';

class FileSource implements ByteSource {
  size: number;
  fh: Awaited<ReturnType<typeof open>>;
  constructor(fh: Awaited<ReturnType<typeof open>>, size: number) {
    this.fh = fh;
    this.size = size;
  }
  static async open(path: string) {
    const fh = await open(path, 'r');
    return new FileSource(fh, (await fh.stat()).size);
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length);
    await this.fh.read(buf, 0, length, offset);
    return buf;
  }
}

for (const file of process.argv.slice(2)) {
  const src = await FileSource.open(file);
  const fig = await openFig(src);
  await src.fh.close();
  const { message } = decodeFigKiwi(fig.kiwi);
  const blobs = (message.blobs ?? []).map((b) => b.bytes);
  let vectors = 0;
  let withNetwork = 0;
  let junctions = 0;
  let withRegions = 0;
  let regionFills = 0;
  let styled = 0;
  const examples: string[] = [];
  for (const nc of message.nodeChanges ?? []) {
    if (nc.type !== 'VECTOR' || nc.phase === 'REMOVED') continue;
    vectors++;
    const vd = nc.vectorData as { vectorNetworkBlob?: number; styleOverrideTable?: { styleID?: number; fillPaints?: unknown[] }[] } | undefined;
    if (typeof vd?.vectorNetworkBlob !== 'number') continue;
    const net = decodeVectorNetwork(blobs[vd.vectorNetworkBlob]!);
    if (!net) continue;
    withNetwork++;
    const deg = new Array(net.vertices.length).fill(0);
    for (const s of net.segments) {
      deg[s.start]++;
      if (s.end !== s.start) deg[s.end]++;
    }
    if (deg.some((d) => d > 2)) junctions++;
    if (net.regions.length) withRegions++;
    const fillStyles = new Set((vd.styleOverrideTable ?? []).filter((s) => Array.isArray(s.fillPaints)).map((s) => s.styleID));
    const geo = (nc.fillGeometry ?? []) as { styleID?: number }[];
    if (geo.some((g) => g.styleID && fillStyles.has(g.styleID))) {
      styled++;
      if (examples.length < 5) examples.push(`${nc.name} (${net.regions.length} обл., ${geo.length} конт.)`);
    }
    for (const r of net.regions) if (r.style && fillStyles.has(r.style)) regionFills++;
  }
  console.log(`${file}: векторов ${vectors}, с сетью ${withNetwork}, с развилками ${junctions}, с областями ${withRegions}, областей со своей заливкой ${regionFills}, векторов с такими контурами ${styled}`);
  if (examples.length) console.log('  например:', examples.join('; '));
}
