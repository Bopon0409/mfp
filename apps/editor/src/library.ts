// User files: the index (folders, files, edit and open times, thumbnails) and working copies.
//
// Everything lives in browser storage (OPFS; on desktop too, in WebView2):
//   library/index.json                 — index: folders and files;
//   library/files/<id>/document.json   — working copy (like document.json in .mfp);
//   library/files/<id>/journal/…        — edit journal after the snapshot (journal.ts);
//   library/files/<id>/images/<sha1>   — document images;
//   library/files/<id>/thumb.png       — thumbnail;
//   library/files/<id>/versions/…      — version history (versions.ts).
// A file lives only in storage (web) or also on disk (desktop: path is the .mfp; for an import, the
// .fig path is in source). Deleting moves to trash; “Delete forever” removes it from trash.
// Several tabs edit the index: each edit is read, modify, write under a lock.

import { Document } from '@mfp/core';
import { parseJsonAsync } from './parse-json.ts';
import type { ImageBytesSource } from '@mfp/io-figma';
import { readJournal, type JournalMark } from './journal.ts';
import { t } from './i18n/index.ts';

export interface FileMeta {
  id: string;
  name: string;
  /** Folder: '' is the root, “Clients/Bank” is nested. */
  folder: string;
  created: number;
  /** Last edit. */
  modified: number;
  /** Last opened (“Recent”). */
  opened: number;
  /** Working copy size, bytes (estimate). */
  size?: number;
  /** Desktop: the .mfp file on disk. */
  path?: string;
  /** Where it came from (.fig import, sample, collaboration room), to reopen the same thing. */
  source?: string;
  /** In trash since this moment. */
  trashed?: number;
}

interface Index {
  version: 1;
  folders: string[];
  files: Record<string, FileMeta>;
}

interface WorkCopy {
  format: 'mfp';
  version: 2;
  name: string;
  savedAt: number;
  document: ReturnType<Document['snapshot']>;
}

const ROOT = 'library';
const EMPTY: Index = { version: 1, folders: [], files: {} };

export const newFileId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | string | Uint8Array) {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(data as FileSystemWriteChunkType);
  await w.close();
}

async function readText(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    return await (await (await dir.getFileHandle(name)).getFile()).text();
  } catch {
    return null;
  }
}

/** Under a lock (if the browser supports it): index edits from different tabs take turns. */
async function locked<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: { request(name: string, cb: () => Promise<T>): Promise<T> } }).locks;
  return locks ? locks.request('mfp-library', fn) : fn();
}

export class Library {
  private root: FileSystemDirectoryHandle;
  private files: FileSystemDirectoryHandle;
  /** The index changed (here or in another tab). */
  onChange: (() => void)[] = [];
  private channel: BroadcastChannel | null = null;

  private constructor(root: FileSystemDirectoryHandle, files: FileSystemDirectoryHandle) {
    this.root = root;
    this.files = files;
    try {
      this.channel = new BroadcastChannel('mfp-library');
      this.channel.onmessage = () => this.onChange.forEach((cb) => cb());
    } catch {
      // no channel: other tabs find out on their next read
    }
  }

  /**
   * Persistent storage: without it the browser may delete files when space runs low (this did happen
   * in the browser's built-in panel: only empty folders were left). Chromium decides on its own, without
   * asking; true means persisted.
   */
  static async persist(): Promise<boolean> {
    try {
      return (await navigator.storage.persisted?.()) || ((await navigator.storage.persist?.()) ?? false);
    } catch {
      return false;
    }
  }

  /** null: no storage (old browser, private mode). */
  static async open(): Promise<Library | null> {
    try {
      void Library.persist();
      const opfs = await navigator.storage.getDirectory();
      const root = await opfs.getDirectoryHandle(ROOT, { create: true });
      const files = await root.getDirectoryHandle('files', { create: true });
      return new Library(root, files);
    } catch {
      return null;
    }
  }

  private async read(): Promise<Index> {
    const text = await readText(this.root, 'index.json');
    if (!text) return structuredClone(EMPTY);
    try {
      const data = JSON.parse(text) as Index;
      return data.version === 1 ? data : structuredClone(EMPTY);
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /** Modify the index (under a lock) and notify the tabs. */
  private async edit<T>(fn: (index: Index) => T): Promise<T> {
    const r = await locked(async () => {
      const index = await this.read();
      const out = fn(index);
      await writeFile(this.root, 'index.json', JSON.stringify(index));
      return out;
    });
    this.onChange.forEach((cb) => cb());
    this.channel?.postMessage('changed');
    return r;
  }

  async list(): Promise<{ folders: string[]; files: FileMeta[] }> {
    const index = await this.read();
    return { folders: [...index.folders].sort((a, b) => a.localeCompare(b, 'ru')), files: Object.values(index.files) };
  }

  async get(id: string): Promise<FileMeta | null> {
    return (await this.read()).files[id] ?? null;
  }

  async findBy(key: 'path' | 'source', value: string): Promise<FileMeta | null> {
    const index = await this.read();
    return Object.values(index.files).find((f) => f[key] === value && !f.trashed) ?? null;
  }

  /** Add or update a file record. */
  async put(meta: FileMeta): Promise<FileMeta> {
    return this.edit((index) => {
      index.files[meta.id] = { ...index.files[meta.id], ...meta };
      if (meta.folder) for (const f of ancestors(meta.folder)) if (!index.folders.includes(f)) index.folders.push(f);
      return index.files[meta.id]!;
    });
  }

  async update(id: string, patch: Partial<FileMeta>): Promise<FileMeta | null> {
    return this.edit((index) => {
      const f = index.files[id];
      if (!f) return null;
      Object.assign(f, patch);
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (f as unknown as Record<string, unknown>)[k];
      return f;
    });
  }

  /** Move to trash (restore brings it back). */
  trash(id: string) {
    return this.update(id, { trashed: Date.now() });
  }

  restore(id: string) {
    return this.update(id, { trashed: undefined });
  }

  /** Permanently: the record and the working copy with versions. */
  async purge(id: string) {
    await this.edit((index) => {
      delete index.files[id];
    });
    try {
      await this.files.removeEntry(id, { recursive: true });
    } catch {
      // there was no working copy
    }
  }

  async makeFolder(path: string) {
    const clean = normalizeFolder(path);
    if (!clean) return;
    await this.edit((index) => {
      for (const f of ancestors(clean)) if (!index.folders.includes(f)) index.folders.push(f);
    });
  }

  /** Rename or move a folder (with all its contents). */
  async moveFolder(from: string, to: string) {
    const dst = normalizeFolder(to);
    if (!dst || dst === from || dst.startsWith(`${from}/`)) return;
    await this.edit((index) => {
      const re = (p: string) => (p === from ? dst : p.startsWith(`${from}/`) ? dst + p.slice(from.length) : p);
      index.folders = [...new Set(index.folders.map(re))];
      for (const f of ancestors(dst)) if (!index.folders.includes(f)) index.folders.push(f);
      for (const f of Object.values(index.files)) f.folder = re(f.folder);
    });
  }

  /** Delete a folder: its files go to trash. */
  async removeFolder(path: string) {
    const now = Date.now();
    await this.edit((index) => {
      const inside = (p: string) => p === path || p.startsWith(`${path}/`);
      index.folders = index.folders.filter((f) => !inside(f));
      for (const f of Object.values(index.files)) {
        if (!inside(f.folder)) continue;
        f.folder = '';
        f.trashed ??= now;
      }
    });
  }

  // ---------- Working copies ----------

  async dir(id: string): Promise<FileSystemDirectoryHandle> {
    return this.files.getDirectoryHandle(id, { create: true });
  }

  /** Write the document's working copy (without images: Autosave writes them one by one). */
  async writeDocument(id: string, name: string, json: string) {
    await writeFile(await this.dir(id), 'document.json', json);
    void name;
  }

  /**
   * Working copy: the snapshot and journal edits after it, images (null: missing or corrupted).
   * journal is the mark to continue the journal from (null: start a new line); savedAt is the time
   * of the last write (snapshot or journal batch); lost means part of the journal could not be read.
   */
  async readDocument(id: string): Promise<{
    doc: Document;
    name: string;
    savedAt: number;
    images: ImageBytesSource;
    journal: JournalMark | null;
    replayed: number;
    lost: boolean;
  } | null> {
    const dir = await this.dir(id);
    const text = await readText(dir, 'document.json');
    if (!text) return null;
    let data: Partial<WorkCopy> & { journal?: JournalMark };
    let doc: Document;
    try {
      data = await parseJsonAsync(text) as typeof data;
      if (data.format !== 'mfp' || !data.document) return null;
      doc = await Document.fromSnapshotAsync(data.document, Math.floor(Math.random() * 2 ** 31));
    } catch {
      return null;
    }
    let savedAt = data.savedAt ?? 0;
    let journal: JournalMark | null = null;
    let replayed = 0;
    let lost = false;
    if (data.journal) {
      const j = await readJournal(dir, data.journal).catch(() => null);
      lost = !j || j.gap;
      if (j) {
        // In batches: a corrupted operation stops recovery at that point instead of failing the open.
        // A hole in the journal (gap): operations before it are still ours.
        for (let i = 0; i < j.ops.length; i += 1000) {
          try {
            doc.apply(j.ops.slice(i, i + 1000), 'load');
            replayed = Math.min(j.ops.length, i + 1000);
            if (i + 1000 < j.ops.length) await new Promise((r) => setTimeout(r, 0));
          } catch (e) {
            console.warn('Журнал правок: восстановление остановлено', e);
            lost = true;
            break;
          }
        }
        savedAt = Math.max(savedAt, j.at);
      }
      // The journal is intact: continue its line; otherwise a new one (the next snapshot removes the old one).
      if (!lost && j) journal = { lineage: data.journal.lineage, next: j.next };
    }
    return { doc, name: data.name ?? t('Без названия'), savedAt, images: imagesIn(dir), journal, replayed, lost };
  }

  /**
   * Write a whole working copy for a file that is not open in the editor (moving a page into
   * it). The edit journal of the previous line is no longer read (it is not in the snapshot).
   */
  async writeWorkCopy(id: string, name: string, doc: Document) {
    const data: WorkCopy = { format: 'mfp', version: 2, name, savedAt: Date.now(), document: doc.snapshot() };
    await writeFile(await this.dir(id), 'document.json', JSON.stringify(data));
    this.channel?.postMessage('changed');
  }

  /** An image (video, audio) into the file's working copy, by hash. */
  async writeImage(id: string, hash: string, bytes: Uint8Array) {
    const images = await (await this.dir(id)).getDirectoryHandle('images', { create: true });
    await writeFile(images, hash, bytes);
  }

  /** Working copy images (for opening and for “Save as”). */
  async images(id: string): Promise<ImageBytesSource> {
    return imagesIn(await this.dir(id));
  }

  async writeThumbnail(id: string, png: Blob) {
    await writeFile(await this.dir(id), 'thumb.png', png);
    this.channel?.postMessage('thumb');
  }

  /** Thumbnail as a PNG Blob (null: none yet). */
  async thumbnail(id: string): Promise<Blob | null> {
    try {
      return await (await (await this.files.getDirectoryHandle(id)).getFileHandle('thumb.png')).getFile();
    } catch {
      return null;
    }
  }

  /** Copy a working copy (file duplicate): document, images, thumbnail; not versions. */
  async copyWorkCopy(from: string, to: string) {
    const src = await this.dir(from);
    const dst = await this.dir(to);
    for (const name of ['document.json', 'thumb.png']) {
      try {
        await writeFile(dst, name, await (await src.getFileHandle(name)).getFile());
      } catch {
        // no such file
      }
    }
    // Images and the edit journal (without it the copy's snapshot would lag behind the original).
    for (const sub of ['images', 'journal']) {
      try {
        const si = await src.getDirectoryHandle(sub);
        const di = await dst.getDirectoryHandle(sub, { create: true });
        for await (const h of (si as unknown as { values(): AsyncIterable<FileSystemFileHandle> }).values()) await writeFile(di, h.name, await h.getFile());
      } catch {
        // no such folder
      }
    }
  }
}

function imagesIn(dir: FileSystemDirectoryHandle): ImageBytesSource {
  return {
    readImage: async (hash) => {
      try {
        const images = await dir.getDirectoryHandle('images');
        return new Uint8Array(await (await (await images.getFileHandle(hash)).getFile()).arrayBuffer());
      } catch {
        return undefined;
      }
    },
  };
}

/** “Clients/Bank” → ['Clients', 'Clients/Bank']. */
export function ancestors(folder: string): string[] {
  const parts = folder.split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

export function normalizeFolder(path: string): string {
  return path
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/');
}

/** Folder name is the last part of the path. */
export const folderName = (path: string) => path.split('/').pop() ?? path;
