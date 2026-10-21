// Sizing modes per axis: fixed, “hug” and “fill”.
// The model stores them as properties from the Figma plugin API:
// - on an auto layout frame — primaryAxisSizingMode / counterAxisSizingMode (AUTO — hug);
// - on text — textAutoResize (auto width / auto height / fixed);
// - on an auto layout child — layoutGrow (along the parent's main axis) and layoutAlign STRETCH (across).
// Constraints live here too — how layers behave when the parent is resized.
// The module does not pull in the layout engine — the plugin sandbox uses it as well.

import type { Constraints, ConstraintType, Document, Matrix, NodeType, PropName, Props } from '@mfp/core';

export type Axis = 'width' | 'height';
/** PERCENT — a percentage of the auto layout parent's inner area (like width: 50% in CSS; MFP extension). */
export type SizingMode = 'FIXED' | 'HUG' | 'FILL' | 'PERCENT';

/** Percentage property per axis. */
export const percentKey = (axis: Axis) => (axis === 'width' ? 'widthPercent' : 'heightPercent') as 'widthPercent' | 'heightPercent';

/** Children laid out by rules (row, column or grid). In a grid, width acts as the cross axis. */
export function isAutoLayout(doc: Document, id: string): boolean {
  const m = doc.get(id, 'layoutMode');
  return m === 'HORIZONTAL' || m === 'VERTICAL' || m === 'GRID';
}

/** Auto layout frame property that stores the sizing mode per axis. */
function ownKey(doc: Document, id: string, axis: Axis): 'primaryAxisSizingMode' | 'counterAxisSizingMode' {
  return (doc.get(id, 'layoutMode') === 'HORIZONTAL') === (axis === 'width') ? 'primaryAxisSizingMode' : 'counterAxisSizingMode';
}

/** “Fill” property per axis: along the parent's main axis — layoutGrow, across — layoutAlign. */
function fillKey(doc: Document, id: string, axis: Axis): 'layoutGrow' | 'layoutAlign' | null {
  const p = doc.parent(id);
  if (!p || !isAutoLayout(doc, p) || doc.get(id, 'layoutPositioning') === 'ABSOLUTE') return null;
  return (doc.get(p, 'layoutMode') === 'HORIZONTAL') === (axis === 'width') ? 'layoutGrow' : 'layoutAlign';
}

/** Auto layout frames and text support “hug”. */
export function canHug(doc: Document, id: string): boolean {
  return doc.type(id) === 'TEXT' || isAutoLayout(doc, id);
}

/** “Fill” applies to layers in the auto layout flow (group bounds follow their children — not allowed for them). */
export function canFill(doc: Document, id: string): boolean {
  const t = doc.type(id);
  return t !== 'GROUP' && t !== 'BOOLEAN_OPERATION' && fillKey(doc, id, 'width') !== null;
}

/** Min/max limits apply to auto layout frames and their children. */
export function canLimit(doc: Document, id: string): boolean {
  const p = doc.parent(id);
  return isAutoLayout(doc, id) || (!!p && isAutoLayout(doc, p));
}

export const LIMIT_KEYS: Record<Axis, readonly ['minWidth' | 'minHeight', 'maxWidth' | 'maxHeight']> = {
  width: ['minWidth', 'maxWidth'],
  height: ['minHeight', 'maxHeight'],
};

function isFill(doc: Document, id: string, axis: Axis): boolean {
  const k = fillKey(doc, id, axis);
  if (k === 'layoutGrow') return (doc.get(id, 'layoutGrow') ?? 0) > 0;
  if (k === 'layoutAlign') return doc.get(id, 'layoutAlign') === 'STRETCH';
  return false;
}

export function getSizing(doc: Document, id: string, axis: Axis): SizingMode {
  if (isFill(doc, id, axis)) return 'FILL';
  if ((doc.get(id, percentKey(axis)) ?? 0) > 0 && canFill(doc, id)) return 'PERCENT';
  if (doc.type(id) === 'TEXT') {
    const m = doc.get(id, 'textAutoResize') ?? 'WIDTH_AND_HEIGHT';
    return m === 'WIDTH_AND_HEIGHT' || (axis === 'height' && m === 'HEIGHT') ? 'HUG' : 'FIXED';
  }
  if (isAutoLayout(doc, id)) return doc.get(id, ownKey(doc, id, axis)) === 'AUTO' ? 'HUG' : 'FIXED';
  return 'FIXED';
}

/**
 * The node's own properties for the mode on an axis. For FIXED this is also what must be added to an
 * explicitly set size (typing a number, dragging a handle): “hug” and “fill” are removed.
 */
export function sizingProps(doc: Document, id: string, axis: Axis, mode: SizingMode): Props {
  const props: Props = {};
  const clearFill = (a: Axis, fill: boolean) => {
    const k = fillKey(doc, id, a);
    if (k === 'layoutGrow') props.layoutGrow = fill ? 1 : 0;
    if (k === 'layoutAlign') props.layoutAlign = fill ? 'STRETCH' : 'INHERIT';
  };
  clearFill(axis, mode === 'FILL');
  // A percentage holds only in its own mode (a number, “fill” or “hug” removes it).
  if (mode !== 'PERCENT' && doc.get(id, percentKey(axis)) != null) props[percentKey(axis)] = undefined;
  if (doc.type(id) === 'TEXT') {
    const m = doc.get(id, 'textAutoResize') ?? 'WIDTH_AND_HEIGHT';
    let next = m;
    if (axis === 'width') next = mode === 'HUG' ? 'WIDTH_AND_HEIGHT' : m === 'WIDTH_AND_HEIGHT' ? 'HEIGHT' : m;
    else next = mode === 'HUG' ? (m === 'NONE' ? 'HEIGHT' : m) : 'NONE';
    if (next !== m) props.textAutoResize = next;
    // Auto width pulls the height along too — fill in height is removed.
    if (axis === 'width' && mode === 'HUG') clearFill('height', false);
  } else if (isAutoLayout(doc, id)) {
    props[ownKey(doc, id, axis)] = mode === 'HUG' ? 'AUTO' : 'FIXED';
  }
  return props;
}

/**
 * Set the sizing mode on an axis with adjustments to neighbors: a “hug” parent
 * becomes fixed when a child fills it; children that filled the frame become
 * fixed when the frame switches to “hug”. The caller opens the transaction.
 */
export function setSizing(doc: Document, id: string, axis: Axis, mode: SizingMode): boolean {
  if (mode === 'HUG' && !canHug(doc, id)) return false;
  if (mode === 'FILL' && !canFill(doc, id)) return false;
  doc.set(id, sizingProps(doc, id, axis, mode));
  if (mode === 'FILL') {
    const p = doc.parent(id)!;
    const key = ownKey(doc, p, axis);
    if (doc.get(p, key) === 'AUTO') doc.set(p, { [key]: 'FIXED' });
  }
  if (mode === 'HUG' && isAutoLayout(doc, id)) {
    for (const k of doc.children(id)) if (isFill(doc, k, axis)) doc.set(k, sizingProps(doc, k, axis, 'FIXED'));
  }
  return true;
}

/**
 * Size as a percentage of the auto layout parent's inner area (the caller opens the transaction).
 * A parent that hugs on this axis becomes fixed: the percentage has nothing to refer to.
 */
export function setPercent(doc: Document, id: string, axis: Axis, value: number): boolean {
  if (!canFill(doc, id) || !(value > 0)) return false;
  doc.set(id, { ...sizingProps(doc, id, axis, 'PERCENT'), [percentKey(axis)]: Math.min(1000, Math.round(value * 100) / 100) });
  const p = doc.parent(id)!;
  const key = ownKey(doc, p, axis);
  if (doc.get(p, key) === 'AUTO') doc.set(p, { [key]: 'FIXED' });
  return true;
}

/** The percentage the layer size would currently be: a fraction of the parent's inner area (null — not in auto layout). */
export function percentOfParent(doc: Document, id: string, axis: Axis): number | null {
  const p = doc.parent(id);
  if (!p || !canFill(doc, id)) return null;
  const pad = axis === 'width' ? (doc.get(p, 'paddingLeft') ?? 0) + (doc.get(p, 'paddingRight') ?? 0) : (doc.get(p, 'paddingTop') ?? 0) + (doc.get(p, 'paddingBottom') ?? 0);
  const inner = (doc.get(p, axis) ?? 0) - pad;
  return inner > 0 ? Math.round(((doc.get(id, axis) ?? 0) / inner) * 10000) / 100 : null;
}

/** Size limit: null — remove. The value is at least zero; the layout adjusts the node size. */
export function setLimit(doc: Document, id: string, key: (typeof LIMIT_KEYS)[Axis][number], value: number | null) {
  doc.set(id, { [key as PropName]: value === null ? null : Math.max(0, value) } as Props);
}

// ---------- Constraints: how layers behave when the parent is resized ----------
// Per axis: MIN — to the left (top) edge, MAX — to the right (bottom), CENTER — centered,
// STRETCH — to both edges (the size changes), SCALE — proportionally.
// Group children always scale with the group. In auto layout, constraints apply only
// to absolutely positioned layers (the flow lays out the rest).


const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];
const SCALE_BOTH: Constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
/** The bounds of these nodes follow their children — their children scale with them. */
const GROUPS = new Set<NodeType>(['GROUP', 'BOOLEAN_OPERATION']);

/** New start and size along an axis: start and size are the child's, from and to are the parent's size. */
function onAxis(c: ConstraintType, start: number, size: number, from: number, to: number): [number, number] {
  const d = to - from;
  switch (c) {
    case 'MAX':
      return [start + d, size];
    case 'CENTER':
      return [start + d / 2, size];
    case 'STRETCH':
      return [start, Math.max(0.01, size + d)];
    case 'SCALE': {
      const k = from > 0 ? to / from : 1;
      return [start * k, Math.max(0.01, size * k)];
    }
    default:
      return [start, size];
  }
}

/** Child bounds in parent coordinates. */
function boxOf(t: Matrix, w: number, h: number): [number, number, number, number] {
  const xs = [0, t[0] * w, t[1] * h, t[0] * w + t[1] * h].map((v) => v + t[2]);
  const ys = [0, t[3] * w, t[4] * h, t[3] * w + t[4] * h].map((v) => v + t[5]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/**
 * Parent id changed size from from to to — position its children by their constraints (and further
 * down if a child's size changed too). source — original node properties: when dragging a
 * handle this is a snapshot from before the start (positions are computed from it, without accumulating errors).
 * The caller opens the transaction.
 */
export function applyConstraints(doc: Document, id: string, from: [number, number], to: [number, number], source: (id: string) => Props = (n) => doc.props(n)) {
  const type = doc.type(id);
  if (!type) return;
  const group = GROUPS.has(type);
  const al = isAutoLayout(doc, id);
  for (const c of doc.children(id)) {
    const p = source(c);
    if (al && p.layoutPositioning !== 'ABSOLUTE') continue;
    const cons = group ? SCALE_BOTH : (p.constraints ?? { horizontal: 'MIN', vertical: 'MIN' });
    const t = (p.transform ?? IDENTITY) as Matrix;
    const w = p.width ?? 0;
    const h = p.height ?? 0;
    const cType = doc.type(c)!;
    const axisAligned = Math.abs(t[1]) < 1e-9 && Math.abs(t[3]) < 1e-9;
    const [bx, by, bw, bh] = boxOf(t, w, h);
    let [nx, nbw] = onAxis(cons.horizontal, bx, bw, from[0], to[0]);
    let [ny, nbh] = onAxis(cons.vertical, by, bh, from[1], to[1]);
    const props: Props = {};
    let nw = w;
    let nh = h;
    if (axisAligned) {
      // Only unrotated layers change size (rotated ones move by their bounds).
      nw = nbw;
      nh = cType === 'LINE' ? h : nbh;
      // For a flipped layer the origin is on the other side.
      props.transform = [t[0], t[1], t[0] < 0 ? nx + nw : nx, t[3], t[4], t[4] < 0 ? ny + nh : ny];
    } else {
      // Rotated: the bounds center follows the constraints, the size is unchanged.
      nx += (nbw - bw) / 2;
      ny += (nbh - bh) / 2;
      props.transform = [t[0], t[1], t[2] + (nx - bx), t[3], t[4], t[5] + (ny - by)];
    }
    if (nw !== w) Object.assign(props, sizingProps(doc, c, 'width', 'FIXED'), { width: nw });
    if (nh !== h) Object.assign(props, sizingProps(doc, c, 'height', 'FIXED'), { height: nh });
    if (nw === w) props.width = w;
    if (nh === h) props.height = h;
    // Back to the original size (dragging from the snapshot) — the text mode is the original too.
    if (cType === 'TEXT' && nw === w && nh === h && p.textAutoResize) props.textAutoResize = p.textAutoResize;
    doc.set(c, props);
    // The child's content: its size changed — or returned to the original (dragging from the snapshot).
    if (doc.children(c).length) applyConstraints(doc, c, [w, h], [nw, nh], source);
  }
}

/**
 * Resize a node respecting its children's constraints (W / H input in the panel, resize() for plugins).
 * props — the node's new properties (including width / height).
 */
export function resizeWithConstraints(doc: Document, id: string, props: Props) {
  const w0 = doc.get(id, 'width') ?? 0;
  const h0 = doc.get(id, 'height') ?? 0;
  doc.set(id, props);
  const w1 = doc.get(id, 'width') ?? 0;
  const h1 = doc.get(id, 'height') ?? 0;
  if ((w0 !== w1 || h0 !== h1) && doc.children(id).length) applyConstraints(doc, id, [w0, h0], [w1, h1]);
}

/**
 * “Resize to fit” (Ctrl+Alt+Shift+R) for a frame or section without auto layout: the bounds
 * follow the children's extent, the children stay in place on the page.
 */
export function resizeToFit(doc: Document, id: string): boolean {
  const kids = doc.children(id).filter((k) => doc.get(k, 'visible') !== false);
  if (!kids.length || isAutoLayout(doc, id)) return false;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const k of kids) {
    const [bx, by, bw, bh] = boxOf((doc.get(k, 'transform') ?? IDENTITY) as Matrix, doc.get(k, 'width') ?? 0, doc.get(k, 'height') ?? 0);
    x0 = Math.min(x0, bx);
    y0 = Math.min(y0, by);
    x1 = Math.max(x1, bx + bw);
    y1 = Math.max(y1, by + bh);
  }
  const t = (doc.get(id, 'transform') ?? IDENTITY) as Matrix;
  // Shift the frame origin by (x0, y0) in its own coordinates; children shift back.
  doc.set(id, { transform: [t[0], t[1], t[0] * x0 + t[1] * y0 + t[2], t[3], t[4], t[3] * x0 + t[4] * y0 + t[5]], width: x1 - x0, height: y1 - y0 });
  for (const k of doc.children(id)) {
    const kt = (doc.get(k, 'transform') ?? IDENTITY) as Matrix;
    doc.set(k, { transform: [kt[0], kt[1], kt[2] - x0, kt[3], kt[4], kt[5] - y0] });
  }
  return true;
}
