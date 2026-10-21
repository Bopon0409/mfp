// Design system Plugin API: styles, variables, component properties and variant sets.
// Styles, variables and collections are document nodes (STYLE, VARIABLE, VARIABLE_COLLECTION) on the
// internal page; in the sandbox they are the same node proxies, with properties and methods matching the
// Style, Variable and VariableCollection objects of the Figma Plugin API.

import {
  addComponentProperty,
  addMode,
  applyComponentProperties,
  applyStyle,
  bindVariable,
  collectionOf,
  combineAsVariants,
  componentSetOf,
  createCollection,
  createStyle,
  createVariable,
  deleteComponentProperty,
  deleteStyle,
  deleteVariable,
  detachInstance,
  editComponentProperty,
  effectWithVariable,
  findVariant,
  instancePropertyValues,
  instantiate,
  localCollections,
  localStyles,
  localVariables,
  COMPOSITE_VARIABLE_TYPES,
  paintWithVariable,
  parseVariantName,
  propertyDefinitions,
  removeMode,
  renameMode,
  resetOverrides,
  resolveVariable,
  resolvedModes,
  setExplicitMode,
  setInstanceProperties,
  setVariableValue,
  styleConsumers,
  STYLE_FIELD_NAMES,
  swapComponent,
  variablesIn,
  variantsOf,
  type ComponentPropertyDefinition,
  type Document,
  type Effect,
  type NodeType,
  type Paint,
  type Props,
  type StyleField,
  type StyleType,
  type VariableType,
  type VariableValue,
} from '@mfp/core';

type Wire = unknown;
const node = (id: string | null | undefined) => (id ? { $node: id } : null);
const idOf = (v: Wire): string => {
  if (v && typeof v === 'object' && '$node' in v) return String((v as { $node: string }).$node);
  if (typeof v === 'string') return v;
  throw new Error('Ожидался узел, стиль или переменная');
};

/** “The design system has no such property” — let the generic code decide. */
export const NOT = Symbol('not handled');

const STYLE_TYPE_OF: Record<string, StyleType> = { PAINT: 'PAINT', TEXT: 'TEXT', EFFECT: 'EFFECT', GRID: 'GRID' };

/** Preferred values: component ids → { type, key } (like InstanceSwapPreferredValue). */
function preferred(doc: Document, ids: string[] | undefined) {
  return (ids ?? []).filter((id) => doc.has(id)).map((id) => ({ type: doc.type(id) === 'COMPONENT_SET' ? 'COMPONENT_SET' : 'COMPONENT', key: doc.get(id, 'key') || id }));
}

/** Property definitions in Plugin API form. */
function definitionsWire(doc: Document, defs: Record<string, ComponentPropertyDefinition>) {
  const out: Record<string, Wire> = {};
  for (const [k, d] of Object.entries(defs)) {
    const v: Record<string, Wire> = { type: d.type, defaultValue: d.defaultValue };
    if (d.variantOptions) v.variantOptions = d.variantOptions;
    if (d.preferredValues) v.preferredValues = preferred(doc, d.preferredValues);
    out[k] = v;
  }
  return out;
}

/** Layer bindings in Plugin API form: fields, paints (arrays of references), effects. */
function boundVariablesWire(doc: Document, id: string) {
  const p = doc.props(id);
  const out: Record<string, Wire> = { ...(p.boundVariables ?? {}) };
  for (const key of ['fills', 'strokes'] as const) {
    const list = (p[key] ?? []).map((paint) => paint.boundVariables?.color).filter(Boolean);
    if (list.length) out[key] = list;
  }
  const effects = (p.effects ?? []).map((e) => e.boundVariables).filter((b) => b && Object.keys(b).length);
  if (effects.length) out.effects = effects;
  return out;
}

/** Reading design system properties (NOT — not ours). */
export function designGet(doc: Document, id: string, type: NodeType, prop: string): Wire | typeof NOT {
  // Style.
  if (type === 'STYLE') {
    switch (prop) {
      case 'type':
        return doc.get(id, 'styleType') ?? 'PAINT';
      case 'paints':
        return doc.get(id, 'fills') ?? [];
      case 'remote':
        return !!doc.get(id, 'library');
      case 'key':
        return doc.get(id, 'key') || id;
      case 'description':
        return doc.get(id, 'description') ?? '';
      case 'documentationLinks':
        return [];
      case 'consumers':
        return styleConsumers(doc, id).map((n) => ({ node: node(n), fields: STYLE_FIELD_NAMES.filter((f) => doc.get(n, f) === id) }));
    }
    return NOT;
  }
  // Variable.
  if (type === 'VARIABLE') {
    switch (prop) {
      case 'variableCollectionId':
        return collectionOf(doc, id);
      case 'valuesByMode':
        return doc.get(id, 'valuesByMode') ?? {};
      case 'resolvedType':
        return doc.get(id, 'resolvedType') ?? 'FLOAT';
      case 'scopes':
        return doc.get(id, 'scopes') ?? ['ALL_SCOPES'];
      case 'codeSyntax':
        return doc.get(id, 'codeSyntax') ?? {};
      case 'description':
        return doc.get(id, 'description') ?? '';
      case 'hiddenFromPublishing':
        return !!doc.get(id, 'hiddenFromPublishing');
      case 'remote':
        return !!doc.get(collectionOf(doc, id) ?? '', 'library');
      case 'key':
        return doc.get(id, 'key') || id;
    }
    return NOT;
  }
  if (type === 'VARIABLE_COLLECTION') {
    switch (prop) {
      case 'modes':
        return doc.get(id, 'modes') ?? [];
      case 'defaultModeId':
        return doc.get(id, 'defaultModeId') || (doc.get(id, 'modes') ?? [])[0]?.modeId || '';
      case 'variableIds':
        return variablesIn(doc, id).filter((v) => !COMPOSITE_VARIABLE_TYPES.includes(doc.get(v, 'resolvedType') ?? 'FLOAT'));
      case 'remote':
        return !!doc.get(id, 'library');
      case 'key':
        return doc.get(id, 'key') || id;
      case 'hiddenFromPublishing':
        return !!doc.get(id, 'hiddenFromPublishing');
      case 'isExtension':
        return false;
    }
    return NOT;
  }
  switch (prop) {
    case 'fillStyleId':
    case 'strokeStyleId':
    case 'effectStyleId':
    case 'gridStyleId':
    case 'textStyleId':
      // Text with differing pieces goes to the generic code (figma.mixed).
      if (type === 'TEXT' && (prop === 'textStyleId' || prop === 'fillStyleId')) return NOT;
      return doc.get(id, prop as StyleField) ?? '';
    case 'boundVariables':
      return boundVariablesWire(doc, id);
    case 'explicitVariableModes':
      return doc.get(id, 'explicitVariableModes') ?? {};
    case 'resolvedVariableModes':
      return resolvedModes(doc, id);
    case 'description':
      return type === 'COMPONENT' || type === 'COMPONENT_SET' ? (doc.get(id, 'description') ?? '') : NOT;
    case 'key':
      return type === 'COMPONENT' || type === 'COMPONENT_SET' ? doc.get(id, 'key') || id : NOT;
    case 'remote':
      return type === 'COMPONENT' || type === 'COMPONENT_SET' ? !!doc.get(id, 'library') || !!doc.get(doc.parent(id) ?? '', 'library') : NOT;
    case 'componentPropertyDefinitions':
      if (type === 'COMPONENT_SET' || (type === 'COMPONENT' && !componentSetOf(doc, id))) return definitionsWire(doc, propertyDefinitions(doc, id));
      if (type === 'COMPONENT') throw new Error('Can only get definitions of a component set or non-variant component');
      return NOT;
    case 'componentProperties': {
      if (type !== 'INSTANCE') return NOT;
      const comp = doc.get(id, 'componentId');
      const defs = comp ? propertyDefinitions(doc, comp) : {};
      const out: Record<string, Wire> = {};
      for (const [k, v] of Object.entries(instancePropertyValues(doc, id))) {
        const d = defs[k]!;
        out[k] = { type: d.type, value: v, ...(d.preferredValues ? { preferredValues: preferred(doc, d.preferredValues) } : {}) };
      }
      return out;
    }
    case 'componentPropertyReferences': {
      const refs = doc.get(id, 'componentPropertyReferences');
      return refs && Object.keys(refs).length ? refs : null;
    }
    case 'mainComponent': {
      if (type !== 'INSTANCE') return NOT;
      const c = doc.get(id, 'componentId');
      return c && doc.has(c) ? node(c) : null;
    }
    case 'variantProperties': {
      const comp = type === 'INSTANCE' ? doc.get(id, 'componentId') : type === 'COMPONENT' ? id : null;
      if (!comp || !doc.has(comp) || !componentSetOf(doc, comp)) return type === 'INSTANCE' || type === 'COMPONENT' ? null : NOT;
      return parseVariantName(doc.get(comp, 'name') ?? '');
    }
    case 'variantGroupProperties': {
      if (type !== 'COMPONENT_SET') return NOT;
      const out: Record<string, { values: string[] }> = {};
      for (const [k, d] of Object.entries(propertyDefinitions(doc, id))) if (d.type === 'VARIANT') out[k] = { values: d.variantOptions ?? [] };
      return out;
    }
    case 'defaultVariant': {
      if (type !== 'COMPONENT_SET') return NOT;
      const values: Record<string, string> = {};
      for (const [k, d] of Object.entries(propertyDefinitions(doc, id))) if (d.type === 'VARIANT') values[k] = String(d.defaultValue);
      return node(findVariant(doc, id, values) ?? variantsOf(doc, id)[0]);
    }
    case 'isExposedInstance':
      return type === 'INSTANCE' ? !!doc.get(id, 'isExposedInstance') : NOT;
    case 'exposedInstances': {
      if (type !== 'INSTANCE') return NOT;
      const out: Wire[] = [];
      const walk = (n: string) => {
        for (const c of doc.children(n)) {
          if (doc.type(c) === 'INSTANCE') {
            if (doc.get(c, 'isExposedInstance')) out.push(node(c));
          } else walk(c);
        }
      };
      walk(id);
      return out;
    }
    case 'overrides': {
      if (type !== 'INSTANCE') return NOT;
      const out: Wire[] = [];
      for (const n of [id, ...doc.descendants(id)]) {
        const ov = doc.get(n, 'overrides');
        if (ov?.length) out.push({ id: n, overriddenFields: ov });
      }
      return out;
    }
  }
  return NOT;
}

/** Writing design system properties; true — written. */
export function designSet(doc: Document, id: string, type: NodeType, prop: string, value: Wire): boolean {
  if (type === 'STYLE') {
    switch (prop) {
      case 'paints':
        doc.set(id, { fills: value as Paint[] });
        return true;
      case 'description':
        doc.set(id, { description: String(value) });
        return true;
    }
    return false;
  }
  if (type === 'VARIABLE') {
    switch (prop) {
      case 'name':
      case 'description':
        doc.set(id, { [prop]: String(value) });
        return true;
      case 'scopes':
        doc.set(id, { scopes: (value as string[]).map(String) });
        return true;
      case 'hiddenFromPublishing':
        doc.set(id, { hiddenFromPublishing: !!value });
        return true;
    }
    return false;
  }
  if (type === 'VARIABLE_COLLECTION') {
    if (prop === 'name' || prop === 'hiddenFromPublishing') {
      doc.set(id, { [prop]: prop === 'name' ? String(value) : !!value } as Props);
      return true;
    }
    return false;
  }
  switch (prop) {
    case 'fillStyleId':
    case 'strokeStyleId':
    case 'effectStyleId':
    case 'gridStyleId':
    case 'textStyleId': {
      const s = value === '' || value === null ? '' : idOf(value);
      if (s && doc.type(s) !== 'STYLE') throw new Error(`Нет стиля ${s}`);
      applyStyle(doc, id, prop as StyleField, s);
      return true;
    }
    case 'description':
      if (type !== 'COMPONENT' && type !== 'COMPONENT_SET') return false;
      doc.set(id, { description: String(value) });
      return true;
    case 'mainComponent':
      if (type !== 'INSTANCE') return false;
      swapComponent(doc, id, idOf(value));
      return true;
    case 'isExposedInstance':
      if (type !== 'INSTANCE') return false;
      doc.set(id, { isExposedInstance: !!value || undefined });
      return true;
    case 'componentPropertyReferences': {
      doc.set(id, { componentPropertyReferences: (value as Props['componentPropertyReferences']) ?? undefined });
      return true;
    }
  }
  return false;
}

/** Methods of styles, variables, collections, components and instances (for node id). */
export function designMethod(doc: Document, id: string, name: string, args: Wire[]): Wire | typeof NOT {
  const type = doc.type(id);
  if (!type) throw new Error(`The node (id: ${id}) does not exist`);
  switch (name) {
    // Variables.
    case 'setValueForMode': {
      const [modeId, value] = args as [string, VariableValue];
      const coll = collectionOf(doc, id);
      if (coll && !(doc.get(coll, 'modes') ?? []).some((m) => m.modeId === modeId)) throw new Error(`Нет режима ${modeId}`);
      setVariableValue(doc, id, String(modeId), value);
      return undefined;
    }
    case 'resolveForConsumer': {
      const consumer = idOf(args[0]);
      return { value: resolveVariable(doc, id, consumer) ?? null, resolvedType: doc.get(id, 'resolvedType') ?? 'FLOAT' };
    }
    case 'setVariableCodeSyntax':
      doc.set(id, { codeSyntax: { ...(doc.get(id, 'codeSyntax') ?? {}), [String(args[0])]: String(args[1]) } });
      return undefined;
    case 'removeVariableCodeSyntax': {
      const cs = { ...(doc.get(id, 'codeSyntax') ?? {}) } as Record<string, string>;
      delete cs[String(args[0])];
      doc.set(id, { codeSyntax: cs });
      return undefined;
    }
    // Collections.
    case 'addMode':
      return addMode(doc, id, String(args[0]));
    case 'removeMode':
      removeMode(doc, id, String(args[0]));
      return undefined;
    case 'renameMode':
      renameMode(doc, id, String(args[0]), String(args[1]));
      return undefined;
    // Layer bindings.
    case 'setBoundVariable':
      bindVariable(doc, id, String(args[0]), args[1] ? idOf(args[1]) : null);
      return undefined;
    case 'setExplicitVariableModeForCollection':
      setExplicitMode(doc, id, idOf(args[0]), String(args[1]));
      return undefined;
    case 'clearExplicitVariableModeForCollection':
      setExplicitMode(doc, id, idOf(args[0]), '');
      return undefined;
    // Components.
    case 'addComponentProperty': {
      const [pname, ptype, def, opts] = args as [string, ComponentPropertyDefinition['type'], string | boolean, { preferredValues?: { key: string }[] } | undefined];
      const pref = opts?.preferredValues?.map((v) => resolveKey(doc, v.key)).filter((x): x is string => !!x);
      return addComponentProperty(doc, id, String(pname), ptype, ptype === 'INSTANCE_SWAP' ? idOf(def) : def, pref ? { preferredValues: pref } : {});
    }
    case 'editComponentProperty': {
      const [key, values] = args as [string, { name?: string; defaultValue?: string | boolean; preferredValues?: { key: string }[] }];
      return editComponentProperty(doc, id, String(key), {
        name: values.name,
        defaultValue: values.defaultValue,
        preferredValues: values.preferredValues?.map((v) => resolveKey(doc, v.key)).filter((x): x is string => !!x),
      });
    }
    case 'deleteComponentProperty':
      deleteComponentProperty(doc, id, String(args[0]));
      return undefined;
    case 'createInstance': {
      if (type !== 'COMPONENT') throw new Error('createInstance есть только у компонента');
      const page = pageOf(doc, id);
      const abs = absolute(doc, id);
      return node(instantiate(doc, id, page, [1, 0, abs[0], 0, 1, abs[1]]));
    }
    case 'setProperties':
      setInstanceProperties(doc, id, args[0] as Record<string, string | boolean>);
      return undefined;
    case 'swapComponent':
      swapComponent(doc, id, idOf(args[0]));
      return undefined;
    case 'resetOverrides':
      resetOverrides(doc, id);
      return undefined;
    case 'detachInstance':
      return node(detachInstance(doc, id));
    case 'getMainComponent': {
      const c = doc.get(id, 'componentId');
      return c && doc.has(c) ? node(c) : null;
    }
    // Styles.
    case 'getStyleConsumers':
      return styleConsumers(doc, id).map((n) => ({ node: node(n), fields: STYLE_FIELD_NAMES.filter((f) => doc.get(n, f) === id) }));
  }
  void applyComponentProperties;
  return NOT;
}

/** Delete a style, variable or collection according to design system rules; false — a regular node. */
export function designRemove(doc: Document, id: string): boolean {
  const t = doc.type(id);
  if (t === 'STYLE') deleteStyle(doc, id);
  else if (t === 'VARIABLE') deleteVariable(doc, id);
  else if (t === 'VARIABLE_COLLECTION') {
    for (const v of variablesIn(doc, id)) deleteVariable(doc, v);
    doc.delete(id);
  } else return false;
  return true;
}

/** Component or set by key (or id). */
function resolveKey(doc: Document, key: string): string | null {
  if (doc.has(key)) return key;
  for (const id of doc.descendants(doc.root)) if (doc.get(id, 'key') === key) return id;
  return null;
}

function pageOf(doc: Document, id: string): string {
  let p = id;
  while (doc.parent(p) && doc.parent(p) !== doc.root) p = doc.parent(p)!;
  return p;
}

function absolute(doc: Document, id: string): [number, number] {
  let x = 0;
  let y = 0;
  for (let n: string | null = id; n && doc.type(n) !== 'PAGE'; n = doc.parent(n)) {
    const t = doc.get(n, 'transform') ?? [1, 0, 0, 0, 1, 0];
    x += t[2];
    y += t[5];
  }
  return [x, y];
}

// ---------- figma.* ----------

export const designGlobals = {
  localStyles(doc: Document, type: Wire) {
    return localStyles(doc, STYLE_TYPE_OF[String(type)]).map((s) => node(s));
  },
  getStyleById(doc: Document, id: Wire) {
    const s = String(id);
    return doc.has(s) && doc.type(s) === 'STYLE' ? node(s) : null;
  },
  createStyle(doc: Document, type: Wire) {
    const t = STYLE_TYPE_OF[String(type)] ?? 'PAINT';
    const name = { PAINT: 'Цвет', TEXT: 'Текст', EFFECT: 'Эффект', GRID: 'Сетка' }[t];
    return node(createStyle(doc, t, `${name} ${localStyles(doc, t).length + 1}`));
  },
  localVariables(doc: Document, type: Wire) {
    // Composite variables (our own) are not for plugins: the API has no such types.
    return localVariables(doc, type ? (String(type) as VariableType) : undefined)
      .filter((v) => !COMPOSITE_VARIABLE_TYPES.includes(doc.get(v, 'resolvedType') ?? 'FLOAT'))
      .map((v) => node(v));
  },
  localCollections(doc: Document) {
    return localCollections(doc).map((c) => node(c));
  },
  getVariableById(doc: Document, id: Wire) {
    const v = String(id);
    return doc.has(v) && doc.type(v) === 'VARIABLE' ? node(v) : null;
  },
  getCollectionById(doc: Document, id: Wire) {
    const c = String(id);
    return doc.has(c) && doc.type(c) === 'VARIABLE_COLLECTION' ? node(c) : null;
  },
  createVariable(doc: Document, name: Wire, collection: Wire, type: Wire) {
    const coll = idOf(collection);
    if (doc.type(coll) !== 'VARIABLE_COLLECTION') throw new Error('Нужна коллекция переменных');
    const t = String(type) as VariableType;
    if (!['BOOLEAN', 'FLOAT', 'STRING', 'COLOR'].includes(t)) throw new Error(`Тип переменной: BOOLEAN, FLOAT, STRING или COLOR, а не ${t}`);
    return node(createVariable(doc, String(name), coll, t));
  },
  createCollection(doc: Document, name: Wire) {
    return node(createCollection(doc, String(name)));
  },
  importVariableByKey(doc: Document, key: Wire) {
    const k = String(key);
    const v = localVariables(doc).find((x) => doc.get(x, 'key') === k || x === k);
    if (!v) throw new Error(`Переменной с ключом ${k} нет (библиотеки подключаются в меню «Дизайн-система»)`);
    return node(v);
  },
  paintWithVariable(doc: Document, paint: Wire, field: Wire, variable: Wire) {
    if (String(field) !== 'color') throw new Error('Привязка у краски — только color');
    return paintWithVariable(doc, paint as Paint, variable ? idOf(variable) : null);
  },
  effectWithVariable(doc: Document, effect: Wire, field: Wire, variable: Wire) {
    return effectWithVariable(doc, effect as Effect, String(field), variable ? idOf(variable) : null);
  },
  combineAsVariants(doc: Document, nodes: Wire, parent: Wire, index: Wire) {
    return node(combineAsVariants(doc, (nodes as Wire[]).map(idOf), idOf(parent), index === null || index === undefined ? undefined : Number(index)));
  },
};
