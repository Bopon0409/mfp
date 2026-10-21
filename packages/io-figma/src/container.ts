// Reading the .fig container.
//
// A modern .fig is a ZIP: canvas.fig (binary fig-kiwi), meta.json,
// thumbnail.png and an images/ folder (images by SHA-1). Old files and the
// clipboard contain fig-kiwi without the ZIP wrapper.
//
// fig-kiwi: 8-byte signature, uint32 LE version, then chunks
// [uint32 LE length][data]. Chunk 0 is the binary Kiwi schema, chunk 1 is the message
// with the document nodes. Both are compressed: zstd (new files) or raw deflate (old ones).

import { inflateSync, unzlibSync } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import type { ByteSource } from './source.ts';
import { readZipDirectory, readZipEntry, type ZipEntry } from './zip.ts';

/** Known signatures: design, FigJam, Slides. Other `fig-*` variants are accepted too. */
export const KNOWN_FIG_MAGICS = ['fig-kiwi', 'fig-jam.', 'fig-deck'] as const;

export interface FigKiwiPayload {
  magic: string;
  version: number;
  /** Decompressed chunks: [0] schema, [1] message, then more if present. */
  chunks: Uint8Array[];
}

export interface FigArchive {
  kiwi: FigKiwiPayload;
  /** Images in images/: name (hex SHA-1) → compressed size. Bytes are read lazily. */
  images: Map<string, number>;
  readImage(name: string): Promise<Uint8Array | undefined>;
  meta: unknown;
  thumbnail: Uint8Array | undefined;
  /** Source file size and how many bytes had to be read on open. */
  fileSize: number;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

export function decompressChunk(data: Uint8Array): Uint8Array {
  if (startsWith(data, ZSTD_MAGIC)) return zstdDecompress(data);
  try {
    return inflateSync(data);
  } catch {
    return unzlibSync(data);
  }
}

export function readFigKiwi(bytes: Uint8Array): FigKiwiPayload {
  const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
  if (!magic.startsWith('fig-')) {
    throw new Error(`Неизвестная сигнатура fig-kiwi: ${JSON.stringify(magic)}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let offset = 12;
  while (offset + 4 <= bytes.byteLength) {
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > bytes.byteLength) throw new Error('Обрезанный чанк fig-kiwi');
    chunks.push(decompressChunk(bytes.subarray(offset, offset + len)));
    offset += len;
  }
  if (chunks.length < 2) throw new Error(`Ожидалось минимум 2 чанка, получено ${chunks.length}`);
  return { magic, version, chunks };
}

export async function openFig(src: ByteSource): Promise<FigArchive> {
  const head = await src.read(0, 8);
  if (!startsWith(head, ZIP_MAGIC)) {
    return {
      kiwi: readFigKiwi(await src.read(0, src.size)),
      images: new Map(),
      readImage: async () => undefined,
      meta: undefined,
      thumbnail: undefined,
      fileSize: src.size,
    };
  }
  const entries = await readZipDirectory(src);
  const byName = new Map<string, ZipEntry>(entries.map((e) => [e.name, e]));
  const canvas = byName.get('canvas.fig');
  if (!canvas) throw new Error('В архиве .fig нет canvas.fig');
  const images = new Map<string, number>();
  for (const e of entries) {
    if (e.name.startsWith('images/') && e.size > 0) images.set(e.name.slice('images/'.length), e.compressedSize);
    // Fill videos are alongside (if Figma puts them in a separate folder).
    else if (e.name.startsWith('videos/') && e.size > 0) images.set(e.name.slice('videos/'.length), e.compressedSize);
  }
  const metaEntry = byName.get('meta.json');
  const thumbEntry = byName.get('thumbnail.png');
  return {
    kiwi: readFigKiwi(await readZipEntry(src, canvas)),
    images,
    readImage: async (name) => {
      const e = byName.get(`images/${name}`) ?? byName.get(`videos/${name}`);
      return e ? readZipEntry(src, e) : undefined;
    },
    meta: metaEntry ? JSON.parse(new TextDecoder().decode(await readZipEntry(src, metaEntry))) : undefined,
    thumbnail: thumbEntry ? await readZipEntry(src, thumbEntry) : undefined,
    fileSize: src.size,
  };
}

/** Figma binary data from clipboard HTML (<!--(figma)base64(/figma)-->), otherwise null. */
export function figmaClipboardBytes(html: string): Uint8Array | null {
  const m = /\(figma\)([A-Za-z0-9+/=\s]+)\(\/figma\)/.exec(html);
  if (!m) return null;
  const bin = atob(m[1]!.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
