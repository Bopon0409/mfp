// Edit journal of the working copy: document operations in batches next to the snapshot.
//
// <copy>/journal/<line>-<from>-<to>.json holds operations numbered [from, to) in their actual
// application order (onCommit), one batch per ~0.3 s of edits. The snapshot (document.json) remembers the
// line and the number of the next operation: on open, the snapshot plus journal operations past that number
// rebuild the document up to the last batch, so a crash costs a fraction of a second of work and closing
// does not need a full snapshot.
// Batches are separate files: OPFS cannot append to a file without copying it whole; each one
// is written atomically (createWritable). A line is a continuous chain of operations from one snapshot:
// when the document is replaced (opened from disk, import, version restore), a new line starts.
// Not recorded: preview (and layout inside it, which gets rolled back) and background page loading
// (import is not an edit: the snapshot will appear whole).

import type { Document, Op } from '@mfp/core';

/** Up to which operation of which line the snapshot goes. */
export interface JournalMark {
  lineage: string;
  /** Number of the next operation (everything lower is in the snapshot). */
  next: number;
}

const DIR = 'journal';
const FLUSH_MS = 300;
const pad = (n: number) => String(n).padStart(12, '0');

interface BatchName {
  name: string;
  lineage: string;
  from: number;
  to: number;
}

function parseName(name: string): BatchName | null {
  const m = /^([a-z0-9]+)-(\d{12})-(\d{12})\.json$/.exec(name);
  return m ? { name, lineage: m[1]!, from: Number(m[2]), to: Number(m[3]) } : null;
}

async function batches(dir: FileSystemDirectoryHandle): Promise<{ dir: FileSystemDirectoryHandle; list: BatchName[] } | null> {
  let jd: FileSystemDirectoryHandle;
  try {
    jd = await dir.getDirectoryHandle(DIR);
  } catch {
    return null;
  }
  const list: BatchName[] = [];
  for await (const name of (jd as unknown as { keys(): AsyncIterable<string> }).keys()) {
    const b = parseName(name);
    if (b) list.push(b);
  }
  list.sort((a, b) => a.from - b.from);
  return { dir: jd, list };
}

export const newLineage = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export class Journal {
  lineage = newLineage();
  /** Number of the next operation. */
  next = 0;
  /** Time of the last written batch (ms since 1970), 0 if nothing was written. */
  writtenAt = 0;
  private dir: () => Promise<FileSystemDirectoryHandle | null>;
  /** Before writing a batch (images referenced by its operations are written earlier). */
  private before: () => Promise<void>;
  private pending: string[] = [];
  private pendingFrom = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  /** Write error for the last batch (the journal is unreliable until the snapshot catches up). */
  failed = false;

  constructor(dir: () => Promise<FileSystemDirectoryHandle | null>, before: () => Promise<void> = async () => {}) {
    this.dir = dir;
    this.before = before;
  }

  /** There are operations not yet written into a batch. */
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /**
   * Watch the document. mark is the line of the snapshot it was opened from (we continue it);
   * null means the document is new or replaced: a new line from zero. enabled() says whether to write now.
   */
  attach(doc: Document, mark: JournalMark | null, enabled: () => boolean) {
    this.detach();
    this.lineage = mark?.lineage ?? newLineage();
    this.next = mark?.next ?? 0;
    this.writtenAt = 0;
    this.failed = false;
    this.unsubscribe = doc.onCommit((op, origin) => {
      if (origin === 'preview' || origin === 'import' || doc.previewCapturing || !enabled()) return;
      if (!this.pending.length) this.pendingFrom = this.next;
      this.pending.push(JSON.stringify(op));
      this.next++;
      this.timer ??= setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, FLUSH_MS);
    });
  }

  /** Stop watching (an unwritten batch is lost; flush first). */
  detach() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }

  /** Mark for the snapshot: everything up to this operation is in it. */
  mark(): JournalMark {
    return { lineage: this.lineage, next: this.next };
  }

  /** Write the accumulated batch now (and wait for earlier writes). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length) {
      const ops = this.pending;
      const from = this.pendingFrom;
      const lineage = this.lineage;
      this.pending = [];
      const at = Date.now();
      const body = `{"from":${from},"at":${at},"ops":[${ops.join(',')}]}`;
      // Take the folder now: by the time of writing another file may already be open.
      const target = this.dir();
      this.writing = this.writing.then(async () => {
        try {
          await this.before();
          const dir = await target;
          if (!dir) return;
          const jd = await dir.getDirectoryHandle(DIR, { create: true });
          const w = await (await jd.getFileHandle(`${lineage}-${pad(from)}-${pad(from + ops.length)}.json`, { create: true })).createWritable();
          await w.write(body);
          await w.close();
          this.writtenAt = at;
        } catch (e) {
          this.failed = true;
          console.warn('Журнал правок: пачка не записана', e);
        }
      });
    }
    return this.writing;
  }

  /**
   * A snapshot with mark was written to dir: remove batches fully contained in it, and other lines.
   * Queued together with batch writes (flush waits for this as well).
   */
  truncate(dir: FileSystemDirectoryHandle, mark: JournalMark): Promise<void> {
    this.writing = this.writing.then(async () => {
      const found = await batches(dir).catch(() => null);
      if (!found) return;
      for (const b of found.list) {
        if (b.lineage === mark.lineage && b.to > mark.next) continue;
        await found.dir.removeEntry(b.name).catch(() => {});
      }
      if (mark.lineage === this.lineage) this.failed = false;
    });
    return this.writing;
  }
}

/**
 * Journal operations after the snapshot with mark (in order, without gaps). Batches of other lines
 * are left alone (the next snapshot removes them). A gap in numbers (a lost batch) stops here:
 * operations after the hole would apply to the wrong document.
 */
export async function readJournal(dir: FileSystemDirectoryHandle, mark: JournalMark): Promise<{ ops: Op[]; next: number; at: number; gap: boolean }> {
  const found = await batches(dir);
  const ops: Op[] = [];
  let next = mark.next;
  let at = 0;
  let gap = false;
  if (!found) return { ops, next, at, gap };
  for (const b of found.list) {
    if (b.lineage !== mark.lineage || b.to <= next) continue;
    if (b.from > next) {
      gap = true;
      break;
    }
    let data: { from: number; at: number; ops: Op[] };
    try {
      data = JSON.parse(await (await (await found.dir.getFileHandle(b.name)).getFile()).text()) as typeof data;
    } catch {
      gap = true;
      break;
    }
    ops.push(...data.ops.slice(next - data.from));
    next = data.from + data.ops.length;
    at = Math.max(at, data.at);
  }
  return { ops, next, at, gap };
}
