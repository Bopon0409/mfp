import { Document } from '@mfp/core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_MAP } from '../src/imaging/nodes/defs.ts';
import { chainToGraph, collapse, expand, newId, reaches, type Graph, type GraphNode } from '../src/imaging/nodes/model.ts';
import { fileGraphs, removeFileGraph, writeFileGraph } from '../src/imaging/nodes/shared.ts';
import { GraphError, batchItems, resolveDef, runItem, type PageOutput, type RunContext, type Services } from '../src/imaging/nodes/runner.ts';

// Fake services: an image is a Blob with text, the size is in its type
const img = (label: string, w: number, h: number) => new Blob([label], { type: `image/x-test;${w}x${h}` });
const label = async (b: Blob) => b.text();
const services = (log: string[]): Services => ({
  generate: async (o) => (log.push(`gen:${o.engine}:${o.prompt}`), img(`gen(${o.prompt})`, 1024, 1024)),
  upscale: async (b, o) => img(`up${o.scale}(${await label(b)})`, 2048, 2048),
  removeBackground: async (b) => img(`nobg(${await label(b)})`, 900, 800),
  fit: async (b, w, h) => img(`fit${w}x${h}(${await label(b)})`, w, h),
  sizeOf: async (b) => {
    const [w, h] = b.type.split(';')[1]!.split('x').map(Number);
    return { width: w!, height: h! };
  },
});

async function run(graph: Graph, images = new Map()) {
  const log: string[] = [];
  const out: (PageOutput & { label: string })[] = [];
  for (const item of batchItems(graph, BUILTIN_MAP, images, graph.name)) {
    const pending: Promise<void>[] = [];
    const ctx: RunContext = { item, services: services(log), signal: new AbortController().signal, status: () => undefined, emit: (o) => void pending.push(label(o.blob).then((l) => void out.push({ ...o, label: l }))) };
    await runItem(graph, BUILTIN_MAP, ctx);
    await Promise.all(pending);
  }
  return { log, out };
}

const node = (type: string, x: number, params: Record<string, unknown> = {}): GraphNode => ({ id: newId(), type, x, y: 0, params });
const wire = (from: GraphNode, fp: string, to: GraphNode, tp: string) => ({ from: { node: from.id, pin: fp }, to: { node: to.id, pin: tp } });

function iconsGraph() {
  const prompts = node('prompts', 0, { lines: 'sword | steel sword\nhealth potion' });
  const tpl = node('template', 1, { template: '{text}, icon' });
  const gen = node('generate', 2, { engine: 'local', template: '{prompt}' });
  const bg = node('remove-bg', 3);
  const fit200 = node('fit', 4, { width: 200, height: 200 });
  const fit450 = node('fit', 4, { width: 450, height: 450 });
  const out200 = node('page', 5, { page: 'Icons', suffix: '/200' });
  const out450 = node('page', 5, { page: 'Icons', suffix: '/450' });
  const graph: Graph = {
    id: newId(),
    name: 'Test',
    nodes: [prompts, tpl, gen, bg, fit200, fit450, out200, out450],
    edges: [wire(prompts, 'prompt', tpl, 'text'), wire(tpl, 'text', gen, 'prompt'), wire(gen, 'image', bg, 'image'), wire(bg, 'image', fit200, 'image'), wire(bg, 'image', fit450, 'image'), wire(fit200, 'image', out200, 'image'), wire(fit450, 'image', out450, 'image'), wire(prompts, 'name', out200, 'name'), wire(prompts, 'name', out450, 'name')],
    macros: [],
  };
  return { graph, gen, bg, fit200, fit450 };
}

describe('image enhancements: node graphs', () => {
  it('request batch: each line is its own run, branches after a shared node are computed once', async () => {
    const { out, log } = await run(iconsGraph().graph);
    expect(log).toEqual(['gen:local:steel sword, icon', 'gen:local:health potion, icon']);
    expect(out.map((o) => `${o.page} ${o.name} ${o.width}x${o.height} ${o.label}`).sort()).toEqual([
      'Icons health potion/200 200x200 fit200x200(nobg(gen(health potion, icon)))',
      'Icons health potion/450 450x450 fit450x450(nobg(gen(health potion, icon)))',
      'Icons sword/200 200x200 fit200x200(nobg(gen(steel sword, icon)))',
      'Icons sword/450 450x450 fit450x450(nobg(gen(steel sword, icon)))',
    ]);
  });

  it('macro node from a group of nodes: the same result, pins follow the wires across the boundary', async () => {
    const { graph, gen, bg, fit200, fit450 } = iconsGraph();
    const before = await run(graph);
    const pinsOf = (n: GraphNode) => resolveDef(n.type, BUILTIN_MAP, graph.macros)!;
    const { graph: collapsed, macro } = collapse(graph, new Set([gen.id, bg.id, fit200.id, fit450.id]), 'Icon in two sizes', pinsOf);
    expect(macro.inputs.map((p) => `${p.name}:${p.type}`)).toEqual(['Запрос:text']);
    expect(macro.outputs.map((p) => `${p.name}:${p.type}`)).toEqual(['Картинка 1:image', 'Картинка 2:image']);
    expect(collapsed.nodes).toHaveLength(5);
    const after = await run(collapsed);
    expect(after.out.map((o) => o.label).sort()).toEqual(before.out.map((o) => o.label).sort());

    const instance = collapsed.nodes.find((n) => n.type.startsWith('macro:'))!;
    const { graph: expanded, ids } = expand(collapsed, instance.id);
    expect(ids).toHaveLength(4);
    expect(expanded.nodes).toHaveLength(8);
    expect(expanded.edges).toHaveLength(graph.edges.length);
    const again = await run(expanded);
    expect(again.out.map((o) => o.label).sort()).toEqual(before.out.map((o) => o.label).sort());
  });

  it('the old “Icons” chain turns into a node graph', async () => {
    const graph = chainToGraph({
      id: 'c1',
      name: 'Icons',
      page: 'Icons',
      steps: [
        { kind: 'generate', template: '{prompt}. icon', aspectRatio: '1:1', imageSize: '1K', engine: 'auto', steps: 2 },
        { kind: 'remove-bg', trim: true },
        { kind: 'sizes', sizes: [{ width: 200, height: 200 }, { width: 450, height: 450 }], padding: 6 },
      ],
    });
    graph.nodes.find((n) => n.type === 'prompts')!.params.lines = 'shield | wooden shield';
    const { out, log } = await run(graph);
    expect(log).toEqual(['gen:auto:wooden shield. icon']);
    expect(out.map((o) => o.name).sort()).toEqual(['shield/200', 'shield/450']);
  });

  it('graph errors: input not connected, no output, two sources', async () => {
    const { graph, bg } = iconsGraph();
    await expect(run({ ...graph, edges: graph.edges.filter((e) => e.to.node !== bg.id) })).rejects.toThrow(/Не подключён вход «Картинка» у ноды «Убрать фон»/);
    await expect(run({ ...graph, nodes: graph.nodes.filter((n) => n.type !== 'page') })).rejects.toThrow(GraphError);
    expect(() => batchItems({ ...graph, nodes: [...graph.nodes, node('prompts', 0)] }, BUILTIN_MAP, new Map(), 'x')).toThrow(/Источник пакета должен быть один/);
  });

  it('path along the wires — to prevent cycles', () => {
    const { graph, gen, fit200 } = iconsGraph();
    expect(reaches(graph.edges, gen.id, fit200.id)).toBe(true);
    expect(reaches(graph.edges, fit200.id, gen.id)).toBe(false);
  });

  it('graph in the file: in the root\'s sharedPluginData, survives a document snapshot, leaves other plugins\' data untouched', () => {
    const doc = new Document();
    doc.set(doc.root, { sharedPluginData: { other: { k: 'v' } } });
    const { graph } = iconsGraph();
    writeFileGraph(doc, graph);
    const copy = Document.fromSnapshot(JSON.parse(JSON.stringify(doc.snapshot())));
    expect(fileGraphs(copy).map((g) => [g.name, g.nodes.length, g.edges.length])).toEqual([['Test', 8, 9]]);
    expect(copy.get(copy.root, 'sharedPluginData')?.other).toEqual({ k: 'v' });
    removeFileGraph(copy, graph.id);
    expect(fileGraphs(copy)).toEqual([]);
  });
});
