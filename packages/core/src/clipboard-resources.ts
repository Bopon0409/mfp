import type { Document } from './document.ts';
import type { NodeRecord, Props } from './types.ts';
import { propertyDefinitions } from './components.ts';
import { patternReferences } from './patterns.ts';
import { STYLE_FIELD_NAMES, resourcesPage } from './styles.ts';
import { hashString } from './hash.ts';

export interface ClipboardResources {
  nodes: NodeRecord[];
  aliases: Record<string, string>;
  swapProperties: Record<string, string[]>;
}

/** Detach an extracted instance fragment, preserving instances nested in a copied frame. */
export function prepareClipboardTree(source: readonly NodeRecord[]): NodeRecord[] {
  const tree = structuredClone([...source]);
  const instanceBranch = new Set<string>();
  for (const rec of tree) {
    const inside = !!rec.parent && instanceBranch.has(rec.parent);
    if (!inside) {
      delete rec.props.componentRef;
      if (rec.type !== 'INSTANCE') delete rec.props.overrides;
    }
    if (inside || rec.type === 'INSTANCE') instanceBranch.add(rec.id);
    delete rec.props.clipboardSource;
    delete rec.props.preservedPatternSource;
  }
  return tree;
}

/** Freeze the dependency closure at Copy time, not when the destination is opened. */
export function collectClipboardResources(doc: Document, trees: readonly (readonly NodeRecord[])[]): ClipboardResources {
  const visible = new Set(trees.flatMap(t => t.map(n => n.id)));
  const nodes = new Map<string, NodeRecord>();
  const queue = trees.flatMap(t => [...t]);
  const aliases: Record<string, string> = {};
  const swapProperties: Record<string, string[]> = {};
  const add = (id: string, child = false) => {
    if ((!child && visible.has(id)) || nodes.has(id) || !doc.has(id)) return;
    const n = structuredClone(doc.node(id)!) as NodeRecord;
    nodes.set(id, n); queue.push(n);
    // A separately selected child still needs its own copy inside an external master.
    for (const child of doc.children(id)) add(child, true);
  };
  const resource = (id: string | undefined) => {
    if (!id || !doc.has(id)) return;
    const parent = doc.parent(id);
    if (doc.type(id) === 'COMPONENT' && parent && doc.type(parent) === 'COMPONENT_SET') add(parent);
    else if (doc.type(id) === 'VARIABLE' && parent) add(parent);
    else add(id);
  };
  const scan = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(scan); return; }
    const obj = v as Record<string, unknown>;
    if (obj.type === 'UNSUPPORTED_FIGMA') return;
    if (obj.type === 'VARIABLE_ALIAS' && typeof obj.id === 'string') resource(obj.id);
    if (obj.type === 'SET_VARIABLE' && typeof obj.variableId === 'string') resource(obj.variableId);
    if (obj.type === 'SET_VARIABLE_MODE' && typeof obj.variableCollectionId === 'string') resource(obj.variableCollectionId);
    for (const field of STYLE_FIELD_NAMES) if (typeof obj[field] === 'string') resource(obj[field] as string);
    for (const [k, value] of Object.entries(obj)) if (k !== 'raw' && k !== 'definition' && k !== 'figma') scan(value);
  };
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!, p = n.props;
    resource(p.componentId);
    resource(p.extendsCollection);
    for (const id of Object.keys(p.explicitVariableModes ?? {})) resource(id);
    scan(p);
    for (const def of Object.values(p.componentPropertyDefinitions ?? {})) {
      if (def.type === 'INSTANCE_SWAP' && typeof def.defaultValue === 'string') resource(def.defaultValue);
      for (const id of def.preferredValues ?? []) resource(id);
    }
    if (p.componentId) {
      const keys = Object.entries(propertyDefinitions(doc, p.componentId)).filter(([, d]) => d.type === 'INSTANCE_SWAP').map(([key]) => key);
      swapProperties[n.id] = keys;
      for (const key of keys) { const id = p.componentProperties?.[key]; if (typeof id === 'string') resource(id); }
    }
    for (const ref of patternReferences(p)) {
      const actual = doc.patternSourceNode(ref);
      if (actual) { aliases[ref] = actual; add(actual); }
    }
  }
  return { nodes: [...nodes.values()], aliases, swapProperties };
}

/** Rewrite typed references only: user text, shader source and opaque effects stay literal. */
export function remapClipboardProps(props: Props, map: ReadonlyMap<string, string>, swaps: readonly string[] = []): Props {
  const ref = (id: string) => map.get(id) ?? id;
  const scan = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(scan);
    const obj = v as Record<string, unknown>;
    if (obj.type === 'UNSUPPORTED_FIGMA') return structuredClone(obj);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(obj)) {
      if (k === 'raw' || k === 'definition' || k === 'figma') out[k] = structuredClone(x);
      else if (typeof x === 'string' && (STYLE_FIELD_NAMES.includes(k as typeof STYLE_FIELD_NAMES[number]) || (k === 'id' && obj.type === 'VARIABLE_ALIAS') || (k === 'sourceNodeId' && obj.type === 'PATTERN') || (k === 'variableId' && obj.type === 'SET_VARIABLE') || (['variableCollectionId', 'variableModeId'].includes(k) && obj.type === 'SET_VARIABLE_MODE') || (k === 'destinationId' && ['NODE', 'UPDATE_MEDIA_RUNTIME'].includes(String(obj.type))))) out[k] = ref(x);
      else out[k] = scan(x);
    }
    return out;
  };
  const out = scan(props) as Props;
  for (const key of ['componentId', 'componentRef', 'detachedFrom', 'extendsCollection', 'defaultModeId'] as const) if (props[key]) out[key] = ref(props[key]);
  if (props.modes) out.modes = props.modes.map(m => ({ ...m, modeId: ref(m.modeId), ...(m.parentModeId ? { parentModeId: ref(m.parentModeId) } : {}) }));
  if (props.valuesByMode) out.valuesByMode = Object.fromEntries(Object.entries(props.valuesByMode).map(([id, v]) => [ref(id), scan(v)])) as Props['valuesByMode'];
  if (props.explicitVariableModes) out.explicitVariableModes = Object.fromEntries(Object.entries(props.explicitVariableModes).map(([id, mode]) => [ref(id), ref(mode)]));
  if (props.variableOverrides) out.variableOverrides = Object.fromEntries(Object.entries(props.variableOverrides).map(([id, modes]) => [ref(id), Object.fromEntries(Object.entries(modes).map(([mode, v]) => [ref(mode), scan(v)]))])) as Props['variableOverrides'];
  if (out.componentPropertyDefinitions) for (const def of Object.values(out.componentPropertyDefinitions)) {
    if (def.type === 'INSTANCE_SWAP' && typeof def.defaultValue === 'string') def.defaultValue = ref(def.defaultValue);
    if (def.preferredValues) def.preferredValues = def.preferredValues.map(ref);
  }
  if (out.componentProperties) for (const key of swaps) { const id = out.componentProperties[key]; if (typeof id === 'string') out.componentProperties[key] = ref(id); }
  return out;
}

/** Visible copies must already be in map. Caller owns the single paste transaction. */
export function insertClipboardResources(doc: Document, bundle: ClipboardResources, map: Map<string, string>, origin: string, sameDocument: boolean): void {
  const records = new Map(bundle.nodes.map(n => [n.id, n]));
  // Dependencies own their descendants even if some were separately selected.
  for (const n of bundle.nodes) map.delete(n.id);
  const signature = hashString(JSON.stringify([...bundle.nodes].sort((a, b) => a.id.localeCompare(b.id))));
  const reusable = new Map<string, string>();
  if (!sameDocument && origin) for (const id of doc.descendants(doc.root)) {
    const n = doc.node(id)!;
    const source = n.props.clipboardSource;
    if (source?.origin === origin && source.signature === signature && records.get(source.id)?.type === n.type) reusable.set(source.id, n.id);
  }
  const copied: [string, string][] = [];
  let components: string | undefined, motifs: string | undefined;
  const creating = new Set<string>();
  const create = (id: string): string | undefined => {
    if (map.has(id)) return map.get(id);
    const n = records.get(id);
    if (!n) return undefined;
    const reuse = sameDocument && doc.has(id) ? id : reusable.get(id);
    if (reuse) { map.set(id, reuse); return reuse; }
    if (creating.has(id)) throw new Error('Циклическая структура ресурсов буфера');
    creating.add(id);
    let parent = n.parent && (records.has(n.parent) || map.has(n.parent)) ? create(n.parent) ?? map.get(n.parent) : undefined;
    if (!parent) {
      if (n.type === 'STYLE' || n.type === 'VARIABLE' || n.type === 'VARIABLE_COLLECTION') parent = resourcesPage(doc)!;
      else if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') parent = components ??= doc.children(doc.root).find(p => doc.get(p, 'name') === 'Компоненты из буфера' && !doc.get(p, 'internal')) ?? doc.create('PAGE', doc.root, { name: 'Компоненты из буфера' });
      else parent = motifs ??= doc.children(doc.root).find(p => doc.get(p, 'patternArchive')) ?? doc.create('PAGE', doc.root, { name: 'Источники узоров', internal: true, patternArchive: true });
    }
    const props = structuredClone(n.props);
    delete props.preservedPatternSource;
    delete props.clipboardSource;
    const next = doc.create(n.type, parent, props);
    map.set(id, next); copied.push([id, next]); creating.delete(id);
    return next;
  };
  for (const n of [...bundle.nodes].sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0)) create(n.id);
  for (const n of bundle.nodes) if (n.type === 'VARIABLE_COLLECTION') {
    const next = map.get(n.id)!;
    for (const mode of n.props.modes ?? []) {
      const reused = !copied.some(([from]) => from === n.id);
      const savedMode = doc.get(next, 'clipboardSource')?.modes?.[mode.modeId];
      const targetMode = reused ? doc.get(next, 'modes')?.find(m => m.modeId === (savedMode ?? mode.modeId))?.modeId : undefined;
      map.set(mode.modeId, targetMode ?? (reused ? doc.get(next, 'defaultModeId') ?? mode.modeId : doc.newId()));
    }
  }
  for (const [alias, actual] of Object.entries(bundle.aliases)) if (map.has(actual)) map.set(alias, map.get(actual)!);
  for (const [from, to] of copied) {
    const props = remapClipboardProps(doc.props(to), map, bundle.swapProperties[from]);
    const modes = records.get(from)!.props.modes;
    doc.set(to, { ...props, ...(origin ? { clipboardSource: { origin, signature, id: from, ...(modes ? { modes: Object.fromEntries(modes.map(m => [m.modeId, map.get(m.modeId)!])) } : {}) } } : {}) });
  }
}
