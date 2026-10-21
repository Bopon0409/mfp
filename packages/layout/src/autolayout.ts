// Auto layout on top of Taffy (CSS Flexbox, Rust → wasm), compatible with .fig files.
//
// Auto layout is almost flexbox, with differences handled here:
// - fixed-size children do not shrink (flex-shrink: 0);
// - “fill” on the main axis = flex-grow: 1 with basis 0; on the cross axis = align-self: stretch;
// - negative spacing between children is allowed (CSS gap cannot be < 0);
//   emulated with a negative margin on all children except the first;
// - hidden children and absolutely positioned children do not participate in layout;
// - baseline alignment (rows only) is done here: Taffy has no baselines for leaves.

import { AlignContent, AlignItems, AlignSelf, Display, FlexDirection, FlexWrap, JustifyContent, loadTaffy, Style, TaffyTree } from 'taffy-layout';

/** Auto spacing: between (SPACE_BETWEEN), around (SPACE_AROUND), evenly (SPACE_EVENLY), as in CSS. */
export type PrimaryAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' | 'SPACE_AROUND' | 'SPACE_EVENLY';
export type CounterAlign = 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';

export interface AutoLayoutFrame {
  version?: 'LEGACY' | 'LATEST';
  direction: 'HORIZONTAL' | 'VERTICAL';
  width: number;
  height: number;
  /** Size along the axes adapts to the content (“hug”). */
  hugWidth?: boolean;
  hugHeight?: boolean;
  gap: number;
  /** Spacing between rows when wrapping. */
  counterGap?: number;
  padding: { top: number; right: number; bottom: number; left: number };
  primaryAlign: PrimaryAlign;
  counterAlign: CounterAlign;
  wrap?: boolean;
  /** Row distribution when wrapping: AUTO — packed to the start, SPACE_BETWEEN — across the height. */
  counterAlignContent?: 'AUTO' | 'SPACE_BETWEEN';
  /** “Hug” size limits. */
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

export interface AutoLayoutChild {
  /** Padding and inside borders, used by Latest when distributing content space. */
  insets?: { top: number; right: number; bottom: number; left: number };
  width: number;
  height: number;
  /** “Fill” on the main axis. */
  grow?: boolean;
  /** “Fill” on the cross axis. */
  stretch?: boolean;
  /** Size as a percentage of the frame's inner area (like width: 50% in CSS). */
  widthPercent?: number;
  heightPercent?: number;
  absolute?: boolean;
  visible?: boolean;
  /** Limits as a percentage of the frame's inner area (take precedence over pixels). */
  minWidthPercent?: number;
  maxWidthPercent?: number;
  minHeightPercent?: number;
  maxHeightPercent?: number;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** How much the stroke takes outside on each side (“include stroke in layout”). */
  outset?: number;
  /** Baseline of the first text line from the child's top; absent — the child's bottom (as in CSS). */
  baseline?: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Value clamped to [min, max]; min takes precedence over max. */
export function clamp(v: number, min?: number | null, max?: number | null): number {
  if (max !== undefined && max !== null && v > max) v = max;
  if (min !== undefined && min !== null && v < min) v = min;
  return v;
}

let ready: Promise<unknown> | null = null;

/** Loads the Taffy wasm module (once). */
export function loadLayoutEngine(): Promise<unknown> {
  ready ??= loadTaffy();
  return ready;
}

const JUSTIFY: Record<PrimaryAlign, JustifyContent> = {
  MIN: JustifyContent.FlexStart,
  CENTER: JustifyContent.Center,
  MAX: JustifyContent.FlexEnd,
  SPACE_BETWEEN: JustifyContent.SpaceBetween,
  SPACE_AROUND: JustifyContent.SpaceAround,
  SPACE_EVENLY: JustifyContent.SpaceEvenly,
};

const ALIGN: Record<CounterAlign, AlignItems> = {
  MIN: AlignItems.FlexStart,
  CENTER: AlignItems.Center,
  MAX: AlignItems.FlexEnd,
  // Baseline: from the top of the row, then shifted by baselines (computeAutoLayout).
  BASELINE: AlignItems.FlexStart,
};

/**
 * Baseline: in each row (when wrapping, by the common top) children's baselines align to
 * the lowest one; the row grows, following rows shift down, and the “hug” height follows
 * the bottom edge. Stretched children (“fill” on the cross axis) stay as they are.
 */
function alignBaselines(frame: AutoLayoutFrame, frameBox: Box, children: AutoLayoutChild[], out: (Box | null)[]) {
  const rows = new Map<number, number[]>();
  out.forEach((b, i) => {
    if (!b || children[i]!.stretch) return;
    const key = Math.round(b.y * 100) / 100;
    rows.set(key, [...(rows.get(key) ?? []), i]);
  });
  const base = (i: number) => {
    const c = children[i]!;
    return c.baseline !== undefined && Number.isFinite(c.baseline) ? c.baseline : out[i]!.height;
  };
  let shift = 0;
  let bottom = -Infinity;
  for (const [top, idx] of [...rows].sort((a, b) => a[0] - b[0])) {
    const B = Math.max(...idx.map(base));
    const oldBottom = Math.max(...idx.map((i) => out[i]!.y + out[i]!.height));
    let newBottom = -Infinity;
    for (const i of idx) {
      const b = out[i]!;
      b.y = top + shift + (B - base(i));
      newBottom = Math.max(newBottom, b.y + b.height);
    }
    shift = newBottom - oldBottom;
    bottom = Math.max(bottom, newBottom);
  }
  // Stretched and other children in lower rows also move down by the accumulated offset (when wrapping).
  if (frame.hugHeight && Number.isFinite(bottom)) {
    for (const b of out) if (b) bottom = Math.max(bottom, b.y + b.height);
    frameBox.height = clamp(bottom + frame.padding.bottom, frame.minHeight, frame.maxHeight);
  }
}

/**
 * Lays out the frame's children. Returns boxes in frame coordinates
 * (for invisible and absolute children, their original sizes and a null position that does not change: x=y=NaN),
 * plus the resulting frame size (taking “hug” into account).
 */
export function computeAutoLayout(frame: AutoLayoutFrame, children: AutoLayoutChild[]): { frame: Box; children: (Box | null)[] } {
  const latest = frame.version === 'LATEST';
  if (latest) frame = {
    ...frame,
    width: Math.max(frame.width, frame.padding.left + frame.padding.right),
    height: Math.max(frame.height, frame.padding.top + frame.padding.bottom),
    minWidth: Math.max(frame.minWidth ?? 0, frame.padding.left + frame.padding.right),
    minHeight: Math.max(frame.minHeight ?? 0, frame.padding.top + frame.padding.bottom),
  };
  const tree = new TaffyTree();
  // Positions are not rounded to pixels (166.67 stays 166.67).
  tree.disableRounding();
  const horizontal = frame.direction === 'HORIZONTAL';
  const styles: Style[] = [];
  const ids: (bigint | null)[] = [];
  const autoGap = frame.primaryAlign === 'SPACE_BETWEEN' || frame.primaryAlign === 'SPACE_AROUND' || frame.primaryAlign === 'SPACE_EVENLY';
  const negativeGap = frame.gap < 0 && !autoGap;
  let flowIndex = 0;
  try {
    for (const c of children) {
      if (c.visible === false || c.absolute) {
        ids.push(null);
        continue;
      }
      const s = new Style();
      styles.push(s);
      s.flexShrink = 0;
      if (latest && c.insets) s.padding = c.insets;
      const o2 = 2 * (c.outset ?? 0);
      const mainSize = (horizontal ? c.width : c.height) + o2;
      const crossSize = (horizontal ? c.height : c.width) + o2;
      // A percentage is relative to the frame's inner area (Taffy: “50%”); no correction for stroke overhang.
      const mainPct = horizontal ? c.widthPercent : c.heightPercent;
      const crossPct = horizontal ? c.heightPercent : c.widthPercent;
      if (c.grow) {
        s.flexGrow = 1;
        s.flexBasis = 0;
      } else if (horizontal) s.width = mainPct != null ? `${mainPct}%` : mainSize;
      else s.height = mainPct != null ? `${mainPct}%` : mainSize;
      if (c.stretch) s.alignSelf = AlignSelf.Stretch;
      else if (horizontal) s.height = crossPct != null ? `${crossPct}%` : crossSize;
      else s.width = crossPct != null ? `${crossPct}%` : crossSize;
      if (c.minWidthPercent != null) s.minWidth = `${c.minWidthPercent}%`;
      else if (c.minWidth !== undefined) s.minWidth = c.minWidth;
      if (c.maxWidthPercent != null) s.maxWidth = `${c.maxWidthPercent}%`;
      else if (c.maxWidth !== undefined) s.maxWidth = c.maxWidth;
      if (c.minHeightPercent != null) s.minHeight = `${c.minHeightPercent}%`;
      else if (c.minHeight !== undefined) s.minHeight = c.minHeight;
      if (c.maxHeightPercent != null) s.maxHeight = `${c.maxHeightPercent}%`;
      else if (c.maxHeight !== undefined) s.maxHeight = c.maxHeight;
      if (negativeGap && flowIndex > 0) {
        if (horizontal) s.marginLeft = frame.gap;
        else s.marginTop = frame.gap;
      }
      flowIndex++;
      ids.push(tree.newLeaf(s));
    }
    const fs = new Style();
    styles.push(fs);
    fs.display = Display.Flex;
    fs.flexDirection = horizontal ? FlexDirection.Row : FlexDirection.Column;
    fs.flexWrap = frame.wrap ? FlexWrap.Wrap : FlexWrap.NoWrap;
    // “Distribute” with a single child centers it (in CSS it goes to the start).
    const singleBetween = !latest && frame.primaryAlign === 'SPACE_BETWEEN' && flowIndex === 1;
    const gap = autoGap || negativeGap ? 0 : frame.gap;
    // Spacing between rows when wrapping: if not set, the main spacing.
    const counterGap = frame.wrap ? Math.max(0, Number.isFinite(frame.counterGap) ? (frame.counterGap as number) : frame.gap) : 0;
    fs.gap = horizontal ? { width: gap, height: counterGap } : { width: counterGap, height: gap };
    fs.padding = { left: frame.padding.left, right: frame.padding.right, top: frame.padding.top, bottom: frame.padding.bottom };
    fs.justifyContent = singleBetween ? JustifyContent.Center : JUSTIFY[frame.primaryAlign];
    fs.alignItems = ALIGN[frame.counterAlign];
    // Wrapped rows are packed to the start (in CSS they stretch by default).
    fs.alignContent = frame.counterAlignContent === 'SPACE_BETWEEN' ? AlignContent.SpaceBetween : AlignContent.FlexStart;
    fs.width = frame.hugWidth ? 'auto' : frame.width;
    fs.height = frame.hugHeight ? 'auto' : frame.height;
    if (frame.hugWidth && frame.minWidth != null) fs.minWidth = frame.minWidth;
    if (frame.hugWidth && frame.maxWidth != null) fs.maxWidth = frame.maxWidth;
    if (frame.hugHeight && frame.minHeight != null) fs.minHeight = frame.minHeight;
    if (frame.hugHeight && frame.maxHeight != null) fs.maxHeight = frame.maxHeight;
    const root = tree.newWithChildren(fs, ids.filter((x): x is bigint => x !== null));
    tree.computeLayout(root, { width: frame.hugWidth ? 'max-content' : frame.width, height: frame.hugHeight ? 'max-content' : frame.height });
    const rl = tree.getLayout(root);
    // CSS does not let the frame get smaller than the sum of its padding; here a fixed size takes precedence.
    // min/max limits constrain the “hug” size (min takes precedence over max, as in CSS).
    const frameBox = {
      x: 0,
      y: 0,
      width: frame.hugWidth ? clamp(rl.width, frame.minWidth, frame.maxWidth) : frame.width,
      height: frame.hugHeight ? clamp(rl.height, frame.minHeight, frame.maxHeight) : frame.height,
    };
    rl.free();
    // If padding exceeds the frame itself, free space is negative and alignment uses it;
    // CSS (Taffy) clamps it to zero. Correction: shift by “alignment factor × remainder”.
    const mainFactor = singleBetween ? 0.5 : { MIN: 0, CENTER: 0.5, MAX: 1, SPACE_BETWEEN: 0, SPACE_AROUND: 0.5, SPACE_EVENLY: 0.5 }[frame.primaryAlign];
    const crossFactor = { MIN: 0, CENTER: 0.5, MAX: 1, BASELINE: 0 }[frame.counterAlign];
    const p = frame.padding;
    const mainFree = horizontal ? frameBox.width - p.left - p.right : frameBox.height - p.top - p.bottom;
    const crossFree = horizontal ? frameBox.height - p.top - p.bottom : frameBox.width - p.left - p.right;
    const mainShift = mainFree < 0 ? mainFactor * mainFree : 0;
    const out = ids.map((id, i) => {
      if (id === null) return null;
      const l = tree.getLayout(id);
      const o = children[i]!.outset ?? 0;
      const box = { x: l.x + o, y: l.y + o, width: l.width - 2 * o, height: l.height - 2 * o };
      l.free();
      const crossShift = crossFree < 0 && !children[i]!.stretch ? crossFactor * crossFree : 0;
      if (horizontal) {
        box.x += mainShift;
        box.y += crossShift;
      } else {
        box.y += mainShift;
        box.x += crossShift;
      }
      return box;
    });
    if (frame.counterAlign === 'BASELINE' && horizontal) alignBaselines(frame, frameBox, children, out);
    return { frame: frameBox, children: out };
  } finally {
    for (const s of styles) s.free();
    tree.free();
  }
}

