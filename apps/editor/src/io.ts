// Open and save: .mfp (our format, see @mfp/io-figma/mfp.ts) and .fig import.

import { Document } from '@mfp/core';
import {
  BlobSource,
  HttpRangeSource,
  buildScene,
  decodeFigKiwi,
  openFig,
  readMfp,
  sceneToCore,
  writeMfp,
  type ByteSource,
  type ImageBytesSource,
  type ImportReport,
} from '@mfp/io-figma';
import { t } from './i18n/index.ts';

export interface OpenResult {
  doc: Document;
  name: string;
  /** Source of the document images: a .fig archive or the .mfp file itself. */
  images: ImageBytesSource | null;
  report?: ImportReport;
  /** Timing of the opening stages, ms (for the status line). */
  timings?: Record<string, number>;
  /** Loading the remaining pages of a large file: one step is one top-level node. */
  more?: Generator<void, void, void>;
  /** What was not fully carried over on import (PDF). */
  warnings?: string[];
}

async function importFig(name: string, source: ByteSource): Promise<OpenResult> {
  let t = performance.now();
  const timings: Record<string, number> = {};
  const lap = (k: string) => {
    const now = performance.now();
    timings[k] = Math.round(now - t);
    t = now;
  };
  const archive = await openFig(source);
  lap('архив');
  const { message } = decodeFigKiwi(archive.kiwi);
  lap('kiwi');
  const scene = buildScene(message);
  lap('сцена');
  // Only the first page right away: the editor loads the rest in the background.
  const { doc, report, more } = sceneToCore(scene, new Document({ clientId: Math.floor(Math.random() * 2 ** 31) }), { lazy: true });
  doc.clearHistory();
  lap('модель');
  // Only images are needed from the archive: the archive itself with the message (tens of MB) is not kept;
  // the read function references only the source and the ZIP directory.
  const readImage = archive.readImage;
  return { doc, name: name.replace(/\.fig$/i, ''), images: { readImage }, report, timings, more };
}

/** Sketch: pages, artboards, symbols; images stay in memory until saved. */
async function importSketchFile(name: string, src: ByteSource): Promise<OpenResult> {
  const t = performance.now();
  const { importSketch } = await import('./sketch-import.ts');
  const clean = name.replace(/\.sketch$/i, '');
  const r = await importSketch(src, clean);
  return { doc: r.doc, name: clean, images: r.images, timings: { sketch: Math.round(performance.now() - t) }, warnings: r.warnings };
}

/** PDF: pages become frames, images stay in memory until saved. */
async function importPdfFile(name: string, bytes: Uint8Array): Promise<OpenResult> {
  const t = performance.now();
  const { importPdf } = await import('./pdf/import.ts');
  const clean = name.replace(/\.pdf$/i, '');
  const r = await importPdf(bytes, clean);
  return { doc: r.doc, name: clean, images: r.images, timings: { pdf: Math.round(performance.now() - t) }, warnings: r.warnings };
}

export async function openFile(file: File): Promise<OpenResult> {
  if (/\.fig$/i.test(file.name)) return importFig(file.name, new BlobSource(file));
  if (/\.pdf$/i.test(file.name)) return importPdfFile(file.name, new Uint8Array(await file.arrayBuffer()));
  if (/\.sketch$/i.test(file.name)) return importSketchFile(file.name, new BlobSource(file));
  const { doc, images } = await readMfp(new BlobSource(file));
  return { doc, name: file.name.replace(/\.(mfp|json)$/i, ''), images };
}

export async function openFixture(name: string): Promise<OpenResult> {
  return importFig(name, await HttpRangeSource.open(`/fixtures/${encodeURIComponent(name)}`));
}

/** Save .mfp (the document and all its images) and hand it to the browser for download. */
export async function download(doc: Document, name: string, images: ImageBytesSource | null, onProgress?: (done: number) => void) {
  const { blob, missing } = await writeMfp(doc, images, onProgress);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name || t('Без названия')}.mfp`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return { size: blob.size, missing };
}

/** Desktop: a file from disk; .fig is imported (read in chunks), .pdf is imported, .mfp is opened as is. */
export async function openDiskFile(path: string): Promise<OpenResult> {
  const { DiskSource, baseName } = await import('./platform.ts');
  const src = await DiskSource.open(path);
  if (/\.fig$/i.test(path)) return importFig(baseName(path), src);
  if (/\.pdf$/i.test(path)) return importPdfFile(baseName(path), await src.read(0, src.size));
  if (/\.sketch$/i.test(path)) return importSketchFile(baseName(path), src);
  const { doc, images } = await readMfp(src);
  return { doc, name: baseName(path), images };
}
