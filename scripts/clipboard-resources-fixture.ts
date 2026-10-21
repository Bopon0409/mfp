// Reproducible UI fixture: open source, Copy the frame, open target, Paste.
import { writeFile, mkdir } from 'node:fs/promises';
import { Document, createCollection, createVariable, createStyle, applyStyle, bindPaintVariable, instantiate } from '@mfp/core';
import { writeMfp } from '@mfp/io-figma';

await mkdir('fixtures/out', { recursive: true });
for (const source of [true, false]) {
  const d = new Document({ clientId: 1 });
  const page = d.create('PAGE', d.root, { name: source ? 'Источник' : 'Приёмник' });
  const collection = createCollection(d, 'Theme');
  const color = createVariable(d, 'Primary', collection, 'COLOR', source ? { r: .2, g: .35, b: .9, a: 1 } : { r: 1, g: 0, b: 0, a: 1 });
  const style = createStyle(d, 'TEXT', 'Body', { fontSize: source ? 24 : 48, fontName: { family: 'Inter', style: 'Regular' } });
  if (source) {
    const components = d.create('PAGE', d.root, { name: 'Мастера' });
    const master = d.create('COMPONENT', components, { name: 'Clipboard Button', width: 260, height: 80, cornerRadius: 12 });
    bindPaintVariable(d, master, 'fills', 0, color);
    const label = d.create('TEXT', master, { name: 'Label', characters: 'Связанный компонент', width: 240, height: 32, transform: [1, 0, 10, 0, 1, 22], fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] });
    applyStyle(d, label, 'textStyleId', style);
    const frame = d.create('FRAME', page, { name: 'Copy this frame', width: 340, height: 160, fills: [{ type: 'SOLID', color: { r: .96, g: .96, b: .98 } }] });
    instantiate(d, master, frame, [1, 0, 40, 0, 1, 40]);
  }
  const { blob } = await writeMfp(d, null);
  await writeFile(`fixtures/out/clipboard-${source ? 'source' : 'target'}.mfp`, new Uint8Array(await blob.arrayBuffer()));
}
