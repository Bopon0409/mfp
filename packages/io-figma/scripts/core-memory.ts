// Diagnostics: document model memory after a .fig import and what it consists of.
// Run: node --expose-gc --max-old-space-size=8192 packages/io-figma/scripts/core-memory.ts <file.fig>
import { Document } from '@mfp/core';
import { openFig } from '../src/container.ts';
import { decodeFigKiwi } from '../src/decode.ts';
import { FileSource } from '../src/node-source.ts';
import { buildScene } from '../src/scene.ts';
import { sceneToCore } from '../src/to-core.ts';

const gc = (globalThis as { gc?: () => void }).gc!;
const mb = (n: number) => `${(n / 2 ** 20).toFixed(0)} МБ`;
gc();
const base = process.memoryUsage().heapUsed;
async function load(): Promise<Document> {
  const archive = await openFig(new FileSource(process.argv[2]!));
  const { message } = decodeFigKiwi(archive.kiwi);
  const scene = buildScene(message);
  return sceneToCore(scene, new Document({ clientId: 1 })).doc;
}
const doc = await load();
gc();
const heapImmediate = process.memoryUsage().heapUsed - base;
await new Promise((r) => setTimeout(r, 100));
gc();
gc();
const heap = process.memoryUsage().heapUsed - base;
console.log(`Сразу после импорта: ${mb(heapImmediate)}; после паузы и двух сборок: ${mb(heap)}`);
const nodes = [...doc.descendants(doc.root)];
// Estimate of property contributions: JSON size per key.
const byKey = new Map<string, number>();
let glyphTuples = 0;
for (const id of nodes) {
  const rec = doc.node(id)!;
  for (const [k, v] of Object.entries(rec.props)) {
    if (v === undefined) continue;
    byKey.set(k, (byKey.get(k) ?? 0) + JSON.stringify(v).length);
    if (k === 'textGlyphs') glyphTuples += (v as { glyphs: unknown[] }).glyphs.length;
  }
}
const blobs = doc.snapshot().blobs ?? {};
const blobBytes = Object.values(blobs).reduce((a, s) => a + (s as string).length, 0);
console.log(`Узлов: ${nodes.length}, heap модели ≈ ${mb(heap)} (${((heap / nodes.length) | 0)} Б/узел)`);
console.log(`Глифов в textGlyphs: ${glyphTuples}; таблица геометрии: ${Object.keys(blobs).length} контуров, ${mb(blobBytes)} текста`);
console.log('JSON свойств по ключам (крупнейшие):');
for (const [k, v] of [...byKey].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${k.padEnd(20)} ${mb(v)}`);

// Number of unique values of object properties (estimate of the gain from sharing identical ones).
const uniq = new Map<string, { total: number; unique: Set<string> }>();
let objects = 0;
for (const id of nodes) {
  for (const [k, v] of Object.entries(doc.node(id)!.props)) {
    if (v === null || typeof v !== 'object') continue;
    objects++;
    const s = JSON.stringify(v);
    let u = uniq.get(k);
    if (!u) uniq.set(k, (u = { total: 0, unique: new Set() }));
    u.total++;
    u.unique.add(s);
  }
}
console.log(`Объектных значений свойств: ${objects}`);
for (const [k, u] of [...uniq].sort((a, b) => b[1].total - a[1].total).slice(0, 14)) console.log(`  ${k.padEnd(20)} всего ${String(u.total).padStart(7)}, уникальных ${String(u.unique.size).padStart(7)}`);

// Experiment: contribution of different model parts (memory difference after removing them).
const anyDoc = doc as unknown as { nodes: Map<string, { props: object; index: string }>; sortedChildren: Map<string, unknown>; childrenOf: Map<string, unknown>; blobs: Map<string, string> };
const measure = () => {
  gc();
  return process.memoryUsage().heapUsed;
};
let h0 = measure();
anyDoc.sortedChildren.clear();
let h1 = measure();
console.log(`Кэш отсортированных детей: ${mb(h0 - h1)}`);
const savedProps = new Map<string, object>();
for (const [id, n] of anyDoc.nodes) {
  savedProps.set(id, n.props);
  n.props = {};
}
let h2 = measure();
console.log(`Объекты свойств (без общих значений, они живут в savedProps): ${mb(h1 - h2 + 0)} — проверка ниже`);
savedProps.clear();
let h3 = measure();
console.log(`Свойства целиком (объекты + общие значения): ${mb(h1 - h3)}`);
anyDoc.childrenOf.clear();
let h4 = measure();
console.log(`Множества детей: ${mb(h3 - h4)}`);
anyDoc.blobs.clear();
let h5 = measure();
console.log(`Таблица геометрии: ${mb(h4 - h5)}`);
anyDoc.nodes.clear();
let h6 = measure();
console.log(`Записи узлов (id, index, Map): ${mb(h5 - h6)}`);
console.log(`Остаток (прочее): ${mb(h6 - base)}`);
