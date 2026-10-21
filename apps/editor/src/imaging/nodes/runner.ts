// Graph execution: a batch is processed one item (a prompt line or an image) at a time; for each item
// only the nodes that output nodes (“To page”) depend on are computed, each once.

import type { ImageOrigin } from '../projects.ts';
import { MACRO_PREFIX, isMacro, type Edge, type Graph, type GraphNode, type MacroDef, type PinDef } from './model.ts';

export type Value = { type: 'image'; blob: Blob; width: number; height: number } | { type: 'text'; text: string };

export interface PageOutput {
  page: string;
  name: string;
  blob: Blob;
  width: number;
  height: number;
}

/** New image for the layer the item's image came from. */
export interface ReplaceOutput {
  origin: ImageOrigin;
  blob: Blob;
  width: number;
  height: number;
  /** The layer takes the image size. */
  resize: boolean;
}

export interface Item {
  name: string;
  prompt?: string;
  image?: Blob;
  /** The image was taken from a document layer and can be replaced there. */
  origin?: ImageOrigin;
}

export interface GenerateOptions {
  engine: 'auto' | 'local' | 'nano';
  prompt: string;
  reference?: Blob;
  steps: number;
  aspectRatio: string;
  imageSize: string;
}

export interface UpscaleOptions {
  engine: 'auto' | 'local' | 'magnific';
  model: string;
  scale: number;
  mode: 'creative' | 'precision';
}

/** Everything the nodes can do; implemented in services.ts (GPU, Nano Banana, Magnific), faked in tests. */
export interface Services {
  generate(o: GenerateOptions, ctx: RunContext): Promise<Blob>;
  upscale(image: Blob, o: UpscaleOptions, ctx: RunContext): Promise<Blob>;
  removeBackground(image: Blob, trim: boolean, ctx: RunContext): Promise<Blob>;
  fit(image: Blob, width: number, height: number, padding: number): Promise<Blob>;
  sizeOf(image: Blob): Promise<{ width: number; height: number }>;
}

export interface RunContext {
  item: Item;
  services: Services;
  signal: AbortSignal;
  status: (text: string) => void;
  emit: (out: PageOutput) => void;
  replace?: (out: ReplaceOutput) => void;
  /** A node started/finished computing, for highlighting on the canvas. */
  onNode?: (nodeId: string, state: 'run' | 'done' | 'error') => void;
}

export interface ParamDef {
  id: string;
  name: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'check';
  options?: [string, string][];
  min?: number;
  max?: number;
  default: unknown;
  hint?: string;
  /** Height of a multiline field, in lines. */
  rows?: number;
  /** Show only for these values of other parameters. */
  when?: (params: Record<string, unknown>) => boolean;
}

export interface NodeDef {
  type: string;
  title: string;
  category: 'input' | 'text' | 'generate' | 'process' | 'output' | 'custom';
  description: string;
  inputs: PinDef[];
  outputs: PinDef[];
  params: ParamDef[];
  /** Batch source: yields items (prompt lines or images). */
  source?: 'prompts' | 'images';
  /** Output node: computation starts from it. */
  output?: boolean;
  run(ctx: RunContext, inputs: Record<string, Value | undefined>, params: Record<string, unknown>): Promise<Record<string, Value>>;
}

export class GraphError extends Error {}

export const paramsOf = (def: NodeDef, node: GraphNode): Record<string, unknown> => {
  const p: Record<string, unknown> = {};
  for (const d of def.params) p[d.id] = node.params[d.id] ?? d.default;
  return p;
};

/** Node definition: built-in or a macro node (pins come from its description). */
export function resolveDef(type: string, builtins: Map<string, NodeDef>, macros: MacroDef[]): NodeDef | undefined {
  if (!isMacro(type)) return builtins.get(type);
  const m = macros.find((x) => x.id === type.slice(MACRO_PREFIX.length));
  if (!m) return undefined;
  return {
    type,
    title: m.name,
    category: 'custom',
    description: 'Своя нода из группы нод',
    inputs: m.inputs.map(({ id, name, type: t, optional }) => ({ id, name, type: t, optional })),
    outputs: m.outputs.map(({ id, name, type: t }) => ({ id, name, type: t })),
    params: [],
    run: async () => ({}),
  };
}

const describe = (node: GraphNode, def: NodeDef | undefined) => `«${node.title ?? def?.title ?? node.type}»`;

/** Compute the graph for one batch item. */
export async function runItem(graph: Graph, builtins: Map<string, NodeDef>, ctx: RunContext): Promise<void> {
  const outputs = graph.nodes.filter((n) => builtins.get(n.type)?.output);
  if (!outputs.length) throw new GraphError('В схеме нет ноды вывода — добавьте «На страницу»');
  const evaluate = scope(graph.nodes, graph.edges, graph.macros, builtins, ctx, new Map());
  for (const n of outputs) await evaluate(n.id);
}

/** Compute the nodes of one graph (or a macro node's contents); bound holds the macro node input values. */
function scope(nodes: GraphNode[], edges: Edge[], macros: MacroDef[], builtins: Map<string, NodeDef>, ctx: RunContext, bound: Map<string, Value | undefined>) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, Promise<Record<string, Value>>>();
  const evaluate = (id: string, path: string[] = []): Promise<Record<string, Value>> => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (path.includes(id)) throw new GraphError('В схеме цикл: провода замыкаются в кольцо');
    const node = byId.get(id);
    if (!node) throw new GraphError('Провод ведёт к удалённой ноде');
    const def = resolveDef(node.type, builtins, macros);
    if (!def) throw new GraphError(`Неизвестная нода ${describe(node, def)}`);
    const run = (async () => {
      const inputs: Record<string, Value | undefined> = {};
      for (const pin of def.inputs) {
        const key = `${id}/${pin.id}`;
        if (bound.has(key)) {
          inputs[pin.id] = bound.get(key);
          continue;
        }
        const edge = edges.find((e) => e.to.node === id && e.to.pin === pin.id);
        if (!edge) {
          if (!pin.optional) throw new GraphError(`Не подключён вход «${pin.name}» у ноды ${describe(node, def)}`);
          continue;
        }
        const from = await evaluate(edge.from.node, [...path, id]);
        inputs[pin.id] = from[edge.from.pin];
      }
      if (ctx.signal.aborted) throw new DOMException('Остановлено', 'AbortError');
      ctx.onNode?.(id, 'run');
      try {
        const result = isMacro(node.type) ? await runMacro(node, inputs, macros, builtins, ctx) : await def.run(ctx, inputs, paramsOf(def, node));
        ctx.onNode?.(id, 'done');
        return result;
      } catch (e) {
        ctx.onNode?.(id, 'error');
        throw e;
      }
    })();
    memo.set(id, run);
    return run;
  };
  return evaluate;
}

async function runMacro(node: GraphNode, inputs: Record<string, Value | undefined>, macros: MacroDef[], builtins: Map<string, NodeDef>, ctx: RunContext): Promise<Record<string, Value>> {
  const m = macros.find((x) => x.id === node.type.slice(MACRO_PREFIX.length))!;
  const bound = new Map<string, Value | undefined>();
  for (const pin of m.inputs) for (const t of pin.target) bound.set(`${t.node}/${t.pin}`, inputs[pin.id]);
  // Highlight only the macro node itself; its inner nodes are not visible on the canvas
  const inner = scope(m.nodes, m.edges, macros, builtins, { ...ctx, onNode: undefined }, bound);
  const out: Record<string, Value> = {};
  for (const pin of m.outputs) {
    const v = (await inner(pin.source.node))[pin.source.pin];
    if (v) out[pin.id] = v;
  }
  return out;
}

/** Batch: lines of the “Prompts” node or images of the “Images” node; with no source, a single run. */
export function batchItems(graph: Graph, builtins: Map<string, NodeDef>, images: Map<string, { name: string; blob: Blob; origin?: ImageOrigin }[]>, fallbackName: string): Item[] {
  const sources = graph.nodes.filter((n) => builtins.get(n.type)?.source);
  if (sources.length > 1) throw new GraphError('Источник пакета должен быть один: оставьте одну ноду «Запросы» или «Картинки»');
  const src = sources[0];
  if (!src) return [{ name: fallbackName }];
  if (builtins.get(src.type)!.source === 'images') return (images.get(src.id) ?? []).map((x) => ({ name: x.name, image: x.blob, origin: x.origin }));
  return String(src.params.lines ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const bar = line.indexOf('|');
      if (bar > 0) return { name: line.slice(0, bar).trim(), prompt: line.slice(bar + 1).trim() };
      return { name: line.split(/\s+/).slice(0, 4).join(' ').replace(/[\\/:*?"<>|]+/g, '').slice(0, 40) || 'image', prompt: line };
    });
}
