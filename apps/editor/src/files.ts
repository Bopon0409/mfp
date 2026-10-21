// The open file and its lifecycle: working copy (autosave), versions, thumbnail, writing to disk.
//
// A new file enters the library on its first save; an import (.fig, .mfp) — immediately.
// Desktop: a file has a path to a .mfp — it is written on Ctrl+S, on close and during idle time (5 s
// after autosave, no more often than 10 write durations); on open whichever is newer is taken:
// the file on disk or the working copy (a crash before writing to disk loses no edits).
//
// A file on the server (openRemote) lives on the server: no working copy or versions on this device;
// name and thumbnail go to the server (hooks.remote).

import { userPages, type Document } from '@mfp/core';
import { readMfp, readZipDirectory, readZipEntry, writeMfp, type ImageBytesSource } from '@mfp/io-figma';
import type { Editor } from './editor.ts';
import { Autosave, legacyAutosave } from './autosave.ts';
import { Library, newFileId, type FileMeta } from './library.ts';
import { Versions } from './versions.ts';
import type { JournalMark } from './journal.ts';
import { baseName, dirName, disk, DiskSource, isDesktop, joinPath, saveDialog } from './platform.ts';
import type { FileRole } from './account.ts';
import { t } from './i18n/index.ts';

export interface FileHooks {
  /** Show the document in the editor (plugins, camera, status bar — handled by main.ts). */
  show(doc: Document, name: string, images: ImageBytesSource | null): void;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Name, path or saved state changed (title, tabs). */
  changed(): void;
  /** Working copy written (status bar). */
  saved?(ms: number): void;
  /** File on the server: rename, write the thumbnail. */
  remote?: {
    rename(id: string, name: string): Promise<void>;
    thumbnail(id: string, png: Blob): Promise<void>;
  };
}

const COVER_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'SECTION', 'INSTANCE', 'GROUP']);

export class Files {
  readonly lib: Library | null;
  readonly versions: Versions | null;
  readonly autosave: Autosave;
  current: FileMeta;
  /** The file has an entry in the library (a new file — after its first save). */
  private indexed = false;
  private ed: Editor;
  private hooks: FileHooks;
  private thumbAt = 0;
  private thumbTimer: ReturnType<typeof setTimeout> | null = null;
  /** Desktop: edits since the last write to disk. */
  diskDirty = false;
  private diskTimer: ReturnType<typeof setTimeout> | null = null;
  private diskWriting: Promise<void> | null = null;
  private diskDuration = 0;
  /** Desktop: the user's files folder (Documents/MFP). */
  workspace: string | null = null;
  /** A server file is open: its id, role and (for a branch) the main file; null — a file on this device. */
  remote: { id: string; role: FileRole; parentId?: string | null } | null = null;

  private constructor(ed: Editor, lib: Library | null, hooks: FileHooks) {
    this.ed = ed;
    this.lib = lib;
    this.hooks = hooks;
    this.current = fresh(t('Без названия'));
    this.versions = lib ? new Versions(lib) : null;
    this.autosave = new Autosave(ed, () => this.current.name, async () => (this.lib ? this.lib.dir(this.current.id) : null));
    this.autosave.onSaved = (ms, bytes) => void this.saved(ms, bytes);
    // .fig import on desktop: images are in the source file anyway — copied in the background, not before the snapshot.
    this.autosave.deferImages = () => !!figSource(this.current);
    ed.onDocument.push((ops) => this.versions?.track(ops));
  }

  static async create(ed: Editor, hooks: FileHooks): Promise<Files> {
    const f = new Files(ed, await Library.open(), hooks);
    f.versions?.attach(null, ed.doc);
    if (isDesktop) f.workspace = (await disk.dirs().catch(() => null))?.[0] ?? null;
    // “Recent” files from an old version: the shell allows only files the person picked, and those
    // were picked before it started remembering that (runs once).
    if (isDesktop && f.lib) {
      const { files } = await f.lib.list().catch(() => ({ files: [] as FileMeta[] }));
      const paths = files.flatMap((m) => [m.path, m.source?.startsWith('fig:') ? m.source.slice(4) : undefined]).filter((p): p is string => !!p);
      if (paths.length) await disk.migrateGrants(paths).catch(() => 0);
    }
    return f;
  }

  get name() {
    return this.current.name;
  }

  /** Make the file the open one (the document is already in the editor). journal — working copy snapshot mark (continue the edit journal). */
  private attach(meta: FileMeta, indexed: boolean, journal: JournalMark | null = null) {
    this.remote = null;
    this.current = meta;
    this.indexed = indexed;
    this.autosave.reset(journal);
    this.versions?.attach(meta.id, this.ed.doc);
    void this.versions?.resume(journal);
    this.diskDirty = false;
    if (this.diskTimer) clearTimeout(this.diskTimer);
    this.diskTimer = null;
    this.thumbAt = 0;
    this.hooks.changed();
  }

  /**
   * Before switching files and closing: finish the working copy, take a version, write to disk.
   * false — edits were not written (neither to the working copy nor to the file on disk).
   */
  async leave(): Promise<boolean> {
    // The journal is enough — append a batch (fast even for a huge file); otherwise — a snapshot.
    await this.autosave.flushQuick();
    if (this.indexed) await this.versions?.leave(this.autosave.journal.mark()).catch((e) => console.warn('Версия не снята', e));
    let disk = true;
    if (isDesktop && this.current.path && this.diskDirty)
      await this.writeDisk(this.current.path).catch((e) => {
        disk = false;
        this.hooks.notify(`Не удалось записать файл: ${(e as Error).message}`, 'error');
      });
    return this.autosave.saved && disk;
  }

  // ---------- Startup ----------

  /**
   * Open the last file (true — opened). The former autosave is moved into the library.
   * canReplace — whether the document can still be replaced (the user may have started working while it was being read).
   */
  async start(canReplace: () => boolean = () => true): Promise<boolean> {
    if (!this.lib) return false;
    await this.migrateLegacy().catch((e) => console.warn('Перенос автосохранения не удался', e));
    const { files } = await this.lib.list();
    const last = files.filter((f) => !f.trashed).sort((a, b) => b.opened - a.opened)[0];
    return last && canReplace() ? this.openId(last.id, true, canReplace) : false;
  }

  private async migrateLegacy() {
    const legacy = await legacyAutosave();
    if (!legacy || !this.lib) return;
    const text = await (await (await legacy.getFileHandle('document.json')).getFile()).text();
    const data = JSON.parse(text) as { name?: string; savedAt?: number };
    const id = newFileId();
    const dst = await this.lib.dir(id);
    const copy = async (from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle) => {
      for await (const h of (from as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (h.kind === 'directory') await copy(h as FileSystemDirectoryHandle, await to.getDirectoryHandle(h.name, { create: true }));
        else {
          const w = await (await to.getFileHandle(h.name, { create: true })).createWritable();
          await w.write(await (h as FileSystemFileHandle).getFile());
          await w.close();
        }
      }
    };
    await copy(legacy, dst);
    const at = data.savedAt ?? Date.now();
    await this.lib.put({ id, name: data.name ?? t('Без названия'), folder: '', created: at, modified: at, opened: at });
    const opfs = await navigator.storage.getDirectory();
    await opfs.removeEntry('autosave', { recursive: true });
  }

  // ---------- Opening ----------

  /** Open a library file. */
  async openId(id: string, quiet = false, canReplace: () => boolean = () => true): Promise<boolean> {
    if (!this.lib) return false;
    const meta = await this.lib.get(id);
    if (!meta) return false;
    if (meta.id !== this.current.id && !(await this.leave())) return false;
    const copy = await this.lib.readDocument(id);
    let r: { doc: Document; images: ImageBytesSource | null; savedAt: number; journal?: JournalMark | null } | null = copy;
    let recovered = false;
    // Desktop: the file on disk is newer than the working copy — take it.
    if (isDesktop && meta.path) {
      const st = await disk.stat(meta.path).catch(() => null);
      if (st && (!r || st.modified > r.savedAt + 2000)) {
        const fromDisk = await this.readDisk(meta.path).catch(() => null);
        if (fromDisk) r = { ...fromDisk, savedAt: st.modified };
      } else if (st && r) recovered = r.savedAt > st.modified + 2000;
    }
    if (!r) {
      if (!quiet) this.hooks.notify(`Файл «${meta.name}» не удалось открыть: рабочая копия пуста или повреждена`, 'error');
      return false;
    }
    if (!canReplace()) return false;
    // Imported images not yet copied into the working copy — from the source .fig on disk.
    const fig = r === copy ? figSource(meta) : null;
    if (fig && r.images) r = { ...r, images: withFallback(r.images, fig) };
    this.hooks.show(r.doc, meta.name, r.images);
    const now = Date.now();
    this.attach({ ...meta, opened: now }, true, r.journal ?? null);
    await this.lib.update(id, { opened: now });
    if (r === copy && copy) {
      if (copy.lost && !quiet) this.hooks.notify('Последние правки файла восстановлены не полностью: часть журнала правок не прочиталась', 'error');
      // A long journal or a new line — a snapshot soon (opening becomes faster, the journal shorter).
      if (copy.lost || copy.replayed > 1000) this.autosave.markDirty();
    }
    if (recovered) {
      this.diskDirty = true;
      this.hooks.notify('Восстановлены правки, не записанные в файл на диске; Ctrl+S — записать');
    }
    return true;
  }

  /** A document opened from outside (import, sample, room): add it to the library. */
  async adopt(name: string, origin: { source?: string; path?: string; reuse?: boolean } = {}) {
    let meta: FileMeta | null = null;
    if (this.lib && origin.path) meta = await this.lib.findBy('path', origin.path);
    if (this.lib && !meta && origin.source && origin.reuse) meta = await this.lib.findBy('source', origin.source);
    const now = Date.now();
    if (meta) this.attach({ ...meta, opened: now, ...(origin.path ? { name: baseName(origin.path) } : {}) }, true);
    else this.attach(fresh(name, { ...(origin.source ? { source: origin.source } : {}), ...(origin.path ? { path: origin.path } : {}) }), false);
    // Working copy right away (an import has none yet; a file from disk — a fresh one).
    this.autosave.markDirty();
  }

  /** New empty file (the document is already in the editor). */
  newFile(folder = '') {
    this.attach(fresh(t('Без названия'), { folder }), false);
  }

  /** A server file is open (the document is already in the editor): no working copy or versions here. */
  openRemote(file: { id: string; name: string; parentId?: string | null }, role: FileRole) {
    const now = Date.now();
    this.attach({ id: `srv:${file.id}`, name: file.name, folder: '', created: now, modified: now, opened: now }, false);
    this.remote = { id: file.id, role, parentId: file.parentId ?? null };
    this.autosave.paused = true;
    this.versions?.attach(null, this.ed.doc);
    this.hooks.changed();
  }

  /** Own edit of a server file was sent: thumbnail no more than once a minute. */
  remoteEdited() {
    if (this.remote) this.scheduleThumbnail();
  }

  /** Desktop: read a .mfp or import a .fig from disk. */
  async readDisk(path: string): Promise<{ doc: Document; images: ImageBytesSource | null }> {
    const src = await DiskSource.open(path);
    return readMfp(src);
  }

  // ---------- Saving ----------

  private async saved(ms: number, bytes: number) {
    this.hooks.saved?.(ms);
    if (!this.lib) return;
    const now = Date.now();
    this.current.modified = now;
    this.current.size = bytes;
    if (!this.indexed) {
      this.indexed = true;
      await this.lib.put(this.current);
    } else await this.lib.update(this.current.id, { modified: now, size: bytes, name: this.current.name });
    this.scheduleThumbnail();
    if (isDesktop && this.current.path) {
      this.diskDirty = true;
      this.scheduleDisk();
      this.hooks.changed();
    }
  }

  /** Rename the open file (and the file on disk, if the name is free). */
  async rename(name: string) {
    const clean = name.trim();
    if (!clean || clean === this.current.name) return;
    if (this.remote) {
      try {
        await this.hooks.remote?.rename(this.remote.id, clean);
        this.current.name = clean;
      } catch (e) {
        this.hooks.notify(`Не удалось переименовать: ${(e as Error).message}`, 'error');
      }
      this.hooks.changed();
      return;
    }
    this.current.name = clean;
    if (isDesktop && this.current.path) {
      const to = joinPath(dirName(this.current.path), `${clean.replace(/[\\/:*?"<>|]/g, '_')}.mfp`);
      if (to !== this.current.path) {
        try {
          await disk.rename(this.current.path, to);
          this.current.path = to;
        } catch (e) {
          this.hooks.notify(`Файл на диске не переименован: ${(e as Error).message}`, 'error');
        }
      }
    }
    if (this.indexed) await this.lib?.update(this.current.id, { name: clean, ...(this.current.path ? { path: this.current.path } : {}) });
    this.autosave.markDirty();
    this.hooks.changed();
  }

  /** Desktop, Ctrl+S: write to disk (no path — ask). false — canceled. */
  async saveToDisk(as = false): Promise<boolean> {
    let path = as ? undefined : this.current.path;
    if (!path) {
      const def = this.workspace ? joinPath(this.workspace, `${this.current.name}.mfp`) : `${this.current.name}.mfp`;
      path = (await saveDialog({ defaultPath: def, title: as ? 'Сохранить как' : 'Сохранить файл' })) ?? undefined;
      if (!path) return false;
      if (!/\.mfp$/i.test(path)) path += '.mfp';
      this.current.path = path;
      this.current.name = baseName(path);
      // A saved file is no longer “imported from”: reopening the .fig is a new import.
      delete this.current.source;
    }
    await this.autosave.flush();
    await this.writeDisk(path);
    if (!this.indexed) {
      this.indexed = true;
      await this.lib?.put(this.current);
    } else await this.lib?.update(this.current.id, { path, name: this.current.name, source: undefined });
    this.hooks.changed();
    return true;
  }

  private scheduleDisk() {
    if (this.diskTimer) clearTimeout(this.diskTimer);
    const wait = Math.max(5000, this.diskDuration * 10);
    this.diskTimer = setTimeout(() => {
      this.diskTimer = null;
      const path = this.current.path;
      if (path && this.diskDirty) void this.writeDisk(path).catch((e) => this.hooks.notify(`Не удалось записать файл: ${(e as Error).message}`, 'error'));
    }, wait);
  }

  /** Write the .mfp to disk (sequentially; edits during the write go into the next write). */
  async writeDisk(path: string): Promise<void> {
    if (this.diskWriting) await this.diskWriting;
    const run = async () => {
      if (this.ed.importing) await this.ed.importing;
      const t0 = performance.now();
      this.diskDirty = false;
      const { blob, missing } = await writeMfp(this.ed.doc, this.ed.store);
      await disk.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      this.diskDuration = performance.now() - t0;
      if (missing.length) this.hooks.notify(`Не найдено картинок: ${missing.length} — в файл они не попали`, 'error');
      this.hooks.changed();
    };
    this.diskWriting = run()
      .catch((e) => {
        this.diskDirty = true;
        throw e;
      })
      .finally(() => (this.diskWriting = null));
    return this.diskWriting;
  }

  // ---------- Thumbnail ----------

  private scheduleThumbnail() {
    if (this.thumbTimer) return;
    const wait = Math.max(0, 60_000 - (Date.now() - this.thumbAt));
    this.thumbTimer = setTimeout(() => {
      this.thumbTimer = null;
      void this.makeThumbnail();
    }, wait || 1500);
  }

  /** Thumbnail — the first frame of the first page. */
  async makeThumbnail() {
    if (!this.remote && (!this.lib || !this.indexed)) return;
    const doc = this.ed.doc;
    const page = userPages(doc)[0];
    if (!page) return;
    const kids = doc.children(page).filter((id) => doc.get(id, 'visible') !== false);
    // The cover can be chosen (frame context menu); otherwise — the first frame of the first page.
    const chosen = doc.get(doc.root, 'thumbnailNodeId');
    const cover = (chosen && doc.has(chosen) ? chosen : null) ?? kids.find((id) => COVER_TYPES.has(doc.type(id)!)) ?? kids[0];
    if (!cover) return;
    const id = this.current.id;
    const remote = this.remote;
    this.thumbAt = Date.now();
    try {
      const blob = await this.ed.renderThumbnail(cover, 480);
      if (!blob || this.current.id !== id) return;
      if (remote) await this.hooks.remote?.thumbnail(remote.id, blob);
      else await this.lib?.writeThumbnail(id, blob);
    } catch (e) {
      console.warn('Миниатюра не получилась', e);
    }
  }
}

function fresh(name: string, extra: Partial<FileMeta> = {}): FileMeta {
  const now = Date.now();
  return { id: newFileId(), name, folder: '', created: now, modified: now, opened: now, ...extra };
}

/** Desktop: path to the source .fig of a file imported from disk (null — none). */
function figSource(meta: FileMeta): string | null {
  return isDesktop && meta.source?.startsWith('fig:') ? meta.source.slice(4) : null;
}

/**
 * Images of the working copy, and those not there yet — from the source .fig (the archive directory is read on first
 * need; the .fig document itself is not parsed). If the file was moved, images not yet copied into the working copy are lost.
 */
function withFallback(own: ImageBytesSource, figPath: string): ImageBytesSource {
  let archive: Promise<((hash: string) => Promise<Uint8Array | undefined>) | null> | null = null;
  return {
    readImage: async (hash) => {
      const bytes = await own.readImage(hash);
      if (bytes) return bytes;
      archive ??= (async () => {
        try {
          const src = await DiskSource.open(figPath);
          const byName = new Map((await readZipDirectory(src)).map((e) => [e.name, e]));
          return async (h: string) => {
            const e = byName.get(`images/${h}`) ?? byName.get(`videos/${h}`);
            return e ? readZipEntry(src, e) : undefined;
          };
        } catch {
          return null;
        }
      })();
      return (await archive)?.(hash);
    },
  };
}
