// Editing text formatting by range — shared rules of the editor, plugins and CLI:
// a run's formatting is changed by a function of its resulting style; what is equal across the whole
// text is lifted into node properties; prepared import glyphs are no longer valid after an edit.

import type { Document } from './document.ts';
import { compactText, effectiveStyle, paragraphSpan, PARAGRAPH_KEYS, styleRange } from './text-runs.ts';
import type { Props, TextStyle } from './types.ts';

/** Resulting run style (node + differences). */
export type EffectiveTextStyle = ReturnType<typeof effectiveStyle>;

/** Text style properties on runs: editing them detaches the text style. */
const TYPO_KEYS = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'openTypeFeatures', 'fontVariations'] as const;

/** A manual formatting edit detaches styles: text style — when editing font and spacing, color — when editing fills. */
function detachStyles(patch: TextStyle): TextStyle {
  let out = patch;
  if (!('textStyleId' in patch) && TYPO_KEYS.some((k) => k in patch)) out = { ...out, textStyleId: '' };
  if (!('fillStyleId' in patch) && 'fills' in patch) out = { ...out, fillStyleId: '' };
  return out;
}

/**
 * Change formatting of characters [start, end) of text id. fn receives the run's resulting style and
 * returns new values. Paragraph properties (list, level) apply to whole paragraphs.
 * keepStyles — do not detach styles (the values come from the style itself).
 */
export function restyleText(doc: Document, id: string, start: number, end: number, fn: (s: EffectiveTextStyle) => TextStyle, paragraph = false, keepStyles = false) {
  if (!keepStyles) {
    const inner = fn;
    fn = (s) => detachStyles(inner(s));
  }
  const p = doc.props(id);
  const chars = p.characters ?? '';
  const glyphs = p.textGlyphs ? { textGlyphs: undefined } : {};
  // Empty text — the node itself changes (the style typing will use).
  if (!chars.length) {
    doc.set(id, { ...(fn(effectiveStyle(p, {})) as Props), ...glyphs });
    return;
  }
  let [a, b] = [start, end];
  if (paragraph) {
    [a, b] = paragraphSpan(chars, start, end);
    if (b < chars.length) b++; // the line break is part of the paragraph too
    // An empty last paragraph is tied to the line break before it (that is how layout reads it).
    else if (a === b && a > 0) a--;
  }
  const runs = styleRange(p.textRuns, chars.length, a, b, (s) => ({ ...s, ...fn(effectiveStyle(p, s)) }));
  // Equal across the whole text — into node properties; matching the node — out of the runs.
  const c = compactText(p, runs, chars.length);
  doc.set(id, { ...c.props, textRuns: c.runs, ...glyphs });
}

/** Keys that change for a whole paragraph. */
export const isParagraphStyle = (patch: TextStyle) => PARAGRAPH_KEYS.some((k) => k in patch);

const WEIGHT_NAMES: [number, string][] = [
  [100, 'Thin'],
  [200, 'ExtraLight'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'SemiBold'],
  [700, 'Bold'],
  [800, 'ExtraBold'],
  [900, 'Black'],
];

const WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  heavy: 800,
  black: 900,
};

/** Weight and slant from the font style name (“Semi Bold Italic” → 600, italic). */
export function styleWeight(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase();
  const italic = /italic|oblique/.test(s);
  const base = s.replace(/italic|oblique/g, '').replace(/[\s_-]+/g, '') || 'regular';
  return { weight: WEIGHTS[base] ?? 400, italic };
}

/** Font style name from weight and slant, in the family's naming (with spaces, like “Semi Bold”, if it had them). */
export function styleName(weight: number, italic: boolean, like = ''): string {
  const spaced = /\s/.test(like.replace(/italic/i, '').trim());
  let name = WEIGHT_NAMES.reduce((best, w) => (Math.abs(w[0] - weight) < Math.abs(best[0] - weight) ? w : best))[1];
  if (spaced) name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (italic) return name === 'Regular' ? 'Italic' : `${name} Italic`;
  return name;
}

/** Bold style: Regular → Bold, Bold → Regular, Italic → Bold Italic. */
export function toggleBold(style: string, on: boolean): string {
  const { italic } = styleWeight(style);
  return styleName(on ? 700 : 400, italic, style);
}

/** Italic: add or remove slant, same weight. */
export function toggleItalic(style: string, on: boolean): string {
  const { weight } = styleWeight(style);
  return styleName(weight, on, style);
}
