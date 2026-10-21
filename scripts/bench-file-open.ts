// Synthetic CRDT import benchmark; excludes network, fonts, images and scene construction.
import { Document } from '@mfp/core';
import { hasNodes, LoroBridge, loroReady } from '@mfp/sync';
await loroReady();
const doc = new Document();
const page = doc.create('PAGE', doc.root, { name: 'Benchmark' });
for (let i = 0; i < 5000; i++) doc.create('RECTANGLE', page, { name: `Node ${i}`, width: 100, height: 80, transform: [1, 0, i % 100 * 120, 0, 1, Math.floor(i / 100) * 100] });
const source = new LoroBridge(doc);
const snapshot = source.loro.export({ mode: 'snapshot' });
const samples: Record<string, number[]> = { previous: [], singleImport: [] };
for (let round = 0; round < 8; round++) for (const mode of round % 2 ? ['singleImport', 'previous'] : ['previous', 'singleImport']) {
  const start = performance.now();
  const bridge = new LoroBridge(new Document());
  if (mode === 'previous') hasNodes(snapshot);
  bridge.importUpdate(snapshot);
  if (round > 1) samples[mode]!.push(performance.now() - start);
  bridge.dispose();
}
source.dispose();
console.log(JSON.stringify({ nodes: 5001, snapshotBytes: snapshot.length, medianMs: Object.fromEntries(Object.entries(samples).map(([mode, values]) => [mode, +values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!.toFixed(1)])) }, null, 2));
