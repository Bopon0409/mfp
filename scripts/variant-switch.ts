// Variant switching check against .fig data: an instance of variant A is switched to variant B and compared
// with an instance of variant B from the same file (ready-made in the file). We take instances without overrides
// and with the main component's size — otherwise differences are legitimate.
//
// Run: node scripts/variant-switch.ts fixtures/design.fig [more.fig …]

import { DesignSync, Document, setInstanceProperties, variantValues, type Op } from '@mfp/core';
import { buildScene, decodeFigKiwi, openFig, sceneToCore } from '@mfp/io-figma';
import { FileSource } from '@mfp/io-figma/node';

const KEYS = ['visible', 'opacity', 'fills', 'strokes', 'effects', 'characters', 'fontSize', 'fontName', 'width', 'height', 'cornerRadius', 'strokeWeight'] as const;

for (const file of process.argv.slice(2)) {
  const archive = await openFig(new FileSource(file));
  const { doc } = sceneToCore(buildScene(decodeFigKiwi(archive.kiwi).message), new Document({ clientId: 1 }));
  const sync = new DesignSync(doc);
  doc.onChange((ops: Op[], origin: string) => {
    sync.observe(ops);
    if (origin === 'local') doc.amend(() => sync.trackOverrides(ops));
    if (origin === 'local' || origin === 'layout') doc.amend(() => sync.propagate(ops));
  });
  // Instances without overrides with the main component's size — per variant.
  const clean = new Map<string, string[]>();
  for (const id of doc.descendants(doc.root)) {
    if (doc.type(id) !== 'INSTANCE' || doc.get(id, 'componentRef')) continue;
    const comp = doc.get(id, 'componentId');
    if (!comp || doc.type(doc.parent(comp) ?? '') !== 'COMPONENT_SET') continue;
    if (doc.get(id, 'width') !== doc.get(comp, 'width') || doc.get(id, 'height') !== doc.get(comp, 'height')) continue;
    if ([id, ...doc.descendants(id)].some((n) => doc.get(n, 'overrides')?.length)) continue;
    if (Object.keys(doc.get(id, 'componentProperties') ?? {}).length) continue;
    const list = clean.get(comp) ?? [];
    list.push(id);
    clean.set(comp, list);
  }
  let pairs = 0;
  let nodes = 0;
  let diffs = 0;
  const examples: string[] = [];
  for (const [compA, listA] of clean) {
    const set = doc.parent(compA)!;
    for (const [compB, listB] of clean) {
      // b — the reference from the file (not switched), a — the one being switched (from another variant).
      if (compB === compA || doc.parent(compB) !== set || listA.length < 2 || !listB.length) continue;
      const a = listA.pop()!;
      const b = listB[0]!;
      doc.transact(() => setInstanceProperties(doc, a, variantValues(doc, compB)));
      if (doc.get(a, 'componentId') !== compB) {
        diffs++;
        examples.push(`${doc.get(set, 'name')}: не переключился на ${doc.get(compB, 'name')}`);
        continue;
      }
      pairs++;
      const walk = (x: string, y: string, path: string) => {
        nodes++;
        for (const k of KEYS) {
          // Root visibility — each instance has its own.
          if (k === 'visible' && x === a) continue;
          const vx = JSON.stringify(doc.get(x, k));
          const vy = JSON.stringify(doc.get(y, k));
          if (vx !== vy) {
            diffs++;
            if (examples.length < 12) examples.push(`${doc.get(set, 'name')} → ${doc.get(compB, 'name')} ${path}.${k}: ${vx?.slice(0, 80)} ≠ ${vy?.slice(0, 80)}`);
          }
        }
        const cx = doc.children(x);
        const cy = doc.children(y);
        if (cx.length !== cy.length) {
          diffs++;
          examples.push(`${path}: детей ${cx.length} ≠ ${cy.length}`);
          return;
        }
        cx.forEach((c, i) => walk(c, cy[i]!, `${path}/${doc.get(c, 'name')}`));
      };
      walk(a, b, doc.get(a, 'name') ?? '');
    }
  }
  console.log(`${file}: пар ${pairs}, узлов ${nodes}, расхождений ${diffs}`);
  for (const e of examples) console.log('  ', e);
}
