// Scene build (CoreScene) benchmark per file page: node scripts/scene-bench.ts <file.fig|.mfp> [repeats]
// A page's scene is built on every switch to it — this is exactly the “page loading” wait.

import { userPages } from '@mfp/core';
import { CoreScene } from '@mfp/renderer';
import { Session } from '../apps/cli/src/session.ts';

const file = process.argv[2];
const repeat = Number(process.argv[3] ?? 3);
if (!file) {
  console.error('Использование: node scripts/scene-bench.ts <файл> [повторов]');
  process.exit(1);
}
const t0 = performance.now();
const s = await Session.open(file);
console.log(`открыт за ${Math.round(performance.now() - t0)} мс`);
for (const p of userPages(s.doc)) {
  const times: number[] = [];
  let nodes = 0;
  for (let i = 0; i < repeat; i++) {
    const t = performance.now();
    const scene = new CoreScene(s.doc, p);
    times.push(performance.now() - t);
    if (!i) for (const _ of s.doc.descendants(p)) nodes++;
    void scene;
  }
  times.sort((a, b) => a - b);
  console.log(`${s.doc.get(p, 'name')}: ${nodes} узлов, сборка ${Math.round(times[0]!)}–${Math.round(times[times.length - 1]!)} мс`);
}
