// Styles: color, text, effects, grids — STYLE nodes on the internal resources page
// (it is not in the page list). Style values are in its regular properties: color uses fills,
// effects use effects, grids use layoutGrids, text uses text properties.
//
// A layer with a style stores a reference (fillStyleId, strokeStyleId, textStyleId, effectStyleId,
// gridStyleId) and a copy of the values: rendering, layout and plugins do not need styles. Editing a
// style rewrites the copies in all layers (DesignSync); editing a value in the layer detaches the style.
// Text can also have references on runs (a style on part of the text).

import type { Document } from './document.ts';
import { restyleText } from './text-style.ts';
import type { NodeType, Props, TextStyle } from './types.ts';

export type StyleField = 'fillStyleId' | 'strokeStyleId' | 'textStyleId' | 'effectStyleId' | 'gridStyleId';
export type StyleType = 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';

/** Text style properties on text runs (like TextStyle in Plugin API). */
export const TEXT_STYLE_RUN_PROPS = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'openTypeFeatures'] as const;
/** Text style properties on paragraphs (stored on the node in the model). */
export const TEXT_STYLE_NODE_PROPS = ['paragraphSpacing', 'paragraphIndent', 'listSpacing', 'leadingTrim'] as const;

/** Layer style field: style type and the layer properties it sets. */
export const STYLE_FIELDS: Record<StyleField, { styleType: StyleType; keys: readonly string[] }> = {
  fillStyleId: { styleType: 'PAINT', keys: ['fills'] },
  strokeStyleId: { styleType: 'PAINT', keys: ['strokes'] },
  effectStyleId: { styleType: 'EFFECT', keys: ['effects'] },
  gridStyleId: { styleType: 'GRID', keys: ['layoutGrids'] },
  textStyleId: { styleType: 'TEXT', keys: [...TEXT_STYLE_RUN_PROPS, ...TEXT_STYLE_NODE_PROPS] },
};
export const STYLE_FIELD_NAMES = Object.keys(STYLE_FIELDS) as StyleField[];

/** Layer property → the style field that sets it. */
export const STYLE_FIELD_OF_KEY: ReadonlyMap<string, StyleField> = new Map(STYLE_FIELD_NAMES.flatMap((f) => STYLE_FIELDS[f].keys.map((k) => [k, f] as [string, StyleField])));

/** Which style fields a layer type can have. */
export function styleFieldsFor(type: NodeType | undefined): StyleField[] {
  switch (type) {
    case 'TEXT':
      return ['textStyleId', 'fillStyleId', 'strokeStyleId', 'effectStyleId'];
    case 'FRAME':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
      return ['fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId'];
    case 'GROUP':
      return ['effectStyleId'];
    case 'STYLE':
    case 'PAGE':
    case 'DOCUMENT':
    case 'VARIABLE':
    case 'VARIABLE_COLLECTION':
    case undefined:
      return [];
    default:
      return ['fillStyleId', 'strokeStyleId', 'effectStyleId'];
  }
}

/** Internal resources page (styles, variables, library mains); create — create it if missing. */
export function resourcesPage(doc: Document, create = true): string | null {
  for (const p of doc.children(doc.root)) if (doc.get(p, 'internal') && !doc.get(p, 'commentsPage') && !doc.get(p, 'patternArchive')) return p;
  if (!create) return null;
  return doc.create('PAGE', doc.root, { name: 'Ресурсы', internal: true });
}

/** Found internal nodes by type — until the document tree changes (treeVersion). */
const RESOURCES = new WeakMap<Document, { version: number; byType: Map<NodeType, string[]> }>();

/**
 * All nodes of type type on internal pages (in document order). Traversed once per document tree
 * change: an internal page can hold tens of thousands of nodes (library mains), and panels ask
 * for them every frame.
 */
export function resourceNodes(doc: Document, type: NodeType): string[] {
  let cache = RESOURCES.get(doc);
  if (!cache || cache.version !== doc.treeVersion) RESOURCES.set(doc, (cache = { version: doc.treeVersion, byType: new Map() }));
  let found = cache.byType.get(type);
  if (!found) {
    found = [];
    for (const p of doc.children(doc.root)) {
      if (!doc.get(p, 'internal') || doc.get(p, 'patternArchive')) continue;
      const stack = [...doc.children(p)].reverse();
      while (stack.length) {
        const id = stack.pop()!;
        if (doc.type(id) === type) found.push(id);
        const kids = doc.children(id);
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
      }
    }
    cache.byType.set(type, found);
  }
  return [...found];
}

/** Local styles (all or of one type), like getLocal*Styles. */
export function localStyles(doc: Document, styleType?: StyleType): string[] {
  return resourceNodes(doc, 'STYLE').filter((s) => !styleType || doc.get(s, 'styleType') === styleType);
}

/** Create a style (like create*Style); values — its values (fills, effects, text properties…). */
export function createStyle(doc: Document, styleType: StyleType, name: string, values: Props = {}): string {
  const page = resourcesPage(doc)!;
  return doc.create('STYLE', page, { ...values, name, styleType });
}

/** Style values for a layer field (for stroke — the style's fills). */
export function styleValues(doc: Document, styleId: string, field: StyleField): Props {
  switch (field) {
    case 'fillStyleId':
      return { fills: doc.get(styleId, 'fills') };
    case 'strokeStyleId':
      return { strokes: doc.get(styleId, 'fills') };
    case 'effectStyleId':
      return { effects: doc.get(styleId, 'effects') };
    case 'gridStyleId':
      return { layoutGrids: doc.get(styleId, 'layoutGrids') };
    case 'textStyleId': {
      const out: Record<string, unknown> = {};
      for (const k of STYLE_FIELDS.textStyleId.keys) out[k] = doc.get(styleId, k as keyof Props);
      // Color in a text style (MFP extension; request “include color in text styles”): only if the style
      // sets it — otherwise the text color is left alone.
      const fills = doc.type(styleId) === 'STYLE' ? doc.get(styleId, 'fills') : undefined;
      if (fills?.length) out.fills = fills;
      return out as Props;
    }
  }
}

/** Layer values for a new style (style from selection): for stroke — into the style's fills. */
export function valuesForStyle(doc: Document, id: string, field: StyleField): Props {
  const v = styleValues(doc, id, field === 'strokeStyleId' ? 'fillStyleId' : field);
  if (field === 'strokeStyleId') return { fills: doc.get(id, 'strokes') };
  return v;
}

/** Text ranges [start, end) where the characters' style field equals styleId. */
export function textStyleSpans(doc: Document, id: string, field: 'textStyleId' | 'fillStyleId', styleId: string): [number, number][] {
  const p = doc.props(id);
  const len = (p.characters ?? '').length;
  const base = p[field] ?? '';
  const out: [number, number][] = [];
  let pos = 0;
  const push = (a: number, b: number) => {
    const last = out[out.length - 1];
    if (last && last[1] === a) last[1] = b;
    else out.push([a, b]);
  };
  for (const r of p.textRuns ?? []) {
    const v = r.style[field] ?? base;
    if (v === styleId && r.length) push(pos, pos + r.length);
    pos += r.length;
  }
  if (pos < len && base === styleId) push(pos, len);
  if (!len && base === styleId) out.push([0, 0]);
  return out;
}

/** Apply a style to text on a range: reference and values on runs, paragraph properties on the node. */
export function applyTextStyleRange(doc: Document, id: string, start: number, end: number, field: 'textStyleId' | 'fillStyleId', styleId: string) {
  const len = (doc.get(id, 'characters') ?? '').length;
  const values = styleId && doc.has(styleId) ? (styleValues(doc, styleId, field) as Record<string, unknown>) : {};
  const run: Record<string, unknown> = { [field]: styleId };
  const node: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if ((TEXT_STYLE_NODE_PROPS as readonly string[]).includes(k)) node[k] = v;
    else run[k] = v;
  }
  restyleText(doc, id, start, end, () => run as TextStyle, false, true);
  // Paragraph properties apply to the whole text if the style covers the whole text.
  if (Object.keys(node).length && start <= 0 && end >= len) doc.set(id, node as Props);
}

/**
 * Apply a style to a layer (styleId '' — detach: values stay, the reference is removed).
 * For text — to the whole text.
 */
export function applyStyle(doc: Document, id: string, field: StyleField, styleId: string) {
  if (doc.type(id) === 'TEXT' && (field === 'textStyleId' || field === 'fillStyleId')) {
    const len = (doc.get(id, 'characters') ?? '').length;
    applyTextStyleRange(doc, id, 0, len, field, styleId);
    return;
  }
  if (!styleId || !doc.has(styleId)) {
    doc.set(id, { [field]: '' } as Props);
    return;
  }
  doc.set(id, { [field]: styleId, ...styleValues(doc, styleId, field) } as Props);
}

/** Rewrite style values in a layer (after a style edit): only where it references this style. */
export function pushStyle(doc: Document, id: string, styleId: string) {
  if (!doc.has(id) || !doc.has(styleId)) return;
  const type = doc.type(id);
  for (const field of STYLE_FIELD_NAMES) {
    if (type === 'TEXT' && (field === 'textStyleId' || field === 'fillStyleId')) {
      const spans = textStyleSpans(doc, id, field, styleId);
      for (const [a, b] of spans) applyTextStyleRange(doc, id, a, b, field, styleId);
      continue;
    }
    if (doc.get(id, field) !== styleId) continue;
    doc.set(id, styleValues(doc, styleId, field));
  }
}

/** Layers that reference the style (across the whole document). */
export function styleConsumers(doc: Document, styleId: string): string[] {
  const out: string[] = [];
  for (const id of doc.descendants(doc.root)) {
    const p = doc.node(id)!.props as Record<string, unknown>;
    if (STYLE_FIELD_NAMES.some((f) => p[f] === styleId) || p.textRuns && (p.textRuns as { style: Record<string, unknown> }[]).some((r) => r.style.textStyleId === styleId || r.style.fillStyleId === styleId)) out.push(id);
  }
  return out;
}

/** Delete a style: layers keep their values, references are removed. */
export function deleteStyle(doc: Document, styleId: string) {
  for (const id of styleConsumers(doc, styleId)) {
    for (const f of STYLE_FIELD_NAMES) {
      if (doc.type(id) === 'TEXT' && (f === 'textStyleId' || f === 'fillStyleId')) {
        for (const [a, b] of textStyleSpans(doc, id, f, styleId)) restyleText(doc, id, a, b, () => ({ [f]: '' }) as TextStyle, false, true);
      } else if (doc.get(id, f) === styleId) doc.set(id, { [f]: '' } as Props);
    }
  }
  doc.delete(styleId);
}

/** Style name without groups: “Brand/Primary” → “Primary”. */
export const styleLeafName = (name: string) => name.split('/').pop()!.trim();
