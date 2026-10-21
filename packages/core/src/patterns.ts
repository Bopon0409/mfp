import type { Document } from './document.ts';
import type { Props } from './types.ts';

/** Paint references, including text runs and per-path fills. */
export function patternReferences(p: Readonly<Props>): Set<string> {
  const refs = new Set<string>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    const obj = v as Record<string, unknown>;
    if (obj.type === 'PATTERN' && typeof obj.sourceNodeId === 'string' && obj.sourceNodeId) refs.add(obj.sourceNodeId);
    else for (const x of Object.values(obj)) visit(x);
  };
  for (const v of [p.fills, p.strokes, p.vectorPaths, p.textRuns, p.textGlyphs?.runs]) visit(v);
  return refs;
}

/** Keep sources as hidden resources before deleting their visible originals.
 * Paints retain original IDs; rendering resolves missing IDs through the archive.
 * All writes belong to the deletion transaction and therefore its Undo/Redo.
 */
export function preservePatternSources(doc: Document, deleting: Set<string>, required: string[]) {
  const copies = new Map<string, string>();
  const add = (id: string) => {
    if (copies.has(id)) return;
    copies.set(id, doc.newId());
    for (const c of doc.children(id)) add(c);
  };
  for (const id of required) add(id);
  // A saved motif can itself use a motif deleted in the same subtree.
  for (const id of copies.keys()) {
    for (const src of patternReferences(doc.props(id))) if (deleting.has(src)) add(src);
  }
  let page = doc.children(doc.root).find((id) => !deleting.has(id) && doc.get(id, 'patternArchive'));
  page ??= doc.create('PAGE', doc.root, { name: 'Источники узоров', internal: true, patternArchive: true });
  const create = (id: string, parent: string) => {
    const n = doc.node(id)!;
    const props = { ...n.props, preservedPatternSource: id };
    doc.createWithId(copies.get(id)!, n.type, parent, props);
    for (const c of doc.children(id)) create(c, copies.get(id)!);
  };
  for (const id of copies.keys()) if (!copies.has(doc.parent(id)!)) create(id, page);
}
