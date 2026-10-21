// Document snapshot to JSON in chunks: huge documents (hundreds of thousands of nodes) are saved in
// the background without freezes — step() serializes nodes until time runs out, the rest goes next
// time. Edits made meanwhile are accounted for: changed nodes are rewritten at the end, moved and new
// ones with their subtrees, deleted ones drop out. The result is the same snapshot as doc.snapshot()
// at the moment of completion (node order may differ: the snapshot is read regardless of order).

import { blobRefs, type Document } from './document.ts';
import type { NodeRecord, Paint, PrototypeAction } from './types.ts';

/** Nodes per JSON chunk (a chunk is ~hundreds of kilobytes: writing and compression go in parts). */
const NODES_PER_CHUNK = 2000;
/** Paths per JSON chunk. */
const BLOBS_PER_CHUNK = 500;

export class SnapshotWriter {
  private doc: Document;
  /** Tree traversal: nodes still to serialize (the last one is next). */
  private stack: string[];
  /** Node record JSON by id (insertion order is traversal order). */
  private json = new Map<string, string>();
  /** Edits during traversal: properties (the node itself only) and tree position (node with subtree). */
  private changed = new Set<string>();
  private placed = new Set<string>();
  private unsubscribe: (() => void) | null;
  /** Paths (geometry table keys) and images of nodes — for those that have them. */
  private blobsOf = new Map<string, string[]>();
  private imagesOf = new Map<string, string[]>();
  private blobQueue: string[] | null = null;
  private blobAt = 0;
  private blobParts: string[] = [];
  /** Assembling node chunks (after traversal): NODES_PER_CHUNK at a time. */
  private assemble: Iterator<string> | null = null;
  private nodeParts: string[] = [];
  /** Hashes of images referenced by snapshot nodes (to write images next to the snapshot) — after completion. */
  readonly images = new Set<string>();
  /** Snapshot JSON chunks — after step() === true; concatenated, they are the JSON of a Snapshot object. */
  chunks: string[] = [];
  /** JSON length (characters) — after completion. */
  length = 0;
  private done = false;
  /** Traversal finished: the snapshot is the document state at this moment (later edits are not in it). */
  cut = false;

  constructor(doc: Document) {
    this.doc = doc;
    this.stack = [doc.root];
    this.unsubscribe = doc.onCommit((op, _origin, removed) => {
      if (op.op === 'blob') return;
      if (op.op === 'set') this.changed.add(op.id);
      else if (op.op === 'delete') for (const r of removed ?? []) this.changed.add(r.id);
      else this.placed.add(op.id);
    });
  }

  /** Keep serializing while performance.now() < deadline; true — the snapshot is ready (chunks). */
  step(deadline: number): boolean {
    if (this.done) return true;
    const doc = this.doc;
    let n = 0;
    while (this.stack.length) {
      if ((++n & 255) === 0 && performance.now() > deadline) return false;
      const id = this.stack.pop()!;
      const rec = doc.savedNode(id);
      if (!rec) continue;
      this.add(rec);
      const kids = doc.children(id);
      for (let i = kids.length - 1; i >= 0; i--) this.stack.push(kids[i]!);
    }
    if (this.unsubscribe) {
      // Edits made during traversal — in one step, so the result is consistent.
      for (const id of this.changed) {
        const rec = doc.savedNode(id);
        if (rec) this.add(rec);
        else this.drop(id);
      }
      for (const id of this.placed) {
        if (!doc.has(id)) continue;
        // Traversal would miss what moved from the not-yet-visited part of the tree into the visited one.
        const stack = [id];
        while (stack.length) {
          const k = stack.pop()!;
          const rec = doc.savedNode(k);
          if (!rec) continue;
          if (k === id || !this.json.has(k)) this.add(rec);
          for (const c of doc.children(k)) stack.push(c);
        }
      }
      this.unsubscribe();
      this.unsubscribe = null;
      this.cut = true;
      const keys = new Set<string>();
      for (const list of this.blobsOf.values()) for (const k of list) keys.add(k);
      this.blobQueue = [...keys].sort();
      for (const list of this.imagesOf.values()) for (const h of list) this.images.add(h);
      this.blobsOf.clear();
      this.imagesOf.clear();
    }
    // Geometry table: values do not change (address is content), so it can go in chunks.
    // Here and below: first a piece of work, then the time check (every step makes progress).
    const queue = this.blobQueue!;
    while (this.blobAt < queue.length) {
      const part: string[] = [];
      for (const k of queue.slice(this.blobAt, (this.blobAt += BLOBS_PER_CHUNK))) {
        const v = doc.blob(k);
        if (v !== undefined) part.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
      }
      if (part.length) this.blobParts.push(part.join(','));
      if (this.blobAt < queue.length && performance.now() > deadline) return false;
    }
    // Node chunks are assembled in parts too: concatenating hundreds of megabytes at once is a noticeable pause.
    this.assemble ??= this.json.values();
    for (;;) {
      const batch: string[] = [];
      for (let r = this.assemble.next(); !r.done; r = this.assemble.next()) if (batch.push(r.value) >= NODES_PER_CHUNK) break;
      if (!batch.length) break;
      this.nodeParts.push(batch.join(','));
      if (batch.length === NODES_PER_CHUNK && performance.now() > deadline) return false;
    }
    this.finish();
    return true;
  }

  /** Stop tracking edits (the snapshot is not needed or is ready). */
  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private add(rec: Readonly<NodeRecord>) {
    this.json.set(rec.id, JSON.stringify(rec));
    const p = rec.props;
    const blobs = blobRefs(p);
    if (blobs.length) this.blobsOf.set(rec.id, blobs);
    else this.blobsOf.delete(rec.id);
    const images: string[] = [];
    const paints = (list: readonly Paint[] | undefined) => {
      if (!list) return;
      for (const paint of list) {
        if (paint.type === 'IMAGE' && paint.imageHash) images.push(paint.imageHash);
        else if (paint.type === 'VIDEO' && paint.videoHash) images.push(paint.videoHash);
        else if (paint.type === 'LOTTIE' && paint.lottieHash) images.push(paint.lottieHash);
        else if (paint.type === 'MODEL3D' && paint.modelHash) images.push(paint.modelHash);
      }
    };
    // Prototype action sounds — in the same storage.
    const actions = (list: readonly PrototypeAction[]) => {
      for (const a of list) {
        if (a.type === 'SOUND' && a.soundHash) images.push(a.soundHash);
        if (a.type === 'CONDITIONAL') for (const b of a.conditionalBlocks) actions(b.actions);
      }
    };
    for (const r of p.reactions ?? []) actions(r.actions);
    paints(p.fills);
    paints(p.strokes);
    paints(p.backgrounds);
    for (const run of p.textGlyphs?.runs ?? []) paints(run.fills);
    if (images.length) this.imagesOf.set(rec.id, images);
    else this.imagesOf.delete(rec.id);
  }

  private drop(id: string) {
    this.json.delete(id);
    this.blobsOf.delete(id);
    this.imagesOf.delete(id);
  }

  private finish() {
    const chunks: string[] = [`{"version":1,"root":${JSON.stringify(this.doc.root)},"nodes":[`];
    this.nodeParts.forEach((p, i) => chunks.push((i ? ',' : '') + p));
    if (this.blobParts.length) {
      chunks.push('],"blobs":{');
      this.blobParts.forEach((p, i) => chunks.push((i ? ',' : '') + p));
      chunks.push('}}');
    } else chunks.push(']}');
    this.chunks = chunks;
    this.length = chunks.reduce((a, c) => a + c.length, 0);
    this.json.clear();
    this.nodeParts = [];
    this.blobParts = [];
    this.done = true;
  }
}
