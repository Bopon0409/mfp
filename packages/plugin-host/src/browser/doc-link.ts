// Main thread ⇄ document copy in the plugin Worker.
//
// Editor edits go to the copy in application order (Document.onCommit), batched per task.
// Plugin edits are applied to the editor document with origin 'plugin'. If the plugin edited
// nodes whose edits had not reached it yet (a race with the user), the order in the two copies differs;
// the copy receives such nodes again in the editor document's state.

import type { Document, NodeRecord, Op } from '@mfp/core';
import type { OpsOrigin, ToWorker } from './protocol.ts';

/** Other participants' edits are REMOTE; loading pages of a large file emits no events. */
const classify = (origin: string): OpsOrigin => (origin === 'loro' || origin === 'remote' ? 'REMOTE' : origin === 'import' ? null : 'LOCAL');

function touch(op: Op, removed: readonly NodeRecord[] | null, ids: Set<string>) {
  if (op.op === 'blob') return;
  ids.add(op.id);
  if (removed) for (const r of removed) ids.add(r.id);
}

export class DocLink {
  private undoGroup = {};

  commitUndo() { this.undoGroup = {}; }
  private doc: Document;
  private send: (m: ToWorker) => void;
  private queue: Op[] = [];
  private queueOrigin: OpsOrigin = 'LOCAL';
  private queueIds = new Set<string>();
  private scheduled = false;
  private seq = 0;
  /** Sequence number of the last replacement of the copy with a snapshot. */
  private resetSeq = 0;
  /** Sent batches the plugin may not have seen yet: which nodes they affect. */
  private unacked: { seq: number; ids: Set<string> }[] = [];
  private unsubscribe: () => void;

  constructor(doc: Document, send: (m: ToWorker) => void) {
    this.doc = doc;
    this.send = send;
    this.unsubscribe = doc.onCommit((op, origin, removed) => {
      // The copy already knows the plugin's own edits.
      if (origin === 'plugin') return;
      const o = classify(origin);
      if (this.queue.length && o !== this.queueOrigin) this.flush();
      this.queueOrigin = o;
      this.queue.push(op);
      touch(op, removed, this.queueIds);
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  /** Send the accumulated editor edits. */
  flush() {
    this.scheduled = false;
    if (!this.queue.length) return;
    const seq = ++this.seq;
    this.send({ type: 'docOps', ops: this.queue, origin: this.queueOrigin, seq });
    this.unacked.push({ seq, ids: this.queueIds });
    this.queue = [];
    this.queueIds = new Set();
  }

  /** Plugin edits (seen — the last editor batch it saw). An error means the copy must be replaced (reset). */
  applyPluginOps(ops: Op[], seen: number) {
    this.flush();
    this.unacked = this.unacked.filter((u) => u.seq > seen);
    const theirs = new Set<string>();
    for (const u of this.unacked) for (const id of u.ids) theirs.add(id);
    this.doc.withUndoGroup(this.undoGroup, () => this.doc.apply(ops, 'plugin'));
    // The edits were made before the copy was replaced with a snapshot, and the snapshot lacks them, so the copy must replay them.
    if (seen < this.resetSeq) {
      this.flush();
      this.send({ type: 'docOps', ops, origin: 'LOCAL', seq: ++this.seq });
      return;
    }
    if (!theirs.size) return;
    const conflict = new Set<string>();
    for (const op of ops) if ((op.op === 'set' || op.op === 'move' || op.op === 'delete') && theirs.has(op.id)) conflict.add(op.id);
    if (!conflict.size) return;
    // Derived edits (layout) come before alignment.
    this.flush();
    const fix: Op[] = [];
    for (const id of conflict) {
      const rec = this.doc.node(id);
      if (!rec) {
        fix.push({ op: 'delete', id });
        continue;
      }
      fix.push({ op: 'set', id, props: { ...rec.props } });
      if (rec.parent) fix.push({ op: 'move', id, parent: rec.parent, index: rec.index });
    }
    const seq = ++this.seq;
    this.send({ type: 'docOps', ops: fix, origin: 'LOCAL', seq });
    this.unacked.push({ seq, ids: conflict });
  }

  /** New snapshot for the copy (it diverged from the editor document). */
  reset(): ToWorker {
    this.flush();
    this.unacked = [];
    this.resetSeq = ++this.seq;
    return { type: 'reset', snapshot: this.doc.snapshot(), seq: this.resetSeq };
  }

  dispose() {
    this.unsubscribe();
    this.queue = [];
  }
}
