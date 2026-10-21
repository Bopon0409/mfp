// Styles by text range. The node stores the base
// formatting, textRuns are consecutive text runs (length in UTF-16 code units) with differences from
// the node; the tail without runs uses the node's formatting. Functions are pure: they take and return new arrays.

import type { NodeProps, Props, TextRun, TextStyle, TextStyleKey } from './types.ts';

export const TEXT_STYLE_KEYS: readonly TextStyleKey[] = [
  'fontName',
  'fontSize',
  'fills',
  'letterSpacing',
  'lineHeight',
  'textCase',
  'textDecoration',
  'textDecorationStyle',
  'textDecorationThickness',
  'textDecorationColor',
  'textDecorationOffset',
  'textDecorationSkipInk',
  'hyperlink',
  'openTypeFeatures',
  'fontVariations',
  'listType',
  'indentation',
  'textStyleId',
  'fillStyleId',
];

/** Paragraph properties: the whole paragraph has one value — taken from its first character. */
export const PARAGRAPH_KEYS: readonly TextStyleKey[] = ['listType', 'indentation'];

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function sameStyle(a: TextStyle, b: TextStyle): boolean {
  for (const k of TEXT_STYLE_KEYS) if (!sameValue(a[k], b[k])) return false;
  return true;
}

const isEmpty = (s: TextStyle) => TEXT_STYLE_KEYS.every((k) => s[k] === undefined);

/** Only the set keys (undefined — “same as node” — is dropped). */
function clean(s: TextStyle): TextStyle {
  const out: TextStyle = {};
  for (const k of TEXT_STYLE_KEYS) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

/**
 * Normalize runs: total length not greater than the text length, no empty runs, equal neighbors
 * merged, the tail without differences dropped (empty array — the whole text is as the node).
 */
export function normalizeRuns(runs: readonly TextRun[] | undefined, length: number): TextRun[] {
  const out: TextRun[] = [];
  let left = Math.max(0, length);
  for (const r of runs ?? []) {
    if (left <= 0) break;
    const len = Math.min(left, Math.max(0, Math.floor(r.length)));
    if (!len) continue;
    left -= len;
    const style = clean(r.style);
    const prev = out[out.length - 1];
    if (prev && sameStyle(prev.style, style)) prev.length += len;
    else out.push({ length: len, style });
  }
  while (out.length && isEmpty(out[out.length - 1]!.style)) out.pop();
  return out;
}

/** Runs covering the whole text (the tail with an empty style). */
function full(runs: readonly TextRun[] | undefined, length: number): TextRun[] {
  const out = normalizeRuns(runs, length).map((r) => ({ length: r.length, style: r.style }));
  const covered = out.reduce((n, r) => n + r.length, 0);
  if (covered < length) out.push({ length: length - covered, style: {} });
  return out;
}

/** Formatting of character i (differences from the node); the tail without runs is as the node. */
export function styleAt(runs: readonly TextRun[] | undefined, i: number): TextStyle {
  let pos = 0;
  for (const r of runs ?? []) {
    if (i < pos + r.length) return r.style;
    pos += r.length;
  }
  return {};
}

/** Runs with positions: [start, end) and differences from the node (whole text, tail with an empty style). */
export function textSegments(runs: readonly TextRun[] | undefined, length: number): { start: number; end: number; style: TextStyle }[] {
  const out: { start: number; end: number; style: TextStyle }[] = [];
  let pos = 0;
  for (const r of full(runs, length)) {
    out.push({ start: pos, end: pos + r.length, style: r.style });
    pos += r.length;
  }
  return out;
}

/** Split runs at the start and end boundaries (for editing a range). */
function split(runs: TextRun[], at: number): TextRun[] {
  const out: TextRun[] = [];
  let pos = 0;
  for (const r of runs) {
    if (at > pos && at < pos + r.length) {
      out.push({ length: at - pos, style: r.style }, { length: pos + r.length - at, style: r.style });
    } else out.push(r);
    pos += r.length;
  }
  return out;
}

/**
 * Change formatting of the range [start, end): patch — new values (undefined for a key removes
 * the difference, making it as the node) or a function of the run's current style.
 */
export function styleRange(runs: readonly TextRun[] | undefined, length: number, start: number, end: number, patch: TextStyle | ((s: TextStyle) => TextStyle)): TextRun[] {
  const a = Math.max(0, Math.min(length, start));
  const b = Math.max(a, Math.min(length, end));
  if (a === b) return normalizeRuns(runs, length);
  const parts = split(split(full(runs, length), a), b);
  let pos = 0;
  const out = parts.map((r) => {
    const inside = pos >= a && pos + r.length <= b;
    pos += r.length;
    if (!inside) return r;
    const next = typeof patch === 'function' ? patch(r.style) : { ...r.style, ...patch };
    return { length: r.length, style: clean(next) };
  });
  return normalizeRuns(out, length);
}

/** Remove the difference key from the whole text (the node's value becomes common). */
export function stripRuns(runs: readonly TextRun[] | undefined, length: number, keys: readonly TextStyleKey[]): TextRun[] {
  return normalizeRuns(
    (runs ?? []).map((r) => {
      const s = { ...r.style };
      for (const k of keys) delete s[k];
      return { length: r.length, style: s };
    }),
    length,
  );
}

/**
 * Text changed: [start, start + removed) was replaced with an insertion of length inserted. The
 * insertion gets style style, or without it the style of the character before it (at the start of
 * the text — of the first character).
 */
export function spliceRuns(runs: readonly TextRun[] | undefined, length: number, start: number, removed: number, inserted: number, style?: TextStyle): TextRun[] {
  const a = Math.max(0, Math.min(length, start));
  const del = Math.max(0, Math.min(length - a, removed));
  const ins = Math.max(0, inserted);
  const parts = split(split(full(runs, length), a), a + del);
  const before: TextRun[] = [];
  const after: TextRun[] = [];
  let pos = 0;
  for (const r of parts) {
    if (pos + r.length <= a) before.push(r);
    else if (pos >= a + del) after.push(r);
    pos += r.length;
  }
  const insStyle = style ?? (before.length ? before[before.length - 1]!.style : (after[0]?.style ?? parts[0]?.style ?? {}));
  const mid = ins ? [{ length: ins, style: insStyle }] : [];
  return normalizeRuns([...before, ...mid, ...after], length - del + ins);
}

/** Resulting formatting (node + differences). */
export function effectiveStyle(base: Props, style: TextStyle): Required<TextStyle> {
  const out = {} as Record<string, unknown>;
  for (const k of TEXT_STYLE_KEYS) out[k] = style[k] !== undefined ? style[k] : base[k];
  return out as Required<TextStyle>;
}

export const MIXED = Symbol('mixed');

/** Property value on the range [start, end) (empty — of the character before the cursor): one value or MIXED. */
export function rangeValue<K extends TextStyleKey>(base: Props, runs: readonly TextRun[] | undefined, length: number, start: number, end: number, key: K): NodeProps[K] | typeof MIXED {
  if (end <= start) {
    const s = styleAt(runs, Math.max(0, start - 1));
    return (s[key] !== undefined ? s[key] : base[key]) as NodeProps[K];
  }
  let value: unknown;
  let first = true;
  for (const seg of textSegments(runs, length)) {
    if (seg.end <= start || seg.start >= end) continue;
    const v = seg.style[key] !== undefined ? seg.style[key] : base[key];
    if (first) {
      value = v;
      first = false;
    } else if (!sameValue(v, value)) return MIXED;
  }
  return (first ? base[key] : value) as NodeProps[K];
}

/** Bounds of the paragraphs touching [start, end): start of the first and end of the last (without the line break). */
export function paragraphSpan(characters: string, start: number, end: number): [number, number] {
  const a = start > 0 ? characters.lastIndexOf('\n', start - 1) + 1 : 0;
  const nl = characters.indexOf('\n', end > start ? end - 1 : start);
  return [a, nl < 0 ? characters.length : nl];
}

/**
 * Simplify formatting: a property equal across the whole text moves into the node (and leaves the
 * runs); differences matching the node's value are removed. Returns node changes and runs.
 */
export function compactText(base: Props, runs: readonly TextRun[] | undefined, length: number): { props: Props; runs: TextRun[] } {
  const props: Props = {};
  let out = normalizeRuns(runs, length);
  if (length > 0 && out.length) {
    const segs = textSegments(out, length);
    const hoisted: TextStyleKey[] = [];
    for (const k of TEXT_STYLE_KEYS) {
      const first = segs[0]!.style[k] !== undefined ? segs[0]!.style[k] : base[k];
      if (segs.every((s) => sameValue(s.style[k] !== undefined ? s.style[k] : base[k], first))) {
        if (!sameValue(first, base[k])) (props as Record<string, unknown>)[k] = first;
        hoisted.push(k);
      }
    }
    if (hoisted.length) out = stripRuns(out, length, hoisted);
  }
  const merged = { ...base, ...props };
  out = normalizeRuns(
    out.map((r) => {
      const s = { ...r.style };
      for (const k of TEXT_STYLE_KEYS) if (s[k] !== undefined && sameValue(s[k], merged[k])) delete s[k];
      return { length: r.length, style: s };
    }),
    length,
  );
  return { props, runs: out };
}
