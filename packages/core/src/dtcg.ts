// Design tokens in DTCG format (Design Tokens Community Group, Format Module 2025.10):
// import and export of variables and styles.
//
// A file is one collection in one mode: “Collection.Mode.tokens.json”.
// Groups follow “/” in the variable name; a variable reference is “{group.token}”; expressions are
// exported as the value (and the expression itself goes into $extensions). Composite tokens are styles: typography (text),
// shadow (effects), gradient (color) — in the file “Styles.tokens.json” (the name is set by the caller: labels.styles). Composite variables (our own) are
// composite tokens in their collection's file; references inside are “{group.token}”.

import { colorFromSpace, parseCssColor } from './color.ts';
import type { Document } from './document.ts';
import { createStyle, localStyles, STYLE_FIELDS } from './styles.ts';
import { styleName, styleWeight } from './text-style.ts';
import type { Effect, GradientPaint, GradientVariableValue, LineHeight, Paint, Props, RGBA, ShadowEffect, ShadowVariableValue, TypographyVariableValue, VariableAlias, VariableValue } from './types.ts';
import { isComposite, resolveComposite, type CompositeValue } from './composite-variables.ts';
import { addMode, alias, createCollection, createVariable, defaultMode, isAlias, isColor, isExpression, localCollections, renameMode, resolveVariable, setVariableValue, variablesIn, type VariableType } from './variables.ts';

export interface TokenFile {
  name: string;
  json: string;
}

type Json = Record<string, unknown>;
const EXT = 'com.mfp';

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');

/** Color in DTCG 2025.10: sRGB, components 0–1, alpha, and hex for convenience. */
function colorValue(c: RGBA): Json {
  const out: Json = { colorSpace: 'srgb', components: [round(c.r), round(c.g), round(c.b)] };
  if ((c.a ?? 1) < 1) out.alpha = round(c.a ?? 1);
  out.hex = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return out;
}

const px = (v: number) => ({ value: round(v, 3), unit: 'px' });

/** Token path from a name: “Brand/Primary 500” → ['Brand', 'Primary 500']. */
const pathOf = (name: string) =>
  name
    .split('/')
    .map((s) => s.trim().replace(/[{}.$]/g, '_'))
    .filter(Boolean);

/** Put a token into the tree at a path (a token with children is the group's “$root”). */
function put(tree: Json, path: string[], token: Json) {
  let node = tree;
  for (const seg of path.slice(0, -1)) {
    let next = node[seg] as Json | undefined;
    if (!next || typeof next !== 'object') next = node[seg] = {};
    else if ('$value' in next) next = node[seg] = { $root: next };
    node = next;
  }
  const leaf = path[path.length - 1]!;
  const existing = node[leaf] as Json | undefined;
  if (existing && typeof existing === 'object' && !('$value' in existing)) existing.$root = token;
  else node[leaf] = token;
}

const DTCG_TYPE: Record<VariableType, string> = { COLOR: 'color', FLOAT: 'number', STRING: 'string', BOOLEAN: 'boolean', GRADIENT: 'gradient', SHADOW: 'shadow', TYPOGRAPHY: 'typography' };

/**
 * Composite value → the token's $value: references inside are “{path}”, the rest as in style tokens.
 * Gradient type and angle, font style and spacing in our own units go into the extension (DTCG lacks them).
 */
function compositeToken(doc: Document, v: CompositeValue, resolve: (id: string) => VariableValue | undefined): { value: unknown; ext: Json } {
  const refOf = (x: unknown) => (x && typeof x === 'object' && (x as VariableAlias).type === 'VARIABLE_ALIAS' && doc.has((x as VariableAlias).id) ? `{${pathOf(doc.get((x as VariableAlias).id, 'name') ?? '').join('.')}}` : null);
  const r = resolveComposite(v, resolve);
  if (v.type === 'GRADIENT') {
    const stops = v.stops.map((st, i) => ({ color: refOf(st.color) ?? colorValue((r as GradientVariableValue).stops[i]!.color as RGBA), position: round(st.position) }));
    return { value: stops, ext: { gradientType: v.gradientType, angle: v.angle } };
  }
  if (v.type === 'SHADOWS') {
    const one = (sh: ShadowVariableValue['shadows'][number], i: number) => ({ color: refOf(sh.color) ?? colorValue((r as ShadowVariableValue).shadows[i]!.color as RGBA), offsetX: px(sh.x), offsetY: px(sh.y), blur: px(sh.blur), spread: px(sh.spread), ...(sh.inner ? { inset: true } : {}) });
    return { value: v.shadows.length === 1 ? one(v.shadows[0]!, 0) : v.shadows.map(one), ext: {} };
  }
  const t = r as TypographyVariableValue;
  const size = t.fontSize as number;
  const lh = v.lineHeight;
  return {
    value: {
      fontFamily: refOf(v.fontFamily) ?? t.fontFamily,
      fontWeight: styleWeight(t.fontStyle as string).weight,
      fontSize: refOf(v.fontSize) ?? px(size),
      lineHeight: lh.unit === 'AUTO' ? 1.2 : lh.unit === 'PIXELS' ? round(lh.value / size, 3) : round(lh.value / 100, 3),
      letterSpacing: px(v.letterSpacing.unit === 'PIXELS' ? v.letterSpacing.value : (v.letterSpacing.value * size) / 100),
    },
    ext: { fontStyle: refOf(v.fontStyle) ?? t.fontStyle, lineHeight: lh, letterSpacing: v.letterSpacing },
  };
}

/** Export: a file per collection and mode; styles in a separate file. */
/** labels — file names in the interface language (the editor passes translated ones). */
export function exportDtcg(doc: Document, labels: { styles?: string; collection?: string } = {}): TokenFile[] {
  const files: TokenFile[] = [];
  for (const c of localCollections(doc)) {
    const cname = doc.get(c, 'name') ?? labels.collection ?? 'Collection';
    for (const m of doc.get(c, 'modes') ?? []) {
      const tree: Json = {};
      for (const v of variablesIn(doc, c)) {
        const type = doc.get(v, 'resolvedType') ?? 'FLOAT';
        const raw = (doc.get(v, 'valuesByMode') ?? {})[m.modeId];
        // Number unit: rem is a DTCG dimension ({ value, unit: 'rem' }); percent and “unitless” are a number, the unit goes into the extension.
        const unit = type === 'FLOAT' ? doc.get(v, 'unit') : undefined;
        const token: Json = { $type: unit === 'REM' ? 'dimension' : DTCG_TYPE[type] };
        const ext: Json = {};
        if (unit) ext.unit = unit;
        if (isAlias(raw) && doc.has(raw.id)) token.$value = `{${pathOf(doc.get(raw.id, 'name') ?? '').join('.')}}`;
        else if (isComposite(raw)) {
          const ct = compositeToken(doc, raw, (id) => resolveVariable(doc, id, null, 0, { [c]: m.modeId }));
          token.$value = ct.value;
          Object.assign(ext, ct.ext);
        } else {
          const val = isExpression(raw) ? resolveVariable(doc, v, null, 0, { [c]: m.modeId }) : raw;
          if (isExpression(raw)) ext.expression = raw.expression;
          token.$value = isColor(val) ? colorValue(val) : unit === 'REM' && typeof val === 'number' ? { value: val, unit: 'rem' } : (val ?? null);
        }
        const desc = doc.get(v, 'description');
        if (desc) token.$description = desc;
        const scopes = doc.get(v, 'scopes');
        if (scopes && !(scopes.length === 1 && scopes[0] === 'ALL_SCOPES')) ext.scopes = scopes;
        const code = doc.get(v, 'codeSyntax');
        if (code && Object.keys(code).length) ext.codeSyntax = code;
        if (Object.keys(ext).length) token.$extensions = { [EXT]: ext };
        put(tree, pathOf(doc.get(v, 'name') ?? ''), token);
      }
      tree.$extensions = { [EXT]: { collection: cname, mode: m.name } };
      files.push({ name: `${cname}.${m.name}.tokens.json`, json: JSON.stringify(tree, null, 2) });
    }
  }
  const styles: Json = {};
  let any = false;
  for (const s of localStyles(doc)) {
    const token = styleToken(doc, s);
    if (!token) continue;
    put(styles, pathOf(doc.get(s, 'name') ?? ''), token);
    any = true;
  }
  styles.$extensions = { [EXT]: { styles: true } };
  if (any) files.push({ name: `${labels.styles ?? 'Styles'}.tokens.json`, json: JSON.stringify(styles, null, 2) });
  return files;
}

/** Style → a composite token (typography, shadow, gradient) or a color. */
function styleToken(doc: Document, s: string): Json | null {
  const type = doc.get(s, 'styleType');
  const desc = doc.get(s, 'description');
  const with$ = (t: Json) => (desc ? { ...t, $description: desc } : t);
  if (type === 'TEXT') {
    const font = doc.get(s, 'fontName') ?? { family: 'Inter', style: 'Regular' };
    const size = doc.get(s, 'fontSize') ?? 12;
    const lh = doc.get(s, 'lineHeight') ?? { unit: 'AUTO' };
    const ls = doc.get(s, 'letterSpacing') ?? { unit: 'PERCENT', value: 0 };
    return with$({
      $type: 'typography',
      $value: {
        fontFamily: font.family,
        fontWeight: styleWeight(font.style).weight,
        fontSize: px(size),
        lineHeight: lh.unit === 'AUTO' ? 1.2 : lh.unit === 'PIXELS' ? round(lh.value / size, 3) : round(lh.value / 100, 3),
        letterSpacing: px(ls.unit === 'PIXELS' ? ls.value : (ls.value * size) / 100),
      },
      $extensions: { [EXT]: { fontStyle: font.style } },
    });
  }
  if (type === 'EFFECT') {
    const shadows = (doc.get(s, 'effects') ?? []).filter((e): e is ShadowEffect => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW');
    if (!shadows.length) return null;
    const one = (e: ShadowEffect) => ({ color: colorValue(e.color), offsetX: px(e.offset.x), offsetY: px(e.offset.y), blur: px(e.radius), spread: px(e.spread ?? 0), ...(e.type === 'INNER_SHADOW' ? { inset: true } : {}) });
    return with$({ $type: 'shadow', $value: shadows.length === 1 ? one(shadows[0]!) : shadows.map(one) });
  }
  if (type === 'PAINT') {
    const fills = (doc.get(s, 'fills') ?? []).filter((p) => p.visible !== false);
    const p = fills[fills.length - 1];
    if (!p) return null;
    if (p.type === 'SOLID') return with$({ $type: 'color', $value: colorValue({ ...p.color, a: p.opacity ?? 1 }) });
    if (p.type.startsWith('GRADIENT')) {
      const g = p as GradientPaint;
      return with$({ $type: 'gradient', $value: [...g.gradientStops].sort((a, b) => a.position - b.position).map((st) => ({ color: colorValue(st.color), position: round(st.position) })) });
    }
  }
  return null;
}

// ---------- Import ----------

interface Token {
  path: string[];
  type: string;
  value: unknown;
  description?: string;
  ext?: Json;
}

/** Tokens of a file (the type is inherited from groups). */
function tokensOf(tree: Json): Token[] {
  const out: Token[] = [];
  const walk = (node: Json, path: string[], inherited: string | undefined) => {
    const type = (node.$type as string | undefined) ?? inherited;
    if ('$value' in node) {
      out.push({ path, type: type ?? '', value: node.$value, description: node.$description as string | undefined, ext: ((node.$extensions as Json | undefined)?.[EXT] ?? (node.$extensions as Json | undefined)?.['com.figma']) as Json | undefined });
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      if (k === '$root') walk(v as Json, path, type);
      else if (!k.startsWith('$')) walk(v as Json, [...path, k], type);
    }
  };
  walk(tree, [], undefined);
  return out;
}

/** Color from DTCG (2025.10 — an object; earlier — a hex string, rgb()). */
export function parseDtcgColor(v: unknown): RGBA | null {
  if (v && typeof v === 'object') {
    const o = v as { colorSpace?: string; components?: (number | string)[]; alpha?: number; hex?: string };
    if (Array.isArray(o.components)) {
      // “none” in components is zero (a gray hue).
      const c = colorFromSpace(o.colorSpace ?? 'srgb', o.components.map((x) => (typeof x === 'number' ? x : 0)), o.alpha ?? 1);
      if (c) return c;
    }
    if (o.hex) return parseDtcgColor(o.hex);
    return null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^(oklch|oklab|hsla?)\(/i.test(s)) return parseCssColor(s);
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) {
    const a = m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
    return { r: +m[1]! / 255, g: +m[2]! / 255, b: +m[3]! / 255, a };
  }
  return null;
}

/** Size in rem from DTCG ({ value, unit: 'rem' } or “1.5rem”): number of rem; otherwise null. */
function remOf(v: unknown): number | null {
  if (v && typeof v === 'object' && (v as { unit?: unknown }).unit === 'rem' && typeof (v as { value?: unknown }).value === 'number') return (v as { value: number }).value;
  const m = typeof v === 'string' ? /^(-?[\d.]+)\s*rem$/.exec(v.trim()) : null;
  return m ? +m[1]! : null;
}

/** Size from DTCG ({value, unit}, “16px”, “1rem”, a number) in px. */
function dimension(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'number') {
    const o = v as { value: number; unit?: string };
    return o.unit === 'rem' || o.unit === 'em' ? o.value * 16 : o.value;
  }
  if (typeof v === 'string') {
    const m = /^(-?[\d.]+)\s*(px|rem|em|ms|s)?$/.exec(v.trim());
    if (m) return m[2] === 'rem' || m[2] === 'em' ? +m[1]! * 16 : m[2] === 's' ? +m[1]! * 1000 : +m[1]!;
  }
  return null;
}

const ref = (v: unknown) => (typeof v === 'string' && /^\{[^{}]+\}$/.test(v.trim()) ? v.trim().slice(1, -1).split('.') : null);

export interface DtcgImportReport {
  collections: number;
  variables: number;
  styles: number;
  warnings: string[];
}

/** Collection and mode from the file name: “Collection.Mode.tokens.json”. */
function fileTarget(name: string, tree: Json): { collection: string; mode: string } {
  const meta = ((tree.$extensions as Json | undefined)?.[EXT] ?? {}) as { collection?: string; mode?: string };
  const base = name.replace(/\.json$/i, '').replace(/\.tokens$/i, '');
  const dot = base.lastIndexOf('.');
  return {
    collection: meta.collection ?? (dot > 0 ? base.slice(0, dot) : base),
    mode: meta.mode ?? (dot > 0 ? base.slice(dot + 1) : 'Mode 1'),
  };
}

/** Import token files: variables (by collection and mode), composite tokens as styles. */
export function importDtcg(doc: Document, files: TokenFile[]): DtcgImportReport {
  const report: DtcgImportReport = { collections: 0, variables: 0, styles: 0, warnings: [] };
  const aliases: { variable: string; modeId: string; path: string[] }[] = [];
  /** Composite values with references inside (still as paths): resolve after all variables. */
  const nested: { variable: string; modeId: string }[] = [];
  const createdCollections = new Set<string>();
  const byPath = new Map<string, string>(); // path “a/b” → variable
  for (const f of files) {
    let tree: Json;
    try {
      tree = JSON.parse(f.json) as Json;
    } catch {
      report.warnings.push(`${f.name}: не JSON`);
      continue;
    }
    const tokens = tokensOf(tree);
    // Styles file: all tokens are styles (colors too).
    const stylesFile = !!((tree.$extensions as Json | undefined)?.[EXT] as Json | undefined)?.styles || /^Стили\.tokens\.json$/i.test(f.name);
    const vars = stylesFile ? [] : tokens.filter((t) => ['color', 'number', 'dimension', 'string', 'boolean', 'fontFamily', 'fontWeight', 'duration', 'gradient', 'shadow', 'typography'].includes(t.type));
    const composite = tokens.filter((t) => !vars.includes(t));
    for (const t of composite) {
      if (importStyle(doc, t, report)) report.styles++;
      else if (t.type) report.warnings.push(`${f.name}: «${t.path.join('.')}» — тип ${t.type} не поддерживается`);
    }
    if (!vars.length) continue;
    const target = fileTarget(f.name, tree);
    let coll = localCollections(doc).find((c) => doc.get(c, 'name') === target.collection) ?? null;
    if (!coll) {
      coll = createCollection(doc, target.collection);
      createdCollections.add(coll);
      report.collections++;
    }
    const modes = doc.get(coll, 'modes') ?? [];
    let modeId = modes.find((m) => m.name === target.mode)?.modeId;
    if (!modeId) {
      // New collection: rename the first mode “Mode 1” instead of adding one.
      if (createdCollections.has(coll) && modes.length === 1 && modes[0]!.name === 'Mode 1' && !variablesIn(doc, coll).length) {
        modeId = modes[0]!.modeId;
        renameMode(doc, coll, modeId, target.mode);
      } else modeId = addMode(doc, coll, target.mode);
    }
    for (const t of vars) {
      const name = t.path.join('/');
      const type: VariableType =
        t.type === 'color' ? 'COLOR' : t.type === 'string' || t.type === 'fontFamily' ? 'STRING' : t.type === 'boolean' ? 'BOOLEAN' : t.type === 'gradient' ? 'GRADIENT' : t.type === 'shadow' ? 'SHADOW' : t.type === 'typography' ? 'TYPOGRAPHY' : t.type === 'fontWeight' && typeof t.value === 'string' ? 'STRING' : 'FLOAT';
      let v = variablesIn(doc, coll).find((x) => doc.get(x, 'name') === name);
      if (!v) {
        v = createVariable(doc, name, coll, type);
        report.variables++;
      }
      byPath.set(name, v);
      const ext = t.ext as { scopes?: string[]; codeSyntax?: Props['codeSyntax']; expression?: string; unit?: Props['unit'] } | undefined;
      // A size in rem stays in rem (the variable's unit) rather than being converted to pixels.
      const remValue = type === 'FLOAT' ? remOf(t.value) : null;
      const r = ref(t.value);
      if (r) aliases.push({ variable: v, modeId, path: r });
      else if (type === 'GRADIENT' || type === 'SHADOW' || type === 'TYPOGRAPHY') {
        const value = compositeFromToken(t, type);
        if (!value) report.warnings.push(`«${t.path.join('.')}»: значение не прочитано`);
        else {
          setVariableValue(doc, v, modeId, value);
          nested.push({ variable: v, modeId });
        }
      } else {
        const value = remValue ?? tokenValue(t, type);
        if (value === null) report.warnings.push(`«${t.path.join('.')}»: значение не прочитано`);
        else setVariableValue(doc, v, modeId, value);
      }
      const props: Props = {};
      if (t.description) props.description = t.description;
      const unit = ext?.unit ?? (remValue !== null ? 'REM' : undefined);
      if (unit === 'REM' || unit === 'PERCENT' || unit === 'MULTIPLIER') props.unit = unit;
      if (ext?.scopes) props.scopes = ext.scopes;
      if (ext?.codeSyntax) props.codeSyntax = ext.codeSyntax;
      if (ext?.expression) setVariableValue(doc, v, modeId, { type: 'EXPRESSION', expression: ext.expression });
      if (Object.keys(props).length) doc.set(v, props);
    }
    // Empty values of other modes are taken from the default mode.
    const def = defaultMode(doc, coll);
    for (const v of variablesIn(doc, coll)) {
      const vals = { ...(doc.get(v, 'valuesByMode') ?? {}) };
      let changed = false;
      for (const m of doc.get(coll, 'modes') ?? []) {
        if (vals[m.modeId] === undefined && vals[def] !== undefined) {
          vals[m.modeId] = vals[def]!;
          changed = true;
        }
      }
      if (changed) doc.set(v, { valuesByMode: vals });
    }
  }
  // References after all variables (they may point into other files).
  for (const a of aliases) {
    const target = byPath.get(a.path.join('/')) ?? findByPath(doc, a.path);
    if (target && target !== a.variable) setVariableValue(doc, a.variable, a.modeId, alias(target));
    else report.warnings.push(`Ссылка {${a.path.join('.')}} не найдена`);
  }
  // References inside composites: “@path” → variable (not found — the default value).
  for (const n of nested) {
    const value = (doc.get(n.variable, 'valuesByMode') ?? {})[n.modeId];
    if (!isComposite(value)) continue;
    const fix = <T>(x: T, fallback: unknown): T => {
      const id = (x as VariableAlias | undefined)?.type === 'VARIABLE_ALIAS' ? (x as VariableAlias).id : null;
      if (!id?.startsWith('@')) return x;
      const target = byPath.get(id.slice(1)) ?? findByPath(doc, id.slice(1).split('/'));
      if (target) return alias(target) as T;
      report.warnings.push(`Ссылка {${id.slice(1).split('/').join('.')}} не найдена`);
      return fallback as T;
    };
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const next: CompositeValue =
      value.type === 'GRADIENT'
        ? { ...value, stops: value.stops.map((st) => ({ ...st, color: fix(st.color, black) })) }
        : value.type === 'SHADOWS'
          ? { ...value, shadows: value.shadows.map((sh) => ({ ...sh, color: fix(sh.color, black) })) }
          : { ...value, fontFamily: fix(value.fontFamily, 'Inter'), fontStyle: fix(value.fontStyle, 'Regular'), fontSize: fix(value.fontSize, 16) };
    setVariableValue(doc, n.variable, n.modeId, next);
  }
  return report;
}

function findByPath(doc: Document, path: string[]): string | undefined {
  const name = path.join('/');
  for (const c of localCollections(doc)) for (const v of variablesIn(doc, c)) if (doc.get(v, 'name') === name) return v;
  return undefined;
}

/** Token value → variable value. */
function tokenValue(t: Token, type: VariableType): VariableValue | null {
  switch (type) {
    case 'COLOR':
      return parseDtcgColor(t.value);
    case 'FLOAT':
      return t.type === 'fontWeight' && typeof t.value === 'string' ? styleWeight(t.value).weight : dimension(t.value);
    case 'BOOLEAN':
      return t.value === true || t.value === 'true';
    case 'STRING':
      return Array.isArray(t.value) ? String(t.value[0] ?? '') : typeof t.value === 'string' || typeof t.value === 'number' ? String(t.value) : null;
    default:
      return null;
  }
}

/** A reference inside a composite token is still a path (“@a/b”); the variable is found after all files. */
const pending = (v: unknown): VariableAlias | null => {
  const r = ref(v);
  return r ? { type: 'VARIABLE_ALIAS', id: `@${r.join('/')}` } : null;
};

/** A composite token in a collection file → a composite variable value. */
function compositeFromToken(t: Token, type: 'GRADIENT' | 'SHADOW' | 'TYPOGRAPHY'): CompositeValue | null {
  const ext = (t.ext ?? {}) as { gradientType?: GradientVariableValue['gradientType']; angle?: number; fontStyle?: string; lineHeight?: LineHeight; letterSpacing?: TypographyVariableValue['letterSpacing'] };
  const color = (c: unknown) => pending(c) ?? parseDtcgColor(c) ?? { r: 0, g: 0, b: 0, a: 1 };
  if (type === 'GRADIENT') {
    if (!Array.isArray(t.value)) return null;
    return { type: 'GRADIENT', gradientType: ext.gradientType ?? 'GRADIENT_LINEAR', angle: ext.angle ?? 90, stops: (t.value as Json[]).map((st) => ({ color: color(st.color), position: typeof st.position === 'number' ? st.position : 0 })) };
  }
  if (type === 'SHADOW') {
    if (!t.value || typeof t.value !== 'object') return null;
    const list = (Array.isArray(t.value) ? t.value : [t.value]) as Json[];
    return { type: 'SHADOWS', shadows: list.map((sh) => ({ ...(sh.inset ? { inner: true } : {}), color: color(sh.color), x: dimension(sh.offsetX) ?? 0, y: dimension(sh.offsetY) ?? 0, blur: dimension(sh.blur) ?? 0, spread: dimension(sh.spread) ?? 0 })) };
  }
  if (!t.value || typeof t.value !== 'object') return null;
  const v = t.value as Json;
  const size = pending(v.fontSize) ?? dimension(v.fontSize) ?? 16;
  const family = pending(v.fontFamily) ?? (Array.isArray(v.fontFamily) ? String(v.fontFamily[0]) : String(v.fontFamily ?? 'Inter'));
  const weight = typeof v.fontWeight === 'number' ? v.fontWeight : styleWeight(String(v.fontWeight ?? 'Regular')).weight;
  const fontStyle = (ext.fontStyle ? (pending(ext.fontStyle) ?? ext.fontStyle) : null) ?? styleName(weight, false);
  const lineHeight: LineHeight = ext.lineHeight ?? (typeof v.lineHeight === 'number' ? { unit: 'PERCENT', value: round(v.lineHeight * 100, 2) } : dimension(v.lineHeight) !== null ? { unit: 'PIXELS', value: dimension(v.lineHeight)! } : { unit: 'AUTO' });
  return { type: 'TYPOGRAPHY', fontFamily: family, fontStyle, fontSize: size, lineHeight, letterSpacing: ext.letterSpacing ?? { unit: 'PIXELS', value: dimension(v.letterSpacing) ?? 0 } };
}

/** Composite token → style (typography, shadow, gradient; color from the styles file). */
function importStyle(doc: Document, t: Token, report: DtcgImportReport): boolean {
  const name = t.path.join('/');
  const existing = localStyles(doc).find((s) => doc.get(s, 'name') === name);
  const write = (type: 'TEXT' | 'EFFECT' | 'PAINT', values: Props) => {
    if (existing && doc.get(existing, 'styleType') === type) doc.set(existing, values);
    else createStyle(doc, type, name, values);
    if (t.description) doc.set(existing ?? localStyles(doc).at(-1)!, { description: t.description });
  };
  if (t.type === 'typography' && t.value && typeof t.value === 'object') {
    const v = t.value as Json;
    const size = dimension(v.fontSize) ?? 16;
    const family = Array.isArray(v.fontFamily) ? String(v.fontFamily[0]) : String(v.fontFamily ?? 'Inter');
    const weight = typeof v.fontWeight === 'number' ? v.fontWeight : styleWeight(String(v.fontWeight ?? 'Regular')).weight;
    const fontStyle = ((t.ext as { fontStyle?: string } | undefined)?.fontStyle) ?? styleName(weight, false);
    const lh = typeof v.lineHeight === 'number' ? { unit: 'PIXELS' as const, value: round(v.lineHeight * size, 2) } : dimension(v.lineHeight) !== null ? { unit: 'PIXELS' as const, value: dimension(v.lineHeight)! } : { unit: 'AUTO' as const };
    write('TEXT', { fontName: { family, style: fontStyle }, fontSize: size, lineHeight: lh, letterSpacing: { unit: 'PIXELS', value: dimension(v.letterSpacing) ?? 0 } });
    return true;
  }
  if (t.type === 'shadow' && t.value) {
    const list = (Array.isArray(t.value) ? t.value : [t.value]) as Json[];
    const effects: Effect[] = [];
    for (const s of list) {
      const color = parseDtcgColor(s.color) ?? { r: 0, g: 0, b: 0, a: 0.25 };
      effects.push({ type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color, offset: { x: dimension(s.offsetX) ?? 0, y: dimension(s.offsetY) ?? 0 }, radius: dimension(s.blur) ?? 0, spread: dimension(s.spread) ?? 0, visible: true, blendMode: 'NORMAL' });
    }
    write('EFFECT', { effects });
    return true;
  }
  if (t.type === 'gradient' && Array.isArray(t.value)) {
    const stops = (t.value as Json[]).map((s) => ({ color: parseDtcgColor(s.color) ?? { r: 0, g: 0, b: 0, a: 1 }, position: typeof s.position === 'number' ? s.position : 0 }));
    const paint: Paint = { type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops };
    write('PAINT', { fills: [paint] });
    return true;
  }
  if (t.type === 'color') {
    const c = parseDtcgColor(t.value);
    if (!c) return false;
    write('PAINT', { fills: [{ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, ...(c.a < 1 ? { opacity: c.a } : {}) }] });
    return true;
  }
  void report;
  void STYLE_FIELDS;
  return false;
}
