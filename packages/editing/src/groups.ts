// Groups and boolean groups: the bounds follow the children. After child edits the bounds
// are fitted to their combined extent, and the children are shifted back — nothing moves on screen.
// Like layout and text size, this is derived data (Editor.fitGroups).

import { invert, multiply, type Document, type Matrix } from '@mfp/core';

export const FIT_TYPES = new Set(['GROUP', 'BOOLEAN_OPERATION']);
/** Child properties the group bounds depend on. */
export const FIT_CHILD_KEYS = new Set(['transform', 'width', 'height', 'visible', 'isMask']);

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];

/** Fit the group bounds to the children. An empty group is deleted. */
export function fitGroup(doc: Document, id: string) {
  if (!doc.has(id) || !FIT_TYPES.has(doc.type(id)!)) return;
  const kids = doc.children(id);
  if (!kids.length) {
    doc.delete(id);
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // A group with a mask: everything above the mask is visible only within it — bounds follow the mask
  // and the layers below it.
  const mask = kids.findIndex((k) => doc.get(k, 'isMask') === true && doc.get(k, 'visible') !== false);
  for (const k of mask >= 0 ? kids.slice(0, mask + 1) : kids) {
    if (doc.get(k, 'visible') === false) continue;
    const t = (doc.get(k, 'transform') ?? IDENTITY) as Matrix;
    const w = doc.get(k, 'width') ?? 0;
    const h = doc.get(k, 'height') ?? 0;
    for (const [x, y] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ] as const) {
      const px = t[0] * x + t[1] * y + t[2];
      const py = t[3] * x + t[4] * y + t[5];
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  }
  if (!Number.isFinite(minX)) return; // all children are hidden — leave the bounds alone
  const W = maxX - minX;
  const H = maxY - minY;
  const eps = 1e-6;
  if (Math.abs(minX) < eps && Math.abs(minY) < eps && Math.abs(W - (doc.get(id, 'width') ?? 0)) < eps && Math.abs(H - (doc.get(id, 'height') ?? 0)) < eps) return;
  // Children move by (-minX, -minY) in group coordinates; the group moves by the same in parent coordinates.
  for (const k of kids) {
    const t = (doc.get(k, 'transform') ?? IDENTITY) as Matrix;
    doc.set(k, { transform: [t[0], t[1], t[2] - minX, t[3], t[4], t[5] - minY] });
  }
  const g = (doc.get(id, 'transform') ?? IDENTITY) as Matrix;
  doc.set(id, {
    transform: [g[0], g[1], g[2] + g[0] * minX + g[1] * minY, g[3], g[4], g[5] + g[3] * minX + g[4] * minY],
    width: W,
    height: H,
  });
}

/**
 * Group siblings into a node of type type (group, boolean operation, component, frame) in place of the
 * topmost one; the on-screen position is preserved. worldOf — the node's world matrix, bounds — the common bounds (world).
 */
export function wrapNodes(
  doc: Document,
  ids: string[],
  pageId: string,
  worldOf: (id: string) => Matrix,
  bounds: [number, number, number, number],
  type: 'GROUP' | 'BOOLEAN_OPERATION' | 'COMPONENT' | 'FRAME',
  props: Parameters<Document['create']>[2] = {},
): string {
  const parent = doc.parent(ids[0]!)!;
  const parentWorld = parent === pageId ? IDENTITY : worldOf(parent);
  const siblings = doc.children(parent);
  // Child order as in the layers (bottom first).
  const ordered = [...ids].sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));
  const index = siblings.indexOf(ordered[ordered.length - 1]!) + 1;
  const world: Matrix = [1, 0, bounds[0], 0, 1, bounds[1]];
  const g = doc.create(type, parent, { ...props, transform: multiply(invert(parentWorld), world), width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] }, index);
  for (const id of ordered) {
    const abs = worldOf(id);
    doc.move(id, g);
    doc.set(id, { transform: multiply(invert(world), abs) });
  }
  return g;
}

/** What a container can be converted to from the layer header. */
export type ContainerKind = 'FRAME' | 'GROUP' | 'SECTION';

const KEEP_COMMON = ['name', 'transform', 'width', 'height', 'visible', 'locked', 'exportSettings'] as const;
const KEEP_LOOK = ['opacity', 'blendMode', 'effects'] as const;

/**
 * Change the container type (frame, group, section) in place: a new node of the same size and position,
 * the children move into it without shifting (child coordinates are in the parent container's space for all three).
 * A group has no fill, clipping or auto layout; a frame from a group has no fill and no
 * clipping (the look does not change); a section only at the top level of a page or inside a section. Returns the new id.
 */
export function convertContainer(doc: Document, id: string, to: ContainerKind): string {
  const from = doc.type(id);
  if (!from || from === to || !(from === 'FRAME' || from === 'GROUP' || from === 'SECTION')) return id;
  const parent = doc.parent(id)!;
  const index = doc.children(parent).indexOf(id);
  const props: Record<string, unknown> = {};
  for (const k of KEEP_COMMON) if (doc.get(id, k) !== undefined) props[k] = doc.get(id, k);
  if (to !== 'SECTION' && from !== 'SECTION') for (const k of KEEP_LOOK) if (doc.get(id, k) !== undefined) props[k] = doc.get(id, k);
  if (to === 'FRAME') {
    props.fills = from === 'SECTION' ? doc.get(id, 'fills') : [];
    props.clipsContent = from === 'SECTION';
  }
  if (to === 'SECTION') {
    if (from === 'FRAME' && doc.get(id, 'fills') !== undefined) props.fills = doc.get(id, 'fills');
    // A section is not rotated or flipped: translation only.
    const t = (doc.get(id, 'transform') ?? IDENTITY) as Matrix;
    props.transform = [1, 0, t[2], 0, 1, t[5]];
  }
  const next = doc.create(to, parent, props as Parameters<Document['create']>[2], index);
  for (const k of [...doc.children(id)]) doc.move(k, next);
  doc.delete(id);
  // Group bounds follow the children (children and the screen do not shift).
  if (to === 'GROUP') fitGroup(doc, next);
  return next;
}
