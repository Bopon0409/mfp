// Scaling a layer as a whole (the K tool; rescale() in the plugin API): along with the size,
// stroke widths, dashes, corner radii, shadows and blurs, text size and spacing,
// auto layout padding, size limits change — and all content too (including child positions).
// The module does not pull in the layout engine — the plugin sandbox uses it as well.

import type { Document, Effect, NodeType, Props } from '@mfp/core';

/** Layer properties after scaling by s from the original properties p (the layer position does not change). */
export function scaledProps(type: NodeType, p: Props, s: number): Props {
  const out: Props = {};
  const k = (v: number | undefined | null) => (typeof v === 'number' ? v * s : v);
  if (p.width !== undefined) out.width = p.width * s;
  if (p.height !== undefined) out.height = p.height * s;
  if (p.strokeWeight) out.strokeWeight = p.strokeWeight * s;
  if (p.cornerRadius) out.cornerRadius = p.cornerRadius * s;
  for (const key of ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'] as const) if (typeof p[key] === 'number') out[key] = p[key]! * s;
  if (p.dashPattern?.length) out.dashPattern = p.dashPattern.map((v) => v * s);
  if (p.effects?.length) {
    out.effects = p.effects.map((e): Effect => {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        return { ...e, radius: e.radius * s, offset: { x: e.offset.x * s, y: e.offset.y * s }, ...(e.spread !== undefined ? { spread: e.spread * s } : {}) };
      }
      if (e.type === 'NOISE') return { ...e, noiseSize: e.noiseSize * s };
      if (e.type === 'TEXTURE') return { ...e, noiseSize: e.noiseSize * s, radius: e.radius * s };
      if (e.type === 'GLASS') return { ...e, depth: e.depth * s, radius: e.radius * s };
      if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') return { ...e, radius: e.radius * s, ...(e.startRadius !== undefined ? { startRadius: e.startRadius * s } : {}) };
      return e;
    });
  }
  if (type === 'TEXT') {
    if (p.fontSize) out.fontSize = p.fontSize * s;
    if (p.lineHeight && p.lineHeight.unit === 'PIXELS') out.lineHeight = { unit: 'PIXELS', value: p.lineHeight.value * s };
    if (p.letterSpacing && p.letterSpacing.unit === 'PIXELS') out.letterSpacing = { unit: 'PIXELS', value: p.letterSpacing.value * s };
    // Prepared glyphs from .fig do not fit the new font size — the text is laid out again.
    if (p.textGlyphs) out.textGlyphs = undefined;
  }
  for (const key of ['itemSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'] as const) if (p[key]) out[key] = p[key]! * s;
  if (typeof p.counterAxisSpacing === 'number') out.counterAxisSpacing = p.counterAxisSpacing * s;
  for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) if (typeof p[key] === 'number') out[key] = k(p[key]) as number;
  return out;
}

/**
 * Scale a layer and all its content by s (the root stays in place — the caller sets its position).
 * source — original node properties (when dragging — a snapshot from before the start, so that the
 * scale does not accumulate). The caller opens the transaction.
 */
export function scaleTree(doc: Document, id: string, s: number, source: (id: string) => Props = (n) => doc.props(n)) {
  const p = source(id);
  doc.set(id, scaledProps(doc.type(id)!, p, s));
  for (const c of doc.children(id)) {
    const t = source(c).transform ?? [1, 0, 0, 0, 1, 0];
    doc.set(c, { transform: [t[0], t[1], t[2] * s, t[3], t[4], t[5] * s] });
    scaleTree(doc, c, s, source);
  }
}

/** Snapshot of subtree properties (for drag scaling from the original state). */
export function snapshotProps(doc: Document, ids: string[]): Map<string, Props> {
  const out = new Map<string, Props>();
  const walk = (id: string) => {
    out.set(id, structuredClone(doc.props(id)));
    for (const c of doc.children(id)) walk(c);
  };
  for (const id of ids) walk(id);
  return out;
}
