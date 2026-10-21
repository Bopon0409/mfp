// The document's design system in motion: copies of component masters, component properties,
// styles and variables. One object per document; the editor (CLI, tests) calls:
//
//   observe(ops)        — after any change: link indexes;
//   trackOverrides(ops) — after local edits (user, plugin), within their undo step:
//                         overrides in instances; an edit to a field bound to a component
//                         property becomes the property value (on an instance) or the default (on a
//                         component); a local value edit detaches the style and variable;
//   propagate(ops)      — after local and derived edits: master copies, component properties,
//                         set variants, style and variable values in layers.
//
// All writes are derived (within the undo step of the edit that caused them) and happen only when values differ,
// so cascades converge.

import { ComponentSync, applyComponentProperties, definitionsHolder, isSlot, propertyDefinitions, propertyOwner, syncVariantDefinitions, variantsOf } from './components.ts';
import type { Document } from './document.ts';
import { STYLE_FIELD_NAMES, STYLE_FIELD_OF_KEY, STYLE_FIELDS, pushStyle, styleValues } from './styles.ts';
import type { Op, Props } from './types.ts';
import { collectionChain, boundVariableIds, fieldKeys, fieldProps, isExpression, resolveNode, resolveVariable, valueRefs, variablesIn } from './variables.ts';

/** Node field → the component property it gets bound to. */
const REF_FIELDS: [field: 'visible' | 'characters' | 'mainComponent', key: 'visible' | 'characters' | 'componentId'][] = [
  ['visible', 'visible'],
  ['characters', 'characters'],
  ['mainComponent', 'componentId'],
];
const REF_KEYS = new Set(['visible', 'characters', 'componentId', 'componentPropertyReferences']);
/** Changes after which the node's variable-bound values are recomputed. */
const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export class DesignSync {
  readonly components: ComponentSync;
  private doc: Document;
  /** style → layers referencing it. */
  private styleUsers = new Map<string, Set<string>>();
  /** variable → layers (and styles) bound to it. */
  private varUsers = new Map<string, Set<string>>();
  private variables = new Set<string>();
  /** variant → set (a deleted node's parent can no longer be found). */
  private variantSet = new Map<string, string>();
  /** Sets whose variants may have changed. */
  private dirtySets = new Set<string>();
  /** Default property values (per set and component) — to find out which ones changed. */
  private defaults = new Map<string, Record<string, string | boolean>>();

  constructor(doc: Document) {
    this.doc = doc;
    this.components = new ComponentSync(doc);
    for (const id of doc.descendants(doc.root)) this.index(id);
  }

  private static defaultsOf(doc: Document, holder: string): Record<string, string | boolean> {
    const out: Record<string, string | boolean> = {};
    for (const [k, d] of Object.entries(doc.get(holder, 'componentPropertyDefinitions') ?? {})) if (d.type !== 'VARIANT') out[k] = d.defaultValue;
    return out;
  }

  private static add(map: Map<string, Set<string>>, key: string, id: string) {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(id);
  }

  private index(id: string) {
    const n = this.doc.node(id);
    if (!n) return;
    const p = n.props;
    if (n.type === 'VARIABLE') this.variables.add(id);
    if (p.componentPropertyDefinitions && (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') && !this.defaults.has(id)) this.defaults.set(id, DesignSync.defaultsOf(this.doc, id));
    if (n.type === 'COMPONENT') {
      const parent = n.parent && this.doc.type(n.parent) === 'COMPONENT_SET' ? n.parent : null;
      if (parent) this.variantSet.set(id, parent);
      else this.variantSet.delete(id);
    }
    for (const f of STYLE_FIELD_NAMES) {
      const s = p[f];
      if (s) DesignSync.add(this.styleUsers, s, id);
    }
    for (const r of p.textRuns ?? []) {
      if (r.style.textStyleId) DesignSync.add(this.styleUsers, r.style.textStyleId, id);
      if (r.style.fillStyleId) DesignSync.add(this.styleUsers, r.style.fillStyleId, id);
    }
    for (const v of boundVariableIds(p)) DesignSync.add(this.varUsers, v, id);
  }

  /** Existing layers from the index. */
  private users(map: Map<string, Set<string>>, key: string): string[] {
    const set = map.get(key);
    if (!set) return [];
    const out: string[] = [];
    for (const id of set) {
      if (this.doc.has(id)) out.push(id);
      else set.delete(id);
    }
    return out;
  }

  /** Whether the node has copies (it is part of a master that has instances). */
  hasCopies(id: string): boolean {
    return this.components.hasCopies(id);
  }

  /** Layers using the style (for the styles panel). */
  styleUsersOf(styleId: string): string[] {
    return this.users(this.styleUsers, styleId);
  }

  /** Layers bound to the variable. */
  variableUsersOf(variableId: string): string[] {
    return this.users(this.varUsers, variableId);
  }

  /** Update the indexes from applied operations (of any source). */
  observe(ops: Op[]) {
    this.components.observe(ops);
    for (const o of ops) {
      if (o.op === 'blob') continue;
      if (o.op === 'delete' || o.op === 'move') {
        const s = this.variantSet.get(o.id);
        if (s) this.dirtySets.add(s);
      }
      if (o.op === 'delete') {
        this.variantSet.delete(o.id);
        this.variables.delete(o.id);
        continue;
      }
      this.index(o.id);
      if (o.op === 'create' || o.op === 'move' || (o.op === 'set' && 'name' in o.props)) {
        const s = this.variantSet.get(o.id);
        if (s) this.dirtySets.add(s);
      }
    }
  }

  /** Local edits by the user or a plugin (call within the undo step of those edits). */
  trackOverrides(ops: Op[]) {
    const doc = this.doc;
    // 1. Fields bound to component properties: an edit becomes the property value.
    const translated = new Map<string, Set<string>>();
    for (const o of ops) {
      if (o.op !== 'set' || !doc.has(o.id)) continue;
      const refs = doc.get(o.id, 'componentPropertyReferences');
      if (!refs || !Object.keys(refs).length) continue;
      for (const [field, nodeKey] of REF_FIELDS) {
        const key = refs[field];
        if (!key || !(nodeKey in o.props)) continue;
        const owner = propertyOwner(doc, o.id);
        if (!owner) continue;
        const value = field === 'visible' ? o.props.visible !== false : field === 'characters' ? String(o.props.characters ?? '') : String(o.props.componentId ?? '');
        if (doc.type(owner) === 'INSTANCE') {
          const vals = { ...(doc.get(owner, 'componentProperties') ?? {}), [key]: value };
          doc.set(owner, { componentProperties: vals });
          // A nested instance copy: the property value is its override.
          if (doc.get(owner, 'componentRef')) {
            const ov = doc.get(owner, 'overrides') ?? [];
            if (!ov.includes('componentProperties')) doc.set(owner, { overrides: [...ov, 'componentProperties'] });
          }
        } else {
          // For a standalone component an edit of a bound layer becomes the default value; for variants of a
          // set the default value is shared by all while variant layers may differ — leave it alone.
          const holder = definitionsHolder(doc, owner);
          const defs = propertyDefinitions(doc, owner);
          const d = defs[key];
          if (holder === owner && d && d.defaultValue !== value) {
            doc.set(holder, { componentPropertyDefinitions: { ...defs, [key]: { ...d, defaultValue: value } } });
            this.defaults.set(holder, { ...(this.defaults.get(holder) ?? {}), [key]: value });
          }
        }
        let s = translated.get(o.id);
        if (!s) translated.set(o.id, (s = new Set()));
        s.add(nodeKey);
      }
    }
    // 2. Overrides in instances: those turned into properties — no; a style and its values,
    // a variable and its field — together (otherwise the master overwrites half of it).
    this.components.trackOverrides(ops, (id, keys) => {
      const skip = translated.get(id);
      const out = new Set(keys.filter((k) => !skip?.has(k)));
      const bound = Object.keys(doc.get(id, 'boundVariables') ?? {});
      for (const k of [...out]) {
        const f = STYLE_FIELD_OF_KEY.get(k);
        if (f) out.add(f);
        if (k in STYLE_FIELDS) for (const v of STYLE_FIELDS[k as keyof typeof STYLE_FIELDS].keys) out.add(v);
        if (bound.some((b) => fieldKeys(b).includes(k))) out.add('boundVariables');
      }
      return [...out];
    });
    // Custom slot content in an instance: new and moved layers are a “children” edit.
    for (const o of ops) {
      if ((o.op !== 'create' && o.op !== 'move') || !doc.has(o.parent)) continue;
      const p = o.parent;
      if (!doc.get(p, 'componentRef') || !isSlot(doc, p)) continue;
      if (o.op === 'create' && doc.get(o.id, 'componentRef')) continue; // a master copy (not a local one)
      const ov = doc.get(p, 'overrides') ?? [];
      if (!ov.includes('children')) doc.set(p, { overrides: [...ov, 'children'] });
    }
    // Changed properties per node (one action may produce several operations on a node).
    const touched = new Map<string, Set<string>>();
    for (const o of ops) {
      if (o.op !== 'set' || !doc.has(o.id)) continue;
      let s = touched.get(o.id);
      if (!s) touched.set(o.id, (s = new Set()));
      for (const k of Object.keys(o.props)) s.add(k);
    }
    // 3. A local value edit detaches the style (for text runs — restyleText).
    for (const [id, keys] of touched) {
      if (doc.type(id) === 'STYLE') continue;
      const detach: Record<string, string> = {};
      for (const f of STYLE_FIELD_NAMES) {
        if (keys.has(f) || !doc.get(id, f)) continue;
        if (STYLE_FIELDS[f].keys.some((k) => keys.has(k))) detach[f] = '';
      }
      if (Object.keys(detach).length) doc.set(id, detach as Props);
    }
    // 4. A local edit of a bound field detaches the variable (if the value differs from what it would give).
    for (const [id, keysTouched] of touched) {
      if (keysTouched.has('boundVariables')) continue;
      const bv = doc.get(id, 'boundVariables');
      if (!bv || !Object.keys(bv).length) continue;
      const next = { ...bv };
      let changed = false;
      for (const [field, a] of Object.entries(bv)) {
        const keys = fieldKeys(field);
        if (!keys.some((k) => keysTouched.has(k))) continue;
        const v = resolveVariable(doc, a.id, id);
        const want = v === undefined ? null : (fieldProps(doc, id, field, v, doc.has(a.id) ? doc.get(a.id, 'unit') : undefined) as Record<string, unknown> | null);
        if (want && keys.every((k) => sameJson(doc.get(id, k as keyof Props), want[k]))) continue;
        delete next[field];
        changed = true;
      }
      if (changed) doc.set(id, { boundVariables: Object.keys(next).length ? next : undefined });
    }
  }

  /** Derived edits after local and derived changes (call inside a transaction). */
  propagate(ops: Op[]) {
    this.components.propagate(ops);
    this.applyProperties(ops);
    this.syncVariants();
    this.syncStyles(ops);
    this.resolveVariables(ops);
  }

  /**
   * Property values go into the bound layers: for changed instances (own values and the master's
   * ones); for components — the changed default values.
   */
  private applyProperties(ops: Op[]) {
    const doc = this.doc;
    const owners = new Set<string>();
    const mains = new Map<string, string[]>();
    for (const o of ops) {
      if (o.op === 'blob' || o.op === 'delete' || !doc.has(o.id)) continue;
      const t = doc.type(o.id);
      if (o.op === 'set') {
        const keys = Object.keys(o.props);
        if (t === 'INSTANCE' && (keys.includes('componentProperties') || keys.includes('componentId'))) owners.add(o.id);
        if ((t === 'COMPONENT' || t === 'COMPONENT_SET') && keys.includes('componentPropertyDefinitions')) {
          const now = DesignSync.defaultsOf(doc, o.id);
          const was = this.defaults.get(o.id) ?? {};
          this.defaults.set(o.id, now);
          const changed = Object.keys(now).filter((k) => k in was && now[k] !== was[k]);
          if (changed.length) for (const c of t === 'COMPONENT_SET' ? variantsOf(doc, o.id) : [o.id]) mains.set(c, changed);
        }
        if (!keys.some((k) => REF_KEYS.has(k))) continue;
      }
      const refs = doc.get(o.id, 'componentPropertyReferences');
      if (refs && Object.keys(refs).length) {
        const owner = propertyOwner(doc, o.id);
        if (owner && doc.type(owner) === 'INSTANCE') owners.add(owner);
      }
    }
    for (const [c, keys] of mains) applyComponentProperties(doc, c, keys);
    for (const owner of owners) applyComponentProperties(doc, owner);
  }

  /** Set variant properties, from variant names. */
  private syncVariants() {
    if (!this.dirtySets.size) return;
    const sets = [...this.dirtySets];
    this.dirtySets.clear();
    for (const s of sets) if (this.doc.has(s) && this.doc.type(s) === 'COMPONENT_SET') syncVariantDefinitions(this.doc, s);
  }

  /** A style edit goes into the layers referencing it; a new reference brings the style values into the layer. */
  private syncStyles(ops: Op[]) {
    const doc = this.doc;
    const changed = new Set<string>();
    const pulls = new Set<string>();
    for (const o of ops) {
      if ((o.op !== 'set' && o.op !== 'create') || !doc.has(o.id)) continue;
      if (doc.type(o.id) === 'STYLE') {
        if (o.op === 'set' && Object.keys(o.props).some((k) => k !== 'name' && k !== 'description')) changed.add(o.id);
        continue;
      }
      if (STYLE_FIELD_NAMES.some((f) => (o.props as Record<string, unknown>)[f])) pulls.add(o.id);
    }
    for (const s of changed) for (const u of this.users(this.styleUsers, s)) pushStyle(doc, u, s);
    for (const id of pulls) {
      for (const f of STYLE_FIELD_NAMES) {
        const s = doc.get(id, f);
        if (!s || !doc.has(s) || doc.type(s) !== 'STYLE') continue;
        if (doc.type(id) === 'TEXT' && (f === 'textStyleId' || f === 'fillStyleId')) pushStyle(doc, id, s);
        else doc.set(id, styleValues(doc, s, f));
      }
    }
  }

  /** Variable-bound values: on variable edits, mode changes, moves and new bindings. */
  private resolveVariables(ops: Op[]) {
    const doc = this.doc;
    const nodes = new Set<string>();
    const vars = new Set<string>();
    const subtrees: string[] = [];
    let rem = false;
    for (const o of ops) {
      if (o.op === 'blob' || o.op === 'delete' || !doc.has(o.id)) continue;
      // The root font size (1 rem) changed — recompute everything in rem.
      if (o.op === 'set' && o.id === doc.root && 'rootFontSize' in o.props) rem = true;
      const t = doc.type(o.id);
      if (t === 'VARIABLE') {
        if (o.op === 'set') vars.add(o.id);
        continue;
      }
      if (t === 'VARIABLE_COLLECTION') {
        // For an extension, parent variables may have their own values — include them too.
        if (o.op === 'set') for (const c of collectionChain(doc, o.id)) for (const v of variablesIn(doc, c)) vars.add(v);
        continue;
      }
      if (o.op === 'move' || (o.op === 'set' && 'explicitVariableModes' in o.props)) subtrees.push(o.id);
      else if (boundVariableIds(doc.node(o.id)!.props).length) nodes.add(o.id);
    }
    if (vars.size) {
      // Referencing variables (along the chain) and expressions too.
      for (let grew = true; grew; ) {
        grew = false;
        for (const v of this.variables) {
          if (vars.has(v) || !doc.has(v)) continue;
          const vals = Object.values(doc.get(v, 'valuesByMode') ?? {});
          if (vals.some((x) => isExpression(x) || valueRefs(x).some((r) => vars.has(r)))) {
            vars.add(v);
            grew = true;
          }
        }
      }
      for (const v of vars) for (const u of this.users(this.varUsers, v)) nodes.add(u);
    }
    for (const root of subtrees) {
      if (boundVariableIds(doc.node(root)!.props).length) nodes.add(root);
      for (const d of doc.descendants(root)) if (boundVariableIds(doc.node(d)!.props).length) nodes.add(d);
    }
    for (const n of nodes) resolveNode(doc, n);
    if (rem) this.resolveAll();
  }

  /** Recompute all bound values (after import). */
  resolveAll() {
    const seen = new Set<string>();
    for (const [, set] of this.varUsers) for (const id of set) if (!seen.has(id) && this.doc.has(id)) {
      seen.add(id);
      resolveNode(this.doc, id);
    }
  }
}
