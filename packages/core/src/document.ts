// Document: a tree of nodes with fractional indexes and an operation stream.
//
// Every change is expressed as an operation (Op). Operations:
// - are sent to subscribers in a batch per transaction (render, sync, plugins);
// - are applied to document copies (plugin Worker, server, other clients) via apply();
// - provide the basis for undo and a future CRDT.

import { generateKeyBetween } from 'fractional-indexing';
import { CONTAINER_TYPES, DEFAULTS } from './defaults.ts';
import { hashString } from './hash.ts';
import type { NodeRecord, NodeType, Op, Props, Snapshot } from './types.ts';
import { Interner } from './intern.ts';
import { patternReferences, preservePatternSources } from './patterns.ts';
import { textNameChange } from './text-name.ts';

export type ChangeListener = (ops: Op[], origin: string) => void;
/** A single operation right after it is applied; removed — records of the deleted subtree (for delete, parents before children). */
export type CommitListener = (op: Op, origin: string, removed: readonly NodeRecord[] | null) => void;

/** Change sources that go into the undo history (edits from other clients do not). */
/** paste — pasting ready content (from the Figma clipboard): undoable, but not recomputed. */
const UNDOABLE = new Set(['local', 'plugin', 'undo', 'redo', 'paste', 'clipboard']);
/** Others' and internal edits: the safeguard does not check them. */
const UNGUARDED = new Set(['loro', 'load', 'preview']);

/** Copy of a property value; frozen (shared, immutable) values are not copied. */
const cloneValue = <T>(v: T): T => (v === null || typeof v !== 'object' || Object.isFrozen(v) ? v : structuredClone(v));
/** Copy of a property set: shallow, values via cloneValue. */
const cloneProps = (p: Props): Props => {
  const out: Record<string, unknown> = {};
  for (const k in p) out[k] = cloneValue((p as Record<string, unknown>)[k]);
  return out as Props;
};
const cloneRecord = (n: NodeRecord): NodeRecord => ({ ...n, props: cloneProps(n.props) });

/** Shapes defined by parameters (their paths can be rebuilt). */
const SHAPE_PARAMETRIC = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'FRAME', 'COMPONENT', 'INSTANCE', 'SECTION']);
/** Shape parameters: editing them makes ready-made import paths stale. */
const SHAPE_KEYS = new Set(['cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius', 'pointCount', 'cornerSmoothing', 'arcData', 'innerRadius']);
/** Stroke parameters: editing them makes the ready-made import stroke path stale. */
const STROKE_KEYS = new Set([
  'strokeWeight',
  'strokeAlign',
  'strokeJoin',
  'dashPattern',
  'strokeTopWeight',
  'strokeRightWeight',
  'strokeBottomWeight',
  'strokeLeftWeight',
  'strokeStartCap',
  'strokeEndCap',
  'strokeMiterLimit',
  'variableWidthPoints',
  'strokeBrush',
]);

/**
 * Geometry table keys referenced by node properties: fill and stroke paths,
 * vector center lines, text glyphs. Everyone collecting the used geometry (snapshot,
 * save, clipboard) goes through this function: center lines were once forgotten and got lost.
 */
export function blobRefs(p: Readonly<Props>): string[] {
  const out: string[] = [];
  for (const list of [p.vectorPaths, p.strokePaths, p.centerPaths]) for (const path of list ?? []) if (path.blob) out.push(path.blob);
  for (const g of p.textGlyphs?.glyphs ?? []) out.push(g[0]);
  if (p.vectorNetwork?.blob) out.push(p.vectorNetwork.blob);
  return out;
}

/** Prototypes for view(): default values per node type. */
const VIEW_PROTOS = new Map<NodeType, Record<string, unknown>>();

export class Document {
  readonly root: string;
  private nodes = new Map<string, NodeRecord>();
  private patternUsers = new Map<string, Set<string>>();
  private patternsByNode = new Map<string, Set<string>>();
  private archivedPatterns = new Map<string, string>();
  private archiveSourceByNode = new Map<string, string>();
  /** Content-addressed geometry table: key → SVG path. */
  private blobs = new Map<string, string>();
  /** Cache of sorted children; reset on changes. */
  private sortedChildren = new Map<string, string[]>();
  private childrenOf = new Map<string, Set<string>>();
  private listeners = new Set<ChangeListener>();
  /**
   * Safeguard for local edits (page permissions): a rejection reason — the transaction is rolled back,
   * change subscribers do not see it (it goes nowhere); null — allowed. Others' edits (loro, load) are
   * not checked.
   */
  guard: ((ops: readonly Op[], inverse: readonly Op[]) => string | null) | null = null;
  /** Safeguard rejection (to report to the person). */
  onGuard: ((reason: string) => void) | null = null;
  private commitListeners = new Set<CommitListener>();
  private pending: Op[] | null = null;
  private pendingOrigin = 'local';
  private clientId: number;
  private counter = 0;
  /** History: a step = the transaction's inverse operations (in the order applied on undo). */
  private undoStack: Op[][] = [];
  private undoOwner: object | undefined;
  private mergeableUndo: { owner: object; step: Op[] } | undefined;

  private redoStack: Op[][] = [];
  /** Inverse operations of the current transaction (in recording order). */
  private inverse: Op[] | null = null;
  /** The next transaction is appended to the last undo step (see amend). */
  private amendNext = false;
  private groupDepth = 0;
  private groupInverse: Op[] | null = null;
  /**
   * Grows on every change to the tree structure (node created, moved, deleted) and to pages'
   * internal flag — a key for traversal caches (styles and variables of internal pages).
   */
  treeVersion = 0;

  constructor(opts: { clientId?: number; root?: string } = {}) {
    this.clientId = opts.clientId ?? Math.floor(Math.random() * 2 ** 31);
    this.root = opts.root ?? '0:0';
    if (!opts.root) {
      this.nodes.set(this.root, { id: this.root, type: 'DOCUMENT', parent: null, index: 'a0', props: { ...DEFAULTS.DOCUMENT } });
    }
  }

  static fromSnapshot(snapshot: Snapshot, clientId?: number): Document {
    const doc = new Document({ clientId, root: snapshot.root });
    for (const _ of doc.restoreSnapshot(snapshot)) { /* synchronous callers */ }
    return doc;
  }

  /** Restore large working copies without monopolizing the UI thread. */
  static async fromSnapshotAsync(snapshot: Snapshot, clientId?: number, yieldTask: () => Promise<void> = () => new Promise((r) => setTimeout(r, 0))): Promise<Document> {
    const doc = new Document({ clientId, root: snapshot.root });
    let deadline = performance.now() + 8;
    let count = 0;
    for (const _ of doc.restoreSnapshot(snapshot)) {
      if ((++count & 127) === 0 && performance.now() >= deadline) {
        await yieldTask();
        deadline = performance.now() + 8;
      }
    }
    return doc;
  }

  private *restoreSnapshot(snapshot: Snapshot): Generator<void> {
    // Identical property values are shared objects (see intern.ts).
    const interner = new Interner();
    for (const n of snapshot.nodes) { this.insertRecord({ ...n, props: interner.props(n.props) }); yield; }
    for (const [k, v] of Object.entries(snapshot.blobs ?? {})) { this.blobs.set(k, v); yield; }
    // Vector center lines used to be left out of the snapshot — in old saves references to them
    // dangle without paths. Drop those: otherwise stroke editing and vector edit mode see nothing.
    for (const n of this.nodes.values()) {
      if (n.props.centerPaths?.some((p) => p.blob && !this.blobs.has(p.blob))) delete n.props.centerPaths;
      yield;
    }
  }

  /** Snapshot in canonical order (tree traversal, children in layer order) — stable for comparison and diff. */
  /** pages — only these pages (prototype presentation: the page and the internal one). */
  snapshot(pages?: readonly string[]): Snapshot {
    const nodes: NodeRecord[] = [];
    const walk = (id: string) => {
      const n = this.savedNode(id);
      if (!n) return;
      nodes.push(cloneRecord(n));
      for (const c of this.children(id)) walk(c);
    };
    if (pages) {
      nodes.push(cloneRecord(this.nodes.get(this.root)!));
      for (const p of pages) walk(p);
    } else walk(this.root);
    // Only used paths go into the snapshot.
    const used = new Set<string>();
    for (const n of nodes) for (const k of blobRefs(n.props)) used.add(k);
    const blobs: Record<string, string> = {};
    for (const k of [...used].sort()) {
      const v = this.blobs.get(k);
      if (v !== undefined) blobs[k] = v;
    }
    return used.size ? { version: 1, root: this.root, nodes, blobs } : { version: 1, root: this.root, nodes };
  }

  // ---------- Reading ----------

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  node(id: string): Readonly<NodeRecord> | undefined {
    return this.nodes.get(id);
  }

  type(id: string): NodeType | undefined {
    return this.nodes.get(id)?.type;
  }

  parent(id: string): string | null {
    return this.nodes.get(id)?.parent ?? null;
  }

  /** Children in layer order: the first is the bottommost. */
  children(id: string): readonly string[] {
    let list = this.sortedChildren.get(id);
    if (!list) {
      const ids = [...(this.childrenOf.get(id) ?? [])];
      ids.sort((a, b) => {
        const ia = this.nodes.get(a)!.index;
        const ib = this.nodes.get(b)!.index;
        return ia < ib ? -1 : ia > ib ? 1 : a < b ? -1 : 1;
      });
      this.sortedChildren.set(id, (list = ids));
    }
    return list;
  }

  /**
   * Property value. A node stores only set values; if a property is not set,
   * the default for the type is returned (default objects are frozen — do not modify).
   */
  get<K extends keyof Props>(id: string, key: K): Props[K] {
    const n = this.nodes.get(id);
    if (!n) return undefined;
    const v = n.props[key];
    return v !== undefined ? v : DEFAULTS[n.type][key];
  }

  /**
   * Read-only node properties: own values over the defaults (via a prototype, without copying
   * dozens of default values) — for hot paths such as scene building. Do not modify or
   * enumerate (Object.keys, spread): the defaults live in the prototype.
   */
  view(id: string): Readonly<Props> {
    const n = this.nodes.get(id);
    if (!n) return {};
    let proto = VIEW_PROTOS.get(n.type);
    // The prototype is an unfrozen copy: a frozen one would not allow assigning an own value on top.
    if (!proto) VIEW_PROTOS.set(n.type, (proto = { ...DEFAULTS[n.type] }));
    const out = Object.create(proto) as Record<string, unknown>;
    const own = n.props as Record<string, unknown>;
    for (const k in own) {
      const v = own[k];
      if (v !== undefined) out[k] = v;
    }
    return out as Props;
  }

  /** All node properties including defaults (a new object). */
  props(id: string): Props {
    const n = this.nodes.get(id);
    if (!n) return {};
    const out: Props = { ...DEFAULTS[n.type] };
    for (const [k, v] of Object.entries(n.props)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    return out;
  }

  /** All descendants (depth-first, in layer order). */
  *descendants(id: string): Generator<string> {
    for (const c of this.children(id)) {
      yield c;
      yield* this.descendants(c);
    }
  }

  /** Put a path into the geometry table; return the key (identical data — one key). */
  putBlob(data: string): string {
    const key = hashString(data);
    if (!this.blobs.has(key)) this.run({ op: 'blob', key, data });
    return key;
  }

  blob(key: string): string | undefined {
    return this.blobs.get(key);
  }

  get size(): number {
    return this.nodes.size;
  }

  // ---------- Writing ----------

  newId(): string {
    return `${this.clientId}:${++this.counter}`;
  }

  /** Creates a node. index — position among the children (by default at the end, i.e. on top). */
  create(type: NodeType, parent: string, props: Props = {}, index?: number): string {
    this.assertContainer(parent);
    const id = this.newId();
    const op: Op = { op: 'create', id, type, parent, index: this.indexAt(parent, index), props: cloneProps(props) };
    this.run(op);
    return id;
  }

  /** Create a node with a known id — for sync (the node came from another client). */
  createWithId(id: string, type: NodeType, parent: string, props: Props = {}, index?: number): string {
    this.assertContainer(parent);
    if (this.nodes.has(id)) throw new Error(`Узел ${id} уже существует`);
    this.run({ op: 'create', id, type, parent, index: this.indexAt(parent, index), props: cloneProps(props) });
    return id;
  }

  set(id: string, props: Props) {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Нет узла ${id}`);
    if (n.type === 'TEXT' && ('characters' in props || 'name' in props || 'autoRename' in props)) props = textNameChange({ ...DEFAULTS.TEXT, ...n.props }, props);
    // Only fields that actually changed: no-op edits create no operations or undo steps.
    const changed: Props = {};
    let any = false;
    for (const [k, v] of Object.entries(props) as [keyof Props, unknown][]) {
      const cur = n.props[k] !== undefined ? n.props[k] : DEFAULTS[n.type][k];
      if (v === cur || JSON.stringify(v) === JSON.stringify(cur)) continue;
      (changed as Record<string, unknown>)[k] = v;
      any = true;
    }
    // Ready-made paths (import) were computed for the original size: on the first resize
    // we remember it so the paths can be scaled (or rebuilt).
    if (any && ('width' in changed || 'height' in changed) && (n.props.vectorPaths || n.props.strokePaths || n.props.textPath) && !n.props.geometrySize) {
      const d = DEFAULTS[n.type];
      changed.geometrySize = { width: n.props.width ?? d.width ?? 0, height: n.props.height ?? d.height ?? 0 };
    }
    // Shape parameters changed — the ready-made import paths are stale: the shape is rebuilt.
    if (any && n.props.vectorPaths && SHAPE_PARAMETRIC.has(n.type) && Object.keys(changed).some((k) => SHAPE_KEYS.has(k))) {
      changed.vectorPaths = undefined;
      changed.strokePaths = undefined;
    }
    // Stroke parameters changed — the renderer builds the stroke: for parametric shapes from parameters, for vectors —
    // from center lines (centerPaths) or the path. Without them (neither is present) — keep the ready-made one.
    if (
      any &&
      n.props.strokePaths &&
      (SHAPE_PARAMETRIC.has(n.type) || n.type === 'LINE' || n.props.centerPaths || n.props.vectorPaths) &&
      Object.keys(changed).some((k) => STROKE_KEYS.has(k))
    ) {
      changed.strokePaths = undefined;
    }
    if (any) this.run({ op: 'set', id, props: cloneProps(changed) });
  }

  move(id: string, parent: string, index?: number) {
    if (!this.nodes.has(id)) throw new Error(`Нет узла ${id}`);
    this.assertContainer(parent);
    // A node cannot be placed inside itself.
    for (let p: string | null = parent; p; p = this.parent(p)) {
      if (p === id) throw new Error('Нельзя переместить узел внутрь самого себя');
    }
    const siblings = this.children(parent).filter((c) => c !== id);
    this.run({ op: 'move', id, parent, index: this.indexBetween(siblings, index) });
  }

  delete(id: string) {
    if (id === this.root) throw new Error('Нельзя удалить корень документа');
    if (!this.nodes.has(id)) return;
    if (!this.patternUsers.size) { this.run({ op: 'delete', id }); return; }
    this.transact(() => {
      const deleting = new Set([id, ...this.descendants(id)]);
      const required = [...deleting].filter((src) => [...(this.patternUsers.get(src) ?? [])].some((user) => !deleting.has(user)));
      if (required.length) preservePatternSources(this, deleting, required);
      this.run({ op: 'delete', id });
    });
  }

  /** Live motif wins; otherwise use its persisted copy. */
  patternSourceNode(id: string): string | undefined {
    return this.has(id) ? id : this.archivedPatterns.get(id);
  }

  /** Groups changes: subscribers get a single batch of operations. */
  transact<T>(fn: () => T, origin = 'local'): T {
    return this.transaction(fn, origin);
  }

  private transaction<T>(fn: () => T, origin: string, settled?: (accepted: boolean) => void): T {
    if (this.pending) return fn();
    const amending = this.amendNext;
    this.amendNext = false;
    this.pending = [];
    this.pendingOrigin = origin;
    const capture = this.previewInverse !== null && (origin === 'preview' || origin === 'layout');
    this.capturing = capture;
    const wantInverse = capture || UNDOABLE.has(origin) || amending;
    const guarded = !!this.guard && !UNGUARDED.has(origin);
    this.inverse = wantInverse || guarded ? [] : null;
    try {
      return fn();
    } finally {
      const ops = this.pending;
      const inverse = this.inverse;
      this.pending = null;
      this.inverse = null;
      this.capturing = false;
      const reason = guarded && ops.length ? this.guard!(ops, inverse ?? []) : null;
      if (reason !== null) {
        // Not allowed: roll back without a trace — change subscribers did not see the edit, it does not go into history.
        this.pending = [];
        for (const op of [...(inverse ?? [])].reverse()) this.commit(op);
        this.pending = null;
        settled?.(false);
        this.onGuard?.(reason);
      } else {
        // History must be updated before callbacks can start another transaction.
        settled?.(true);
        if (capture) {
          this.previewInverse!.push(...(inverse ?? []));
          this.previewBaseCache = null;
        } else if (wantInverse && inverse?.length) {
          if (amending) this.recordAmend(inverse);
          else this.record(inverse, origin);
        }
      }
      if (ops.length && reason === null) this.emit(ops, origin);
    }
  }

  /**
   * Preview (hovering a menu item): changes without an undo step, source 'preview' —
   * sync with other participants skips it. Returns a rollback (also without a step).
   */
  preview(fn: () => void): () => void {
    if (this.pending) {
      fn();
      return () => {};
    }
    // Another one is already open: edits go into its rollback (they are not real) and roll back together with it.
    if (this.previewInverse) {
      this.transact(fn, 'preview');
      return () => {};
    }
    // While a preview is open, derived edits (layout, text size) also go into the rollback.
    const list: Op[] = [];
    this.previewInverse = list;
    this.previewBaseCache = null;
    this.transact(fn, 'preview');
    return () => {
      if (this.previewInverse !== list) return;
      this.previewInverse = null;
      this.previewBaseCache = null;
      const steps = list.reverse();
      if (!steps.length) return;
      this.transact(() => {
        for (const op of steps) this.commit(op);
      }, 'preview');
    };
  }

  /** Rollback of the open preview: its edits and the edits derived from them. */
  private previewInverse: Op[] | null = null;
  /** A transaction writing into the preview rollback is in progress. */
  private capturing = false;
  /** Values before the preview, per node (first rollback records) — for saving; null — recompute. */
  private previewBaseCache: Map<string, Record<string, unknown>> | null = null;

  /**
   * Node for saving: properties changed by the open preview (timeline pose,
   * menu item hover) are as they were before it. The snapshot and file write do not see the preview.
   */
  savedNode(id: string): Readonly<NodeRecord> | undefined {
    const n = this.nodes.get(id);
    if (!n || !this.previewInverse) return n;
    if (!this.previewBaseCache) {
      const map = new Map<string, Record<string, unknown>>();
      for (const op of this.previewInverse) {
        if (op.op !== 'set') continue;
        let b = map.get(op.id);
        if (!b) map.set(op.id, (b = {}));
        for (const [k, v] of Object.entries(op.props)) if (!(k in b)) b[k] = v;
      }
      this.previewBaseCache = map;
    }
    const base = this.previewBaseCache.get(id);
    if (!base) return n;
    const props = { ...n.props } as Record<string, unknown>;
    for (const [k, v] of Object.entries(base)) {
      if (v === undefined) delete props[k];
      else props[k] = v;
    }
    return { ...n, props: props as Props };
  }

  /**
   * A real edit during a preview (user, undo, another participant): the preview rollback
   * no longer touches these properties, and undoing the edit restores the values from before the preview,
   * not the ones it showed. inverse — the edit's inverse operations (null — it is outside history).
   */
  private unpreview(op: Op, inverse: Op[] | null) {
    const list = this.previewInverse!;
    let ids: Set<string>;
    let keys: Set<string> | null = null;
    if (op.op === 'set') {
      ids = new Set([op.id]);
      keys = new Set(Object.keys(op.props));
    } else if (op.op === 'delete') {
      ids = new Set();
      const walk = (id: string) => {
        ids.add(id);
        for (const c of this.children(id)) walk(c);
      };
      walk(op.id);
    } else return;
    // The value before the preview is in the first rollback record (rollback runs from the end).
    const base = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < list.length; i++) {
      const o = list[i]!;
      if (o.op !== 'set' || !ids.has(o.id)) continue;
      const props = o.props as Record<string, unknown>;
      let b = base.get(o.id);
      for (const k of Object.keys(props)) {
        if (keys && !keys.has(k)) continue;
        if (!b) base.set(o.id, (b = {}));
        if (!(k in b)) b[k] = props[k];
        delete props[k];
      }
      if (!Object.keys(props).length) list.splice(i--, 1);
    }
    if (base.size) this.previewBaseCache = null;
    if (!inverse) return;
    for (const o of inverse) if ((o.op === 'set' || o.op === 'create') && base.has(o.id)) Object.assign(o.props, base.get(o.id));
  }

  /** Whether a preview is open. */
  get previewing(): boolean {
    return this.previewInverse !== null;
  }

  /**
   * The current operation is part of the preview (it will be rolled back and never enter the document for good):
   * the preview itself and layout inside it. The snapshot does not see them (savedNode), nor does the edit journal.
   */
  get previewCapturing(): boolean {
    return this.capturing;
  }

  /**
   * Derived edits after a user action (layout, text size): undoing them is
   * part of that action's undo step. Changes are appended to the last step (or the open group).
   */
  amend<T>(fn: () => T, origin = 'layout'): T {
    if (this.pending) return fn();
    this.amendNext = true;
    try {
      return this.transact(fn, origin);
    } finally {
      this.amendNext = false;
    }
  }

  private recordAmend(inverse: Op[]) {
    if (this.groupInverse && !this.undoOwner) {
      this.groupInverse.push(...inverse);
      return;
    }
    // These changes were made after the step — on undo they are rolled back first.
    this.undoStack[this.undoStack.length - 1]?.unshift(...inverse.reverse());
  }

  // ---------- Undo and redo ----------

  get canUndo() {
    return this.undoStack.length > 0;
  }

  /** Number of undo steps (for tests and the UI). */
  get undoDepth() {
    return this.undoStack.length;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    return this.replayHistory(this.undoStack, 'undo');
  }

  redo(): boolean {
    return this.replayHistory(this.redoStack, 'redo');
  }

  private replayHistory(stack: Op[][], origin: 'undo' | 'redo'): boolean {
    // Nested replay would inherit the outer origin and corrupt both histories.
    if (this.pending) return false;
    const step = stack.at(-1);
    if (!step) return false;
    let accepted = false;
    this.transaction(() => {
      for (const op of step) this.commit(op);
    }, origin, (ok) => {
      accepted = ok;
      if (ok) { stack.pop(); this.mergeableUndo = undefined; }
    });
    return accepted;
  }

  /** Synchronous scope: coalesce consecutive actions of one owner, excluding intervening user edits. */
  withUndoGroup<T>(owner: object, fn: () => T): T {
    const previous = this.undoOwner;
    this.undoOwner = owner;
    try { return fn(); } finally { this.undoOwner = previous; }
  }

  /** Merge the following transactions into one undo step (e.g. a mouse drag). */
  beginGroup() {
    this.mergeableUndo = undefined;
    if (this.groupDepth++ === 0) this.groupInverse = [];
  }

  /**
   * record = false — changes stay but do not become an undo step
   * (e.g. empty text that was created and immediately deleted).
   */
  endGroup(record = true) {
    if (this.groupDepth === 0) return;
    if (--this.groupDepth === 0) {
      const inv = this.groupInverse!;
      this.groupInverse = null;
      if (record && inv.length) {
        this.undoStack.push(inv.reverse());
        this.redoStack = [];
      }
    }
  }

  clearHistory() {
    this.mergeableUndo = undefined;
    this.undoStack = [];
    this.redoStack = [];
  }

  private record(inverse: Op[], origin: string) {
    if (origin === 'undo') this.redoStack.push(inverse.reverse());
    else if (origin === 'redo') this.undoStack.push(inverse.reverse());
    else if (this.groupInverse && !this.undoOwner) this.groupInverse.push(...inverse);
    else {
      // A plugin message can arrive during a drag/text-edit group. Split at that
      // boundary without closing the caller's group or absorbing its edits.
      if (this.groupInverse?.length) {
        this.undoStack.push(this.groupInverse.reverse());
        this.groupInverse = [];
        this.mergeableUndo = undefined;
      }
      const step = inverse.reverse();
      if (this.undoOwner && this.mergeableUndo?.owner === this.undoOwner && this.undoStack.at(-1) === this.mergeableUndo.step) {
        this.mergeableUndo.step.unshift(...step);
      } else {
        this.undoStack.push(step);
        this.mergeableUndo = this.undoOwner ? { owner: this.undoOwner, step } : undefined;
      }
      this.redoStack = [];
    }
  }

  /** Inverse operation (computed before the forward one is applied). */
  private invert(op: Op): Op[] {
    switch (op.op) {
      case 'create':
        return [{ op: 'delete', id: op.id }];
      case 'set': {
        const n = this.nodes.get(op.id);
        if (!n) return [];
        const old: Props = {};
        for (const k of Object.keys(op.props) as (keyof Props)[]) (old as Record<string, unknown>)[k] = cloneValue(n.props[k]);
        return [{ op: 'set', id: op.id, props: old }];
      }
      case 'move': {
        const n = this.nodes.get(op.id);
        return n?.parent ? [{ op: 'move', id: op.id, parent: n.parent, index: n.index }] : [];
      }
      case 'blob':
        return []; // the geometry table only grows
      case 'delete': {
        // Subtree restoration: parents before children. Record in reverse order
        // because the whole undo step is reversed later.
        const creates: Op[] = [];
        const walk = (id: string) => {
          const n = this.nodes.get(id);
          if (!n?.parent) return;
          creates.push({ op: 'create', id, type: n.type, parent: n.parent, index: n.index, props: cloneProps(n.props) });
          for (const c of this.children(id)) walk(c);
        };
        walk(op.id);
        return creates.reverse();
      }
    }
  }

  /** A single change — as a transaction of one operation. */
  private run(op: Op) {
    if (this.pending) this.commit(op);
    else this.transact(() => this.commit(op), 'local');
  }

  /** Applies operations coming from outside (another thread, the server, a plugin). */
  apply(ops: Op[], origin = 'remote') {
    this.transact(() => {
      for (const op of ops) this.commit(op);
    }, origin);
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Each operation in the actual order of application. onChange receives batches, and a batch that
   * a subscriber produced inside its handler (layout, text size) reaches the following
   * subscribers before the original one; a document copy (plugin Worker) needs exactly the application order.
   */
  onCommit(listener: CommitListener): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  // ---------- Internal ----------

  private assertContainer(id: string) {
    const t = this.type(id);
    if (!t) throw new Error(`Нет узла ${id}`);
    if (!CONTAINER_TYPES.has(t)) throw new Error(`Узел ${t} не может содержать детей`);
  }

  private indexAt(parent: string, index?: number): string {
    return this.indexBetween(this.children(parent), index);
  }

  private indexBetween(siblings: readonly string[], index?: number): string {
    const i = index === undefined ? siblings.length : Math.max(0, Math.min(index, siblings.length));
    const before = i > 0 ? this.nodes.get(siblings[i - 1]!)!.index : null;
    const after = i < siblings.length ? this.nodes.get(siblings[i]!)!.index : null;
    return generateKeyBetween(before, after);
  }

  private unindexPatterns(id: string) {
    for (const source of this.patternsByNode.get(id) ?? []) {
      const users = this.patternUsers.get(source)!;
      users.delete(id);
      if (!users.size) this.patternUsers.delete(source);
    }
    this.patternsByNode.delete(id);
    const original = this.archiveSourceByNode.get(id);
    if (original && this.archivedPatterns.get(original) === id) this.archivedPatterns.delete(original);
    this.archiveSourceByNode.delete(id);
  }

  private indexPatterns(n: NodeRecord) {
    this.unindexPatterns(n.id);
    const refs = patternReferences(n.props);
    if (refs.size) this.patternsByNode.set(n.id, refs);
    for (const source of refs) {
      let users = this.patternUsers.get(source);
      if (!users) this.patternUsers.set(source, (users = new Set()));
      users.add(n.id);
    }
    const original = n.props.preservedPatternSource;
    if (original) {
      this.archivedPatterns.set(original, n.id);
      this.archiveSourceByNode.set(n.id, original);
    }
  }

  private insertRecord(n: NodeRecord) {
    this.nodes.set(n.id, n);
    this.indexPatterns(n);
    if (n.parent) {
      let set = this.childrenOf.get(n.parent);
      if (!set) this.childrenOf.set(n.parent, (set = new Set()));
      set.add(n.id);
      this.sortedChildren.delete(n.parent);
    }
    // Keep the counter above this client's existing ids to avoid collisions.
    const [client, local] = n.id.split(':').map(Number);
    if (client === this.clientId && local !== undefined && local > this.counter) this.counter = local;
  }

  private detach(id: string) {
    const n = this.nodes.get(id);
    if (!n?.parent) return;
    this.childrenOf.get(n.parent)?.delete(id);
    this.sortedChildren.delete(n.parent);
  }

  private commit(op: Op) {
    const inverse = this.inverse ? this.invert(op) : null;
    if (this.previewInverse && !this.capturing) this.unpreview(op, inverse);
    if (inverse) this.inverse!.push(...inverse);
    let removed: NodeRecord[] | null = null;
    switch (op.op) {
      case 'blob': {
        if (this.blobs.has(op.key)) return;
        this.blobs.set(op.key, op.data);
        break;
      }
      case 'create': {
        if (this.nodes.has(op.id)) throw new Error(`Узел ${op.id} уже существует`);
        this.insertRecord({ id: op.id, type: op.type, parent: op.parent, index: op.index, props: cloneProps(op.props) });
        this.treeVersion++;
        break;
      }
      case 'set': {
        const n = this.nodes.get(op.id);
        if (!n) return; // the node is already deleted (e.g. a race with a deletion on another client)
        Object.assign(n.props, cloneProps(op.props));
        if (['fills', 'strokes', 'vectorPaths', 'textRuns', 'textGlyphs', 'preservedPatternSource'].some((k) => k in op.props)) this.indexPatterns(n);
        if ('internal' in op.props) this.treeVersion++;
        break;
      }
      case 'move': {
        const n = this.nodes.get(op.id);
        if (!n || !this.nodes.has(op.parent)) return;
        this.detach(op.id);
        n.parent = op.parent;
        n.index = op.index;
        this.insertRecord(n);
        this.treeVersion++;
        break;
      }
      case 'delete': {
        if (!this.nodes.has(op.id)) return;
        if (this.commitListeners.size) removed = [];
        const removeTree = (id: string) => {
          if (removed) removed.push(this.nodes.get(id)!);
          for (const c of [...(this.childrenOf.get(id) ?? [])]) removeTree(c);
          this.detach(id);
          this.unindexPatterns(id);
          this.nodes.delete(id);
          this.childrenOf.delete(id);
          this.sortedChildren.delete(id);
        };
        removeTree(op.id);
        this.treeVersion++;
        break;
      }
    }
    if (this.commitListeners.size) {
      const origin = this.pending ? this.pendingOrigin : 'local';
      for (const l of this.commitListeners) l(op, origin, removed);
    }
    if (this.pending) this.pending.push(op);
    else this.emit([op], 'local');
  }

  private emit(ops: Op[], origin: string) {
    for (const l of this.listeners) l(ops, origin);
  }
}
