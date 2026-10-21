// Spike C: can Loro (CRDT) handle real-size documents.
// We take nodes from a .fig, build a Loro tree (movable tree) with node properties,
// measure time, memory, snapshot and update size, and check merging of concurrent edits.
//
// Run: node --expose-gc packages/sync/scripts/bench-loro.ts fixtures/Untitled.fig

import { LoroDoc, type TreeID } from 'loro-crdt';
import { openFig, decodeFigKiwi, guidKey } from '../../io-figma/src/index.ts';
import { FileSource } from '../../io-figma/src/node-source.ts';
import type { FigNodeChange } from '../../io-figma/src/types.ts';
import { Document } from '../../core/src/index.ts';

const file = process.argv[2] ?? 'fixtures/Untitled.fig';
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const mem = () => {
  gc();
  const m = process.memoryUsage();
  return { heap: m.heapUsed, external: m.external + m.arrayBuffers, rss: m.rss };
};
const mb = (n: number) => `${(n / 2 ** 20).toFixed(1)} МБ`;
const ms = (t: number) => `${t.toFixed(0)} мс`;
const time = <T>(fn: () => T): [T, number] => {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
};

// ---------- Data: nodes from .fig in “parent before children” order ----------
const src = new FileSource(file);
const { message } = decodeFigKiwi((await openFig(src)).kiwi);
src.close();
const all = (message.nodeChanges ?? []).filter((n) => n.phase !== 'REMOVED' && n.guid);
const byParent = new Map<string, FigNodeChange[]>();
let root: FigNodeChange | undefined;
for (const n of all) {
  if (n.type === 'DOCUMENT') root = n;
  if (!n.parentIndex) continue;
  const k = guidKey(n.parentIndex.guid);
  let l = byParent.get(k);
  if (!l) byParent.set(k, (l = []));
  l.push(n);
}
for (const l of byParent.values()) l.sort((a, b) => ((a.parentIndex!.position ?? '') < (b.parentIndex!.position ?? '') ? -1 : 1));
const ordered: FigNodeChange[] = [];
const walk = (n: FigNodeChange) => {
  for (const c of byParent.get(guidKey(n.guid)) ?? []) {
    ordered.push(c);
    walk(c);
  }
};
walk(root!);

/** Node properties in MFP model form (what will actually be stored). */
const propsOf = (n: FigNodeChange) => ({
  type: n.type ?? 'FRAME',
  name: n.name ?? '',
  visible: n.visible !== false,
  opacity: n.opacity ?? 1,
  transform: n.transform ? [n.transform.m00, n.transform.m01, n.transform.m02, n.transform.m10, n.transform.m11, n.transform.m12] : [1, 0, 0, 0, 1, 0],
  width: n.size?.x ?? 0,
  height: n.size?.y ?? 0,
  fills: (n.fillPaints ?? []).map((p) => ({ type: p.type, color: p.color, opacity: p.opacity, visible: p.visible })),
});

console.log(`Файл: ${file}; узлов для загрузки: ${ordered.length}`);

// ---------- 1. Building the Loro document ----------
const m0 = mem();
const [built, tBuild] = time(() => {
  const doc = new LoroDoc();
  doc.setPeerId(1);
  const tree = doc.getTree('nodes');
  tree.enableFractionalIndex(0);
  const ids = new Map<string, TreeID>();
  for (const n of ordered) {
    const parent = n.parentIndex ? ids.get(guidKey(n.parentIndex.guid)) : undefined;
    const node = tree.createNode(parent);
    ids.set(guidKey(n.guid), node.id);
    const data = node.data;
    for (const [k, v] of Object.entries(propsOf(n))) data.set(k, v);
  }
  doc.commit();
  return { doc, tree, ids };
});
const m1 = mem();
console.log(`\n1. Построение: ${ms(tBuild)}; память Loro: heap +${mb(m1.heap - m0.heap)}, wasm/внешняя +${mb(m1.external - m0.external)}, RSS +${mb(m1.rss - m0.rss)}`);

// ---------- 2. Snapshot: export and load ----------
const [snapshot, tExport] = time(() => built.doc.export({ mode: 'snapshot' }));
if (process.argv[3]) (await import('node:fs')).writeFileSync(process.argv[3], snapshot);
const [loaded, tImport] = time(() => LoroDoc.fromSnapshot(snapshot));
const mLoad0 = mem();
const [fresh, tFresh] = time(() => LoroDoc.fromSnapshot(snapshot));
const [, tFirstRead] = time(() => {
  // Opening the document: read all nodes and their properties (as on first render).
  let n = 0;
  for (const node of fresh.getTree('nodes').getNodes()) n += Object.keys(node.data.toJSON()).length;
  return n;
});
const mLoad1 = mem();
console.log(`2. Снимок: ${mb(snapshot.byteLength)}, экспорт ${ms(tExport)}, загрузка ${ms(tImport)}/${ms(tFresh)}, чтение всех узлов и свойств ${ms(tFirstRead)}; память открытого из снимка документа: wasm +${mb(mLoad1.external - mLoad0.external)}, RSS +${mb(mLoad1.rss - mLoad0.rss)}`);

// ---------- 3. Incremental update (a single edit) ----------
const someId = built.ids.get(guidKey(ordered[Math.floor(ordered.length / 2)]!.guid))!;
const vv = built.doc.oplogVersion();
const [, tEdit] = time(() => {
  const node = built.tree.getNodeByID(someId)!;
  node.data.set('transform', [1, 0, 123, 0, 1, 456]);
  built.doc.commit();
});
const update = built.doc.export({ mode: 'update', from: vv });
const [, tApply] = time(() => loaded.import(update));
const ok = JSON.stringify(loaded.getTree('nodes').getNodeByID(someId)!.data.get('transform')) === '[1,0,123,0,1,456]';
console.log(`3. Одна правка: применение ${ms(tEdit)}, обновление ${update.byteLength} байт, импорт у другого клиента ${ms(tApply)}, совпадает: ${ok}`);

// ---------- 4. Concurrent edits and merging (branches) ----------
const a = built.doc.fork();
a.setPeerId(2);
const b = built.doc.fork();
b.setPeerId(3);
const nodes = ordered.map((n) => built.ids.get(guidKey(n.guid))!);
const EDITS = Math.min(2000, Math.floor(nodes.length / 7));
const [, tEditsA] = time(() => {
  const t = a.getTree('nodes');
  for (let i = 0; i < EDITS; i++) t.getNodeByID(nodes[(i * 7) % nodes.length]!)!.data.set('name', `A-${i}`);
  a.commit();
});
const [, tEditsB] = time(() => {
  const t = b.getTree('nodes');
  for (let i = 0; i < EDITS; i++) t.getNodeByID(nodes[(i * 7 + 3) % nodes.length]!)!.data.set('opacity', 0.5);
  b.commit();
});
const updA = a.export({ mode: 'update', from: built.doc.oplogVersion() });
const updB = b.export({ mode: 'update', from: built.doc.oplogVersion() });
const [, tMerge] = time(() => {
  a.import(updB);
  b.import(updA);
});
const same = JSON.stringify(a.getTree('nodes').getNodeByID(nodes[7]!)!.data.toJSON()) === JSON.stringify(b.getTree('nodes').getNodeByID(nodes[7]!)!.data.toJSON());
console.log(
  `4. Ветки: ${EDITS} правок в A (${ms(tEditsA)}) и ${EDITS} в B (${ms(tEditsB)}); обновления ${(updA.byteLength / 1024).toFixed(1)} КБ и ${(updB.byteLength / 1024).toFixed(1)} КБ; слияние ${ms(tMerge)}; сошлись: ${same}`,
);

// ---------- 5. Move conflict: a cycle and concurrent moves of the same node ----------
{
  const base = new LoroDoc();
  base.setPeerId(10);
  const t = base.getTree('nodes');
  t.enableFractionalIndex(0);
  const page = t.createNode();
  const f1 = t.createNode(page.id);
  const f2 = t.createNode(page.id);
  const x = t.createNode(page.id);
  base.commit();
  const p1 = base.fork();
  p1.setPeerId(11);
  const p2 = base.fork();
  p2.setPeerId(12);
  // User 1 puts f1 inside f2, user 2 puts f2 inside f1 (together they would form a cycle).
  p1.getTree('nodes').move(f1.id, f2.id);
  p2.getTree('nodes').move(f2.id, f1.id);
  // Both concurrently move x to different places.
  p1.getTree('nodes').move(x.id, f1.id);
  p2.getTree('nodes').move(x.id, f2.id);
  p1.commit();
  p2.commit();
  p1.import(p2.export({ mode: 'update' }));
  p2.import(p1.export({ mode: 'update' }));
  const parentOf = (d: LoroDoc, id: TreeID) => d.getTree('nodes').getNodeByID(id)!.parent()?.id ?? null;
  const converged = [f1.id, f2.id, x.id].every((id) => parentOf(p1, id) === parentOf(p2, id));
  const cycle = parentOf(p1, f1.id) === f2.id && parentOf(p1, f2.id) === f1.id;
  console.log(`5. Конфликт перемещений: сошлись ${converged}, цикл ${cycle ? 'ЕСТЬ (плохо)' : 'нет'}`);
}

// ---------- 6. Comparison: the same model in @mfp/core without CRDT ----------
const m2 = mem();
const [core, tCore] = time(() => {
  const d = new Document({ clientId: 1 });
  const ids = new Map<string, string>();
  ids.set(guidKey(root!.guid), d.root);
  for (const n of ordered) {
    const p = propsOf(n);
    const parent = ids.get(guidKey(n.parentIndex!.guid));
    if (!parent) continue;
    const type = (['DOCUMENT', 'CANVAS'].includes(p.type) ? 'PAGE' : 'FRAME') as 'PAGE' | 'FRAME';
    const id = d.create(type, parent, { name: p.name, visible: p.visible, opacity: p.opacity, width: p.width, height: p.height, transform: p.transform as never, fills: p.fills as never });
    ids.set(guidKey(n.guid), id);
  }
  return d;
});
const m3 = mem();
console.log(`6. Для сравнения @mfp/core (без CRDT): построение ${ms(tCore)}, heap +${mb(m3.heap - m2.heap)}; узлов ${core.size}`);
