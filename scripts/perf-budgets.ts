// Performance budgets: key operations on real files from fixtures/
// (no files — the measurement is skipped). Exceeding a budget — exit code 1 (for CI).
// Run: npm run perf   (node --expose-gc is needed to measure memory)
// Files (any real design files; override the paths with environment variables):
//   fixtures/medium.fig    — import and render of a 1920×1080 frame   (MFP_PERF_MEDIUM)
//   fixtures/layout.fig    — file with many auto layout frames        (MFP_PERF_LAYOUT)
//   fixtures/Untitled.fig  — very large file (2+ GB)                  (MFP_PERF_GIANT)

import { existsSync } from 'node:fs';
import { Document } from '@mfp/core';
import { buildScene, decodeFigKiwi, openFig, sceneToCore } from '@mfp/io-figma';
import { FileSource } from '@mfp/io-figma/node';
import { isAutoLayout, layoutEngineReady, layoutFrame } from '@mfp/editing';
import { Session } from '../apps/cli/src/session.ts';

interface Result {
  name: string;
  value: number;
  budget: number;
  unit: string;
}
const results: Result[] = [];
const gc = (globalThis as { gc?: () => void }).gc;
const heap = () => {
  gc?.();
  return process.memoryUsage().heapUsed;
};
const measure = async (name: string, budget: number, fn: () => Promise<unknown> | unknown) => {
  const t0 = performance.now();
  await fn();
  results.push({ name, value: performance.now() - t0, budget, unit: 'мс' });
};

async function importFig(path: string) {
  const archive = await openFig(new FileSource(path));
  return sceneToCore(buildScene(decodeFigKiwi(archive.kiwi).message), new Document({ clientId: 1 })).doc;
}

const MEDIUM = process.env.MFP_PERF_MEDIUM ?? 'fixtures/medium.fig';
const LAYOUT = process.env.MFP_PERF_LAYOUT ?? 'fixtures/layout.fig';
const GIANT = process.env.MFP_PERF_GIANT ?? 'fixtures/Untitled.fig';

if (existsSync(MEDIUM)) {
  await measure('Импорт среднего файла (.fig → модель)', 1500, () => importFig(MEDIUM));
}

if (existsSync(LAYOUT)) {
  const doc = await importFig(LAYOUT);
  await layoutEngineReady;
  const frames = [...doc.descendants(doc.root)].filter((id) => isAutoLayout(doc, id));
  await measure(`Пересчёт auto layout (${frames.length} фреймов)`, 150, () => doc.transact(() => frames.forEach((f) => layoutFrame(doc, f)), 'layout'));
}

if (existsSync(MEDIUM)) {
  const s = await Session.open(MEDIUM);
  // The first full-screen frame of the file.
  const id = s.find({ type: 'FRAME', limit: Infinity }).find((n) => n.w === 1920 && n.h === 1080)?.id as string | undefined;
  if (id) await measure('Рендер фрейма 1920×1080 в PNG (CLI, процессор)', 3000, () => s.render(id, 1));
}

if (existsSync(GIANT)) {
  const before = heap();
  let doc: Document | null = null;
  await measure('Импорт гиганта 2,27 ГБ (.fig → модель)', 6000, async () => {
    doc = await importFig(GIANT);
  });
  if (gc) results.push({ name: 'Память модели гиганта', value: (heap() - before) / 2 ** 20, budget: 200, unit: 'МБ' });
  await measure('Снимок гиганта (сохранение: snapshot + JSON)', 2500, () => JSON.stringify(doc!.snapshot()));
}

let failed = 0;
for (const r of results) {
  const ok = r.value <= r.budget;
  if (!ok) failed++;
  console.log(`${ok ? 'ok ' : 'ПРЕВЫШЕН'}  ${r.name}: ${r.value.toFixed(0)} ${r.unit} (бюджет ${r.budget})`);
}
if (!results.length) console.log('Нет файлов в fixtures/ — замеры пропущены');
process.exit(failed ? 1 : 0);
