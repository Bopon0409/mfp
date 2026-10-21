// Graphs shared in the file: stored in sharedPluginData of the document root (namespace
// mfp-imaging, one key per graph), saved and synced along with the file, so the team sees them too.

import type { Editor } from '../../editor.ts';
import type { Graph } from './model.ts';

type Doc = Editor['doc'];

const NS = 'mfp-imaging';
const PREFIX = 'graph:';

const shared = (doc: Doc) => doc.get(doc.root, 'sharedPluginData') ?? {};

const parse = (json: string): Graph | null => {
  try {
    const g = JSON.parse(json) as Graph;
    return g && typeof g.id === 'string' && Array.isArray(g.nodes) && Array.isArray(g.edges) ? { ...g, macros: Array.isArray(g.macros) ? g.macros : [] } : null;
  } catch {
    return null;
  }
};

export function fileGraphs(doc: Doc): Graph[] {
  return Object.entries(shared(doc)[NS] ?? {})
    .filter(([k]) => k.startsWith(PREFIX))
    .flatMap(([, v]) => parse(v) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

export const fileGraphJson = (doc: Doc, id: string): string | undefined => shared(doc)[NS]?.[PREFIX + id];

export const fileGraph = (doc: Doc, id: string): Graph | null => {
  const json = fileGraphJson(doc, id);
  return json ? parse(json) : null;
};

export function writeFileGraph(doc: Doc, graph: Graph): string {
  const json = JSON.stringify(graph);
  const all = { ...shared(doc) };
  all[NS] = { ...(all[NS] ?? {}), [PREFIX + graph.id]: json };
  doc.set(doc.root, { sharedPluginData: all });
  return json;
}

export function removeFileGraph(doc: Doc, id: string) {
  const all = { ...shared(doc) };
  const ns = { ...(all[NS] ?? {}) };
  delete ns[PREFIX + id];
  all[NS] = ns;
  doc.set(doc.root, { sharedPluginData: all });
}

/** Whether a batch of edits touches the file's shared graphs. */
export const touchesShared = (doc: Doc, ops: { op: string; id?: string; props?: object }[]) => ops.some((op) => op.op === 'set' && op.id === doc.root && !!op.props && 'sharedPluginData' in op.props);
