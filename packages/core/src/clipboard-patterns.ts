import type { Document } from './document.ts';
import { patternReferences } from './patterns.ts';
import type { NodeRecord, Props } from './types.ts';

export interface ClipboardPatterns {
  nodes: NodeRecord[];
  /** A paint may still refer to a deleted source ID; map it to its saved motif. */
  aliases: Record<string, string>;
}

/** Freeze external motifs at Copy time, including nested patterns and children. */
export function collectClipboardPatterns(doc: Document, trees: readonly (readonly NodeRecord[])[]): ClipboardPatterns {
  const included = new Set(trees.flatMap((t) => t.map((n) => n.id)));
  const nodes = new Map<string, NodeRecord>();
  const queue = trees.flatMap((t) => [...t]);
  const aliases: Record<string, string> = {};
  const add = (id: string) => {
    if (included.has(id) || nodes.has(id)) return;
    const rec = doc.node(id);
    if (!rec) return;
    const copy = structuredClone(rec) as NodeRecord;
    nodes.set(id, copy);
    queue.push(copy);
    for (const child of doc.children(id)) add(child);
  };
  for (let i = 0; i < queue.length; i++) {
    for (const ref of patternReferences(queue[i]!.props)) {
      const source = doc.patternSourceNode(ref);
      if (!source) continue;
      aliases[ref] = source;
      add(source);
    }
  }
  return { nodes: [...nodes.values()], aliases };
}

/** Only paint references are rewritten; ordinary text matching an ID stays text. */
export function remapPatternPaints(props: Props, map: ReadonlyMap<string, string>): Props {
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (!v || typeof v !== 'object') return v;
    const obj = v as Record<string, unknown>;
    if (obj.type === 'PATTERN' && typeof obj.sourceNodeId === 'string') return { ...obj, sourceNodeId: map.get(obj.sourceNodeId) ?? obj.sourceNodeId };
    return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, visit(x)]));
  };
  const out = { ...props };
  for (const key of ['fills', 'strokes', 'vectorPaths', 'textRuns', 'textGlyphs'] as const) {
    if (props[key]) (out as Record<string, unknown>)[key] = visit(props[key]);
  }
  return out;
}

/** Caller creates visible copies first, supplies their ID map, and owns the transaction.
 * Foreign IDs must never resolve against unrelated nodes of the target document. */
export function insertClipboardPatterns(doc: Document, bundle: ClipboardPatterns, map: Map<string, string>, reuseExisting: boolean): void {
  const records = new Map(bundle.nodes.map((n) => [n.id, n]));
  const copied: string[] = [];
  const reusedAliases = new Set<string>();
  if (reuseExisting) for (const [alias, actual] of Object.entries(bundle.aliases)) {
    if (map.has(actual) || map.has(alias)) continue;
    const live = doc.patternSourceNode(alias);
    if (live) { map.set(actual, live); reusedAliases.add(alias); }
  }
  let page: string | undefined;
  const create = (id: string): string | undefined => {
    const known = map.get(id);
    if (known) return known;
    if (reuseExisting && doc.has(id)) { map.set(id, id); return id; }
    const n = records.get(id);
    if (!n) return undefined;
    page ??= doc.children(doc.root).find((p) => doc.get(p, 'patternArchive')) ?? doc.create('PAGE', doc.root, { name: 'Источники узоров', internal: true, patternArchive: true });
    const parent = n.parent && records.has(n.parent) ? create(n.parent)! : page;
    const props = { ...n.props };
    delete props.preservedPatternSource;
    const next = doc.create(n.type, parent, props);
    map.set(id, next);
    copied.push(next);
    return next;
  };
  // Parents before children, siblings in their original fractional-index order.
  for (const n of [...bundle.nodes].sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0)) create(n.id);
  for (const [alias, actual] of Object.entries(bundle.aliases)) {
    if (reusedAliases.has(alias)) continue;
    const target = map.get(actual);
    if (target) map.set(alias, target);
  }
  for (const id of copied) doc.set(id, remapPatternPaints(doc.props(id), map));
}
