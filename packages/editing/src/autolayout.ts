// Auto layout in the editor: frame children are laid out by the @mfp/layout engine (Taffy + auto layout rules).
// Child positions and sizes and the “hug” frame size are derived data: the editor
// recomputes them after edits (Editor.relayout) outside the undo history, like text size.

import { invert, multiply, type Document, type Matrix, type Props } from '@mfp/core';
import { clamp, computeAutoLayout, computeGridLayout, loadLayoutEngine, type AutoLayoutChild, type AutoLayoutFrame, type GridChild, type GridResult } from '@mfp/layout';
import { applyConstraints, isAutoLayout } from './sizing.ts';

let ready = false;
/** The layout engine (wasm) is loaded once at startup. */
export const layoutEngineReady = loadLayoutEngine().then(() => {
  ready = true;
});

/** Frame properties its layout depends on. */
export const LAYOUT_SELF_KEYS = new Set([
  'layoutMode',
  'layoutVersion',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'primaryAxisSizingMode',
  'counterAxisSizingMode',
  'layoutWrap',
  'counterAxisAlignContent',
  'strokesIncludedInLayout',
  'strokes', 'strokeWeight', 'strokeAlign', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight',
  'gridRowSizes',
  'gridColumnSizes',
  'gridRowGap',
  'gridColumnGap',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
]);

/** Child properties the parent's layout depends on. */
export const LAYOUT_CHILD_KEYS = new Set(['width', 'height', 'transform', 'visible', 'layoutGrow', 'layoutAlign', 'layoutPositioning', 'widthPercent', 'heightPercent', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'minWidthPercent', 'maxWidthPercent', 'minHeightPercent', 'maxHeightPercent', 'strokes', 'strokeWeight', 'strokeAlign', 'gridRowAnchorIndex', 'gridColumnAnchorIndex', 'gridRowSpan', 'gridColumnSpan', 'gridChildHorizontalAlign', 'gridChildVerticalAlign']);
for (const k of ['layoutVersion', 'strokesIncludedInLayout', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight']) LAYOUT_CHILD_KEYS.add(k);

/** Latest includes only the frame's own inside stroke, independently per edge. */
function layoutInsets(doc: Document, id: string, latest = doc.get(id, 'layoutVersion') === 'LATEST') {
  const p = doc.props(id);
  const inside = latest && p.strokesIncludedInLayout !== false &&
    (p.strokeAlign ?? 'INSIDE') === 'INSIDE' && (p.strokes ?? []).some((s) => s.visible !== false);
  const weight = inside ? p.strokeWeight ?? 0 : 0;
  return {
    top: (p.paddingTop ?? 0) + (inside ? p.strokeTopWeight ?? weight : 0),
    right: (p.paddingRight ?? 0) + (inside ? p.strokeRightWeight ?? weight : 0),
    bottom: (p.paddingBottom ?? 0) + (inside ? p.strokeBottomWeight ?? weight : 0),
    left: (p.paddingLeft ?? 0) + (inside ? p.strokeLeftWeight ?? weight : 0),
  };
}

/** How far the layer's stroke extends outside (outside — the full width, center — half). */
function strokeOutset(doc: Document, id: string): number {
  const visible = (doc.get(id, 'strokes') ?? []).some((p) => p.visible !== false);
  if (!visible) return 0;
  // Per-side widths — use the thickest (the layout knows one outset per child).
  const base = doc.get(id, 'strokeWeight') ?? 0;
  const sides = [doc.get(id, 'strokeTopWeight'), doc.get(id, 'strokeRightWeight'), doc.get(id, 'strokeBottomWeight'), doc.get(id, 'strokeLeftWeight')];
  const w = sides.some((v) => v !== undefined) ? Math.max(...sides.map((v) => v ?? base)) : base;
  const a = doc.get(id, 'strokeAlign') ?? 'INSIDE';
  return a === 'OUTSIDE' ? w : a === 'CENTER' ? w / 2 : 0;
}

/**
 * Baseline of the first text line from the top of its bounds: the editor knows font metrics (it calls
 * setTextBaseline); without it — from prepared import glyphs or estimated from the font size.
 */
let textBaseline: ((doc: Document, id: string) => number | undefined) | null = null;
export function setTextBaseline(fn: ((doc: Document, id: string) => number | undefined) | null) {
  textBaseline = fn;
}

/** Child baseline (from the top of its bounds): for text — of the first line, for a frame — of the first child that has one. */
function childBaseline(doc: Document, id: string, depth = 0): number | undefined {
  const t = (doc.get(id, 'transform') ?? IDENTITY) as Matrix;
  if (Math.abs(t[1]) > 1e-9 || Math.abs(t[3]) > 1e-9) return undefined;
  if (doc.type(id) === 'TEXT') {
    const own = textBaseline?.(doc, id);
    if (own !== undefined) return own;
    const g = doc.get(id, 'textGlyphs')?.glyphs[0];
    if (g) return g[2];
    const size = doc.get(id, 'fontSize') ?? 12;
    return size * 0.95;
  }
  if (depth > 8) return undefined;
  for (const k of doc.children(id)) {
    if (doc.get(k, 'visible') === false || doc.get(k, 'layoutPositioning') === 'ABSOLUTE') continue;
    const b = childBaseline(doc, k, depth + 1);
    if (b !== undefined) return b + ((doc.get(k, 'transform') ?? IDENTITY) as Matrix)[5];
  }
  return undefined;
}

const LIMITS = ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const;
/** Limits as a percentage of the parent (MFP extension). */
const PCT_LIMITS = ['minWidthPercent', 'maxWidthPercent', 'minHeightPercent', 'maxHeightPercent'] as const;
/** null in the model means “no limit”; the layout engine needs undefined. */
const limit = (v: number | null | undefined) => (v === null ? undefined : v);

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Child bounding box in parent coordinates (rotated ones — by their bounding box). */
function childBox(doc: Document, id: string) {
  const t = (doc.get(id, 'transform') ?? IDENTITY) as Matrix;
  const w = doc.get(id, 'width') ?? 0;
  const h = doc.get(id, 'height') ?? 0;
  const xs = [0, t[0] * w, t[1] * h, t[0] * w + t[1] * h].map((v) => v + t[2]);
  const ys = [0, t[3] * w, t[4] * h, t[3] * w + t[4] * h].map((v) => v + t[5]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, axisAligned: Math.abs(t[1]) < 1e-9 && Math.abs(t[3]) < 1e-9 && t[0] > 0 && t[4] > 0 };
}

/** Lay out the frame's children (changes go through doc.set; the caller opens the transaction). */
/** Grid layout input and result (for drawing tracks on the canvas). */
export function gridLayout(doc: Document, id: string): GridResult | null {
  if (!ready || doc.get(id, 'layoutMode') !== 'GRID') return null;
  const p = doc.props(id);
  const kids = doc.children(id);
  const boxes = kids.map((k) => childBox(doc, k));
  const input: GridChild[] = kids.map((k, i) => ({
    width: boxes[i]!.w,
    height: boxes[i]!.h,
    visible: doc.get(k, 'visible') !== false,
    absolute: doc.get(k, 'layoutPositioning') === 'ABSOLUTE',
    row: (doc.get(k, 'gridRowAnchorIndex') ?? -1) >= 0 ? doc.get(k, 'gridRowAnchorIndex')! : undefined,
    column: (doc.get(k, 'gridColumnAnchorIndex') ?? -1) >= 0 ? doc.get(k, 'gridColumnAnchorIndex')! : undefined,
    rowSpan: doc.get(k, 'gridRowSpan') ?? 1,
    columnSpan: doc.get(k, 'gridColumnSpan') ?? 1,
    // In a grid, “fill” in width is layoutAlign STRETCH, in height — layoutGrow (as in a column).
    fillWidth: doc.get(k, 'layoutAlign') === 'STRETCH',
    fillHeight: (doc.get(k, 'layoutGrow') ?? 0) > 0,
    hAlign: doc.get(k, 'gridChildHorizontalAlign') ?? 'AUTO',
    vAlign: doc.get(k, 'gridChildVerticalAlign') ?? 'AUTO',
  }));
  const one = [{ type: 'FLEX' as const, value: 1 }];
  return computeGridLayout(
    {
      width: p.width ?? 0,
      height: p.height ?? 0,
      // As with flex, Fill cannot resolve against a Hug axis: retain its current size.
      hugWidth: p.counterAxisSizingMode === 'AUTO' && !input.some(c => c.visible !== false && !c.absolute && c.fillWidth),
      hugHeight: p.primaryAxisSizingMode === 'AUTO' && !input.some(c => c.visible !== false && !c.absolute && c.fillHeight),
      padding: { top: p.paddingTop ?? 0, right: p.paddingRight ?? 0, bottom: p.paddingBottom ?? 0, left: p.paddingLeft ?? 0 },
      rowGap: p.gridRowGap ?? 0,
      columnGap: p.gridColumnGap ?? 0,
      rows: p.gridRowSizes?.length ? p.gridRowSizes : one,
      columns: p.gridColumnSizes?.length ? p.gridColumnSizes : one,
      minWidth: limit(p.minWidth),
      maxWidth: limit(p.maxWidth),
      minHeight: limit(p.minHeight),
      maxHeight: limit(p.maxHeight),
    },
    input,
  );
}

/** Lay out a grid frame's children (changes go through doc.set; the caller opens the transaction). */
function layoutGridFrame(doc: Document, id: string) {
  const res = gridLayout(doc, id);
  if (!res) return;
  const p = doc.props(id);
  if (p.counterAxisSizingMode === 'AUTO' || p.primaryAxisSizingMode === 'AUTO') doc.set(id, { width: round(res.frame.width), height: round(res.frame.height) });
  doc.children(id).forEach((k, i) => {
    const box = res.children[i];
    if (!box) return;
    const b = childBox(doc, k);
    const t = (doc.get(k, 'transform') ?? IDENTITY) as Matrix;
    const props: Props = {};
    const fill = doc.get(k, 'layoutAlign') === 'STRETCH' || (doc.get(k, 'layoutGrow') ?? 0) > 0;
    if (fill && b.axisAligned) {
      props.width = round(box.width / t[0]);
      props.height = round(box.height / t[4]);
    }
    props.transform = [t[0], t[1], round(t[2] + box.x - b.x), t[3], t[4], round(t[5] + box.y - b.y)];
    doc.set(k, props);
  });
}

/** Size percentage: a number greater than zero, otherwise none. */
const percent = (v: number | undefined) => (typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : undefined);

export function layoutFrame(doc: Document, id: string) {
  if (!ready || !isAutoLayout(doc, id)) return;
  if (doc.get(id, 'layoutMode') === 'GRID') return layoutGridFrame(doc, id);
  const p = doc.props(id);
  const horizontal = p.layoutMode === 'HORIZONTAL';
  const latest = p.layoutVersion === 'LATEST';
  const hugPrimary = p.primaryAxisSizingMode === 'AUTO';
  const hugCounter = p.counterAxisSizingMode === 'AUTO';
  const kids = doc.children(id);
  const boxes = kids.map((k) => childBox(doc, k));
  const input: AutoLayoutChild[] = kids.map((k, i) => ({
    width: boxes[i]!.w,
    height: boxes[i]!.h,
    grow: (doc.get(k, 'layoutGrow') ?? 0) > 0,
    stretch: doc.get(k, 'layoutAlign') === 'STRETCH',
    widthPercent: percent(doc.get(k, 'widthPercent')),
    heightPercent: percent(doc.get(k, 'heightPercent')),
    absolute: doc.get(k, 'layoutPositioning') === 'ABSOLUTE',
    visible: doc.get(k, 'visible') !== false,
    minWidth: limit(doc.get(k, 'minWidth')),
    maxWidth: limit(doc.get(k, 'maxWidth')),
    minWidthPercent: percent(doc.get(k, 'minWidthPercent') ?? undefined),
    maxWidthPercent: percent(doc.get(k, 'maxWidthPercent') ?? undefined),
    minHeightPercent: percent(doc.get(k, 'minHeightPercent') ?? undefined),
    maxHeightPercent: percent(doc.get(k, 'maxHeightPercent') ?? undefined),
    minHeight: limit(doc.get(k, 'minHeight')),
    maxHeight: limit(doc.get(k, 'maxHeight')),
    outset: !latest && p.strokesIncludedInLayout ? strokeOutset(doc, k) : 0,
    insets: latest ? layoutInsets(doc, k, !isAutoLayout(doc, k) || doc.get(k, 'layoutVersion') === 'LATEST') : undefined,
    ...(horizontal && p.counterAxisAlignItems === 'BASELINE' ? { baseline: childBaseline(doc, k) } : {}),
  }));
  // “Hug” with a “fill” child on the same axis is not allowed — the axis becomes fixed
  // (files do contain this: otherwise the size would collapse to the padding).
  // A percentage on a “hug” axis has nothing to refer to either (like width: 50% inside max-content in CSS).
  const flowing = input.filter((c) => c.visible !== false && !c.absolute);
  const pctMain = (c: AutoLayoutChild) => (horizontal ? c.widthPercent : c.heightPercent) != null;
  const pctCross = (c: AutoLayoutChild) => (horizontal ? c.heightPercent : c.widthPercent) != null;
  const hugMain = hugPrimary && !flowing.some((c) => c.grow || pctMain(c));
  const hugCross = hugCounter && !flowing.some((c) => c.stretch || pctCross(c));
  // A fixed size is kept within min/max too.
  const hugWidth = horizontal ? hugMain : hugCross;
  const hugHeight = horizontal ? hugCross : hugMain;
  const width = hugWidth ? (p.width ?? 0) : clamp(p.width ?? 0, p.minWidth, p.maxWidth);
  const height = hugHeight ? (p.height ?? 0) : clamp(p.height ?? 0, p.minHeight, p.maxHeight);
  const frame: AutoLayoutFrame = {
    version: p.layoutVersion,
    direction: horizontal ? 'HORIZONTAL' : 'VERTICAL',
    width,
    height,
    minWidth: limit(p.minWidth),
    maxWidth: limit(p.maxWidth),
    minHeight: limit(p.minHeight),
    maxHeight: limit(p.maxHeight),
    hugWidth,
    hugHeight,
    gap: p.itemSpacing ?? 0,
    counterGap: p.counterAxisSpacing ?? undefined,
    padding: layoutInsets(doc, id),
    primaryAlign: p.primaryAxisAlignItems ?? 'MIN',
    counterAlign: p.counterAxisAlignItems ?? 'MIN',
    wrap: p.layoutWrap === 'WRAP',
    counterAlignContent: p.counterAxisAlignContent ?? 'AUTO',
  };
  const res = computeAutoLayout(frame, input);
  if (frame.hugWidth || frame.hugHeight || res.frame.width !== p.width || res.frame.height !== p.height) doc.set(id, { width: round(res.frame.width), height: round(res.frame.height) });
  kids.forEach((k, i) => {
    const box = res.children[i];
    if (!box) return;
    const b = boxes[i]!;
    const t = (doc.get(k, 'transform') ?? IDENTITY) as Matrix;
    const props: Props = {};
    // “Fill” and min/max limits change the size (only for unrotated ones — rotated ones only change
    // position). Text limits are handled by text fitting, not by the layout.
    const limited = doc.type(k) !== 'TEXT' && (LIMITS.some((key) => doc.get(k, key) != null) || PCT_LIMITS.some((key) => doc.get(k, key) != null));
    const pct = input[i]!.widthPercent != null || input[i]!.heightPercent != null;
    if ((input[i]!.grow || input[i]!.stretch || limited || pct) && b.axisAligned) {
      // Layout boxes are in parent coordinates; model dimensions precede the transform.
      props.width = round(box.width / t[0]);
      props.height = round(box.height / t[4]);
      // Text stretched by the layout cannot be “auto width”.
      if (doc.type(k) === 'TEXT' && (doc.get(k, 'textAutoResize') ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT') props.textAutoResize = 'HEIGHT';
    }
    props.transform = [t[0], t[1], round(t[2] + box.x - b.x), t[3], t[4], round(t[5] + box.y - b.y)];
    const w0 = doc.get(k, 'width') ?? 0;
    const h0 = doc.get(k, 'height') ?? 0;
    doc.set(k, props);
    // The layout changed the child's size — its content follows its own constraints.
    if (props.width !== undefined && (props.width !== w0 || props.height !== h0) && doc.children(k).length) applyConstraints(doc, k, [w0, h0], [props.width, props.height ?? h0]);
  });
}

/**
 * Enable auto layout on a frame (Shift+A), choosing parameters from the children's current arrangement:
 * direction — by the spread of centers, spacing — the average gap, padding — from the edges;
 * children are reordered in on-screen order.
 */
export function enableAutoLayout(doc: Document, id: string, opts: { hug?: boolean } = {}) {
  // New layouts follow Latest; merely opening old documents does not migrate them.
  doc.set(id, { layoutVersion: 'LATEST' });
  const visible = doc.children(id).filter((k) => doc.get(k, 'visible') !== false);
  const kids = visible.filter(k => doc.get(k, 'layoutPositioning') !== 'ABSOLUTE');
  const W = doc.get(id, 'width') ?? 0;
  const H = doc.get(id, 'height') ?? 0;
  if (!kids.length) {
    // Absolute children do not contribute to Hug. Preserve the clipping viewport.
    if (visible.length) {
      doc.set(id, { layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED' });
      return;
    }
    doc.set(id, { layoutMode: 'HORIZONTAL', itemSpacing: 10, paddingLeft: 10, paddingRight: 10, paddingTop: 10, paddingBottom: 10, primaryAxisSizingMode: 'AUTO', counterAxisSizingMode: 'AUTO' });
    return;
  }
  const boxes = new Map(kids.map((k) => [k, childBox(doc, k)]));
  const cx = kids.map((k) => boxes.get(k)!.x + boxes.get(k)!.w / 2);
  const cy = kids.map((k) => boxes.get(k)!.y + boxes.get(k)!.h / 2);
  const horizontal = Math.max(...cx) - Math.min(...cx) >= Math.max(...cy) - Math.min(...cy);
  const sorted = [...kids].sort((a, b) => (horizontal ? boxes.get(a)!.x - boxes.get(b)!.x : boxes.get(a)!.y - boxes.get(b)!.y));
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = boxes.get(sorted[i - 1]!)!;
    const cur = boxes.get(sorted[i]!)!;
    gaps.push(horizontal ? cur.x - (prev.x + prev.w) : cur.y - (prev.y + prev.h));
  }
  const gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)) : 0;
  const all = [...boxes.values()];
  const minX = Math.min(...all.map((b) => b.x));
  const minY = Math.min(...all.map((b) => b.y));
  const maxX = Math.max(...all.map((b) => b.x + b.w));
  const maxY = Math.max(...all.map((b) => b.y + b.h));
  // Cross-axis alignment: all aligned to the start, the end or the center.
  const near = (a: number, b: number) => Math.abs(a - b) < 1;
  const cross = horizontal
    ? all.every((b) => near(b.y, minY)) ? 'MIN' : all.every((b) => near(b.y + b.h, maxY)) ? 'MAX' : all.every((b) => near(b.y + b.h / 2, (minY + maxY) / 2)) ? 'CENTER' : 'MIN'
    : all.every((b) => near(b.x, minX)) ? 'MIN' : all.every((b) => near(b.x + b.w, maxX)) ? 'MAX' : all.every((b) => near(b.x + b.w / 2, (minX + maxX) / 2)) ? 'CENTER' : 'MIN';
  // Layout order = layer order (the first child is first in the flow).
  sorted.forEach((k, i) => doc.move(k, id, i));
  doc.set(id, {
    layoutMode: horizontal ? 'HORIZONTAL' : 'VERTICAL',
    itemSpacing: gap,
    paddingLeft: Math.max(0, Math.round(minX)),
    paddingTop: Math.max(0, Math.round(minY)),
    paddingRight: Math.max(0, Math.round(W - maxX)),
    paddingBottom: Math.max(0, Math.round(H - maxY)),
    primaryAxisAlignItems: 'MIN',
    counterAxisAlignItems: cross,
    primaryAxisSizingMode: opts.hug === false ? 'FIXED' : 'AUTO',
    counterAxisSizingMode: opts.hug === false ? 'FIXED' : 'AUTO',
  });
}

/**
 * Wrap nodes in a new auto layout frame (Shift+A on several layers or not on a frame).
 * worldOf — the node's world matrix, bounds — the common bounding box (world).
 */
export function wrapInAutoLayout(
  doc: Document,
  ids: string[],
  pageId: string,
  worldOf: (id: string) => Matrix,
  bounds: [number, number, number, number],
): string {
  const parent = doc.parent(ids[0]!)!;
  const parentWorld = parent === pageId ? IDENTITY : worldOf(parent);
  const siblings = doc.children(parent);
  const index = Math.max(...ids.map((id) => siblings.indexOf(id))) + 1;
  const frameWorld: Matrix = [1, 0, bounds[0], 0, 1, bounds[1]];
  const frame = doc.create(
    'FRAME',
    parent,
    {
      name: 'Frame',
      transform: multiply(invert(parentWorld), frameWorld),
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
      fills: [],
      clipsContent: false,
    },
    index,
  );
  for (const id of ids) {
    const abs = worldOf(id);
    doc.move(id, frame);
    doc.set(id, { transform: multiply(invert(frameWorld), abs) });
  }
  enableAutoLayout(doc, frame);
  return frame;
}
