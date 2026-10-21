// “Image enhancements” node graphs (like Blueprints): nodes with pins, wires, custom nodes:
// macro nodes made from a group of nodes, and presets (saved node settings). Data only here.

export type PinType = 'image' | 'text';

export interface PinDef {
  id: string;
  name: string;
  type: PinType;
  /** The input may be left unconnected (e.g. a sample for generation). */
  optional?: boolean;
}

export interface GraphNode {
  id: string;
  /** A built-in type or “macro:<id>”, an instance of a macro node. */
  type: string;
  x: number;
  y: number;
  params: Record<string, unknown>;
  /** Name of the preset the node was created from, shown in the header. */
  title?: string;
}

export interface Edge {
  from: { node: string; pin: string };
  to: { node: string; pin: string };
}

/** A custom node made from a group of nodes: inner graph and pins exposed outside. */
export interface MacroDef {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: Edge[];
  inputs: (PinDef & { target: { node: string; pin: string }[] })[];
  outputs: (PinDef & { source: { node: string; pin: string } })[];
}

export interface Graph {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: Edge[];
  /** Copies of the macro nodes the graph uses, so it works for others and in another browser. */
  macros: MacroDef[];
}

export interface Preset {
  id: string;
  name: string;
  nodeType: string;
  params: Record<string, unknown>;
}

export interface Library {
  version: 1;
  graphs: Graph[];
  macros: MacroDef[];
  presets: Preset[];
}

export const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

export const MACRO_PREFIX = 'macro:';
export const isMacro = (type: string) => type.startsWith(MACRO_PREFIX);

/** Macro nodes the graph needs (and those nested in them); copied into the graph. */
export function usedMacros(nodes: GraphNode[], known: MacroDef[]): MacroDef[] {
  const byId = new Map(known.map((m) => [m.id, m]));
  const out = new Map<string, MacroDef>();
  const visit = (list: GraphNode[]) => {
    for (const n of list) {
      if (!isMacro(n.type)) continue;
      const m = byId.get(n.type.slice(MACRO_PREFIX.length));
      if (!m || out.has(m.id)) continue;
      out.set(m.id, structuredClone(m));
      visit(m.nodes);
    }
  };
  visit(nodes);
  return [...out.values()];
}

/** Whether a wire path from → to exists (to prevent cycles). */
export function reaches(edges: Edge[], from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.from.node, [...(next.get(e.from.node) ?? []), e.to.node]);
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

/**
 * Collapse the selected nodes into a macro node: wires crossing the boundary become pins,
 * the selection is replaced by a single node. pinsOf gives a node's pins by type (for the pin type and name).
 */
export function collapse(
  graph: Graph,
  selected: Set<string>,
  name: string,
  pinsOf: (node: GraphNode) => { inputs: PinDef[]; outputs: PinDef[] },
): { graph: Graph; macro: MacroDef } {
  const inside = graph.nodes.filter((n) => selected.has(n.id));
  const inner = graph.edges.filter((e) => selected.has(e.from.node) && selected.has(e.to.node));
  const incoming = graph.edges.filter((e) => !selected.has(e.from.node) && selected.has(e.to.node));
  const outgoing = graph.edges.filter((e) => selected.has(e.from.node) && !selected.has(e.to.node));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const pinDef = (nodeId: string, pin: string, side: 'inputs' | 'outputs') => pinsOf(nodeById.get(nodeId)!)[side].find((p) => p.id === pin)!;

  // One external source feeding several inner inputs becomes a single macro node pin
  const inputs: MacroDef['inputs'] = [];
  const inputKey = new Map<string, string>();
  for (const e of incoming) {
    const key = `${e.from.node}/${e.from.pin}`;
    let id = inputKey.get(key);
    if (!id) {
      id = `in${inputs.length + 1}`;
      inputKey.set(key, id);
      const def = pinDef(e.to.node, e.to.pin, 'inputs');
      inputs.push({ id, name: def.name, type: def.type, target: [] });
    }
    inputs.find((p) => p.id === id)!.target.push({ node: e.to.node, pin: e.to.pin });
  }
  const outputs: MacroDef['outputs'] = [];
  const outputKey = new Map<string, string>();
  for (const e of outgoing) {
    const key = `${e.from.node}/${e.from.pin}`;
    if (outputKey.has(key)) continue;
    const id = `out${outputs.length + 1}`;
    outputKey.set(key, id);
    const def = pinDef(e.from.node, e.from.pin, 'outputs');
    outputs.push({ id, name: def.name, type: def.type, source: { node: e.from.node, pin: e.from.pin } });
  }

  // Identical pin names (“Image”, “Image”) get numbers, otherwise they are indistinguishable
  for (const list of [inputs, outputs] as { name: string }[][]) {
    const count = new Map<string, number>();
    for (const p of list) count.set(p.name, (count.get(p.name) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const p of list) {
      if (count.get(p.name)! < 2) continue;
      const n = (seen.get(p.name) ?? 0) + 1;
      seen.set(p.name, n);
      p.name = `${p.name} ${n}`;
    }
  }

  const minX = Math.min(...inside.map((n) => n.x));
  const minY = Math.min(...inside.map((n) => n.y));
  const macro: MacroDef = {
    id: newId(),
    name,
    nodes: inside.map((n) => ({ ...structuredClone(n), x: n.x - minX, y: n.y - minY })),
    edges: structuredClone(inner),
    inputs,
    outputs,
  };
  const instance: GraphNode = { id: newId(), type: MACRO_PREFIX + macro.id, x: minX, y: minY, params: {} };
  const edges: Edge[] = graph.edges.filter((e) => !selected.has(e.from.node) && !selected.has(e.to.node));
  for (const e of incoming) edges.push({ from: e.from, to: { node: instance.id, pin: inputKey.get(`${e.from.node}/${e.from.pin}`)! } });
  for (const e of outgoing) edges.push({ from: { node: instance.id, pin: outputKey.get(`${e.from.node}/${e.from.pin}`)! }, to: e.to });
  // Duplicate inputs after merging (one source → the same node twice) are not needed
  const unique = edges.filter((e, i) => edges.findIndex((x) => x.to.node === e.to.node && x.to.pin === e.to.pin) === i);
  return {
    graph: { ...graph, nodes: [...graph.nodes.filter((n) => !selected.has(n.id)), instance], edges: unique, macros: [...graph.macros.filter((m) => m.id !== macro.id), macro] },
    macro,
  };
}

/** Expand a macro node: its nodes go back into the graph (with new ids), wires through pins connect directly. */
export function expand(graph: Graph, nodeId: string): { graph: Graph; ids: string[] } {
  const instance = graph.nodes.find((n) => n.id === nodeId);
  const macro = instance && isMacro(instance.type) ? graph.macros.find((m) => m.id === instance.type.slice(MACRO_PREFIX.length)) : undefined;
  if (!instance || !macro) return { graph, ids: [] };
  const ids = new Map(macro.nodes.map((n) => [n.id, newId()]));
  const map = (end: { node: string; pin: string }) => ({ node: ids.get(end.node)!, pin: end.pin });
  const nodes = macro.nodes.map((n) => ({ ...structuredClone(n), id: ids.get(n.id)!, x: n.x + instance.x, y: n.y + instance.y }));
  const edges: Edge[] = graph.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId);
  edges.push(...macro.edges.map((e) => ({ from: map(e.from), to: map(e.to) })));
  for (const e of graph.edges) {
    if (e.to.node === nodeId) for (const t of macro.inputs.find((p) => p.id === e.to.pin)?.target ?? []) edges.push({ from: e.from, to: map(t) });
    if (e.from.node === nodeId) {
      const src = macro.outputs.find((p) => p.id === e.from.pin)?.source;
      if (src) edges.push({ from: map(src), to: e.to });
    }
  }
  return { graph: { ...graph, nodes: [...graph.nodes.filter((n) => n.id !== nodeId), ...nodes], edges }, ids: [...ids.values()] };
}

// ---------- old “Chains” (list of steps) → graphs ----------

type OldStep =
  | { kind: 'generate'; template: string; aspectRatio: string; imageSize: string; engine?: string; steps?: number }
  | { kind: 'upscale'; engine: string; model: string; scale: number; mode: string }
  | { kind: 'remove-bg'; trim: boolean }
  | { kind: 'sizes'; sizes: { width: number; height: number }[]; padding: number };

interface OldChain {
  id: string;
  name: string;
  page: string;
  steps: OldStep[];
}

/** Chain → a line of nodes: input (prompts or images) → steps → “Fit” and “To page” for each size. */
export function chainToGraph(chain: OldChain): Graph {
  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  let x = 0;
  const add = (type: string, params: Record<string, unknown>, y = 0): GraphNode => {
    const n: GraphNode = { id: newId(), type, x, y, params };
    nodes.push(n);
    x += 300;
    return n;
  };
  const link = (from: GraphNode, fromPin: string, to: GraphNode, toPin: string) => edges.push({ from: { node: from.id, pin: fromPin }, to: { node: to.id, pin: toPin } });

  const gen = chain.steps[0]?.kind === 'generate';
  const source = gen ? add('prompts', { lines: '' }) : add('images', {});
  let image: { node: GraphNode; pin: string } | null = gen ? null : { node: source, pin: 'image' };
  let sizes: Extract<OldStep, { kind: 'sizes' }> | null = null;
  for (const s of chain.steps) {
    if (s.kind === 'generate') {
      const g = add('generate', { engine: s.engine ?? 'auto', template: s.template, aspectRatio: s.aspectRatio, imageSize: s.imageSize, steps: s.steps ?? 2 });
      link(source, 'prompt', g, 'prompt');
      image = { node: g, pin: 'image' };
    } else if (!image) {
      continue;
    } else if (s.kind === 'upscale') {
      const u = add('upscale', { engine: s.engine, model: s.model, scale: s.scale, mode: s.mode });
      link(image.node, image.pin, u, 'image');
      image = { node: u, pin: 'image' };
    } else if (s.kind === 'remove-bg') {
      const r = add('remove-bg', { trim: s.trim });
      link(image.node, image.pin, r, 'image');
      image = { node: r, pin: 'image' };
    } else {
      sizes = s;
    }
  }
  if (image) {
    const list = sizes?.sizes.length ? sizes.sizes : [null];
    const startX = x;
    list.forEach((z, i) => {
      x = startX;
      const y = i * 220;
      let last = image!;
      if (z) {
        const f = add('fit', { width: z.width, height: z.height, padding: sizes!.padding }, y);
        link(last.node, last.pin, f, 'image');
        last = { node: f, pin: 'image' };
      }
      const out = add('page', { page: chain.page, suffix: z ? (z.width === z.height ? `/${z.width}` : `/${z.width}x${z.height}`) : '' }, y);
      link(last.node, last.pin, out, 'image');
      link(source, 'name', out, 'name');
    });
  }
  return { id: chain.id || newId(), name: chain.name, nodes, edges, macros: [] };
}

const LIBRARY = 'mfp-imaging-library';
const OLD_CHAINS = 'mfp-imaging-chains';

export const emptyLibrary = (): Library => ({ version: 1, graphs: [], macros: [], presets: [] });

/** Personal library in the browser; on first open, old chains are migrated. */
export function loadLibrary(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): Library {
  try {
    const v = JSON.parse(storage.getItem(LIBRARY) ?? 'null') as Library | null;
    if (v?.version === 1) return v;
  } catch {
    // garbage: start over
  }
  const lib = emptyLibrary();
  try {
    const old = JSON.parse(storage.getItem(OLD_CHAINS) ?? 'null') as OldChain[] | null;
    if (Array.isArray(old)) lib.graphs = old.map(chainToGraph);
  } catch {
    // no old chains
  }
  return lib;
}

export function saveLibrary(lib: Library, storage: Pick<Storage, 'setItem'> = localStorage) {
  try {
    storage.setItem(LIBRARY, JSON.stringify(lib));
  } catch {
    // no storage: until reload
  }
}
