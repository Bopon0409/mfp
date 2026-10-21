// The native .mfp format.
//   v2 — ZIP: document.json (document snapshot, deflate) and images/<sha1> (images as is).
//   v1 — a single JSON without images (read for compatibility).

import { Document, mediaHashes, type Snapshot } from '@mfp/core';
import type { ByteSource } from './source.ts';
import { readZipDirectory, readZipEntry, type ZipEntry } from './zip.ts';
import { ZipWriter } from './zip-write.ts';

/** Where to get image bytes by hash (.fig archive, .mfp file, images added in the editor). */
export interface ImageBytesSource {
  readImage(hash: string): Promise<Uint8Array | undefined>;
  /** Optional display-only variant. Saving/exporting must use readImage. */
  readImagePreview?(hash: string, maxSide: number): Promise<Uint8Array | undefined>;
}

interface MfpDocumentFile {
  format: 'mfp';
  version: 1 | 2;
  document: Snapshot;
}

export const MFP_VERSION = 2;

/** Hashes of all images the document references. */
export function imageHashes(doc: Document): Set<string> {
  const out = new Set<string>();
  for (const id of doc.descendants(doc.root)) for (const hash of mediaHashes(doc.props(id))) out.add(hash);
  return out;
}

/** Save the document with images; onProgress — completion fraction (0…1). */
export async function writeMfp(doc: Document, images: ImageBytesSource | null, onProgress?: (done: number) => void): Promise<{ blob: Blob; missing: string[] }> {
  const zip = new ZipWriter();
  const file: MfpDocumentFile = { format: 'mfp', version: MFP_VERSION, document: doc.snapshot() };
  zip.add('document.json', new TextEncoder().encode(JSON.stringify(file)), true);
  const hashes = [...imageHashes(doc)];
  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i++) {
    const hash = hashes[i]!;
    const bytes = images ? await images.readImage(hash) : undefined;
    if (bytes) zip.add(`images/${hash}`, bytes);
    else missing.push(hash);
    onProgress?.((i + 1) / hashes.length);
  }
  return { blob: zip.finish(), missing };
}

function parseDocument(text: string): Document {
  const data = JSON.parse(text) as Partial<MfpDocumentFile>;
  if (data.format !== 'mfp' || !data.document) throw new Error('Это не файл MFP');
  if (data.version !== 1 && data.version !== 2) throw new Error(`Версия файла ${data.version} не поддерживается — обновите редактор`);
  return Document.fromSnapshot(data.document, Math.floor(Math.random() * 2 ** 31));
}

/** Open a .mfp (v2 — ZIP with images, v1 — JSON). */
export async function readMfp(src: ByteSource): Promise<{ doc: Document; images: ImageBytesSource | null }> {
  const head = await src.read(0, Math.min(4, src.size));
  if (head[0] !== 0x50 || head[1] !== 0x4b) {
    // v1: the whole file is JSON.
    return { doc: parseDocument(new TextDecoder().decode(await src.read(0, src.size))), images: null };
  }
  const entries = await readZipDirectory(src);
  const byName = new Map<string, ZipEntry>(entries.map((e) => [e.name, e]));
  const docEntry = byName.get('document.json');
  if (!docEntry) throw new Error('В файле .mfp нет document.json');
  const doc = parseDocument(new TextDecoder().decode(await readZipEntry(src, docEntry)));
  return {
    doc,
    images: {
      readImage: async (hash) => {
        const e = byName.get(`images/${hash}`);
        return e ? readZipEntry(src, e) : undefined;
      },
    },
  };
}
