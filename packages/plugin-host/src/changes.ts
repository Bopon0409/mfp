// Document change events for plugins, in the form of the Figma Plugin API:
// documentchange (figma.on), nodechange (on a page), stylechange.
// Source: document operations in application order (Document.onCommit).

import type { Document, NodeRecord, NodeType, Op } from '@mfp/core';

export type ChangeOrigin = 'LOCAL' | 'REMOTE';

/** Change for the sandbox: nodes as {$node} references, removed ones as { removed, type, id }. */
export interface WireChange {
  type: 'CREATE' | 'DELETE' | 'PROPERTY_CHANGE' | 'STYLE_CREATE' | 'STYLE_DELETE' | 'STYLE_PROPERTY_CHANGE';
  id: string;
  origin: ChangeOrigin;
  node?: unknown;
  style?: unknown;
  properties?: string[];
}

interface Entry {
  change: WireChange;
  /** Page of the node (for nodechange); null — not on a page (the page itself, a style). */
  page: string | null;
  props?: Set<string>;
}

/** Internal and derived model properties; plugins are not notified about them. */
const HIDDEN = new Set([
  'centerPaths',
  'strokePaths',
  'textGlyphs',
  'geometrySize',
  'componentRef',
  'overrides',
  'internal',
  'commentsPage',
  'comment',
  'measurements',
  'codeConnect',
  'library',
  'teamLibraries',
  'annotationCategories',
]);

/** Model properties → NodeChangeProperty names. */
const ALIASES: Record<string, string[]> = {
  transform: ['x', 'y', 'relativeTransform'],
  strokeStartCap: ['strokeCap'],
  strokeEndCap: ['strokeCap'],
  textRuns: ['styledTextSegments'],
  listType: ['listOptions'],
  vectorPaths: ['vectorNetwork', 'vectorPaths'],
  vectorNetwork: ['vectorNetwork', 'vectorPaths', 'handleMirroring'],
  componentId: ['mainComponent'],
  sharedPluginData: ['pluginData'],
};

/** Style properties → StyleChangeProperty names. */
const STYLE_ALIASES: Record<string, string[]> = {
  fills: ['paint'],
  styleType: ['type'],
  sharedPluginData: ['pluginData'],
};

const SKIP_TYPES = new Set<NodeType>(['DOCUMENT', 'VARIABLE', 'VARIABLE_COLLECTION'] as NodeType[]);

export class ChangeTracker {
  private doc: Document;
  private entries: Entry[] = [];
  /** Last record per node: consecutive property edits merge into one. */
  private last = new Map<string, Entry>();

  constructor(doc: Document) {
    this.doc = doc;
  }

  get empty() {
    return this.entries.length === 0;
  }

  add(op: Op, origin: ChangeOrigin, removed: readonly NodeRecord[] | null) {
    switch (op.op) {
      case 'blob':
        return;
      case 'create': {
        if (op.type === 'STYLE') return this.push(op.id, { change: { type: 'STYLE_CREATE', id: op.id, origin, style: { $node: op.id } }, page: null });
        if (SKIP_TYPES.has(op.type)) return;
        const page = this.pageOf(op.id);
        if (page !== undefined) this.push(op.id, { change: { type: 'CREATE', id: op.id, origin, node: { $node: op.id } }, page });
        return;
      }
      case 'set':
      case 'move': {
        const t = this.doc.type(op.id);
        if (!t || SKIP_TYPES.has(t)) return;
        const keys = op.op === 'move' ? ['parent'] : this.names(op.id, t, Object.keys(op.props));
        if (!keys.length) return;
        const prev = this.last.get(op.id);
        if (prev && prev.change.origin === origin) {
          // Created in the same batch — CREATE is enough; consecutive edits are one change.
          if (prev.change.type === 'CREATE' || prev.change.type === 'STYLE_CREATE') return;
          if (prev.props) {
            for (const k of keys) prev.props.add(k);
            return;
          }
        }
        if (t === 'STYLE') {
          return this.push(op.id, { change: { type: 'STYLE_PROPERTY_CHANGE', id: op.id, origin, style: { $node: op.id } }, page: null, props: new Set(keys) });
        }
        const page = this.pageOf(op.id);
        if (page !== undefined) this.push(op.id, { change: { type: 'PROPERTY_CHANGE', id: op.id, origin, node: { $node: op.id } }, page, props: new Set(keys) });
        return;
      }
      case 'delete': {
        if (!removed?.length) return;
        const root = removed[0]!;
        // Page of the removed subtree (the root's parent is still in the document).
        const page = root.type === 'PAGE' ? (root.props.internal ? undefined : null) : root.parent ? this.pageOf(root.parent) : undefined;
        for (const r of removed) {
          if (r.type === 'STYLE') this.push(r.id, { change: { type: 'STYLE_DELETE', id: r.id, origin, style: null }, page: null });
          else if (page !== undefined && !SKIP_TYPES.has(r.type)) {
            this.push(r.id, { change: { type: 'DELETE', id: r.id, origin, node: { removed: true, type: r.type, id: r.id } }, page: r.type === 'PAGE' ? null : page });
          }
        }
        return;
      }
    }
  }

  /** Accumulated changes (and clearing). */
  take() {
    const documentChanges: WireChange[] = [];
    const styleChanges: WireChange[] = [];
    const nodeChanges = new Map<string, WireChange[]>();
    for (const e of this.entries) {
      if (e.props) e.change.properties = [...e.props];
      documentChanges.push(e.change);
      if (e.change.type.startsWith('STYLE_')) styleChanges.push(e.change);
      else if (e.page) {
        let list = nodeChanges.get(e.page);
        if (!list) nodeChanges.set(e.page, (list = []));
        list.push(e.change);
      }
    }
    this.entries = [];
    this.last.clear();
    return { documentChanges, styleChanges, nodeChanges };
  }

  private push(id: string, e: Entry) {
    this.entries.push(e);
    this.last.set(id, e);
  }

  /** Names of changed properties in the Plugin API. */
  private names(id: string, t: NodeType, keys: string[]): string[] {
    const aliases = t === 'STYLE' ? STYLE_ALIASES : ALIASES;
    const out = new Set<string>();
    for (const k of keys) {
      if (HIDDEN.has(k)) continue;
      for (const a of aliases[k] ?? [k]) out.add(a);
      // Rotation: for a rotated node, rotation changes too.
      if (k === 'transform') {
        const m = this.doc.get(id, 'transform');
        if (m && (m[1] !== 0 || m[3] !== 0)) out.add('rotation');
      }
    }
    return [...out];
  }

  /** Page of the node: id; null — the node itself is a page; undefined — internal (not reported). */
  private pageOf(id: string): string | null | undefined {
    for (let cur: string | null = id; cur; cur = this.doc.parent(cur)) {
      const t = this.doc.type(cur);
      if (t === 'PAGE') {
        if (this.doc.get(cur, 'internal')) return undefined;
        return cur === id ? null : cur;
      }
      if (t === 'DOCUMENT') return undefined;
    }
    return undefined;
  }
}
