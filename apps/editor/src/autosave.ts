// Autosave of the open file's working copy (library.ts): a tab reload or a crash does not
// wipe out work.
//
// <copy>/document.json — document snapshot (like document.json in .mfp), written atomically;
// <copy>/images/<sha1> — document images, one by one (only new ones), after the snapshot: by then
// the snapshot is already released (for a huge file it is hundreds of megabytes; holding it while gigabytes of
// imported images are copied means page memory over 3 GB and a frozen exchange with the shell). Integrity is ensured differently:
// the file enters the library (onSaved) and switches to the journal only after all its images;
// new images (paste) are written immediately when added. The exception is images that already
// lie in the source file on disk (.fig import on desktop, deferImages): their copy is not needed for
// integrity, and there is no point copying gigabytes at once — they are copied in the background bit by bit, with pauses for
// the garbage collector (all at once: page memory over 3 GB, stutters and a frozen exchange with the shell).
// <copy>/journal/… — edit journal (journal.ts): operations in batches ~0.3 s after an edit.
// The snapshot is written 2 s after the last edit — in chunks during idle time (a huge document
// takes a second or more to serialize: all at once that would be a freeze mid-work). If
// serialization is noticeable — no more often than once per 30 of its durations. Between snapshots edits go to the journal:
// a crash costs a fraction of a second of work, and closing or switching files only needs to write the last batch.
// New images (paste) are written immediately and before the batch that references them.

import type { Document } from '@mfp/core';
import type { Editor } from './editor.ts';
import { idleSnapshot, writeParts } from './idle-snapshot.ts';
import { Journal, type JournalMark } from './journal.ts';

const IDLE_MS = 2000;

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | string | Uint8Array) {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(data as FileSystemWriteChunkType);
  await w.close();
}

export class Autosave {
  private ed: Editor;
  private name: () => string;
  /** Working copy folder of the open file (null — no storage). */
  private dir: () => Promise<FileSystemDirectoryHandle | null>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private saving: Promise<void> | null = null;
  private lastDuration = 0;
  private lastSave = 0;
  /** Images already in the working copy. */
  private persisted = new Set<string>();
  /** The working copy image folder is already read into persisted (as one list, not a request per image). */
  private listed = false;
  /** Images exist in the source file on disk (.fig import on desktop): copy in the background, don't wait. */
  deferImages: () => boolean = () => false;
  /** Background image copy number: if it changes (another file), the copy stops. */
  private trickleRun = 0;
  /** Saved: snapshot duration and its size (bytes). */
  onSaved: ((ms: number, bytes: number) => void) | null = null;
  /** Do not save (version preview: edits there are not saved). */
  paused = false;
  /** Finish saving immediately, without idle time (leaving the file, closing, hidden tab). */
  private urgent = 0;
  /** Edit journal between snapshots. */
  readonly journal: Journal;
  /** The working copy has a snapshot of the current journal line: the journal is enough to lose nothing. */
  private based = false;
  /** Writing new images: the journal batch waits for it (an operation must not arrive before the image). */
  private imageWrites: Promise<void> = Promise.resolve();
  private unsubscribeStore: (() => void) | null = null;
  /** The document the journal follows, and journals of documents that left the canvas (version preview and return). */
  private journalDoc: Document | null = null;
  private parked = new WeakMap<Document, { mark: JournalMark; based: boolean }>();

  constructor(ed: Editor, name: () => string, dir: () => Promise<FileSystemDirectoryHandle | null>) {
    this.ed = ed;
    this.name = name;
    this.dir = dir;
    this.journal = new Journal(dir, () => this.imageWrites);
    ed.onDocument.push(() => this.changed());
    // The document was swapped without changing the file (version preview and restore): the journal follows it.
    ed.onDocumentSet.push((doc) => this.follow(doc));
    // The document the editor started with (new file): journal right away, the line snapshot with the first save.
    this.watch(ed.doc, null, false);
    // Leaving the tab — write immediately: the journal (fast) or, if it's not enough, the whole snapshot.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      if (this.canJournal) {
        void this.journal.flush();
        return;
      }
      if (!this.dirty && !this.saving) return;
      this.urgent++;
      void this.save().finally(() => this.urgent--);
    });
  }

  /** The journal is enough to lose nothing: a snapshot of its line is already in the working copy. */
  get canJournal(): boolean {
    return this.based && !this.journal.failed && !this.paused;
  }

  private changed() {
    if (this.paused) return;
    this.dirty = true;
    this.schedule();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    // Huge document: the pause between saves is at least 30 save durations.
    const wait = Math.max(IDLE_MS, this.lastDuration * 30 - (performance.now() - this.lastSave));
    this.timer = setTimeout(() => {
      this.timer = null;
      if ('requestIdleCallback' in window) requestIdleCallback(() => void this.save(), { timeout: 5000 });
      else void this.save();
    }, wait);
  }

  /**
   * Another file was opened: start over (save after the first edit or markDirty).
   * journal — mark of the snapshot the file was opened from (continue its journal line); null —
   * the document is new or swapped: a new line, the journal is not enough until the first snapshot.
   */
  reset(journal: JournalMark | null = null) {
    this.persisted.clear();
    this.listed = false;
    this.trickleRun++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.paused = false;
    this.parked = new WeakMap();
    this.watch(this.ed.doc, journal, !!journal);
  }

  /** The journal follows document doc (continue line mark or start a new one); based — the line snapshot is already written. */
  private watch(doc: Document, mark: JournalMark | null, based: boolean) {
    this.journalDoc = doc;
    this.based = based;
    this.journal.attach(doc, mark, () => !this.paused);
    this.unsubscribeStore?.();
    this.unsubscribeStore = this.ed.store.subscribe((hash, bytes) => this.persistImage(hash, bytes));
  }

  /** The editor has another document of the same file: the previous one is parked (when it returns, its line continues). */
  private follow(doc: Document) {
    if (doc === this.journalDoc) return;
    if (this.journalDoc) {
      void this.journal.flush();
      this.parked.set(this.journalDoc, { mark: this.journal.mark(), based: this.based });
    }
    const back = this.parked.get(doc);
    this.watch(doc, back?.mark ?? null, back?.based ?? false);
  }

  /** A new image goes into the working copy immediately (the edit journal may reference it before the snapshot). */
  private persistImage(hash: string, bytes: Uint8Array) {
    if (this.paused) return;
    const target = this.dir();
    this.imageWrites = this.imageWrites.then(async () => {
      try {
        const dir = await target;
        if (!dir) return;
        const images = await dir.getDirectoryHandle('images', { create: true });
        try {
          await images.getFileHandle(hash);
        } catch {
          await writeFile(images, hash, bytes);
        }
      } catch (e) {
        console.warn('Картинка не записана в рабочую копию', e);
      }
    });
  }

  /** Save without an edit (import: the working copy appears immediately). */
  markDirty() {
    this.dirty = true;
    this.schedule();
  }

  /** Wait until all edits are saved (before switching files, closing the window). */
  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.urgent++;
    try {
      if (this.saving) await this.saving;
      if (this.dirty) await this.save();
    } finally {
      this.urgent--;
    }
  }

  /**
   * Closing and switching files: if the journal is enough — write the last batch (a fraction of a second even for
   * a huge file; the snapshot will catch up next time), otherwise — a full snapshot.
   */
  async flushQuick() {
    if (!this.canJournal) {
      await this.flush();
      // Edits after the snapshot mark go to the journal (its line is now in the working copy).
      await this.journal.flush();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Don't wait for the snapshot being written during idle time: for a huge file that takes seconds. Closing cuts
    // it off (the write is atomic — the previous snapshot is intact, the journal isn't truncated); switching files cancels it.
    await this.journal.flush();
  }

  /** All edits are written (or writing is not needed: version preview, server file). */
  get saved(): boolean {
    if (this.paused) return true;
    if (this.canJournal && !this.journal.hasPending) return true;
    return !this.dirty && !this.saving;
  }

  async save(): Promise<void> {
    if (this.saving) return this.saving;
    if (!this.dirty || this.paused) return;
    const run = async () => {
      // The document is still loading — save it whole when it finishes.
      if (this.ed.importing) await this.ed.importing;
      const dir = await this.dir();
      if (!dir) return;
      this.dirty = false;
      const doc = this.ed.doc;
      try {
        let mark: JournalMark | null = null;
        const snap = await idleSnapshot(doc, {
          urgent: () => this.urgent > 0,
          cancelled: () => this.ed.doc !== doc,
          onCut: () => (mark = this.journalDoc === doc ? this.journal.mark() : null),
        });
        // While serializing, another document was opened (without flush — e.g. a version): don't write this one.
        if (!snap) return;
        this.lastDuration = snap.cpu;
        this.lastSave = performance.now();
        const cut = mark as JournalMark | null;
        const head = `{"format":"mfp","version":2,"name":${JSON.stringify(this.name())},"savedAt":${Date.now()},${cut ? `"journal":${JSON.stringify(cut)},` : ''}"document":`;
        await writeParts(dir, 'document.json', [head, ...snap.writer.chunks, '}']);
        const bytes = head.length + snap.writer.length + 1;
        const images = snap.writer.images;
        // Snapshot written — release the chunks before the images (the garbage collector takes them while we copy).
        snap.writer.chunks = [];
        await this.writeImages(dir, images);
        // The copy is complete: the journal before the snapshot is not needed, from now on the journal is enough; file goes to the library.
        // If another file was opened while writing (switching doesn't wait for the idle snapshot): don't touch its info.
        if (cut && this.ed.doc === doc && cut.lineage === this.journal.lineage) {
          this.based = true;
          void this.journal.truncate(dir, cut);
        }
        if (this.ed.doc === doc) this.onSaved?.(Math.round(snap.cpu), bytes);
      } catch (e) {
        console.warn('Автосохранение не удалось', e);
        this.dirty = true;
      }
    };
    this.saving = run().finally(() => {
      this.saving = null;
      // Edits that arrived during the write — with the next save.
      if (this.dirty && !this.paused && !this.timer) this.schedule();
    });
    return this.saving;
  }

  /** Snapshot images — one by one, only those not yet in the working copy. */
  private async writeImages(dir: FileSystemDirectoryHandle, hashes: ReadonlySet<string>) {
    if (this.deferImages()) {
      this.trickle(dir, hashes);
      return;
    }
    const store = this.ed.store;
    let images: FileSystemDirectoryHandle | null = null;
    for (const hash of hashes) {
      if (this.persisted.has(hash)) continue;
      if (!images) {
        images = await this.imagesDir(dir);
        if (this.persisted.has(hash)) continue;
      }
      try {
        await images.getFileHandle(hash); // already there (from the previous session)
        this.persisted.add(hash);
        continue;
      } catch {
        // missing — write it
      }
      const bytes = await store.readImage(hash);
      if (!bytes) continue;
      await writeFile(images, hash, bytes);
      this.persisted.add(hash);
      await new Promise((r) => setTimeout(r, 0)); // don't hog the thread for long
    }
  }

  /** Working copy image folder; its contents go into persisted as one list (once per file). */
  private async imagesDir(dir: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle> {
    const images = await dir.getDirectoryHandle('images', { create: true });
    if (!this.listed) {
      this.listed = true;
      try {
        for await (const name of (images as unknown as { keys(): AsyncIterable<string> }).keys()) this.persisted.add(name);
      } catch {
        // no list — check one by one
      }
    }
    return images;
  }

  /**
   * Background copy of images that exist in the source file: one at a time during idle, a pause after every
   * ~64 MB (the garbage collector catches up). Another file or closing — stop; whatever wasn't
   * copied — next time (the snapshot lists the images again).
   */
  private trickle(dir: FileSystemDirectoryHandle, hashes: ReadonlySet<string>) {
    const run = ++this.trickleRun;
    const store = this.ed.store;
    const list = [...hashes];
    void (async () => {
      const images = await this.imagesDir(dir);
      let batch = 0;
      for (const hash of list) {
        if (run !== this.trickleRun) return;
        if (this.persisted.has(hash)) continue;
        await new Promise((r) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(r, { timeout: 1000 }) : setTimeout(r, 30)));
        if (run !== this.trickleRun) return;
        try {
          const bytes = await store.readImage(hash);
          if (!bytes || run !== this.trickleRun) continue;
          await writeFile(images, hash, bytes);
          this.persisted.add(hash);
          batch += bytes.length;
        } catch {
          // couldn't be read — next time
        }
        if (batch > 64 * 2 ** 20) {
          batch = 0;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    })();
  }
}

/** The former single autosave (before the file library): the autosave/ folder in storage. */
export async function legacyAutosave(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const opfs = await navigator.storage.getDirectory();
    const dir = await opfs.getDirectoryHandle('autosave');
    await dir.getFileHandle('document.json');
    return dir;
  } catch {
    return null;
  }
}
