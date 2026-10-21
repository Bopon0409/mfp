// Corpus run: each file is opened, saved to .mfp and read back losslessly,
// the first screens are rendered. A failure on any file fails the run.
//
//   npm run corpus                    — fixtures/ and small samples of every format;
//   MFP_CORPUS=folder npm run corpus  — also files from this folder (.fig, .mfp, .sketch, .pdf).
//
// .sketch and .pdf import — the same modules as in the editor. PDF images aren't re-encoded in Node
// (no OffscreenCanvas) — that's a warning, not an error: in the app e2e-desktop checks them.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Document } from '@mfp/core';
import { MemorySource, readMfp, writeMfp, type ImageBytesSource } from '@mfp/io-figma';
import { Session } from '../apps/cli/src/session.ts';
import { importSketch } from '../apps/editor/src/sketch-import.ts';
import { importPdf } from '../apps/editor/src/pdf/import.ts';
import { sampleMfp, samplePdf, sampleSketch } from './samples.ts';

const ROOT = resolve(import.meta.dirname, '..');

interface Row {
  file: string;
  ok: boolean;
  nodes?: number;
  pages?: number;
  ms?: number;
  notes: string[];
}

const sources: { name: string; bytes?: Uint8Array; path?: string }[] = [
  { name: 'образец.pdf', bytes: samplePdf() },
  { name: 'образец.sketch', bytes: sampleSketch() },
  { name: 'образец.mfp', bytes: await sampleMfp() },
];
for (const dir of [join(ROOT, 'fixtures'), process.env.MFP_CORPUS].filter((d): d is string => !!d && existsSync(d))) {
  for (const f of readdirSync(dir).sort()) if (/\.(fig|mfp|sketch|pdf)$/i.test(f) && statSync(join(dir, f)).isFile()) sources.push({ name: f, path: join(dir, f) });
}

async function open(src: (typeof sources)[number]): Promise<{ doc: Document; images: ImageBytesSource | null; notes: string[] }> {
  const ext = src.name.replace(/^.*\./, '').toLowerCase();
  const bytes = () => src.bytes ?? new Uint8Array(readFileSync(src.path!));
  if (ext === 'sketch') {
    const r = await importSketch(bytes(), src.name);
    return { doc: r.doc, images: r.images, notes: r.warnings.slice(0, 3) };
  }
  if (ext === 'pdf') {
    const r = await importPdf(bytes(), src.name);
    return { doc: r.doc, images: r.images, notes: r.warnings.slice(0, 3) };
  }
  if (src.path) {
    const s = await Session.open(src.path);
    return { doc: s.doc, images: s.images, notes: [] };
  }
  const r = await readMfp(new MemorySource(bytes()));
  return { doc: r.doc, images: r.images, notes: [] };
}

const rows: Row[] = [];
for (const src of sources) {
  const row: Row = { file: src.name, ok: false, notes: [] };
  rows.push(row);
  process.stdout.write(`… ${src.name}\n`);
  try {
    const t = performance.now();
    const { doc, images, notes } = await open(src);
    row.ms = Math.round(performance.now() - t);
    row.nodes = doc.size;
    row.pages = doc.children(doc.root).length;
    row.notes.push(...notes);
    // Save to .mfp and read back: the same document.
    const { blob, missing } = await writeMfp(doc, images);
    if (missing.length) row.notes.push(`нет картинок: ${missing.length}`);
    const back = await readMfp(new MemorySource(new Uint8Array(await blob.arrayBuffer())));
    const same = JSON.stringify(back.doc.snapshot()) === JSON.stringify(doc.snapshot());
    if (!same) throw new Error('после сохранения и чтения документ другой');
    // The first screens of the first page are rendered.
    const session = Session.fromDocument(doc, images, src.name);
    const page = doc.children(doc.root)[0];
    let drawn = 0;
    for (const id of page ? doc.children(page).slice(0, 3) : []) {
      const png = await session.render(id, 0.25);
      if (!png.png.length) throw new Error(`пустая отрисовка ${id}`);
      drawn++;
    }
    row.notes.push(`нарисовано экранов: ${drawn}`);
    row.ok = true;
  } catch (e) {
    row.notes.push(`ОШИБКА: ${(e as Error).message}`);
  }
}

console.log('');
for (const r of rows) {
  const stats = r.nodes !== undefined ? `узлов ${r.nodes}, страниц ${r.pages}, открытие ${r.ms} мс` : '';
  console.log(`${r.ok ? '✓' : '✗'} ${r.file.padEnd(24)} ${stats}${r.notes.length ? ` — ${r.notes.join('; ')}` : ''}`);
}
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed} из ${rows.length} файлов без ошибок.`);
if (failed) process.exitCode = 1;
