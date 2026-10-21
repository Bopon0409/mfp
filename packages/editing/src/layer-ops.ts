// Small layer operations (MFP extension): reorder selected layers
// within their place in the list (reverse order, by name, by position), split text into parts,
// join texts, word count. Pure functions over the document — the caller opens the transaction.

import { maxChroma, oklchToRgb, rgbToOklch, textSegments, type Document, type Paint, type Props, type TextRun } from '@mfp/core';

/** “Human” name comparison: “Screen 2” before “Screen 10”, case-insensitive. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, ['ru', 'en'], { numeric: true, sensitivity: 'base' });
}

/**
 * Place layers of one parent in the given order (top to bottom, as in the layer list) into the same
 * slots they occupied: other children do not move. Layers of other parents are handled per group.
 */
export function reorderSiblings(doc: Document, topToBottom: readonly string[]) {
  const byParent = new Map<string, string[]>();
  for (const id of topToBottom) {
    const p = doc.parent(id);
    if (!p) continue;
    byParent.set(p, [...(byParent.get(p) ?? []), id]);
  }
  for (const [parent, ids] of byParent) {
    const kids = doc.children(parent);
    const set = new Set(ids);
    // Slots of the selected layers in ascending order (bottom to top); fill them bottom to top.
    const slots = kids.map((k, i) => (set.has(k) ? i : -1)).filter((i) => i >= 0);
    const bottomUp = [...ids].reverse();
    const final = [...kids];
    slots.forEach((slot, k) => (final[slot] = bottomUp[k]!));
    if (final.every((k, i) => k === kids[i])) continue;
    final.forEach((k, i) => {
      if (doc.children(parent)[i] !== k) doc.move(k, parent, i);
    });
  }
}

/** Layers in the list top to bottom (as they currently stand). */
export function topDown(doc: Document, ids: readonly string[]): string[] {
  const rank = (id: string) => {
    const p = doc.parent(id);
    return p ? doc.children(p).indexOf(id) : 0;
  };
  return [...ids].sort((a, b) => rank(b) - rank(a));
}

/** Reverse order of the selected layers (within each parent). */
export function reverseOrder(doc: Document, ids: readonly string[]) {
  reorderSiblings(doc, topDown(doc, ids).reverse());
}

/** By name: “A”, “1” on top (natural). desc — the reverse. */
export function sortByName(doc: Document, ids: readonly string[], desc = false) {
  const sorted = [...ids].sort((a, b) => naturalCompare(doc.get(a, 'name') ?? '', doc.get(b, 'name') ?? ''));
  reorderSiblings(doc, desc ? sorted.reverse() : sorted);
}

/** By position: the layer higher on the canvas (then further left) goes to the top of the list, the way a page is read. */
export function sortByPosition(doc: Document, ids: readonly string[], pos: (id: string) => [number, number]) {
  const p = new Map(ids.map((id) => [id, pos(id)]));
  const sorted = [...ids].sort((a, b) => {
    const [ax, ay] = p.get(a)!;
    const [bx, by] = p.get(b)!;
    return Math.abs(ay - by) > 1 ? ay - by : ax - bx;
  });
  reorderSiblings(doc, sorted);
}

/** Text formatting runs for the range [start, end) — as textRuns of a new text. */
export function sliceRuns(doc: Document, id: string, start: number, end: number): TextRun[] | undefined {
  const chars = doc.get(id, 'characters') ?? '';
  const runs = doc.get(id, 'textRuns');
  if (!runs?.length) return undefined;
  const out: TextRun[] = [];
  for (const s of textSegments(runs, chars.length)) {
    const a = Math.max(s.start, start);
    const b = Math.min(s.end, end);
    if (b > a) out.push({ length: b - a, style: s.style });
  }
  return out.length ? out : undefined;
}

/** Properties of a text part [start, end): the same formatting, its own text and runs. */
export function textPartProps(doc: Document, id: string, start: number, end: number): Props {
  const p = { ...doc.node(id)!.props } as Props;
  const chars = doc.get(id, 'characters') ?? '';
  delete p.textGlyphs;
  delete p.textRuns;
  const runs = sliceRuns(doc, id, start, end);
  return { ...p, characters: chars.slice(start, end), ...(runs ? { textRuns: runs } : {}), textAutoResize: 'WIDTH_AND_HEIGHT', name: chars.slice(start, end).trim().slice(0, 40) || (p.name ?? 'Text') };
}

/** Text ranges: lines (by line break) or words (without spaces). */
export function textPieces(chars: string, by: 'lines' | 'words'): [number, number][] {
  const out: [number, number][] = [];
  const re = by === 'lines' ? /[^\n]+/g : /\S+/g;
  for (let m = re.exec(chars); m; m = re.exec(chars)) if (m[0].trim()) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * Join texts into the first one (in ids order): text joined with a separator, run formatting
 * is kept; the rest are deleted. Returns the remaining text.
 */
export function joinTexts(doc: Document, ids: readonly string[], sep = '\n'): string | null {
  const texts = ids.filter((id) => doc.type(id) === 'TEXT');
  if (texts.length < 2) return texts[0] ?? null;
  const [first, ...rest] = texts;
  let chars = doc.get(first!, 'characters') ?? '';
  const baseStyle = (id: string) => {
    const p = doc.props(id);
    return { fontName: p.fontName, fontSize: p.fontSize, fills: p.fills, lineHeight: p.lineHeight, letterSpacing: p.letterSpacing, textDecoration: p.textDecoration, textCase: p.textCase };
  };
  const runs: TextRun[] = [];
  const pushRuns = (id: string) => {
    const c = doc.get(id, 'characters') ?? '';
    const own = sliceRuns(doc, id, 0, c.length);
    const base = baseStyle(id);
    if (own) for (const r of own) runs.push({ length: r.length, style: { ...base, ...r.style } as TextRun['style'] });
    else if (c.length) runs.push({ length: c.length, style: base as TextRun['style'] });
  };
  pushRuns(first!);
  for (const id of rest) {
    runs.push({ length: sep.length, style: baseStyle(id) as TextRun['style'] });
    chars += sep + (doc.get(id, 'characters') ?? '');
    pushRuns(id);
  }
  doc.set(first!, { characters: chars, textRuns: runs, textGlyphs: undefined });
  for (const id of rest) doc.delete(id);
  return first!;
}

/** Words and characters in the text (characters — excluding line breaks; words — non-whitespace groups). */
export function textStats(chars: string): { words: number; chars: number; charsNoSpaces: number } {
  return { words: (chars.match(/\S+/g) ?? []).length, chars: chars.replace(/\n/g, '').length, charsNoSpaces: chars.replace(/\s/g, '').length };
}

/**
 * Invert colors of layers and everything nested (MFP extension; request “introduce invert colors feature”):
 * solid fills and strokes, gradient stops, mesh gradients, shadow and text run colors.
 * mode 'rgb' — regular inversion, 'lightness' — only OKLCH lightness (hue and chroma
 * stay — a dark theme draft). Colors from variables and images are left alone. Returns how many
 * colors were changed.
 */
export function invertColors(doc: Document, ids: readonly string[], mode: 'rgb' | 'lightness' = 'rgb'): number {
  let n = 0;
  const inv = <C extends { r: number; g: number; b: number }>(c: C): C => {
    n++;
    if (mode === 'rgb') return { ...c, r: 1 - c.r, g: 1 - c.g, b: 1 - c.b };
    const o = rgbToOklch(c);
    const out = oklchToRgb(1 - o.l, Math.min(o.c, maxChroma(1 - o.l, o.h)), o.h);
    return { ...c, r: out.r, g: out.g, b: out.b };
  };
  const paints = (list: readonly Paint[] | undefined): Paint[] | undefined => {
    if (!list?.length) return undefined;
    let changed = false;
    const out = list.map((p) => {
      if (p.type === 'SOLID' && !p.boundVariables?.color) {
        changed = true;
        return { ...p, color: inv(p.color) };
      }
      if ((p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') && !p.boundVariables?.gradient) {
        changed = true;
        return { ...p, gradientStops: p.gradientStops.map((s) => ({ ...s, color: inv(s.color) })) };
      }
      if (p.type === 'GRADIENT_FREEFORM') {
        changed = true;
        return { ...p, points: p.points.map((q) => ({ ...q, color: inv(q.color) })) };
      }
      return p;
    });
    return changed ? out : undefined;
  };
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !doc.has(id)) return;
    seen.add(id);
    const p = doc.node(id)!.props as Props;
    const patch: Props = {};
    const fills = paints(p.fills);
    if (fills) patch.fills = fills;
    const strokes = paints(p.strokes);
    if (strokes) patch.strokes = strokes;
    if (p.effects?.some((e) => 'color' in e && e.color)) patch.effects = p.effects.map((e) => ('color' in e && e.color && !(e.boundVariables as Record<string, unknown> | undefined)?.color ? ({ ...e, color: inv(e.color) } as typeof e) : e));
    if (p.textRuns?.some((r) => r.style.fills?.length)) patch.textRuns = p.textRuns.map((r) => (r.style.fills ? { ...r, style: { ...r.style, fills: paints(r.style.fills) ?? r.style.fills } } : r));
    if (Object.keys(patch).length) doc.set(id, patch);
    for (const k of doc.children(id)) visit(k);
  };
  for (const id of ids) visit(id);
  return n;
}
