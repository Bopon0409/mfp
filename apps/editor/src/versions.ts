// File version history (v1): autosaves and named versions, viewing, restoring.
//
// library/files/<id>/versions/index.json — the version list; <vid>.json.gz — the contents:
// the first version of a chain is a full snapshot, the rest are changes since the previous version (whole node
// records, deleted ids, new paths). A version = full snapshot + changes along the chain.
// Autosave — after 10 minutes of edits, on file switch and before a restore.
// The chain continues across sessions: when leaving a file, edits after the last version go to
// pending.json together with the edit journal mark; the next session opened in exactly the same
// state (the same mark — meaning no crash in between) continues the chain instead of starting
// with a full snapshot (for a huge file — tens of megabytes and seconds on every close).
// A full snapshot — at the start, every MAX_CHAIN versions and after a restore; for a huge
// document it isn't taken on close but stays as a debt — done in the background in the next session.
// The last 30 chains are kept; chains with named versions — always.

import { Document, type NodeRecord, type Op, type Snapshot } from '@mfp/core';
import type { Library } from './library.ts';
import { gzipParts, idleSnapshot } from './idle-snapshot.ts';
import type { JournalMark } from './journal.ts';

export interface VersionMeta {
  id: string;
  created: number;
  kind: 'auto' | 'named';
  name?: string;
  description?: string;
  author?: string;
  /** Changes relative to this version (none — a full snapshot). */
  base?: string;
  /** Nodes in the document. */
  nodes: number;
  /** Record size (compressed), bytes. */
  bytes: number;
}

interface VersionData {
  full?: Snapshot;
  changed?: NodeRecord[];
  deleted?: string[];
  blobs?: Record<string, string>;
}

const AUTO_MS = 10 * 60 * 1000;
const KEEP_SESSIONS = 30;
/** Consecutive versions from one full snapshot (then a new full one: version loading doesn't grow unbounded). */
const MAX_CHAIN = 40;
/** A document whose full snapshot is deferred on close (nodes). */
const BIG_DOC = 50_000;

/** Edits after the last version at the time of leaving the file (versions/pending.json). */
interface Pending {
  mark: JournalMark;
  base: string | null;
  needFull: boolean;
  replaced: boolean;
  chain: number;
  changed: string[];
  deleted: string[];
  blobs: string[];
}

async function gunzip(blob: Blob): Promise<string> {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

async function write(dir: FileSystemDirectoryHandle, name: string, data: Blob | string) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

export class Versions {
  private lib: Library;
  private file: string | null = null;
  private doc: Document | null = null;
  private changed = new Set<string>();
  private deleted = new Set<string>();
  private newBlobs = new Set<string>();
  /** The session's first version is a full snapshot. */
  private needFull = true;
  /** The document was replaced entirely (version restore): a version is needed even without edits. */
  private replacedDoc = false;
  private last: string | null = null;
  /** Versions since the last full snapshot. */
  private chain = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  /** Version author (name, as in presence). */
  author: () => string = () => '';
  /** The version list changed. */
  onChange: (() => void)[] = [];
  /** Don't track edits (viewing a version: another document is on the canvas). */
  paused = false;
  /** A snapshot is awaited (not a timer autosave): full snapshot right away, without waiting for idle. */
  private hurry = 0;

  constructor(lib: Library) {
    this.lib = lib;
  }

  /** Track the file's document (opened, created, restored). */
  attach(file: string | null, doc: Document) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.file = file;
    this.doc = doc;
    this.changed.clear();
    this.deleted.clear();
    this.newBlobs.clear();
    this.needFull = true;
    this.replacedDoc = false;
    this.last = null;
    this.chain = 0;
  }

  /**
   * Continue the previous session's chain. mark — the edit journal mark of the open document:
   * matches the leave mark — the document is exactly as it was; otherwise (crash, file from disk) — from a full snapshot.
   */
  async resume(mark: JournalMark | null) {
    const file = this.file;
    const doc = this.doc;
    if (!file || !doc || !mark) return;
    let p: Pending;
    try {
      p = JSON.parse(await (await (await (await this.dir(file)).getFileHandle('pending.json')).getFile()).text()) as Pending;
    } catch {
      return;
    }
    if (this.file !== file || this.doc !== doc) return;
    if (p.mark?.lineage !== mark.lineage || p.mark.next !== mark.next) return;
    if (p.base && !(await this.list(file)).some((v) => v.id === p.base)) return;
    if (this.file !== file || this.doc !== doc) return;
    // Edits that arrived while reading are newer.
    for (const id of p.changed) if (!this.changed.has(id) && !this.deleted.has(id)) this.changed.add(id);
    for (const id of p.deleted) if (!this.changed.has(id)) this.deleted.add(id);
    for (const k of p.blobs) this.newBlobs.add(k);
    this.last = p.base;
    this.needFull = p.needFull || !p.base;
    this.replacedDoc ||= p.replaced;
    this.chain = p.chain ?? 0;
    // A version is owed from the previous session (a huge file was closed without a full snapshot) — in the background.
    if (this.dirty && !this.timer) this.timer = setTimeout(() => void this.snapshot('auto', undefined, undefined, false, true), this.wantsFull ? 60_000 : AUTO_MS);
  }

  /**
   * Leaving the file (close, switch): the session's edit version and edits after it go to pending.json.
   * A full snapshot of a huge document isn't taken (seconds) — it is a debt for the next session.
   */
  async leave(mark: JournalMark) {
    const file = this.file;
    if (!file || this.paused) return;
    if (this.dirty && !(this.wantsFull && (this.doc?.size ?? 0) > BIG_DOC)) await this.snapshot('auto');
    if (this.file !== file) return;
    const p: Pending = {
      mark,
      base: this.last,
      needFull: this.needFull,
      replaced: this.replacedDoc,
      chain: this.chain,
      changed: [...this.changed],
      deleted: [...this.deleted],
      blobs: [...this.newBlobs],
    };
    await write(await this.dir(file), 'pending.json', JSON.stringify(p));
  }

  /** The next version is a full snapshot. */
  private get wantsFull(): boolean {
    return this.needFull || !this.last || this.chain >= MAX_CHAIN;
  }

  /** Document edits (from Editor.onDocument). */
  track(ops: readonly Op[]) {
    if (!this.file || this.paused) return;
    for (const op of ops) {
      if (op.op === 'blob') this.newBlobs.add(op.key);
      else if (op.op === 'delete') {
        this.changed.delete(op.id);
        this.deleted.add(op.id);
      } else {
        this.changed.add(op.id);
        this.deleted.delete(op.id);
      }
    }
    // After 10 minutes of edits — an autosave.
    if (!this.timer && this.dirty) this.timer = setTimeout(() => void this.snapshot('auto', undefined, undefined, false, true), AUTO_MS);
  }

  get dirty() {
    // A full snapshot at the session start is about “how”, not “whether”: without edits no version is needed.
    return this.changed.size > 0 || this.deleted.size > 0 || this.replacedDoc;
  }

  private async dir(file: string) {
    return (await this.lib.dir(file)).getDirectoryHandle('versions', { create: true });
  }

  async list(file: string): Promise<VersionMeta[]> {
    try {
      const dir = await this.dir(file);
      const text = await (await (await dir.getFileHandle('index.json')).getFile()).text();
      return (JSON.parse(text) as { list: VersionMeta[] }).list;
    } catch {
      return [];
    }
  }

  private async saveList(file: string, list: VersionMeta[]) {
    await write(await this.dir(file), 'index.json', JSON.stringify({ version: 1, list }));
    this.onChange.forEach((cb) => cb());
  }

  /**
   * Take a version. auto without edits does nothing. Returns the new version.
   * A named one without edits is still a version (a full snapshot or empty changes).
   */
  /** force — take one even without edits since the previous version (the “Ready for development” mark). */
  /** background — timer autosave: a full snapshot of a huge document is taken in chunks during idle time. */
  snapshot(kind: 'auto' | 'named', name?: string, description?: string, force = false, background = false): Promise<VersionMeta | null> {
    if (!background) this.hurry++;
    const run = async () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      const file = this.file;
      const doc = this.doc;
      if (!file || !doc) return null;
      if (kind === 'auto' && !this.dirty && !force) return null;
      const data: VersionData = {};
      const full = this.wantsFull;
      // Edits since the previous version are taken at snapshot time: those arriving during the write go to the next one.
      const taken = { changed: this.changed, deleted: this.deleted, blobs: this.newBlobs, replaced: this.replacedDoc };
      const take = () => {
        this.changed = new Set();
        this.deleted = new Set();
        this.newBlobs = new Set();
        this.replacedDoc = false;
      };
      // Full snapshot of a huge document — in chunks during idle time (like autosave).
      let parts: string[] | null = null;
      if (full) {
        const snap = await idleSnapshot(doc, { urgent: () => this.hurry > 0, cancelled: () => this.doc !== doc, onCut: take });
        if (!snap) return null;
        parts = ['{"full":', ...snap.writer.chunks, '}'];
      } else {
        take();
        // Records — in tree order (parents before children).
        const changed: NodeRecord[] = [];
        for (const id of taken.changed) {
          const rec = doc.node(id);
          if (rec) changed.push(JSON.parse(JSON.stringify(rec)) as NodeRecord);
        }
        data.changed = changed;
        data.deleted = [...taken.deleted];
        const blobs: Record<string, string> = {};
        for (const k of taken.blobs) {
          const v = doc.blob(k);
          if (v !== undefined) blobs[k] = v;
        }
        data.blobs = blobs;
      }
      try {
        return await this.store(file, kind, full, parts ?? [JSON.stringify(data)], doc, name, description);
      } catch (e) {
        // Write failed — the taken edits are returned (new ones have been added to them).
        if (this.file === file) {
          for (const id of taken.changed) if (!this.deleted.has(id)) this.changed.add(id);
          for (const id of taken.deleted) if (!this.changed.has(id)) this.deleted.add(id);
          for (const k of taken.blobs) this.newBlobs.add(k);
          this.replacedDoc ||= taken.replaced;
        }
        throw e;
      }
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => {});
    if (!background) {
      const done = () => void this.hurry--;
      p.then(done, done);
    }
    return p;
  }

  /** Write the version and the list; further changes are computed from it. */
  private async store(file: string, kind: 'auto' | 'named', full: boolean, parts: string[], doc: Document, name?: string, description?: string): Promise<VersionMeta> {
    const blob = await gzipParts(parts);
    const meta: VersionMeta = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      created: Date.now(),
      kind,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(this.author() ? { author: this.author() } : {}),
      ...(full ? {} : { base: this.last! }),
      nodes: doc.size,
      bytes: blob.size,
    };
    await write(await this.dir(file), `${meta.id}.json.gz`, blob);
    const list = await this.list(file);
    list.push(meta);
    await this.saveList(file, await this.prune(file, list));
    // Snapshot taken: from now on — changes relative to it (those taken at snapshot time are already in it).
    if (this.file === file) {
      this.needFull = false;
      this.last = meta.id;
      this.chain = full ? 0 : this.chain + 1;
    }
    return meta;
  }

  /** Old sessions (chains from a full snapshot) without named versions — delete. */
  private async prune(file: string, list: VersionMeta[]): Promise<VersionMeta[]> {
    const sessions: VersionMeta[][] = [];
    for (const v of list) {
      if (!v.base || !sessions.length) sessions.push([v]);
      else sessions[sessions.length - 1]!.push(v);
    }
    const plain = sessions.filter((s) => !s.some((v) => v.kind === 'named'));
    const drop = new Set(plain.slice(0, Math.max(0, plain.length - KEEP_SESSIONS)).flat().map((v) => v.id));
    if (!drop.size) return list;
    const dir = await this.dir(file);
    for (const id of drop) {
      try {
        await dir.removeEntry(`${id}.json.gz`);
      } catch {
        // already gone
      }
    }
    return list.filter((v) => !drop.has(v.id));
  }

  /** Version document: a full snapshot and the changes along the chain. */
  async load(file: string, id: string): Promise<Document> {
    const list = await this.list(file);
    const byId = new Map(list.map((v) => [v.id, v]));
    const chain: VersionMeta[] = [];
    for (let v = byId.get(id); v; v = v.base ? byId.get(v.base) : undefined) chain.unshift(v);
    if (!chain.length || chain[0]!.base) throw new Error('Цепочка версии неполная');
    const dir = await this.dir(file);
    const read = async (v: VersionMeta) => JSON.parse(await gunzip(await (await dir.getFileHandle(`${v.id}.json.gz`)).getFile())) as VersionData;
    const first = await read(chain[0]!);
    if (!first.full) throw new Error('Нет полного снимка');
    const nodes = new Map(first.full.nodes.map((n) => [n.id, n]));
    const blobs: Record<string, string> = { ...(first.full.blobs ?? {}) };
    for (const v of chain.slice(1)) {
      const d = await read(v);
      for (const rec of d.changed ?? []) nodes.set(rec.id, rec);
      for (const del of d.deleted ?? []) nodes.delete(del);
      Object.assign(blobs, d.blobs ?? {});
    }
    // Deleted parents — their children are gone too (subtree deletion records only the root).
    for (const [nid, n] of nodes) if (n.parent && !nodes.has(n.parent)) nodes.delete(nid);
    let removed = true;
    while (removed) {
      removed = false;
      for (const [nid, n] of nodes) {
        if (n.parent && !nodes.has(n.parent)) {
          nodes.delete(nid);
          removed = true;
        }
      }
    }
    return Document.fromSnapshot({ version: 1, root: first.full.root, nodes: [...nodes.values()], blobs }, Math.floor(Math.random() * 2 ** 31));
  }

  async rename(file: string, id: string, name: string, description?: string) {
    const list = await this.list(file);
    const v = list.find((x) => x.id === id);
    if (!v) return;
    v.kind = name ? 'named' : 'auto';
    if (name) v.name = name;
    else delete v.name;
    if (description) v.description = description;
    else delete v.description;
    await this.saveList(file, list);
  }

  /** Mark that the document was replaced entirely (version restore): the next version is full. */
  replaced(doc: Document) {
    this.doc = doc;
    this.needFull = true;
    this.replacedDoc = true;
    this.changed.clear();
    this.deleted.clear();
    this.newBlobs.clear();
  }
}
