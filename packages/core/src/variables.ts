// Variables: collections with modes (VARIABLE_COLLECTION) and variables
// (VARIABLE) — values by mode, references to other variables or expressions (our extension:
// “{Spacing/base} * 2”, color with opacity and color mixing). Collections and variables live on
// the internal resources page.
//
// Binding: boundVariables on a layer (field → variable), paints and effects have their own. The
// layer also stores the value: rendering and layout do not need variables. DesignSync recomputes the
// value when a variable is edited, when the mode changes on the layer or an ancestor
// (explicitVariableModes) and when the layer is moved.

import type { Document } from './document.ts';
import { resourceNodes, resourcesPage } from './styles.ts';
import { restyleText, styleName, styleWeight } from './text-style.ts';
import { compositeRefs, defaultComposite, gradientPaintOf, isComposite, resolveComposite, typographyPropsOf, withShadows } from './composite-variables.ts';
import type { Effect, LetterSpacing, LineHeight, Paint, Props, RGBA, SolidPaint, TextStyle, VariableAlias, VariableExpression, VariableValue } from './types.ts';

export type VariableType = 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR' | 'GRADIENT' | 'SHADOW' | 'TYPOGRAPHY';

/** Composite types (MFP extension): bound to a paint, the layer's shadows and the whole text formatting. */
export const COMPOSITE_VARIABLE_TYPES: readonly VariableType[] = ['GRADIENT', 'SHADOW', 'TYPOGRAPHY'];

/** Layer fields that bind to a variable (like VariableBindableNodeField), and the value type. */
export const NODE_VARIABLE_FIELDS: Readonly<Record<string, VariableType>> = {
  width: 'FLOAT',
  height: 'FLOAT',
  minWidth: 'FLOAT',
  maxWidth: 'FLOAT',
  minHeight: 'FLOAT',
  maxHeight: 'FLOAT',
  itemSpacing: 'FLOAT',
  counterAxisSpacing: 'FLOAT',
  paddingLeft: 'FLOAT',
  paddingRight: 'FLOAT',
  paddingTop: 'FLOAT',
  paddingBottom: 'FLOAT',
  gridRowGap: 'FLOAT',
  gridColumnGap: 'FLOAT',
  cornerRadius: 'FLOAT',
  topLeftRadius: 'FLOAT',
  topRightRadius: 'FLOAT',
  bottomLeftRadius: 'FLOAT',
  bottomRightRadius: 'FLOAT',
  strokeWeight: 'FLOAT',
  strokeTopWeight: 'FLOAT',
  strokeRightWeight: 'FLOAT',
  strokeBottomWeight: 'FLOAT',
  strokeLeftWeight: 'FLOAT',
  opacity: 'FLOAT',
  visible: 'BOOLEAN',
  characters: 'STRING',
  fontFamily: 'STRING',
  fontStyle: 'STRING',
  fontWeight: 'FLOAT',
  fontSize: 'FLOAT',
  letterSpacing: 'FLOAT',
  lineHeight: 'FLOAT',
  paragraphSpacing: 'FLOAT',
  paragraphIndent: 'FLOAT',
  // Composite (MFP extension): layer shadows and text formatting with a single variable.
  shadows: 'SHADOW',
  typography: 'TYPOGRAPHY',
};

/** Layer properties set by a variable field. */
export function fieldKeys(field: string): string[] {
  if (field === 'shadows') return ['effects'];
  if (field === 'typography') return ['fontName', 'fontSize', 'lineHeight', 'letterSpacing'];
  return field === 'fontFamily' || field === 'fontStyle' || field === 'fontWeight' ? ['fontName'] : [field];
}

/** Scopes suitable for a field (like VariableScope). */
export function fieldScopes(field: string, nodeType?: string): string[] {
  switch (field) {
    case 'width':
    case 'height':
    case 'minWidth':
    case 'maxWidth':
    case 'minHeight':
    case 'maxHeight':
      return ['WIDTH_HEIGHT'];
    case 'itemSpacing':
    case 'counterAxisSpacing':
    case 'paddingLeft':
    case 'paddingRight':
    case 'paddingTop':
    case 'paddingBottom':
    case 'gridRowGap':
    case 'gridColumnGap':
      return ['GAP'];
    case 'cornerRadius':
    case 'topLeftRadius':
    case 'topRightRadius':
    case 'bottomLeftRadius':
    case 'bottomRightRadius':
      return ['CORNER_RADIUS'];
    case 'strokeWeight':
    case 'strokeTopWeight':
    case 'strokeRightWeight':
    case 'strokeBottomWeight':
    case 'strokeLeftWeight':
      return ['STROKE_FLOAT'];
    case 'opacity':
      return ['OPACITY'];
    case 'characters':
      return ['TEXT_CONTENT'];
    case 'fontFamily':
      return ['FONT_FAMILY'];
    case 'fontStyle':
      return ['FONT_STYLE'];
    case 'fontWeight':
      return ['FONT_WEIGHT', 'FONT_STYLE'];
    case 'fontSize':
      return ['FONT_SIZE'];
    case 'lineHeight':
      return ['LINE_HEIGHT'];
    case 'letterSpacing':
      return ['LETTER_SPACING'];
    case 'paragraphSpacing':
      return ['PARAGRAPH_SPACING'];
    case 'paragraphIndent':
      return ['PARAGRAPH_INDENT'];
    case 'fills':
      return nodeType === 'TEXT' ? ['ALL_FILLS', 'TEXT_FILL'] : nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE' ? ['ALL_FILLS', 'FRAME_FILL'] : ['ALL_FILLS', 'SHAPE_FILL'];
    case 'strokes':
      return ['STROKE_COLOR'];
    case 'effectColor':
      return ['EFFECT_COLOR'];
    case 'effectFloat':
      return ['EFFECT_FLOAT'];
    case 'shadows':
      return ['EFFECT_SHADOW'];
    case 'typography':
      return ['TEXT_STYLE'];
    default:
      return [];
  }
}

/** Whether the variable suits the field by its scopes. */
export function variableAllowed(doc: Document, variableId: string, field: string, nodeType?: string): boolean {
  const scopes = doc.get(variableId, 'scopes') ?? ['ALL_SCOPES'];
  if (!scopes.length || scopes.includes('ALL_SCOPES')) return true;
  return fieldScopes(field, nodeType).some((s) => scopes.includes(s));
}

export const alias = (id: string): VariableAlias => ({ type: 'VARIABLE_ALIAS', id });

/** Variable value as text: color — #RRGGBB (with alpha — #RRGGBBAA), number — up to 4 digits, boolean — true/false. */
export function variableText(value: unknown): string {
  if (value && typeof value === 'object' && 'r' in value && 'g' in value && 'b' in value) {
    const c = value as RGBA;
    const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0').toUpperCase();
    return `#${h(c.r)}${h(c.g)}${h(c.b)}${(c.a ?? 1) < 1 ? h(c.a ?? 1) : ''}`;
  }
  if (typeof value === 'number') return String(Math.round(value * 10000) / 10000);
  if (typeof value === 'object' && value) return '';
  return String(value ?? '');
}
export const isAlias = (v: unknown): v is VariableAlias => !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'VARIABLE_ALIAS';
export const isExpression = (v: unknown): v is VariableExpression => !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'EXPRESSION';
export const isColor = (v: unknown): v is RGBA => !!v && typeof v === 'object' && 'r' in v && 'g' in v && 'b' in v;

// ---------- Collections, modes, variables ----------

/** The variable's collection. */
export function collectionOf(doc: Document, variableId: string): string | null {
  const p = doc.parent(variableId);
  return p && doc.type(p) === 'VARIABLE_COLLECTION' ? p : null;
}

export function localCollections(doc: Document): string[] {
  return resourceNodes(doc, 'VARIABLE_COLLECTION');
}

/** Local variables (of one type or all), like getLocalVariables. */
export function localVariables(doc: Document, type?: VariableType): string[] {
  return resourceNodes(doc, 'VARIABLE').filter((v) => !type || doc.get(v, 'resolvedType') === type);
}

export function variablesIn(doc: Document, collection: string): string[] {
  return doc.children(collection).filter((c) => doc.type(c) === 'VARIABLE');
}

/** The collection's default mode (the first one if not set). */
export function defaultMode(doc: Document, collection: string): string {
  const modes = doc.get(collection, 'modes') ?? [];
  const d = doc.get(collection, 'defaultModeId');
  return d && modes.some((m) => m.modeId === d) ? d : (modes[0]?.modeId ?? '');
}

/** Create a collection with one mode. */
export function createCollection(doc: Document, name: string): string {
  const id = doc.create('VARIABLE_COLLECTION', resourcesPage(doc)!, { name });
  const modeId = doc.newId();
  doc.set(id, { modes: [{ modeId, name: 'Mode 1' }], defaultModeId: modeId });
  return id;
}

/** Add a mode: variable values are as in the default mode; extensions get their own mode for it. */
export function addMode(doc: Document, collection: string, name: string): string {
  const modeId = doc.newId();
  const def = defaultMode(doc, collection);
  doc.set(collection, { modes: [...(doc.get(collection, 'modes') ?? []), { modeId, name }] });
  if (!doc.get(collection, 'defaultModeId')) doc.set(collection, { defaultModeId: modeId });
  for (const v of variablesIn(doc, collection)) {
    const vals = doc.get(v, 'valuesByMode') ?? {};
    if (def && vals[def] !== undefined) doc.set(v, { valuesByMode: { ...vals, [modeId]: vals[def] } });
  }
  for (const ext of extensionsOf(doc, collection)) doc.set(ext, { modes: [...(doc.get(ext, 'modes') ?? []), { modeId: doc.newId(), name, parentModeId: modeId }] });
  return modeId;
}

// ---------- Collection extensions (multi-brand) ----------

/** Direct extensions of the collection. */
export function extensionsOf(doc: Document, collection: string): string[] {
  return localCollections(doc).filter((c) => doc.get(c, 'extendsCollection') === collection);
}

/** The collection and its parents along the extension chain (itself first). */
export function collectionChain(doc: Document, collection: string): string[] {
  const out: string[] = [];
  for (let c: string | undefined = collection; c && doc.has(c) && !out.includes(c) && out.length < 8; c = doc.get(c, 'extendsCollection')) out.push(c);
  return out;
}

/**
 * Extend a collection: a new collection with the parent's modes (each extends its own); variables are
 * the parent's, values are the parent's too until an own one is set (an override).
 */
export function extendCollection(doc: Document, parent: string, name: string): string {
  const id = doc.create('VARIABLE_COLLECTION', resourcesPage(doc)!, { name, extendsCollection: parent });
  const modes = (doc.get(parent, 'modes') ?? []).map((m) => ({ modeId: doc.newId(), name: m.name, parentModeId: m.modeId }));
  const def = defaultMode(doc, parent);
  doc.set(id, { modes, defaultModeId: modes.find((m) => m.parentModeId === def)?.modeId ?? modes[0]?.modeId });
  return id;
}

/** Variables visible in the collection: the parents' (top-down along the chain) and its own. */
export function collectionVariables(doc: Document, collection: string): string[] {
  return collectionChain(doc, collection)
    .reverse()
    .flatMap((c) => variablesIn(doc, c));
}

/** Own value of a parent variable in an extension mode; undefined — remove it (back to the parent's). */
export function setVariableOverride(doc: Document, extension: string, variableId: string, modeId: string, value: VariableValue | undefined) {
  const all = { ...(doc.get(extension, 'variableOverrides') ?? {}) };
  const own = { ...(all[variableId] ?? {}) };
  if (value === undefined) delete own[modeId];
  else own[modeId] = value;
  if (Object.keys(own).length) all[variableId] = own;
  else delete all[variableId];
  doc.set(extension, { variableOverrides: Object.keys(all).length ? all : undefined });
}

/**
 * Where a layer gets the mode of collection base for a variable: the nearest ancestor with an explicit mode
 * of the collection itself or any of its extensions (a brand on a frame); explicit — explicitly set modes (variables window).
 */
export function modeContext(doc: Document, nodeId: string | null, base: string, explicit?: Record<string, string>): { collection: string; modeId: string } {
  const valid = (c: string, m: string | undefined) => !!m && (doc.get(c, 'modes') ?? []).some((x) => x.modeId === m);
  const extends_ = (c: string) => c !== base && collectionChain(doc, c).includes(base);
  if (explicit) {
    if (valid(base, explicit[base])) return { collection: base, modeId: explicit[base]! };
    for (const [c, m] of Object.entries(explicit)) if (doc.has(c) && extends_(c) && valid(c, m)) return { collection: c, modeId: m };
  }
  for (let n = nodeId; n; n = doc.parent(n)) {
    const em = doc.get(n, 'explicitVariableModes');
    if (!em) continue;
    // On the same layer, an extension (brand) refines the parent's mode — it takes precedence.
    for (const [c, m] of Object.entries(em)) if (doc.has(c) && extends_(c) && valid(c, m)) return { collection: c, modeId: m };
    if (valid(base, em[base])) return { collection: base, modeId: em[base]! };
  }
  return { collection: base, modeId: defaultMode(doc, base) };
}

/** Raw variable value in a mode of the collection (or its extension): the extension's own value takes precedence. */
function rawValue(doc: Document, variableId: string, base: string, ctx: { collection: string; modeId: string }): VariableValue | undefined {
  let c = ctx.collection;
  let m = ctx.modeId;
  for (let guard = 0; guard < 8 && c !== base; guard++) {
    const own = doc.get(c, 'variableOverrides')?.[variableId]?.[m];
    if (own !== undefined) return own;
    const parent = doc.get(c, 'extendsCollection');
    if (!parent || !doc.has(parent)) break;
    m = (doc.get(c, 'modes') ?? []).find((x) => x.modeId === m)?.parentModeId ?? defaultMode(doc, parent);
    c = parent;
  }
  const vals = doc.get(variableId, 'valuesByMode') ?? {};
  return vals[c === base ? m : defaultMode(doc, base)] ?? vals[defaultMode(doc, base)] ?? Object.values(vals)[0];
}

/** Variable value in a mode of the collection or extension (variables window; references not resolved). */
export function variableValueIn(doc: Document, variableId: string, collection: string, modeId: string): VariableValue | undefined {
  const base = collectionOf(doc, variableId);
  return base ? rawValue(doc, variableId, base, { collection, modeId }) : undefined;
}

export function renameMode(doc: Document, collection: string, modeId: string, name: string) {
  doc.set(collection, { modes: (doc.get(collection, 'modes') ?? []).map((m) => (m.modeId === modeId ? { ...m, name } : m)) });
}

/** Delete a mode (the last one is not deleted): variable values in it too. */
export function removeMode(doc: Document, collection: string, modeId: string) {
  const modes = (doc.get(collection, 'modes') ?? []).filter((m) => m.modeId !== modeId);
  if (!modes.length) return;
  const props: Props = { modes };
  if (doc.get(collection, 'defaultModeId') === modeId) props.defaultModeId = modes[0]!.modeId;
  doc.set(collection, props);
  for (const v of variablesIn(doc, collection)) {
    const vals = { ...(doc.get(v, 'valuesByMode') ?? {}) };
    if (!(modeId in vals)) continue;
    delete vals[modeId];
    doc.set(v, { valuesByMode: vals });
  }
}

export const defaultValueFor = (type: VariableType): VariableValue =>
  type === 'BOOLEAN' ? false : type === 'FLOAT' ? 0 : type === 'STRING' ? '' : type === 'COLOR' ? { r: 0, g: 0, b: 0, a: 1 } : defaultComposite(type);

/** Create a variable in a collection; value — the value in all modes. */
export function createVariable(doc: Document, name: string, collection: string, type: VariableType, value?: VariableValue): string {
  const v = value ?? defaultValueFor(type);
  const valuesByMode: Record<string, VariableValue> = {};
  for (const m of doc.get(collection, 'modes') ?? []) valuesByMode[m.modeId] = v;
  return doc.create('VARIABLE', collection, { name, resolvedType: type, valuesByMode });
}

export function setVariableValue(doc: Document, variableId: string, modeId: string, value: VariableValue) {
  doc.set(variableId, { valuesByMode: { ...(doc.get(variableId, 'valuesByMode') ?? {}), [modeId]: value } });
}

/** Delete a variable: layers keep their values; other variables' references are replaced with its values. */
export function deleteVariable(doc: Document, variableId: string) {
  for (const v of localVariables(doc)) {
    const vals = doc.get(v, 'valuesByMode') ?? {};
    let changed = false;
    const next: Record<string, VariableValue> = {};
    for (const [m, val] of Object.entries(vals)) {
      if (isAlias(val) && val.id === variableId) {
        next[m] = resolveVariable(doc, variableId, null) ?? defaultValueFor(doc.get(v, 'resolvedType') ?? 'FLOAT');
        changed = true;
      } else next[m] = val;
    }
    if (changed) doc.set(v, { valuesByMode: next });
  }
  doc.delete(variableId);
}

/** Variable by name: first in collection from, then in all. The name is full (“Spacing/base”). */
export function findVariable(doc: Document, name: string, collection?: string | null): string | null {
  const n = name.trim();
  if (collection) for (const v of variablesIn(doc, collection)) if (doc.get(v, 'name') === n) return v;
  for (const v of localVariables(doc)) if (doc.get(v, 'name') === n) return v;
  // “Collection/name”.
  const i = n.indexOf('/');
  if (i > 0) {
    for (const c of localCollections(doc)) {
      if (doc.get(c, 'name') !== n.slice(0, i)) continue;
      for (const v of variablesIn(doc, c)) if (doc.get(v, 'name') === n.slice(i + 1)) return v;
    }
  }
  return null;
}

// ---------- Modes and values ----------

/** Collection mode on a layer: set on the layer or the nearest ancestor, otherwise the default. */
export function modeFor(doc: Document, nodeId: string | null, collection: string, explicit?: Record<string, string>): string {
  const modes = doc.get(collection, 'modes') ?? [];
  const forced = explicit?.[collection];
  if (forced && modes.some((x) => x.modeId === forced)) return forced;
  for (let n = nodeId; n; n = doc.parent(n)) {
    const m = doc.get(n, 'explicitVariableModes')?.[collection];
    if (m && modes.some((x) => x.modeId === m)) return m;
  }
  return defaultMode(doc, collection);
}

/**
 * Variable value for a layer (null — in default modes): references and expressions resolved.
 * explicit — explicitly set collection modes (variables window: the value in a mode column).
 */
export function resolveVariable(doc: Document, variableId: string, nodeId: string | null, depth = 0, explicit?: Record<string, string>): VariableValue | undefined {
  if (depth > 16 || !doc.has(variableId) || doc.type(variableId) !== 'VARIABLE') return undefined;
  const coll = collectionOf(doc, variableId);
  // The mode comes from the nearest ancestor: of the collection itself or its extension (a brand on a frame).
  const v = coll ? rawValue(doc, variableId, coll, modeContext(doc, nodeId, coll, explicit)) : Object.values(doc.get(variableId, 'valuesByMode') ?? {})[0];
  if (isAlias(v)) return resolveVariable(doc, v.id, nodeId, depth + 1, explicit);
  if (isExpression(v)) return evaluateExpression(doc, v.expression, nodeId, coll, depth + 1, explicit);
  return v;
}

// ---------- Expressions (our extension) ----------

type Val = number | string | boolean | RGBA;

/**
 * Expression: numbers, quoted strings, variable references in curly braces, + − × ÷ %,
 * parentheses and the functions min, max, round, floor, ceil, abs, alpha(color, a), mix(color, color, t).
 * Logic (MFP extension): negation “!” / not / не, comparisons == != < > <= >=, и / and / &&, или / or / ||,
 * if(condition, yes, no) — a boolean variable “not {SignedIn}” without a second variable.
 */
export function evaluateExpression(doc: Document, expression: string, nodeId: string | null, collection: string | null, depth = 0, explicit?: Record<string, string>): VariableValue | undefined {
  let i = 0;
  const s = expression;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const fail = (): never => {
    throw new Error(`Ошибка в выражении: «${s}»`);
  };
  const num = (v: Val) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : typeof v === 'string' && v.trim() !== '' && !isNaN(+v) ? +v : fail());
  /** Truthiness: true / false, a non-zero number, a non-empty string, a color — always. */
  const truth = (v: Val) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : typeof v === 'string' ? v !== '' && v !== 'false' : true);
  /** Word operator at position i (not the start of another word): and, or, not, и, или, не. */
  const word = (...ws_: string[]) => {
    for (const w of ws_) {
      if (!s.startsWith(w, i)) continue;
      const next = s[i + w.length];
      if (next && /[\p{L}\d_]/u.test(next)) continue;
      i += w.length;
      return true;
    }
    return false;
  };
  const primary = (): Val => {
    ws();
    const c = s[i];
    if (c === '(') {
      i++;
      const v = expr();
      ws();
      if (s[i++] !== ')') fail();
      return v;
    }
    if (c === '-') {
      i++;
      return -num(primary());
    }
    if (c === '!' && s[i + 1] !== '=') {
      i++;
      return !truth(primary());
    }
    if (word('not', 'не')) return !truth(primary());
    if (c === '{') {
      const end = s.indexOf('}', i);
      if (end < 0) fail();
      const name = s.slice(i + 1, end);
      i = end + 1;
      const id = findVariable(doc, name, collection);
      const v = id ? resolveVariable(doc, id, nodeId, depth + 1, explicit) : undefined;
      if (v === undefined || isAlias(v) || isExpression(v)) fail();
      return v as Val;
    }
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      if (end < 0) fail();
      const v = s.slice(i + 1, end);
      i = end + 1;
      return v;
    }
    const m = /^(\d+(?:\.\d*)?|\.\d+)/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      return parseFloat(m[0]);
    }
    const w = /^[a-zA-Z_]\w*/.exec(s.slice(i));
    if (w) {
      i += w[0].length;
      if (w[0] === 'true' || w[0] === 'false') return w[0] === 'true';
      ws();
      if (s[i++] !== '(') fail();
      const args: Val[] = [];
      ws();
      if (s[i] !== ')') {
        for (;;) {
          args.push(expr());
          ws();
          if (s[i] === ',') {
            i++;
            continue;
          }
          break;
        }
      }
      if (s[i++] !== ')') fail();
      return call(w[0], args);
    }
    return fail();
  };
  const call = (f: string, a: Val[]): Val => {
    switch (f) {
      case 'min':
        return Math.min(...a.map(num));
      case 'max':
        return Math.max(...a.map(num));
      case 'round':
        return Math.round(num(a[0]!));
      case 'floor':
        return Math.floor(num(a[0]!));
      case 'ceil':
        return Math.ceil(num(a[0]!));
      case 'abs':
        return Math.abs(num(a[0]!));
      case 'if':
        return truth(a[0]!) ? a[1]! : (a[2] ?? false);
      case 'alpha': {
        const c = a[0];
        if (!isColor(c)) fail();
        return { ...(c as RGBA), a: num(a[1]!) };
      }
      case 'mix': {
        const [x, y] = [a[0], a[1]];
        if (!isColor(x) || !isColor(y)) fail();
        const t = num(a[2] ?? 0.5);
        const [p, q] = [x as RGBA, y as RGBA];
        return { r: p.r + (q.r - p.r) * t, g: p.g + (q.g - p.g) * t, b: p.b + (q.b - p.b) * t, a: (p.a ?? 1) + ((q.a ?? 1) - (p.a ?? 1)) * t };
      }
      default:
        return fail();
    }
  };
  const multiplicative = (): Val => {
    let v = primary();
    for (;;) {
      ws();
      const op = s[i];
      if (op !== '*' && op !== '/' && op !== '%') return v;
      i++;
      const r = num(primary());
      v = op === '*' ? num(v) * r : op === '/' ? num(v) / r : num(v) % r;
    }
  };
  const additive = (): Val => {
    let v = multiplicative();
    for (;;) {
      ws();
      const op = s[i];
      if (op !== '+' && op !== '-') return v;
      i++;
      const r = multiplicative();
      v = op === '+' && (typeof v === 'string' || typeof r === 'string') ? `${v}${r}` : op === '+' ? num(v) + num(r) : num(v) - num(r);
    }
  };
  /** Equality: numbers by value, colors by channels, everything else strictly. */
  const same = (x: Val, y: Val) => {
    if (isColor(x) && isColor(y)) return colorHex(x as RGBA) === colorHex(y as RGBA);
    if (typeof x === 'number' || typeof y === 'number') return num(x) === num(y);
    return x === y;
  };
  const compare = (): Val => {
    const v = additive();
    ws();
    const op = /^(==|!=|<=|>=|<|>)/.exec(s.slice(i))?.[0];
    if (!op) return v;
    i += op.length;
    const r = additive();
    switch (op) {
      case '==':
        return same(v, r);
      case '!=':
        return !same(v, r);
      case '<':
        return num(v) < num(r);
      case '>':
        return num(v) > num(r);
      case '<=':
        return num(v) <= num(r);
      default:
        return num(v) >= num(r);
    }
  };
  const and = (): Val => {
    let v = compare();
    for (;;) {
      ws();
      if (s.startsWith('&&', i)) i += 2;
      else if (!word('and', 'и')) return v;
      const r = compare();
      v = truth(v) && truth(r);
    }
  };
  const expr = (): Val => {
    let v = and();
    for (;;) {
      ws();
      if (s.startsWith('||', i)) i += 2;
      else if (!word('or', 'или')) return v;
      const r = and();
      v = truth(v) || truth(r);
    }
  };
  try {
    const v = expr();
    ws();
    if (i < s.length) fail();
    return v as VariableValue;
  } catch {
    return undefined;
  }
}

// ---------- Binding to layers ----------

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Number variable unit (none — pixels or a plain number). */
export type VariableUnit = 'REM' | 'PERCENT' | 'MULTIPLIER';

/** Document root font size (1 rem), px. */
export const rootFontSize = (doc: Document) => doc.get(doc.root, 'rootFontSize') ?? 16;

/**
 * Variable value → layer properties for a field (null — not suitable). unit — the variable's unit:
 * rem — to pixels from the root font size; percent and “unitless” for line height (and percent
 * for letter spacing) — as in CSS, relative to the font size; other fields take the number as is.
 */
export function fieldProps(doc: Document, id: string, field: string, value: VariableValue, unit?: VariableUnit): Props | null {
  // Composite: shadows and typography — with references inside, resolved for this layer.
  if (isComposite(value)) {
    const v = resolveComposite(value, (ref) => resolveVariable(doc, ref, id));
    if (field === 'shadows' && v.type === 'SHADOWS') return { effects: withShadows(doc.get(id, 'effects'), v) };
    if (field === 'typography' && v.type === 'TYPOGRAPHY') return typographyPropsOf(v);
    return null;
  }
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' && !isNaN(+value) ? +value : NaN;
  const n = unit === 'REM' && field !== 'opacity' && field !== 'fontWeight' ? raw * rootFontSize(doc) : raw;
  switch (field) {
    case 'visible':
      return { visible: value === true || value === 'true' || (typeof value === 'number' && value !== 0) };
    case 'characters':
      // Text shows a variable value of any kind (MFP extension): color as HEX, number as is.
      return { characters: variableText(value) };
    case 'opacity':
      return isNaN(n) ? null : { opacity: Math.max(0, Math.min(1, n / 100)) };
    case 'fontFamily':
      return typeof value === 'string' ? { fontName: { family: value, style: doc.get(id, 'fontName')?.style ?? 'Regular' } } : null;
    case 'fontStyle':
      return typeof value === 'string' ? { fontName: { family: doc.get(id, 'fontName')?.family ?? 'Inter', style: value } } : null;
    case 'fontWeight': {
      const cur = doc.get(id, 'fontName') ?? { family: 'Inter', style: 'Regular' };
      if (isNaN(n)) return typeof value === 'string' ? { fontName: { ...cur, style: value } } : null;
      return { fontName: { ...cur, style: styleName(n, styleWeight(cur.style).italic, cur.style) } };
    }
    case 'letterSpacing':
      if (isNaN(n)) return null;
      return { letterSpacing: (unit === 'PERCENT' ? { unit: 'PERCENT', value: raw } : { unit: 'PIXELS', value: n }) as LetterSpacing };
    case 'lineHeight':
      if (isNaN(n)) return null;
      if (unit === 'PERCENT') return { lineHeight: { unit: 'PERCENT', value: raw } as LineHeight };
      if (unit === 'MULTIPLIER') return { lineHeight: { unit: 'PERCENT', value: Math.round(raw * 100 * 1000) / 1000 } as LineHeight };
      return { lineHeight: { unit: 'PIXELS', value: n } as LineHeight };
    default:
      return isNaN(n) || !(field in NODE_VARIABLE_FIELDS) ? null : ({ [field]: n } as Props);
  }
}

/** Text properties that runs can have: the value applies to the whole text. */
const RUN_KEYS = new Set(['fontName', 'fontSize', 'letterSpacing', 'lineHeight']);

/** Write properties into the layer if they differ (for text — into runs too, without needlessly dropping prepared glyphs). */
function writeProps(doc: Document, id: string, props: Props) {
  const runKeys = doc.type(id) === 'TEXT' ? Object.keys(props).filter((k) => RUN_KEYS.has(k)) : [];
  const rest: Record<string, unknown> = { ...props };
  if (runKeys.length) {
    const runs = doc.get(id, 'textRuns') ?? [];
    const differs = runKeys.some((k) => !sameJson(doc.get(id, k as keyof Props), (props as Record<string, unknown>)[k]) || runs.some((r) => (r.style as Record<string, unknown>)[k] !== undefined && !sameJson((r.style as Record<string, unknown>)[k], (props as Record<string, unknown>)[k])));
    if (differs) {
      const patch: Record<string, unknown> = {};
      for (const k of runKeys) patch[k] = rest[k];
      restyleText(doc, id, 0, (doc.get(id, 'characters') ?? '').length, () => patch as TextStyle, false, true);
    }
    for (const k of runKeys) delete rest[k];
  }
  if (Object.keys(rest).length) {
    if ('characters' in rest && doc.get(id, 'characters') !== rest.characters) rest.textGlyphs = undefined;
    doc.set(id, rest as Props);
  }
}

/** Layer paints with colors from variables (in the layer's context); null — no changes. */
export function resolvePaints(doc: Document, id: string, paints: readonly Paint[] | undefined): Paint[] | null {
  if (!paints?.some((p) => p.boundVariables?.color || p.boundVariables?.gradient)) return null;
  let changed = false;
  const out = paints.map((p) => {
    // Gradient from a composite variable: the whole paint (type, angle, stops); visibility and opacity stay the paint's own.
    const g = p.boundVariables?.gradient;
    if (g) {
      const v = resolveVariable(doc, g.id, id);
      if (!isComposite(v) || v.type !== 'GRADIENT') return p;
      const next = { ...gradientPaintOf(resolveComposite(v, (ref) => resolveVariable(doc, ref, id)), p), boundVariables: { gradient: g } } as Paint;
      if (!sameJson(next, p)) changed = true;
      return next;
    }
    const a = p.boundVariables?.color;
    if (!a || p.type !== 'SOLID') return p;
    const v = resolveVariable(doc, a.id, id);
    if (!isColor(v)) return p;
    const next: SolidPaint = { ...p, color: { r: v.r, g: v.g, b: v.b } };
    if ((v.a ?? 1) < 1) next.opacity = v.a;
    else delete next.opacity;
    if (!sameJson(next, p)) changed = true;
    return next;
  });
  return changed ? out : null;
}

/** Layer effects with values from variables; null — no changes. */
export function resolveEffects(doc: Document, id: string, effects: readonly Effect[] | undefined): Effect[] | null {
  if (!effects?.some((e) => e.boundVariables && Object.keys(e.boundVariables).length)) return null;
  let changed = false;
  const out = effects.map((e) => {
    const bv = e.boundVariables as Record<string, VariableAlias> | undefined;
    if (!bv) return e;
    const next = { ...e } as Record<string, unknown>;
    for (const [f, a] of Object.entries(bv)) {
      const v = resolveVariable(doc, a.id, id);
      if (v === undefined) continue;
      if (f === 'color' && isColor(v)) next.color = { r: v.r, g: v.g, b: v.b, a: v.a ?? 1 };
      else if (typeof v === 'number') {
        if (f === 'offsetX' || f === 'offsetY') next.offset = { ...(next.offset as { x: number; y: number }), [f === 'offsetX' ? 'x' : 'y']: v };
        else next[f] = v;
      }
    }
    if (!sameJson(next, e)) changed = true;
    return next as unknown as Effect;
  });
  return changed ? out : null;
}

/** Recompute all bound values of the layer (its fields, paints, effects, text run paints). */
export function resolveNode(doc: Document, id: string) {
  const node = doc.node(id);
  if (!node) return;
  const p = node.props;
  for (const [field, a] of Object.entries(p.boundVariables ?? {})) {
    const v = resolveVariable(doc, a.id, id);
    if (v === undefined) continue;
    const props = fieldProps(doc, id, field, v, doc.has(a.id) ? doc.get(a.id, 'unit') : undefined);
    if (props) writeProps(doc, id, props);
  }
  const patch: Props = {};
  const fills = resolvePaints(doc, id, p.fills);
  if (fills) patch.fills = fills;
  const strokes = resolvePaints(doc, id, p.strokes);
  if (strokes) patch.strokes = strokes;
  const effects = resolveEffects(doc, id, p.effects);
  if (effects) patch.effects = effects;
  if (Object.keys(patch).length) doc.set(id, patch);
  // Text run paints: editing runs drops prepared glyphs — only if something changed.
  const runs = p.textRuns;
  if (runs?.some((r) => r.style.fills?.some((f) => f.boundVariables?.color))) {
    let pos = 0;
    for (const r of runs) {
      const f = resolvePaints(doc, id, r.style.fills);
      if (f) restyleText(doc, id, pos, pos + r.length, () => ({ fills: f }), false, true);
      pos += r.length;
    }
  }
}

/** Variables the layer references (fields, paints, effects, text run paints). */
export function boundVariableIds(props: Props): string[] {
  const out = new Set<string>();
  for (const a of Object.values(props.boundVariables ?? {})) out.add(a.id);
  for (const list of [props.fills, props.strokes])
    for (const p of list ?? []) {
      if (p.boundVariables?.color) out.add(p.boundVariables.color.id);
      if (p.boundVariables?.gradient) out.add(p.boundVariables.gradient.id);
    }
  for (const e of props.effects ?? []) for (const a of Object.values(e.boundVariables ?? {}) as VariableAlias[]) out.add(a.id);
  for (const r of props.textRuns ?? []) for (const p of r.style.fills ?? []) if (p.boundVariables?.color) out.add(p.boundVariables.color.id);
  return [...out];
}

/** Bind a layer field to a variable (null — unbind, the value stays), like setBoundVariable. */
export function bindVariable(doc: Document, id: string, field: string, variableId: string | null) {
  const bv = { ...(doc.get(id, 'boundVariables') ?? {}) };
  if (variableId) bv[field] = alias(variableId);
  else delete bv[field];
  doc.set(id, { boundVariables: Object.keys(bv).length ? bv : undefined });
  if (variableId) resolveNode(doc, id);
}

/** Paint with a color from a variable (like setBoundVariableForPaint); null — unbind. */
export function paintWithVariable(doc: Document, paint: Paint, variableId: string | null, nodeId: string | null = null): Paint {
  if (!variableId) {
    const { boundVariables: _, ...rest } = paint;
    return rest as Paint;
  }
  const base: SolidPaint = paint.type === 'SOLID' ? { ...paint } : { type: 'SOLID', color: { r: 0, g: 0, b: 0 } };
  base.boundVariables = { color: alias(variableId) };
  const v = resolveVariable(doc, variableId, nodeId);
  if (isColor(v)) {
    base.color = { r: v.r, g: v.g, b: v.b };
    if ((v.a ?? 1) < 1) base.opacity = v.a;
    else delete base.opacity;
  }
  return base;
}

/** Gradient paint from a composite variable (MFP extension); null — unbind (the gradient stays as is). */
export function paintWithGradient(doc: Document, paint: Paint, variableId: string | null, nodeId: string | null = null): Paint {
  if (!variableId) {
    if (!paint.boundVariables?.gradient) return paint;
    const { gradient: _, ...rest } = paint.boundVariables;
    const out = { ...paint, boundVariables: rest } as Paint;
    if (!Object.keys(rest).length) delete (out as { boundVariables?: unknown }).boundVariables;
    return out;
  }
  const v = resolveVariable(doc, variableId, nodeId);
  if (!isComposite(v) || v.type !== 'GRADIENT') return paint;
  return { ...gradientPaintOf(resolveComposite(v, (ref) => resolveVariable(doc, ref, nodeId)), paint), boundVariables: { gradient: alias(variableId) } } as Paint;
}

/** Bind a layer paint (fills or strokes, by index) to a gradient from a variable; null — unbind. */
export function bindPaintGradient(doc: Document, id: string, key: 'fills' | 'strokes', index: number, variableId: string | null) {
  const paints = [...(doc.get(id, key) ?? [])];
  if (!paints[index]) return;
  paints[index] = paintWithGradient(doc, paints[index]!, variableId, id);
  if (doc.type(id) === 'TEXT' && key === 'fills') {
    restyleText(doc, id, 0, (doc.get(id, 'characters') ?? '').length, () => ({ fills: paints }));
    return;
  }
  doc.set(id, { [key]: paints } as Props);
}

/** Variables referenced by a value (a reference or references inside a composite). */
export const valueRefs = (v: unknown): string[] => (isAlias(v) ? [v.id] : compositeRefs(v));

/** Effect with a field from a variable (like setBoundVariableForEffect); null — unbind. */
export function effectWithVariable(doc: Document, effect: Effect, field: string, variableId: string | null, nodeId: string | null = null): Effect {
  const bv = { ...((effect.boundVariables ?? {}) as Record<string, VariableAlias>) };
  if (variableId) bv[field] = alias(variableId);
  else delete bv[field];
  const next = { ...effect, boundVariables: bv } as Effect;
  if (!Object.keys(bv).length) delete (next as { boundVariables?: unknown }).boundVariables;
  return resolveEffects(doc, nodeId ?? '', [next])?.[0] ?? next;
}

/** Bind a layer paint color (fills or strokes, by index) to a variable; null — unbind. */
export function bindPaintVariable(doc: Document, id: string, key: 'fills' | 'strokes', index: number, variableId: string | null) {
  const paints = [...(doc.get(id, key) ?? [])];
  if (!paints[index]) return;
  paints[index] = paintWithVariable(doc, paints[index]!, variableId, id);
  if (doc.type(id) === 'TEXT' && key === 'fills') {
    restyleText(doc, id, 0, (doc.get(id, 'characters') ?? '').length, () => ({ fills: paints }));
    return;
  }
  doc.set(id, { [key]: paints } as Props);
}

/** Collection mode on a layer or page (modeId '' — as the ancestor's). */
export function setExplicitMode(doc: Document, id: string, collection: string, modeId: string) {
  const modes = { ...(doc.get(id, 'explicitVariableModes') ?? {}) };
  if (modeId) modes[collection] = modeId;
  else delete modes[collection];
  doc.set(id, { explicitVariableModes: Object.keys(modes).length ? modes : undefined });
}

/** Layer modes by collection (like resolvedVariableModes). */
export function resolvedModes(doc: Document, id: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of localCollections(doc)) out[c] = modeFor(doc, id, c);
  return out;
}

/** Variable color as #RRGGBB (with opacity — #RRGGBBAA). */
export function colorHex(c: RGBA): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${(c.a ?? 1) < 1 ? h(c.a ?? 1) : ''}`;
}
