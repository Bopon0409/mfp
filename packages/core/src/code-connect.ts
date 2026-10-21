// Linking components to code (similar to Code Connect): a component or variant set has code
// templates in different languages; an instance's code is produced by substituting its properties: {{Property name}} —
// the value (variant, text, true/false, for a swap — the code or name of the nested component), {{name}} —
// the layer name. Braces are doubled: single ones are part of JSX. Plus a playground: a copy of the component in a separate document where instance properties are changed
// live without touching the file.

import { componentSetOf, instancePropertyValues, instantiate, propertyDefinitions } from './components.ts';
import { Document, blobRefs } from './document.ts';
import type { CodeConnect } from './types.ts';

/** Where the link is stored: variant set, component; for an instance — its component's. */
export function codeConnectHolder(doc: Document, id: string): string | null {
  const t = doc.type(id);
  const comp = t === 'INSTANCE' ? doc.get(id, 'componentId') : t === 'COMPONENT' || t === 'COMPONENT_SET' ? id : null;
  if (!comp || !doc.has(comp)) return null;
  return doc.type(comp) === 'COMPONENT_SET' ? comp : (componentSetOf(doc, comp) ?? comp);
}

export function codeConnectOf(doc: Document, id: string): CodeConnect[] {
  const holder = codeConnectHolder(doc, id);
  return holder ? [...(doc.get(holder, 'codeConnect') ?? [])] : [];
}

/** Template placeholders: property names (without “#id”) and keys. */
export function codeConnectPlaceholders(doc: Document, id: string): string[] {
  const holder = codeConnectHolder(doc, id);
  if (!holder) return ['name'];
  return ['name', ...Object.keys(propertyDefinitions(doc, holder)).map((k) => k.split('#')[0]!)];
}

/** Instance code (or component code — with default values) from the template. */
export function renderCodeConnect(doc: Document, id: string, cc: CodeConnect, depth = 0): string {
  const holder = codeConnectHolder(doc, id);
  if (!holder) return cc.template;
  const comp = doc.type(id) === 'INSTANCE' ? doc.get(id, 'componentId')! : doc.type(id) === 'COMPONENT_SET' ? holder : id;
  const defs = propertyDefinitions(doc, comp);
  const values: Record<string, string | boolean> = doc.type(id) === 'INSTANCE' ? instancePropertyValues(doc, id) : Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.defaultValue]));
  const byName = new Map<string, string>();
  for (const k of Object.keys(defs)) byName.set(k.split('#')[0]!.toLowerCase(), k);
  return cc.template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, raw: string) => {
    const name = raw.trim();
    if (name === 'name') return doc.get(id, 'name') ?? '';
    const key = name in defs ? name : byName.get(name.toLowerCase());
    if (!key) return m;
    const v = values[key];
    if (v === undefined) return m;
    if (typeof v === 'boolean') return String(v);
    if (defs[key]!.type === 'INSTANCE_SWAP') {
      // Nested component: its code in the same language, otherwise its name.
      if (!doc.has(v)) return '';
      const nested = codeConnectOf(doc, v).find((x) => x.language === cc.language);
      if (nested && depth < 4) return renderCodeConnect(doc, v, nested, depth + 1);
      const set = componentSetOf(doc, v);
      return doc.get(set ?? v, 'name') ?? '';
    }
    return v;
  });
}

// ---------- Playground ----------

/** Copy subtrees into another document with the same ids (and paths from the geometry table). */
function copySubtrees(from: Document, to: Document, roots: string[], parent: string) {
  const blob = (k: string | undefined) => {
    if (!k) return;
    const v = from.blob(k);
    if (v !== undefined) to.putBlob(v);
  };
  const copy = (id: string, into: string) => {
    if (to.has(id)) return;
    const n = from.node(id);
    if (!n) return;
    const props = structuredClone(n.props);
    for (const k of blobRefs(props)) blob(k);
    to.createWithId(id, n.type, into, props);
    for (const c of from.children(id)) copy(c, id);
  };
  for (const r of roots) copy(r, parent);
}

/**
 * Component playground: a separate document with a copy of the variant set (or component), the components
 * available for swapping and an instance — its properties are changed with setInstanceProperties; the file stays unchanged.
 */
export function playgroundDoc(doc: Document, componentId: string): { doc: Document; instance: string } | null {
  if (!doc.has(componentId)) return null;
  const comp = doc.type(componentId) === 'COMPONENT_SET' ? doc.children(componentId).find((c) => doc.type(c) === 'COMPONENT') : componentId;
  if (!comp) return null;
  const root = componentSetOf(doc, comp) ?? comp;
  const scratch = new Document({ clientId: 900_000_000 + Math.floor(Math.random() * 1e6) });
  scratch.transact(() => {
    const page = scratch.create('PAGE', scratch.root, { name: 'Площадка' });
    const store = scratch.create('FRAME', page, { name: 'Компоненты', visible: false });
    copySubtrees(doc, scratch, [root], store);
    // Components for swapping (INSTANCE_SWAP properties) too.
    const extra = new Set<string>();
    for (const d of Object.values(propertyDefinitions(doc, comp))) {
      if (d.type !== 'INSTANCE_SWAP') continue;
      for (const v of [d.defaultValue, ...(d.preferredValues ?? [])]) {
        if (typeof v !== 'string' || !doc.has(v)) continue;
        extra.add(doc.type(v) === 'COMPONENT' ? (componentSetOf(doc, v) ?? v) : v);
      }
    }
    copySubtrees(doc, scratch, [...extra].filter((x) => x !== root), store);
  }, 'import');
  const page = scratch.children(scratch.root)[0]!;
  const instance = scratch.transact(() => instantiate(scratch, comp, page, [1, 0, 0, 0, 1, 0]), 'import');
  return { doc: scratch, instance };
}
