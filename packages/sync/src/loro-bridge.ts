// Bridge between the working document model (@mfp/core) and the Loro CRDT.
//
// Loro is the source of truth for sync, history and branches (movable tree:
// concurrent moves converge without cycles). Document is the fast working
// model for rendering and tools. The bridge translates:
// - local Document operations → Loro tree and map operations;
// - Loro events from other clients (import) → Document operations (origin 'loro').

import * as loroModule from 'loro-crdt';
import { LoroDoc, type LoroEventBatch, type TreeID } from 'loro-crdt';
import type { Document, NodeType, Op, Props } from '@mfp/core';

const TREE = 'nodes';
/** Geometry table (paths by hash key): must be the same for all participants. */
const BLOBS = 'blobs';
/** Properties of the document itself (the root): annotation categories, team libraries. */
const ROOT = 'root';
const META_KEYS = new Set(['id', 'type']);

let ready: Promise<void> | null = null;

/**
 * Loro readiness. In the browser (web variant) the wasm loads asynchronously — wait for it before
 * the first LoroDoc; in Node the module is ready immediately.
 */
export function loroReady(): Promise<void> {
  const init = (loroModule as unknown as { default?: unknown }).default;
  ready ??= typeof init === 'function' ? (init as () => Promise<unknown>)().then(() => undefined) : Promise.resolve();
  return ready;
}

/** Whether the update (room snapshot) contains document nodes. */
export function hasNodes(update: Uint8Array): boolean {
  const probe = new LoroDoc();
  probe.import(update);
  return probe.getTree(TREE).getNodes().length > 0;
}

export class LoroBridge {
  readonly loro: LoroDoc;
  private doc: Document;
  private toTree = new Map<string, TreeID>();
  private toCore = new Map<TreeID, string>();
  private unsubscribe: (() => void)[] = [];

  constructor(doc: Document, opts: { peer?: number; loro?: LoroDoc } = {}) {
    this.doc = doc;
    this.loro = opts.loro ?? new LoroDoc();
    if (opts.peer !== undefined) this.loro.setPeerId(opts.peer);
    const tree = this.loro.getTree(TREE);
    if (!tree.isFractionalIndexEnabled()) tree.enableFractionalIndex(0);

    // The document already contains nodes (e.g. opened locally) — move them into Loro.
    if (tree.getNodes().length === 0 && doc.children(doc.root).length) {
      const blobs = this.loro.getMap(BLOBS);
      for (const [k, v] of Object.entries(doc.snapshot().blobs ?? {})) blobs.set(k, v);
      const root = this.loro.getMap(ROOT);
      for (const [k, v] of Object.entries(doc.node(doc.root)?.props ?? {})) if (v !== undefined) root.set(k, v as never);
      const pushTree = (id: string) => {
        for (const c of doc.children(id)) {
          const rec = doc.node(c)!;
          this.pushOps([{ op: 'create', id: c, type: rec.type, parent: id, index: rec.index, props: rec.props }]);
          pushTree(c);
        }
      };
      pushTree(doc.root);
      this.loro.commit({ origin: 'mfp' });
    }

    this.unsubscribe.push(
      doc.onChange((ops, origin) => {
        // Preview (hovering a menu item) — local only.
        if (origin === 'loro' || origin === 'preview') return;
        this.pushOps(ops);
        this.loro.commit({ origin: 'mfp' });
      }),
    );
    this.unsubscribe.push(this.loro.subscribe((batch) => this.pull(batch)));
  }

  dispose() {
    for (const u of this.unsubscribe) u();
  }

  /** The document the bridge is bound to. */
  get document(): Document {
    return this.doc;
  }

  /** Update to send to other clients (everything, or starting from a version). */
  exportUpdate(from?: ReturnType<LoroDoc['oplogVersion']>): Uint8Array {
    return this.loro.export(from ? { mode: 'update', from } : { mode: 'update' });
  }

  importUpdate(bytes: Uint8Array) {
    this.loro.import(bytes);
  }

  // ---------- Document → Loro ----------

  private pushOps(ops: Op[]) {
    const tree = this.loro.getTree(TREE);
    // Loro doesn't store undefined: such a property is removed from the node map.
    const setProps = (data: { set(k: string, v: never): void; delete(k: string): void }, props: Props) => {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined) data.delete(k);
        else data.set(k, v as never);
      }
    };
    for (const op of ops) {
      switch (op.op) {
        case 'blob':
          this.loro.getMap(BLOBS).set(op.key, op.data);
          break;
        case 'create': {
          const parent = op.parent === this.doc.root ? undefined : this.toTree.get(op.parent);
          const index = this.doc.children(op.parent).indexOf(op.id);
          const node = tree.createNode(parent, index < 0 ? undefined : index);
          this.toTree.set(op.id, node.id);
          this.toCore.set(node.id, op.id);
          node.data.set('id', op.id);
          node.data.set('type', op.type);
          setProps(node.data, op.props);
          break;
        }
        case 'set': {
          if (op.id === this.doc.root) {
            setProps(this.loro.getMap(ROOT), op.props);
            break;
          }
          const t = this.toTree.get(op.id);
          const node = t && tree.getNodeByID(t);
          if (!node) break;
          setProps(node.data, op.props);
          break;
        }
        case 'move': {
          const t = this.toTree.get(op.id);
          if (!t) break;
          const parent = op.parent === this.doc.root ? undefined : this.toTree.get(op.parent);
          tree.move(t, parent, this.doc.children(op.parent).indexOf(op.id));
          break;
        }
        case 'delete': {
          const t = this.toTree.get(op.id);
          if (t && tree.has(t)) tree.delete(t);
          break;
        }
      }
    }
  }

  // ---------- Loro → Document ----------

  private pull(batch: LoroEventBatch) {
    if (batch.by === 'local') return;
    const tree = this.loro.getTree(TREE);
    const doc = this.doc;
    doc.transact(() => {
      // Geometry first: nodes in the same batch refer to it.
      for (const e of batch.events) {
        if (e.diff.type !== 'map' || e.path.length !== 1 || e.path[0] !== BLOBS) continue;
        for (const v of Object.values(e.diff.updated)) if (typeof v === 'string') doc.putBlob(v);
      }
      for (const e of batch.events) {
        if (e.diff.type === 'map' && e.path.length === 1 && e.path[0] === BLOBS) continue;
        if (e.diff.type === 'map' && e.path.length === 1 && e.path[0] === ROOT) {
          doc.set(doc.root, { ...e.diff.updated } as Props);
          continue;
        }
        if (e.diff.type === 'tree') {
          for (const item of e.diff.diff) {
            if (item.action === 'create') {
              const node = tree.getNodeByID(item.target);
              if (!node) continue;
              const data = node.data.toJSON() as Record<string, unknown>;
              const id = String(data.id);
              const props: Props = {};
              for (const [k, v] of Object.entries(data)) if (!META_KEYS.has(k)) (props as Record<string, unknown>)[k] = v;
              const parent = item.parent ? this.toCore.get(item.parent) : doc.root;
              if (!parent || doc.has(id)) continue;
              this.toTree.set(id, item.target);
              this.toCore.set(item.target, id);
              doc.createWithId(id, data.type as NodeType, parent, props, item.index);
            } else if (item.action === 'move') {
              const id = this.toCore.get(item.target);
              const parent = item.parent ? this.toCore.get(item.parent) : doc.root;
              if (id && parent && doc.has(id)) doc.move(id, parent, item.index);
            } else if (item.action === 'delete') {
              const id = this.toCore.get(item.target);
              if (id && doc.has(id)) doc.delete(id);
            }
          }
        } else if (e.diff.type === 'map') {
          // Node properties: the event path goes through the node's TreeID.
          const treeId = [...e.path].reverse().find((p) => typeof p === 'string' && /^\d+@\d+$/.test(p)) as TreeID | undefined;
          const id = treeId && this.toCore.get(treeId);
          if (!id || !doc.has(id)) continue;
          const props: Props = {};
          for (const [k, v] of Object.entries(e.diff.updated)) if (!META_KEYS.has(k)) (props as Record<string, unknown>)[k] = v;
          if (Object.keys(props).length) doc.set(id, props);
        }
      }
    }, 'loro');
  }
}
