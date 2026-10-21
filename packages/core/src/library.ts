// Libraries (local): assets of another document — components and variant sets, styles,
// variable collections — are copied onto this document's internal page (with the library name and
// asset keys). Importing the same library again is an update: assets with the same keys
// are changed in place (component nodes keep their ids — instances stay linked, their copies
// are updated by DesignSync), new ones are added. Updates can also be selective: each
// imported asset carries a signature of its version in the source (librarySig); libraryChanges compares
// it with the current one and lists what is new and changed, and importLibrary({ only }) takes only the selection.

import { variantsOf } from './components.ts';
import type { Document } from './document.ts';
import { resourceNodes, resourcesPage } from './styles.ts';
import { userPages } from './defaults.ts';
import type { ComponentPropertyDefinition, NodeType, Paint, Props, VariableValue } from './types.ts';
import { fieldKeys, isAlias } from './variables.ts';
import { STYLE_FIELD_NAMES, STYLE_FIELDS } from './styles.ts';
import { isComposite } from './composite-variables.ts';
import { mediaHashes } from './media.ts';

export interface LibraryImport {
  components: number;
  styles: number;
  variables: number;
  /** How many assets were updated (already in the document). */
  updated: number;
  /** Image hashes in the copied nodes (bytes come from the library source). */
  images: Set<string>;
}

/** Document assets: components and sets (top-level), styles, collections. */
function assetsOf(doc: Document): { components: string[]; styles: string[]; collections: string[] } {
  const components: string[] = [];
  const walk = (id: string) => {
    for (const c of doc.children(id)) {
      const t = doc.type(c);
      if (t === 'COMPONENT' || t === 'COMPONENT_SET') components.push(c);
      else if (t !== 'INSTANCE' && t !== 'STYLE' && t !== 'VARIABLE_COLLECTION') walk(c);
    }
  };
  for (const p of doc.children(doc.root)) walk(p);
  void userPages;
  return { components, styles: resourceNodes(doc, 'STYLE'), collections: resourceNodes(doc, 'VARIABLE_COLLECTION') };
}

/** Remap the copied node's references (components, master nodes, styles, variables, collections) using the id table. */
function remap(props: Record<string, unknown>, map: Map<string, string>): Record<string, unknown> {
  const m = (id: unknown) => (typeof id === 'string' && map.has(id) ? map.get(id)! : id);
  const out = { ...props };
  for (const k of ['componentId', 'componentRef', 'fillStyleId', 'strokeStyleId', 'textStyleId', 'effectStyleId', 'gridStyleId', 'detachedFrom']) if (k in out) out[k] = m(out[k]);
  const aliasMap = (a: { type: 'VARIABLE_ALIAS'; id: string }) => ({ ...a, id: m(a.id) as string });
  if (out.boundVariables) out.boundVariables = Object.fromEntries(Object.entries(out.boundVariables as Record<string, { type: 'VARIABLE_ALIAS'; id: string }>).map(([f, a]) => [f, aliasMap(a)]));
  const paints = (list: unknown) =>
    (list as Paint[] | undefined)?.map((p) =>
      p.boundVariables?.color || p.boundVariables?.gradient
        ? { ...p, boundVariables: { ...(p.boundVariables.color ? { color: aliasMap(p.boundVariables.color) } : {}), ...(p.boundVariables.gradient ? { gradient: aliasMap(p.boundVariables.gradient) } : {}) } }
        : p,
    );
  // Composite value: references inside (stop and shadow colors, font family, font style, font size).
  const inner = (v: VariableValue): VariableValue => {
    if (!isComposite(v)) return v;
    const x = <T>(y: T): T => (isAlias(y) ? (aliasMap(y) as T) : y);
    if (v.type === 'GRADIENT') return { ...v, stops: v.stops.map((st) => ({ ...st, color: x(st.color) })) };
    if (v.type === 'SHADOWS') return { ...v, shadows: v.shadows.map((sh) => ({ ...sh, color: x(sh.color) })) };
    return { ...v, fontFamily: x(v.fontFamily), fontStyle: x(v.fontStyle), fontSize: x(v.fontSize) };
  };
  if (out.fills) out.fills = paints(out.fills);
  if (out.strokes) out.strokes = paints(out.strokes);
  if (out.effects)
    out.effects = (out.effects as { boundVariables?: Record<string, { type: 'VARIABLE_ALIAS'; id: string }> }[]).map((e) =>
      e.boundVariables ? { ...e, boundVariables: Object.fromEntries(Object.entries(e.boundVariables).map(([f, a]) => [f, aliasMap(a)])) } : e,
    );
  if (out.textRuns)
    out.textRuns = (out.textRuns as { length: number; style: Record<string, unknown> }[]).map((r) => ({
      ...r,
      style: { ...r.style, ...(r.style.textStyleId ? { textStyleId: m(r.style.textStyleId) } : {}), ...(r.style.fillStyleId ? { fillStyleId: m(r.style.fillStyleId) } : {}), ...(r.style.fills ? { fills: paints(r.style.fills) } : {}) },
    }));
  if (out.explicitVariableModes) out.explicitVariableModes = Object.fromEntries(Object.entries(out.explicitVariableModes as Record<string, string>).map(([c, mode]) => [m(c) as string, mode]));
  if (out.componentPropertyDefinitions)
    out.componentPropertyDefinitions = Object.fromEntries(
      Object.entries(out.componentPropertyDefinitions as Record<string, ComponentPropertyDefinition>).map(([k, d]) => [
        k,
        d.type === 'INSTANCE_SWAP' ? { ...d, defaultValue: m(d.defaultValue) as string, ...(d.preferredValues ? { preferredValues: d.preferredValues.map((p) => m(p) as string) } : {}) } : d,
      ]),
    );
  if (out.componentProperties) out.componentProperties = Object.fromEntries(Object.entries(out.componentProperties as Record<string, string | boolean>).map(([k, v]) => [k, m(v) as string | boolean]));
  if (out.valuesByMode) out.valuesByMode = Object.fromEntries(Object.entries(out.valuesByMode as Record<string, VariableValue>).map(([mode, v]) => [mode, isAlias(v) ? aliasMap(v) : inner(v)]));
  return out;
}

/** Media in node properties (images, video, Lottie, 3D models, sounds) — copied together with the asset. */
function imagesOf(props: Record<string, unknown>, out: Set<string>) {
  for (const h of mediaHashes(props as Props)) out.add(h);
}

/** JSON with sorted keys (the signature does not depend on the order properties were written). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/**
 * Signature of an asset's version in its document: subtree properties (without page position and keys).
 * Values from bound styles and variables are excluded: editing them is an edit of the style or
 * variable itself (they have their own signature), not of the component.
 */
export function assetSignature(doc: Document, id: string): string {
  const IGNORE = new Set(['key', 'library', 'librarySig']);
  const walk = (n: string, root: boolean): string => {
    const own = (doc.node(n)?.props ?? {}) as Props;
    const props = { ...(own as Record<string, unknown>) };
    for (const k of IGNORE) delete props[k];
    if (root) delete props.transform;
    for (const f of STYLE_FIELD_NAMES) if (own[f]) for (const k of STYLE_FIELDS[f].keys) delete props[k];
    for (const field of Object.keys(own.boundVariables ?? {})) for (const k of fieldKeys(field)) delete props[k];
    for (const k of ['fills', 'strokes'] as const) {
      const list = own[k];
      if (list) props[k] = list.map((p) => (p.boundVariables?.gradient ? { boundVariables: p.boundVariables, visible: p.visible, opacity: p.opacity } : p.boundVariables?.color ? { ...p, color: undefined, opacity: undefined } : p));
    }
    return `${doc.type(n)}${stable(props)}[${doc.children(n).map((c) => walk(c, false)).join(',')}]`;
  };
  // FNV-1a, 32 bits, over two halves (64 bits per signature).
  const text = walk(id, true);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

export interface LibraryChange {
  key: string;
  name: string;
  type: NodeType;
  /** A new asset is not in the file yet; a changed one has a different version in the source. */
  status: 'new' | 'changed';
  /** Component: how many copies of it are in the file. */
  instances: number;
}

/**
 * What is new or changed in the library source compared with the connected one (by signatures).
 * An asset imported before signatures existed counts as changed.
 */
export function libraryChanges(target: Document, source: Document, name: string, prefix = name): LibraryChange[] {
  const keyOf = (id: string) => source.get(id, 'key') || `${prefix}:${id}`;
  const page = resourcesPage(target, false);
  const existing = new Map<string, string>();
  if (page) for (const id of target.descendants(page)) {
    const k = target.get(id, 'key');
    if (k) existing.set(k, id);
  }
  const usage = libraryUsage(target, name);
  const out: LibraryChange[] = [];
  const check = (id: string) => {
    const key = keyOf(id);
    const was = existing.get(key);
    const status = !was ? 'new' : target.get(was, 'librarySig') !== assetSignature(source, id) ? 'changed' : null;
    if (status) out.push({ key, name: source.get(id, 'name') ?? '', type: source.type(id)!, status, instances: usage[key] ?? 0 });
  };
  const a = assetsOf(source);
  a.components.forEach(check);
  a.styles.forEach(check);
  for (const c of a.collections) for (const v of source.children(c)) if (source.type(v) === 'VARIABLE') check(v);
  return out;
}

/**
 * Import (or update) library name from document source. Call inside a transaction.
 * prefix — the start of keys for assets without their own key (a team library uses its file id:
 * renaming the library does not change the keys). only — the asset keys to take (selective
 * update); everything else stays as it was.
 */
export function importLibrary(target: Document, source: Document, name: string, prefix = name, opts: { only?: ReadonlySet<string> } = {}): LibraryImport {
  const report: LibraryImport = { components: 0, styles: 0, variables: 0, updated: 0, images: new Set() };
  const page = resourcesPage(target)!;
  const keyOf = (id: string) => source.get(id, 'key') || `${prefix}:${id}`;
  const take = (id: string) => !opts.only || opts.only.has(keyOf(id));
  /** Signatures — after all edits (for a component — its subtree in the source). */
  const signed: [string, string][] = [];
  // Already connected: key → node.
  const existing = new Map<string, string>();
  for (const id of target.descendants(page)) {
    const k = target.get(id, 'key');
    if (k) existing.set(k, id);
  }
  const map = new Map<string, string>();
  /** Nodes whose references are remapped later (copied properties come from the source). */
  const created: [string, string][] = [];
  const stored = (doc: Document, id: string) => ({ ...(doc.node(id)!.props as Record<string, unknown>) });
  const copyTree = (from: string, parent: string, index?: number): string => {
    const props = stored(source, from);
    imagesOf(props, report.images);
    const id = target.create(source.type(from)!, parent, props as Props, index);
    map.set(from, id);
    created.push([from, id]);
    for (const c of source.children(from)) copyTree(c, id);
    return id;
  };
  /** Replace a node's content (children anew), with new properties; the node id is kept. */
  const replaceTree = (from: string, into: string) => {
    map.set(from, into);
    created.push([from, into]);
    const props = stored(source, from);
    imagesOf(props, report.images);
    const cur = target.node(into)!.props as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const k of Object.keys(cur)) if (!(k in props) && k !== 'transform' && k !== 'library' && k !== 'librarySig') next[k] = undefined;
    Object.assign(next, props);
    delete next.transform;
    target.set(into, next as Props);
    for (const c of [...target.children(into)]) target.delete(c);
    for (const c of source.children(from)) copyTree(c, into);
  };
  const assets = assetsOf(source);
  // Collections and variables.
  for (const c of assets.collections) {
    const vars = source.children(c).filter((v) => source.type(v) === 'VARIABLE');
    if (opts.only && !take(c) && !vars.some(take)) continue;
    const k = keyOf(c);
    const was = existing.get(k);
    let coll: string;
    if (was && target.type(was) === 'VARIABLE_COLLECTION') {
      coll = was;
      target.set(coll, { ...stored(source, c), key: k, library: name } as Props);
      report.updated++;
    } else coll = target.create('VARIABLE_COLLECTION', page, { ...stored(source, c), key: k, library: name } as Props);
    map.set(c, coll);
    signed.push([c, coll]);
    for (const v of source.children(c)) {
      if (source.type(v) !== 'VARIABLE') continue;
      if (!take(v)) {
        // Not selected but already connected — references to it keep working.
        const old = existing.get(keyOf(v));
        if (old) map.set(v, old);
        continue;
      }
      const vk = keyOf(v);
      const old = existing.get(vk);
      let id: string;
      if (old && target.type(old) === 'VARIABLE') {
        id = old;
        if (target.parent(old) !== coll) target.move(old, coll);
        target.set(id, { ...stored(source, v), key: vk } as Props);
        report.updated++;
      } else {
        id = target.create('VARIABLE', coll, { ...stored(source, v), key: vk } as Props);
        report.variables++;
      }
      map.set(v, id);
      created.push([v, id]);
      signed.push([v, id]);
    }
  }
  // Styles.
  for (const s of assets.styles) {
    const k = keyOf(s);
    if (!take(s)) {
      const old = existing.get(k);
      if (old) map.set(s, old);
      continue;
    }
    const was = existing.get(k);
    if (was && target.type(was) === 'STYLE') {
      target.set(was, { ...stored(source, s), key: k, library: name } as Props);
      map.set(s, was);
      created.push([s, was]);
      signed.push([s, was]);
      report.updated++;
    } else {
      const id = target.create('STYLE', page, { ...stored(source, s), key: k, library: name } as Props);
      map.set(s, id);
      created.push([s, id]);
      signed.push([s, id]);
      report.styles++;
    }
  }
  // Components and sets: variants are matched by key or name — instances do not lose their link.
  for (const c of assets.components) {
    const k = keyOf(c);
    const was = existing.get(k);
    const type = source.type(c) as NodeType;
    if (!take(c)) {
      // Not selected: copy links in other assets point to the existing one (variants — by key or name).
      if (was) {
        map.set(c, was);
        if (type === 'COMPONENT_SET')
          for (const v of source.children(c)) {
            const tv = target.children(was).find((x) => target.get(x, 'key') === keyOf(v) || target.get(x, 'name') === source.get(v, 'name'));
            if (tv) map.set(v, tv);
          }
      }
      continue;
    }
    if (was && target.type(was) === type) {
      report.updated++;
      if (type === 'COMPONENT_SET') {
        const props = stored(source, c);
        delete props.transform;
        target.set(was, { ...props, key: k, library: name } as Props);
        map.set(c, was);
        created.push([c, was]);
        const old = new Map<string, string>();
        for (const v of variantsOf(target, was)) old.set(target.get(v, 'key') || (target.get(v, 'name') ?? ''), v);
        const keep = new Set<string>();
        for (const v of source.children(c)) {
          if (source.type(v) !== 'COMPONENT') {
            copyTree(v, was);
            continue;
          }
          const match = old.get(keyOf(v)) ?? old.get(source.get(v, 'name') ?? '');
          if (match) {
            replaceTree(v, match);
            target.set(match, { transform: source.get(v, 'transform'), key: keyOf(v) });
            keep.add(match);
          } else target.set(copyTree(v, was), { key: keyOf(v) });
        }
        for (const v of target.children(was)) if (!keep.has(v) && !created.some(([, t]) => t === v)) target.delete(v);
      } else {
        replaceTree(c, was);
        target.set(was, { key: k, library: name });
      }
      signed.push([c, was]);
      continue;
    }
    const id = copyTree(c, page);
    target.set(id, { key: k, library: name });
    signed.push([c, id]);
    if (type === 'COMPONENT_SET') for (const v of variantsOf(target, id)) target.set(v, { key: keyOf([...map].find(([, t]) => t === v)![0]) });
    report.components++;
  }
  // References of the copied nodes point to the copies.
  for (const [from, to] of created) {
    if (!target.has(to)) continue;
    const props = remap(stored(source, from), map);
    const fix: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (k === 'transform' || k === 'key' || k === 'library' || k === 'librarySig') continue;
      if (JSON.stringify(v) !== JSON.stringify((target.node(to)!.props as Record<string, unknown>)[k])) fix[k] = v;
    }
    if (Object.keys(fix).length) target.set(to, fix as Props);
  }
  for (const [from, to] of signed) if (target.has(to)) target.set(to, { librarySig: assetSignature(source, from) });
  return report;
}

/** Document assets for publishing as a library: key (own or prefix:id), name, type. */
export function libraryAssets(doc: Document, prefix: string): { key: string; name: string; type: string }[] {
  const a = assetsOf(doc);
  const keyOf = (id: string) => doc.get(id, 'key') || `${prefix}:${id}`;
  const item = (id: string) => ({ key: keyOf(id), name: doc.get(id, 'name') ?? '', type: doc.type(id)! });
  // Own assets, not ones that came from other libraries.
  const own = (id: string) => !doc.get(id, 'library');
  return [
    ...a.components.filter(own).map(item),
    ...a.styles.filter(own).map(item),
    ...a.collections.filter(own).flatMap((c) => [item(c), ...doc.children(c).filter((v) => doc.type(v) === 'VARIABLE').map(item)]),
  ];
}

/** Instances of library name's components in the document: component key (for a variant — its set's) → count. */
export function libraryUsage(doc: Document, name: string): Record<string, number> {
  const page = resourcesPage(doc, false);
  const out: Record<string, number> = {};
  if (!page) return out;
  // Library component (and set variant) → top-level asset key.
  const keyOf = new Map<string, string>();
  for (const id of doc.children(page)) {
    if (doc.get(id, 'library') !== name) continue;
    const key = doc.get(id, 'key');
    if (!key) continue;
    if (doc.type(id) === 'COMPONENT') keyOf.set(id, key);
    else if (doc.type(id) === 'COMPONENT_SET') for (const v of doc.children(id)) keyOf.set(v, key);
  }
  if (!keyOf.size) return out;
  for (const p of doc.children(doc.root)) {
    if (p === page) continue;
    for (const id of doc.descendants(p)) {
      if (doc.type(id) !== 'INSTANCE') continue;
      const key = keyOf.get(doc.get(id, 'componentId') ?? '');
      if (key) out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}

/** Connected libraries: name → number of assets. */
export function linkedLibraries(doc: Document): Map<string, number> {
  const out = new Map<string, number>();
  const page = resourcesPage(doc, false);
  if (!page) return out;
  for (const id of doc.children(page)) {
    const lib = doc.get(id, 'library');
    if (lib) out.set(lib, (out.get(lib) ?? 0) + 1);
  }
  return out;
}

/** Disconnect a library: its assets stay in the document as local ones. */
export function unlinkLibrary(doc: Document, name: string) {
  const page = resourcesPage(doc, false);
  if (!page) return;
  for (const id of doc.children(page)) if (doc.get(id, 'library') === name) doc.set(id, { library: undefined });
}
