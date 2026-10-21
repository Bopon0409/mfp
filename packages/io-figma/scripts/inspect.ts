// Spike B: .fig parsing and document statistics.
// Run: npm run fig:inspect -- fixtures/file.fig [--schema]

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { openFig } from '../src/container.ts';
import { decodeFigKiwi } from '../src/decode.ts';
import { FileSource } from '../src/node-source.ts';
import { buildScene, guidKey } from '../src/scene.ts';
import type { FigNodeChange } from '../src/types.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Использование: npm run fig:inspect -- <файл.fig> [--schema]');
  process.exit(1);
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} МБ`;
const ms = (a: number, b: number) => `${(b - a).toFixed(0)} мс`;

const t0 = performance.now();
const src = new FileSource(file);
const archive = await openFig(src);
const t1 = performance.now();
const { schema, message } = decodeFigKiwi(archive.kiwi);
const t2 = performance.now();
const scene = buildScene(message);
const t3 = performance.now();

const nodes = message.nodeChanges ?? [];
const byType = new Map<string, number>();
for (const n of nodes) byType.set(n.type ?? '?', (byType.get(n.type ?? '?') ?? 0) + 1);

const children = new Map<string, FigNodeChange[]>();
for (const n of nodes) {
  if (!n.parentIndex) continue;
  const p = guidKey(n.parentIndex.guid);
  let list = children.get(p);
  if (!list) children.set(p, (list = []));
  list.push(n);
}
const doc = nodes.find((n) => n.type === 'DOCUMENT');
const pages = doc ? (children.get(guidKey(doc.guid)) ?? []) : [];
const imageBytes = [...archive.images.values()].reduce((s, n) => s + n, 0);

console.log(`Файл:            ${basename(file)} (${mb(archive.fileSize)}), прочитано с диска ${mb(src.bytesRead)}`);
console.log(`Сигнатура:       ${archive.kiwi.magic}, версия ${archive.kiwi.version}`);
console.log(`Схема:           ${schema.definitions.length} определений, чанков: ${archive.kiwi.chunks.length}`);
console.log(`canvas.fig:      схема ${mb(archive.kiwi.chunks[0]!.byteLength)}, сообщение ${mb(archive.kiwi.chunks[1]!.byteLength)} (распаковано)`);
console.log(`Картинки:        ${archive.images.size} шт., ${mb(imageBytes)} (читаются по требованию)`);
console.log(`Blobs:           ${(message.blobs ?? []).length}`);
console.log(`Узлов в файле:   ${nodes.length}; в сцене после разворачивания инстансов: ${scene.stats.nodes}`);
console.log(`Инстансы:        развёрнуто ${scene.stats.instancesExpanded}, без компонента ${scene.stats.missingSymbols}, overrides ${scene.stats.overridesApplied}`);
console.log(`Время:           открытие ${ms(t0, t1)}, декодирование ${ms(t1, t2)}, сцена ${ms(t2, t3)}`);
console.log(`Память (heap):   ${mb(process.memoryUsage().heapUsed)}`);
console.log('\nТипы узлов:');
for (const [type, count] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${type.padEnd(24)} ${count}`);
console.log(`\nСтраницы (${pages.length}):`);
for (const page of pages) {
  const top = children.get(guidKey(page.guid)) ?? [];
  const hidden = page.visible === false ? ' (скрыта)' : '';
  console.log(`  «${page.name}»${hidden} — ${top.length} объектов верхнего уровня`);
}

if (args.includes('--schema')) {
  const outDir = join('fixtures', 'out');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${basename(file, '.fig')}.schema.json`);
  writeFileSync(out, JSON.stringify(schema, null, 2));
  console.log(`\nСхема сохранена: ${out}`);
}
src.close();
