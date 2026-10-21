// Components, instances, variant sets and component properties.
//
// An instance (INSTANCE) stores componentId — its main component; its children are real nodes
// with a componentRef link to the corresponding master node. Master edits (properties, added
// and removed nodes, order) are copied into all instances — except properties changed
// manually in the instance (overrides). The copying is derived data: it is part of the undo step of the
// master edit (Document.amend), so undo rolls back the master and the copies together.
//
// A nested instance inside an instance follows its master (componentRef). A swapped one
// (its componentId differs from the master's: instance swap, the “Instance swap” property) takes
// its content and styling from the new component, and its position and layout participation from the master.
//
// Component properties (componentPropertyDefinitions on a variant set or a component):
// nodes inside the component reference them (componentPropertyReferences — visibility, text,
// nested component). Values live on the instance (componentProperties); variant values —
// in the name of its component (“Size=L, State=Hover”); the component itself holds the defaults.

import type { Document } from './document.ts';
import type { ComponentPropertyDefinition, NodeRecord, Op, Props, TextRun } from './types.ts';

/** Instance root properties not taken from the master: position, name, participation in the parent's layout, its own property values. */
export const ROOT_OWN = new Set([
  'transform',
  'name',
  'componentId',
  'overrides',
  'componentRef',
  'layoutGrow',
  'layoutAlign',
  'layoutPositioning',
  'visible',
  'locked',
  'componentProperties',
  // Links of a nested instance to the outer component's properties are its own, not its component's.
  'componentPropertyReferences',
  'isExposedInstance',
  'exposedProperties',
]);

/**
 * Properties of an exposed nested instance to show, in order: the selected ones
 * (exposedProperties) or all. keys — its component's property keys in definition order.
 */
export function exposedPropertyKeys(doc: Document, nested: string, keys: readonly string[]): string[] {
  const chosen = doc.get(nested, 'exposedProperties');
  return chosen ? chosen.filter((k) => keys.includes(k)) : [...keys];
}
/** Properties of the main component only (instances do not have them; dev links are per layer). */
export const COMPONENT_ONLY = new Set(['componentPropertyDefinitions', 'description', 'key', 'devResources']);
/** Internal properties: not copied and not counted as overrides. */
const SERVICE = new Set(['componentRef', 'overrides', 'clipboardSource']);
/** Derived properties (adjusted automatically) are not overrides. */
const DERIVED = new Set(['geometrySize']);

type Values = Record<string, string | boolean>;

/** Stored node properties (without defaults). */
const stored = (doc: Document, id: string): Record<string, unknown> => (doc.node(id)?.props ?? {}) as Record<string, unknown>;

export function isInstanceNode(doc: Document, id: string): boolean {
  return doc.type(id) === 'INSTANCE' || !!doc.get(id, 'componentRef');
}

/** The nearest instance ancestor (or the node itself), otherwise null. */
export function instanceRoot(doc: Document, id: string): string | null {
  for (let cur: string | null = id; cur; cur = doc.parent(cur)) if (doc.type(cur) === 'INSTANCE') return cur;
  return null;
}

/** The outermost instance containing the node (or the node itself), otherwise null. */
export function outermostInstance(doc: Document, id: string): string | null {
  let out: string | null = null;
  for (let cur: string | null = id; cur; cur = doc.parent(cur)) if (doc.type(cur) === 'INSTANCE') out = cur;
  return out;
}

/** Slot: a frame inside a component whose content can be changed in an instance. */
export function isSlot(doc: Document, id: string): boolean {
  return !!doc.get(id, 'componentPropertyReferences')?.slot;
}

/** Whether layers can be placed into the node: inside an instance — only into slots. */
export function acceptsChildren(doc: Document, id: string): boolean {
  if (doc.type(id) === 'INSTANCE') return false;
  if (doc.get(id, 'componentRef')) return isSlot(doc, id);
  return true;
}

/** The nested instance copy is swapped: its component differs from the master node's. */
export function isSwapped(doc: Document, id: string): boolean {
  if (doc.type(id) !== 'INSTANCE') return false;
  const ref = doc.get(id, 'componentRef');
  return !!ref && doc.has(ref) && doc.get(ref, 'componentId') !== doc.get(id, 'componentId');
}

/** Master node properties for a new copy under an instance. */
function copyOf(doc: Document, master: string): Props {
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored(doc, master))) if (v !== undefined && !SERVICE.has(k) && !COMPONENT_ONLY.has(k)) p[k] = v;
  p.componentRef = master;
  return p as Props;
}

/** Copies of the master's children (as subtrees) under node into. */
function copyChildren(doc: Document, master: string, into: string) {
  for (const c of doc.children(master)) {
    const id = doc.create(doc.type(c)!, into, copyOf(doc, c));
    copyChildren(doc, c, id);
  }
}

/** Create an instance of a component: a copy of its subtree with links to the master nodes. */
export function instantiate(doc: Document, componentId: string, parent: string, transform: Props['transform'], index?: number): string {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored(doc, componentId))) if (v !== undefined && !SERVICE.has(k) && !COMPONENT_ONLY.has(k)) props[k] = v;
  props.transform = transform;
  props.componentId = componentId;
  // A variant's instance is named after the set (as in .fig files).
  const set = componentSetOf(doc, componentId);
  if (set) props.name = doc.get(set, 'name');
  const inst = doc.create('INSTANCE', parent, props as Props, index);
  copyChildren(doc, componentId, inst);
  applyComponentProperties(doc, inst);
  return inst;
}

/** Detach an instance: a regular frame; links to the master are removed. */
export function detachInstance(doc: Document, id: string): string {
  const parent = doc.parent(id)!;
  const index = doc.children(parent).indexOf(id);
  const props = { ...stored(doc, id) };
  const from = props.componentId as string | undefined;
  for (const k of [...SERVICE, 'componentId', 'componentProperties']) delete props[k];
  if (from) props.detachedFrom = from;
  const frame = doc.create('FRAME', parent, props as Props, index);
  for (const c of [...doc.children(id)]) doc.move(c, frame);
  const clear = (n: string) => {
    const s = stored(doc, n);
    if (s.componentRef || s.overrides || s.componentPropertyReferences) doc.set(n, { componentRef: undefined, overrides: undefined, componentPropertyReferences: undefined });
    // Nested instances remain instances of their components.
    if (doc.type(n) !== 'INSTANCE') for (const c of doc.children(n)) clear(c);
  };
  for (const c of doc.children(frame)) clear(c);
  doc.delete(id);
  return frame;
}

/**
 * Reset instance overrides: properties match the master again. keys — only these properties
 * (otherwise all, including component property values and nested instance swaps).
 */
export function resetOverrides(doc: Document, id: string, keys?: string[]) {
  const only = keys ? new Set(keys) : null;
  const walk = (n: string) => {
    const isRoot = n === id && !doc.get(n, 'componentRef');
    const master = isRoot ? doc.get(n, 'componentId') : doc.get(n, 'componentRef');
    // A swapped nested instance goes back to the master's component.
    if (!only && !isRoot && master && doc.has(master) && isSwapped(doc, n)) swapComponent(doc, n, doc.get(master, 'componentId')!);
    const own = doc.get(n, 'overrides') ?? [];
    const reset = own.filter((k) => !only || only.has(k));
    // Custom slot content becomes the default content again.
    if (master && doc.has(master) && reset.includes('children')) {
      for (const c of [...doc.children(n)]) doc.delete(c);
      copyChildren(doc, master, n);
    }
    if (master && doc.has(master) && reset.length) {
      const props: Record<string, unknown> = {};
      const rest = own.filter((k) => !reset.includes(k));
      props.overrides = rest.length ? rest : undefined;
      for (const k of reset) if (k !== 'children') props[k] = stored(doc, master)[k];
      doc.set(n, props as Props);
    }
    if (!only && n === id && doc.type(n) === 'INSTANCE' && Object.keys(doc.get(n, 'componentProperties') ?? {}).length) {
      // Property values: the root gets its own (defaults), a nested one — the master's.
      doc.set(n, { componentProperties: isRoot ? undefined : (stored(doc, master!).componentProperties as Values | undefined) });
    }
    for (const c of doc.children(n)) walk(c);
  };
  walk(id);
  applyComponentProperties(doc, id);
}

/**
 * Push instance edits to the main component (“apply to main”): overridden properties of
 * nodes become properties of their master nodes, overrides are removed.
 */
export function pushOverridesToMain(doc: Document, id: string): number {
  let n = 0;
  const walk = (node: string) => {
    const isRoot = node === id && !doc.get(node, 'componentRef');
    const master = isRoot ? doc.get(node, 'componentId') : doc.get(node, 'componentRef');
    const own = doc.get(node, 'overrides') ?? [];
    if (master && doc.has(master) && own.length) {
      const props: Record<string, unknown> = {};
      for (const k of own) if (k !== 'componentId' && (!ROOT_OWN.has(k) || !isRoot)) props[k] = stored(doc, node)[k];
      doc.set(master, props as Props);
      if (own.includes('componentId') && !isRoot) swapComponent(doc, master, doc.get(node, 'componentId')!);
      doc.set(node, { overrides: undefined });
      n += own.length;
    }
    for (const c of doc.children(node)) walk(c);
  };
  walk(id);
  return n;
}

// ---------- Swapping an instance's component ----------

/** Node path inside an instance by names (siblings with the same name get an index). */
function namePaths(doc: Document, root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (n: string, prefix: string) => {
    const seen = new Map<string, number>();
    for (const c of doc.children(n)) {
      const name = doc.get(c, 'name') ?? '';
      const k = seen.get(name) ?? 0;
      seen.set(name, k + 1);
      const path = `${prefix}/${name}${k ? `#${k}` : ''}`;
      out.set(c, path);
      walk(c, path);
    }
  };
  walk(root, '');
  return out;
}

/**
 * Replace the instance's component (variant, instance swap). Edits are preserved
 * on layers with the same name, tree position and type.
 */
export function swapComponent(doc: Document, id: string, componentId: string) {
  if (!doc.has(componentId) || doc.type(componentId) !== 'COMPONENT' || doc.get(id, 'componentId') === componentId) return;
  // A component cannot be placed inside itself.
  for (let p: string | null = id; p; p = doc.parent(p)) if (p === componentId) return;
  const ref = doc.get(id, 'componentRef');
  // A nested instance returns to its master's component — the master copies the content.
  const source = ref && doc.has(ref) && doc.get(ref, 'componentId') === componentId ? ref : componentId;
  // 1. Children's edits, by path.
  const saved = new Map<string, { type: string; props: Record<string, unknown>; keys: string[] }>();
  for (const [n, path] of namePaths(doc, id)) {
    const keys = doc.get(n, 'overrides') ?? [];
    if (!keys.length) continue;
    const props: Record<string, unknown> = {};
    for (const k of keys) props[k] = stored(doc, n)[k];
    saved.set(path, { type: doc.type(n)!, props, keys });
  }
  // 2. New content: root properties from the new source (except own and overridden ones).
  for (const c of [...doc.children(id)]) doc.delete(c);
  const own = new Set(doc.get(id, 'overrides') ?? []);
  const isRoot = !ref;
  const skip = (k: string) => SERVICE.has(k) || COMPONENT_ONLY.has(k) || own.has(k) || (isRoot ? ROOT_OWN.has(k) : ROOT_OWN.has(k) && k !== 'componentId');
  const next: Record<string, unknown> = {};
  const src = stored(doc, source);
  for (const k of Object.keys(stored(doc, id))) if (!skip(k) && !(k in src)) next[k] = undefined;
  for (const [k, v] of Object.entries(src)) if (!skip(k)) next[k] = v;
  next.componentId = componentId;
  // Property values: keep only those the new component has (for variants of a set — shared ones).
  const defs = propertyDefinitions(doc, componentId);
  const values = doc.get(id, 'componentProperties') ?? {};
  const kept = Object.fromEntries(Object.entries(values).filter(([k]) => k in defs));
  if (Object.keys(kept).length !== Object.keys(values).length) next.componentProperties = Object.keys(kept).length ? kept : undefined;
  doc.set(id, next as Props);
  copyChildren(doc, source, id);
  // 3. Edits — back.
  for (const [n, path] of namePaths(doc, id)) {
    const s = saved.get(path);
    if (!s || s.type !== doc.type(n)) continue;
    doc.set(n, { ...s.props, overrides: s.keys } as Props);
  }
  applyComponentProperties(doc, id);
}

// ---------- Variant sets and properties ----------

/** The variant set containing the component (or null). */
export function componentSetOf(doc: Document, componentId: string): string | null {
  const p = doc.parent(componentId);
  return p && doc.type(p) === 'COMPONENT_SET' ? p : null;
}

/** The node holding property definitions: the variant set or the component itself. */
export function definitionsHolder(doc: Document, componentId: string): string {
  return componentSetOf(doc, componentId) ?? componentId;
}

/** Component property definitions (for a variant — its set's). */
export function propertyDefinitions(doc: Document, componentId: string): Record<string, ComponentPropertyDefinition> {
  if (!doc.has(componentId)) return {};
  const holder = doc.type(componentId) === 'COMPONENT_SET' ? componentId : definitionsHolder(doc, componentId);
  return doc.get(holder, 'componentPropertyDefinitions') ?? {};
}

/** Variant values from a name: “Size=L, State=Hover” → { Size: 'L', State: 'Hover' }. */
export function parseVariantName(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of name.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Variant name from values (order as in the set's properties). */
export function variantName(values: Record<string, string>, order: string[] = Object.keys(values)): string {
  const keys = [...order.filter((k) => k in values), ...Object.keys(values).filter((k) => !order.includes(k))];
  return keys.map((k) => `${k}=${values[k]}`).join(', ');
}

/** Variants of a set (child components). */
export function variantsOf(doc: Document, setId: string): string[] {
  return doc.children(setId).filter((c) => doc.type(c) === 'COMPONENT');
}

/** Variant values of a set's component (from its name). */
export function variantValues(doc: Document, componentId: string): Record<string, string> {
  return componentSetOf(doc, componentId) ? parseVariantName(doc.get(componentId, 'name') ?? '') : {};
}

/**
 * The set's variant with these values. If there is no exact one — the closest: the changed ones
 * (prefer) match, plus as many of the rest as possible.
 */
export function findVariant(doc: Document, setId: string, values: Record<string, string>, prefer: string[] = []): string | null {
  let best: string | null = null;
  let score = -1;
  for (const v of variantsOf(doc, setId)) {
    const own = parseVariantName(doc.get(v, 'name') ?? '');
    let s = 0;
    for (const [k, val] of Object.entries(values)) if (own[k] === val) s += prefer.includes(k) ? 1000 : 1;
    if (s > score) [best, score] = [v, s];
  }
  return best;
}

/** Variant definitions of a set, from component names (value order as in the grid). */
export function variantDefinitions(doc: Document, setId: string): Record<string, ComponentPropertyDefinition> {
  const defs: Record<string, ComponentPropertyDefinition> = {};
  for (const v of variantsOf(doc, setId)) {
    for (const [k, val] of Object.entries(parseVariantName(doc.get(v, 'name') ?? ''))) {
      const d = (defs[k] ??= { type: 'VARIANT', defaultValue: val, variantOptions: [] });
      if (!d.variantOptions!.includes(val)) d.variantOptions!.push(val);
    }
  }
  return defs;
}

/** Update a set's variant properties from its component names (other properties are untouched). */
export function syncVariantDefinitions(doc: Document, setId: string) {
  const old = doc.get(setId, 'componentPropertyDefinitions') ?? {};
  const fresh = variantDefinitions(doc, setId);
  const next: Record<string, ComponentPropertyDefinition> = {};
  // Order: previous variants, new variants, then the remaining properties.
  for (const [k, d] of Object.entries(old)) {
    if (d.type !== 'VARIANT') continue;
    const f = fresh[k];
    if (!f) continue;
    // Value order is kept, new ones go to the end; the default value stays if it still exists.
    const options = [...(d.variantOptions ?? []).filter((o) => f.variantOptions!.includes(o)), ...f.variantOptions!.filter((o) => !(d.variantOptions ?? []).includes(o))];
    next[k] = { ...d, variantOptions: options, defaultValue: options.includes(String(d.defaultValue)) ? d.defaultValue : options[0]! };
  }
  for (const [k, f] of Object.entries(fresh)) if (!next[k]) next[k] = f;
  for (const [k, d] of Object.entries(old)) if (d.type !== 'VARIANT') next[k] = d;
  if (JSON.stringify(next) !== JSON.stringify(old)) doc.set(setId, { componentPropertyDefinitions: next });
}

/** The node field that a component property controls: the field's value on the node. */
function fieldValue(doc: Document, id: string, field: 'visible' | 'characters' | 'mainComponent'): string | boolean | undefined {
  if (field === 'visible') return doc.get(id, 'visible') !== false;
  if (field === 'characters') return doc.type(id) === 'TEXT' ? (doc.get(id, 'characters') ?? '') : undefined;
  return doc.type(id) === 'INSTANCE' ? doc.get(id, 'componentId') : undefined;
}

const REF_FIELDS = ['visible', 'characters', 'mainComponent'] as const;

/** Nodes inside the owner (instance or component) bound to its properties; nested instances themselves, without their children. */
function boundNodes(doc: Document, owner: string): string[] {
  const out: string[] = [];
  const walk = (n: string) => {
    for (const c of doc.children(n)) {
      const refs = doc.get(c, 'componentPropertyReferences');
      if (refs && Object.keys(refs).length) out.push(c);
      const t = doc.type(c);
      if (t !== 'INSTANCE' && t !== 'COMPONENT' && t !== 'COMPONENT_SET') walk(c);
    }
  };
  walk(owner);
  return out;
}

/**
 * Instance property values: variants from its component; set ones are its own; unset ones are
 * taken from the bound layer (the master may show its own for each variant), otherwise the default.
 */
export function instancePropertyValues(doc: Document, instanceId: string): Values {
  const comp = doc.get(instanceId, 'componentId');
  if (!comp || !doc.has(comp)) return {};
  const defs = propertyDefinitions(doc, comp);
  const own = doc.get(instanceId, 'componentProperties') ?? {};
  const variant = variantValues(doc, comp);
  const shown: Values = {};
  for (const n of boundNodes(doc, instanceId)) {
    const refs = doc.get(n, 'componentPropertyReferences')!;
    for (const f of REF_FIELDS) {
      const k = refs[f];
      if (!k || k in shown) continue;
      const v = fieldValue(doc, n, f);
      if (v !== undefined) shown[k] = v;
    }
  }
  const out: Values = {};
  for (const [k, d] of Object.entries(defs)) {
    if (d.type === 'SLOT') continue;
    if (d.type === 'VARIANT') out[k] = variant[k] ?? d.defaultValue;
    else out[k] = k in own ? own[k]! : (shown[k] ?? d.defaultValue);
  }
  return out;
}

/** Property key by name (boolean, text and swap keys are “name#id”). */
export function propertyKey(defs: Record<string, ComponentPropertyDefinition>, nameOrKey: string): string | null {
  if (nameOrKey in defs) return nameOrKey;
  for (const k of Object.keys(defs)) if (k.split('#')[0] === nameOrKey) return k;
  return null;
}

/** Owner of the properties the node references: the nearest instance or component above the node. */
export function propertyOwner(doc: Document, id: string): string | null {
  for (let p = doc.parent(id); p; p = doc.parent(p)) {
    const t = doc.type(p);
    if (t === 'INSTANCE' || t === 'COMPONENT') return p;
    if (t === 'PAGE' || t === 'DOCUMENT' || t === 'COMPONENT_SET') return null;
  }
  return null;
}

/** Replace a node's text keeping its styling (runs are trimmed or extended with the node's styling). */
function setCharacters(doc: Document, id: string, text: string) {
  const runs = doc.get(id, 'textRuns');
  const props: Props = { characters: text, textGlyphs: undefined };
  if (runs?.length) {
    let left = text.length;
    const next: TextRun[] = [];
    for (const r of runs) {
      if (left <= 0) break;
      next.push({ ...r, length: Math.min(r.length, left) });
      left -= r.length;
    }
    props.textRuns = next;
  }
  doc.set(id, props);
}

/** Write a property value into the node field (if it differs). */
function writeField(doc: Document, id: string, field: 'visible' | 'characters' | 'mainComponent', value: string | boolean) {
  if (field === 'visible') {
    const v = value === true || value === 'true';
    if (doc.get(id, 'visible') !== v) doc.set(id, { visible: v });
  } else if (field === 'characters') {
    const v = String(value);
    if (doc.type(id) === 'TEXT' && doc.get(id, 'characters') !== v) setCharacters(doc, id, v);
  } else {
    const v = String(value);
    if (doc.type(id) === 'INSTANCE' && v && doc.has(v) && doc.type(v) === 'COMPONENT' && doc.get(id, 'componentId') !== v) swapComponent(doc, id, v);
  }
}

/**
 * Property values go into the bound layers. For an instance: set ones are its own, unset ones match the master
 * node (each variant has its own). For a component — the default values (keys — only these
 * properties; called when a default value is edited).
 */
export function applyComponentProperties(doc: Document, owner: string, keys?: Iterable<string>) {
  if (!doc.has(owner)) return;
  const isInstance = doc.type(owner) === 'INSTANCE';
  const only = keys ? new Set(keys) : null;
  let values: Values;
  if (isInstance) values = doc.get(owner, 'componentProperties') ?? {};
  else {
    values = {};
    for (const [k, d] of Object.entries(propertyDefinitions(doc, owner))) if (d.type !== 'VARIANT' && d.type !== 'SLOT' && (!only || only.has(k))) values[k] = d.defaultValue;
    if (!Object.keys(values).length) return;
  }
  for (const n of boundNodes(doc, owner)) {
    const refs = doc.get(n, 'componentPropertyReferences')!;
    for (const f of REF_FIELDS) {
      const k = refs[f];
      if (!k || (only && !only.has(k))) continue;
      if (k in values) writeField(doc, n, f, values[k]!);
      else if (isInstance) {
        // Not set — same as the master node.
        const master = doc.get(n, 'componentRef');
        const v = master && doc.has(master) ? fieldValue(doc, master, f) : undefined;
        if (v !== undefined) writeField(doc, n, f, v);
      }
    }
  }
}

/**
 * Set instance properties (like setProperties in the Plugin API). The key is “name#id” or the name;
 * variant values switch the instance's component to the matching variant of the set.
 */
export function setInstanceProperties(doc: Document, id: string, values: Record<string, string | boolean>) {
  const comp = doc.get(id, 'componentId');
  if (!comp || !doc.has(comp)) throw new Error('У инстанса нет компонента');
  const defs = propertyDefinitions(doc, comp);
  const variant: Record<string, string> = {};
  const own: Values = { ...(doc.get(id, 'componentProperties') ?? {}) };
  for (const [name, v] of Object.entries(values)) {
    const key = propertyKey(defs, name);
    if (!key) throw new Error(`Нет свойства «${name}»`);
    const d = defs[key]!;
    if (d.type === 'VARIANT') variant[key] = String(v);
    else if (d.type === 'BOOLEAN') own[key] = v === true || v === 'true';
    else own[key] = String(v);
  }
  if (Object.keys(variant).length) {
    const set = componentSetOf(doc, comp);
    if (set) {
      const target = findVariant(doc, set, { ...variantValues(doc, comp), ...variant }, Object.keys(variant));
      if (target && target !== comp) swapComponent(doc, id, target);
    }
  }
  doc.set(id, { componentProperties: Object.keys(own).length ? own : undefined });
  applyComponentProperties(doc, id);
}

/** New property key “name#id” (id is unique in the document). */
function newPropertyKey(doc: Document, name: string): string {
  return `${name}#${doc.newId()}`;
}

/** Add a property to a component or set (like addComponentProperty in the Plugin API); return the key. */
export function addComponentProperty(
  doc: Document,
  holder: string,
  name: string,
  type: ComponentPropertyDefinition['type'],
  defaultValue: string | boolean,
  opts: { preferredValues?: string[] } = {},
): string {
  const t = doc.type(holder);
  if (t !== 'COMPONENT' && t !== 'COMPONENT_SET') throw new Error('Свойства бывают у компонента или набора вариантов');
  if (t === 'COMPONENT' && componentSetOf(doc, holder)) holder = componentSetOf(doc, holder)!;
  if (type === 'VARIANT') {
    // A variant goes into the set's component names; the definition is recomputed from the names.
    if (doc.type(holder) !== 'COMPONENT_SET') throw new Error('Свойство-вариант бывает только у набора вариантов');
    for (const v of variantsOf(doc, holder)) {
      const vals = parseVariantName(doc.get(v, 'name') ?? '');
      if (!(name in vals)) doc.set(v, { name: variantName({ ...vals, [name]: String(defaultValue) }) });
    }
    syncVariantDefinitions(doc, holder);
    return name;
  }
  const key = newPropertyKey(doc, name);
  const defs = { ...(doc.get(holder, 'componentPropertyDefinitions') ?? {}) };
  defs[key] = { type, defaultValue: type === 'BOOLEAN' ? defaultValue === true || defaultValue === 'true' : String(defaultValue), ...(opts.preferredValues ? { preferredValues: opts.preferredValues } : {}) };
  doc.set(holder, { componentPropertyDefinitions: defs });
  return key;
}

/** Component nodes the holder's definitions apply to (the component itself or all variants of the set). */
function componentsOf(doc: Document, holder: string): string[] {
  return doc.type(holder) === 'COMPONENT_SET' ? variantsOf(doc, holder) : [holder];
}

/** Instances of the holder's components across the whole document. */
function instancesOf(doc: Document, holder: string): string[] {
  const comps = new Set(componentsOf(doc, holder));
  const out: string[] = [];
  for (const id of doc.descendants(doc.root)) if (doc.type(id) === 'INSTANCE' && comps.has(doc.get(id, 'componentId') ?? '')) out.push(id);
  return out;
}

/** Rename a property key in component node references and instance values. */
function renameKey(doc: Document, holder: string, from: string, to: string | null) {
  for (const c of componentsOf(doc, holder)) {
    for (const n of doc.descendants(c)) {
      const refs = doc.get(n, 'componentPropertyReferences');
      if (!refs) continue;
      let changed = false;
      const next: Record<string, string | undefined> = { ...refs };
      for (const [f, k] of Object.entries(refs)) {
        if (k !== from) continue;
        next[f] = to ?? undefined;
        changed = true;
      }
      if (changed) doc.set(n, { componentPropertyReferences: Object.fromEntries(Object.entries(next).filter(([, v]) => v)) });
    }
  }
  for (const inst of instancesOf(doc, holder)) {
    const vals = doc.get(inst, 'componentProperties');
    if (!vals || !(from in vals)) continue;
    const next = { ...vals };
    const v = next[from]!;
    delete next[from];
    if (to) next[to] = v;
    doc.set(inst, { componentProperties: Object.keys(next).length ? next : undefined });
  }
}

/** Change a property (name, default value, preferred values); return the key (a new one if renamed). */
export function editComponentProperty(doc: Document, holder: string, key: string, patch: { name?: string; defaultValue?: string | boolean; preferredValues?: string[] }): string {
  if (doc.type(holder) === 'COMPONENT' && componentSetOf(doc, holder)) holder = componentSetOf(doc, holder)!;
  const defs = { ...(doc.get(holder, 'componentPropertyDefinitions') ?? {}) };
  const d = defs[key];
  if (!d) throw new Error(`Нет свойства «${key}»`);
  if (d.type === 'VARIANT') {
    // The variant name and default value go into component names and the definition.
    if (patch.name && patch.name !== key) {
      for (const v of variantsOf(doc, holder)) {
        const vals = parseVariantName(doc.get(v, 'name') ?? '');
        if (!(key in vals)) continue;
        const next: Record<string, string> = {};
        for (const [k, val] of Object.entries(vals)) next[k === key ? patch.name : k] = val;
        doc.set(v, { name: variantName(next) });
      }
      const renamed: typeof defs = {};
      for (const [k, def] of Object.entries(defs)) renamed[k === key ? patch.name : k] = def;
      doc.set(holder, { componentPropertyDefinitions: renamed });
      key = patch.name;
    }
    if (patch.defaultValue !== undefined) {
      const cur = doc.get(holder, 'componentPropertyDefinitions')!;
      doc.set(holder, { componentPropertyDefinitions: { ...cur, [key]: { ...cur[key]!, defaultValue: String(patch.defaultValue) } } });
    }
    return key;
  }
  let next = { ...d };
  if (patch.defaultValue !== undefined) next.defaultValue = d.type === 'BOOLEAN' ? patch.defaultValue === true || patch.defaultValue === 'true' : String(patch.defaultValue);
  if (patch.preferredValues) next = { ...next, preferredValues: patch.preferredValues };
  let newKey = key;
  if (patch.name && patch.name !== key.split('#')[0]) newKey = `${patch.name}#${key.split('#').slice(1).join('#') || doc.newId()}`;
  const out: typeof defs = {};
  for (const [k, def] of Object.entries(defs)) out[k === key ? newKey : k] = k === key ? next : def;
  doc.set(holder, { componentPropertyDefinitions: out });
  if (newKey !== key) renameKey(doc, holder, key, newKey);
  if (patch.defaultValue !== undefined) for (const c of componentsOf(doc, holder)) applyComponentProperties(doc, c, [newKey]);
  for (const inst of instancesOf(doc, holder)) applyComponentProperties(doc, inst, [newKey]);
  return newKey;
}

/** Delete a property: node references and instance values are removed (a variant — from component names). */
export function deleteComponentProperty(doc: Document, holder: string, key: string) {
  if (doc.type(holder) === 'COMPONENT' && componentSetOf(doc, holder)) holder = componentSetOf(doc, holder)!;
  const defs = { ...(doc.get(holder, 'componentPropertyDefinitions') ?? {}) };
  const d = defs[key];
  if (!d) return;
  delete defs[key];
  doc.set(holder, { componentPropertyDefinitions: defs });
  if (d.type === 'VARIANT') {
    for (const v of variantsOf(doc, holder)) {
      const vals = parseVariantName(doc.get(v, 'name') ?? '');
      delete vals[key];
      doc.set(v, { name: variantName(vals) || 'Default' });
    }
    return;
  }
  renameKey(doc, holder, key, null);
}

/** Bind a node field inside a component to a property (null — unbind). */
export function setPropertyReference(doc: Document, id: string, field: 'visible' | 'characters' | 'mainComponent' | 'slot', key: string | null) {
  const refs = { ...(doc.get(id, 'componentPropertyReferences') ?? {}) } as Record<string, string>;
  if (key) refs[field] = key;
  else delete refs[field];
  doc.set(id, { componentPropertyReferences: Object.keys(refs).length ? refs : undefined });
  const owner = propertyOwner(doc, id);
  if (owner && key) applyComponentProperties(doc, owner, [key]);
}

/**
 * Combine components into a variant set (like combineAsVariants). Names without “=” become
 * “Property 1=…”. The set fits the components' bounds; the components inside keep their position on the canvas.
 */
export function combineAsVariants(doc: Document, components: string[], parent: string, index?: number): string {
  const comps = components.filter((c) => doc.type(c) === 'COMPONENT');
  if (!comps.length) throw new Error('Нужны компоненты');
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of comps) {
    const t = doc.get(c, 'transform') ?? [1, 0, 0, 0, 1, 0];
    x0 = Math.min(x0, t[2]);
    y0 = Math.min(y0, t[5]);
    x1 = Math.max(x1, t[2] + (doc.get(c, 'width') ?? 0));
    y1 = Math.max(y1, t[5] + (doc.get(c, 'height') ?? 0));
  }
  const pad = 20;
  const set = doc.create(
    'COMPONENT_SET',
    parent,
    {
      name: doc.get(comps[0]!, 'name')?.includes('=') ? 'Component Set' : (doc.get(comps[0]!, 'name') ?? 'Component Set'),
      transform: [1, 0, x0 - pad, 0, 1, y0 - pad],
      width: x1 - x0 + pad * 2,
      height: y1 - y0 + pad * 2,
      strokes: [{ type: 'SOLID', color: { r: 0.592, g: 0.278, b: 1 } }],
      strokeWeight: 1,
      dashPattern: [10, 5],
      cornerRadius: 5,
    },
    index,
  );
  let n = 0;
  for (const c of comps) {
    const t = doc.get(c, 'transform') ?? [1, 0, 0, 0, 1, 0];
    doc.move(c, set);
    doc.set(c, { transform: [t[0], t[1], t[2] - (x0 - pad), t[3], t[4], t[5] - (y0 - pad)] });
    const name = doc.get(c, 'name') ?? '';
    if (!name.includes('=')) doc.set(c, { name: `Property 1=${n++ ? `Variant${n}` : 'Default'}` });
  }
  syncVariantDefinitions(doc, set);
  return set;
}

/**
 * “Master → copies” links and edit propagation. The index is built once per document
 * and maintained through operations; stale entries are filtered out on use.
 */
export class ComponentSync {
  private doc: Document;
  /** master node (or component) → copy nodes (or instances). */
  private copies = new Map<string, Set<string>>();

  constructor(doc: Document) {
    this.doc = doc;
    for (const id of doc.descendants(doc.root)) this.index(id);
  }

  private add(master: string, id: string) {
    let set = this.copies.get(master);
    if (!set) this.copies.set(master, (set = new Set()));
    set.add(id);
  }

  private index(id: string) {
    const ref = this.doc.get(id, 'componentRef');
    if (ref) this.add(ref, id);
    if (this.doc.type(id) === 'INSTANCE') {
      const c = this.doc.get(id, 'componentId');
      if (c) this.add(c, id);
    }
  }

  /**
   * Copies of node master. props — whom to take properties from (swapped nested instances take
   * their own properties from the new component, position from the master), otherwise structure (children).
   */
  private copiesOf(master: string, purpose: 'props' | 'structure'): string[] {
    const set = this.copies.get(master);
    if (!set) return [];
    const doc = this.doc;
    const out: string[] = [];
    for (const id of set) {
      if (!doc.has(id)) {
        set.delete(id);
        continue;
      }
      const ref = doc.get(id, 'componentRef');
      const comp = doc.type(id) === 'INSTANCE' ? doc.get(id, 'componentId') : undefined;
      if (ref !== master && comp !== master) {
        set.delete(id);
        continue;
      }
      const swapped = isSwapped(doc, id);
      // Via the master link: properties always (for a swapped one only position), structure if not swapped.
      if (ref === master && (purpose === 'props' || !swapped)) out.push(id);
      // Via the component: instance roots and swapped nested ones.
      else if (comp === master && (!ref || swapped)) out.push(id);
    }
    return out;
  }

  /** Whether the node has copies (it is part of a master that has instances). */
  hasCopies(id: string): boolean {
    return this.copiesOf(id, 'props').length > 0;
  }

  /** Instances of the component that take properties from it directly (roots and swapped nested ones). */
  instancesOf(componentId: string): string[] {
    return this.copiesOf(componentId, 'props').filter((id) => this.doc.type(id) === 'INSTANCE' && this.doc.get(id, 'componentId') === componentId);
  }

  /** Update the index from applied operations (created nodes and changed links). */
  observe(ops: Op[]) {
    for (const o of ops) {
      if (o.op === 'create' && (o.props.componentRef || o.type === 'INSTANCE')) this.index(o.id);
      else if (o.op === 'set' && ('componentRef' in o.props || 'componentId' in o.props) && this.doc.has(o.id)) this.index(o.id);
    }
  }

  /**
   * A local edit inside an instance is an override: the master will no longer overwrite it.
   * filter — which of the node's changed properties count as overrides (and what to add to them).
   */
  trackOverrides(ops: Op[], filter?: (id: string, keys: string[]) => string[]) {
    const doc = this.doc;
    const add = new Map<string, Set<string>>();
    for (const o of ops) {
      if (o.op !== 'set' || !doc.has(o.id)) continue;
      const ref = doc.get(o.id, 'componentRef');
      const isRoot = doc.type(o.id) === 'INSTANCE' && !ref;
      if (!isRoot && !ref) continue;
      // Swapping a component (swapComponent) writes the new component's properties together with componentId — these are
      // not edits: for the root — nothing, for a nested one — only the swap itself.
      let keys = 'componentId' in o.props ? (isRoot ? [] : ['componentId']) : Object.keys(o.props).filter((k) => !SERVICE.has(k) && !DERIVED.has(k) && !(isRoot && ROOT_OWN.has(k)));
      if (filter) keys = filter(o.id, keys);
      if (!keys.length) continue;
      let s = add.get(o.id);
      if (!s) add.set(o.id, (s = new Set()));
      for (const k of keys) s.add(k);
    }
    for (const [id, keys] of add) {
      const old = doc.get(id, 'overrides') ?? [];
      const next = [...new Set([...old, ...keys])];
      if (next.length !== old.length) doc.set(id, { overrides: next });
    }
  }

  /** Propagate master edits to copies (call inside a transaction). */
  propagate(ops: Op[]) {
    const doc = this.doc;
    for (const o of ops) {
      if (o.op === 'blob') continue;
      if (o.op === 'set') {
        if (!doc.has(o.id)) continue;
        const targets = this.copiesOf(o.id, 'props');
        if (!targets.length) continue;
        const fromComponent = doc.type(o.id) === 'COMPONENT';
        for (const t of targets) {
          const overridden = new Set(doc.get(t, 'overrides') ?? []);
          const viaRef = doc.get(t, 'componentRef') === o.id;
          // A nested instance swap in the master becomes a swap in copies that did not swap it themselves.
          if (viaRef && 'componentId' in o.props && !overridden.has('componentId') && doc.type(t) === 'INSTANCE') swapComponent(doc, t, o.props.componentId as string);
          // A swapped nested instance takes only position and layout participation from the master node.
          const placeOnly = !fromComponent && viaRef && isSwapped(doc, t);
          const props: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(o.props)) {
            if (SERVICE.has(k) || overridden.has(k) || k === 'componentId') continue;
            if (fromComponent && (ROOT_OWN.has(k) || COMPONENT_ONLY.has(k))) continue;
            if (placeOnly && (!ROOT_OWN.has(k) || k === 'componentProperties')) continue;
            props[k] = v;
          }
          if (Object.keys(props).length) doc.set(t, props as Props);
        }
      } else if (o.op === 'create') {
        // A new node in the master goes into every copy of its parent, at the same position.
        if (!doc.has(o.id) || !o.parent) continue;
        // Slots with custom content (a “children” edit in the instance) are left alone.
        const parents = this.copiesOf(o.parent, 'structure').filter((p) => !doc.get(p, 'overrides')?.includes('children'));
        if (!parents.length) continue;
        const index = doc.children(o.parent).indexOf(o.id);
        for (const p of parents) {
          // Already copied (a component swap copies the children itself).
          if (doc.children(p).some((c) => doc.get(c, 'componentRef') === o.id)) continue;
          const id = doc.create(doc.type(o.id)!, p, copyOf(doc, o.id), Math.min(index, doc.children(p).length));
          copyChildren(doc, o.id, id);
          this.index(id);
          for (const d of doc.descendants(id)) this.index(d);
        }
      } else if (o.op === 'delete') {
        for (const t of this.copiesOf(o.id, 'structure')) {
          const tp = doc.parent(t);
          if (doc.get(t, 'componentRef') === o.id && !(tp && doc.get(tp, 'overrides')?.includes('children'))) doc.delete(t);
        }
      } else if (o.op === 'move') {
        // A reorder inside the master is mirrored in the copies (in the corresponding parent).
        if (!doc.has(o.id)) continue;
        const index = doc.children(o.parent).indexOf(o.id);
        const parents = new Set(this.copiesOf(o.parent, 'structure'));
        for (const t of this.copiesOf(o.id, 'structure')) {
          if (doc.get(t, 'componentRef') !== o.id) continue;
          const tp = doc.parent(t);
          if (tp && parents.has(tp)) doc.move(t, tp, index);
        }
      }
    }
  }
}

/** Remove master links from subtree copies (pasting part of an instance outside it). */
export function stripRefs(tree: NodeRecord[]) {
  for (const rec of tree) {
    delete (rec.props as Record<string, unknown>).componentRef;
    delete (rec.props as Record<string, unknown>).overrides;
  }
}
