// Opening a document from a Loro snapshot in a fresh process: time and memory.
// Run: node --expose-gc packages/sync/scripts/load-snapshot.ts fixtures/out/untitled.loro
import { readFileSync } from 'node:fs';
import { LoroDoc } from 'loro-crdt';
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const bytes = readFileSync(process.argv[2]!);
gc();
const m0 = process.memoryUsage();
const t0 = performance.now();
const doc = LoroDoc.fromSnapshot(bytes);
let props = 0;
const nodes = doc.getTree('nodes').getNodes();
for (const n of nodes) props += Object.keys(n.data.toJSON()).length;
const t1 = performance.now();
gc();
const m1 = process.memoryUsage();
const mb = (n: number) => (n / 2 ** 20).toFixed(1) + ' МБ';
console.log(`Снимок ${mb(bytes.byteLength)}: узлов ${nodes.length}, свойств ${props}; загрузка+чтение ${(t1 - t0).toFixed(0)} мс; RSS +${mb(m1.rss - m0.rss)}, wasm/внешняя +${mb(m1.external + m1.arrayBuffers - m0.external - m0.arrayBuffers)}, heap +${mb(m1.heapUsed - m0.heapUsed)}`);
