// Grid in auto layout (grid flow) on top of Taffy's CSS Grid engine.
// Tracks: FIXED — in pixels, FLEX — fractions of free space (fr), HUG — by content.
// Children are placed in the given cell (with row and column spans) or in order into free cells.

import { AlignItems, AlignSelf, Display, GridAutoFlow, Style, TaffyTree, type TrackSizingFunction } from 'taffy-layout';
import { clamp, type Box } from './autolayout.ts';

export interface GridTrack {
  type: 'FLEX' | 'FIXED' | 'HUG';
  value?: number;
}

export interface GridFrame {
  width: number;
  height: number;
  hugWidth?: boolean;
  hugHeight?: boolean;
  padding: { top: number; right: number; bottom: number; left: number };
  rowGap: number;
  columnGap: number;
  rows: GridTrack[];
  columns: GridTrack[];
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

export type GridAlign = 'AUTO' | 'MIN' | 'CENTER' | 'MAX';

export interface GridChild {
  width: number;
  height: number;
  visible?: boolean;
  absolute?: boolean;
  /** Cell (zero-based); not set — placed in order into a free cell. */
  row?: number;
  column?: number;
  rowSpan?: number;
  columnSpan?: number;
  /** “Fill” the cell by width / height. */
  fillWidth?: boolean;
  fillHeight?: boolean;
  hAlign?: GridAlign;
  vAlign?: GridAlign;
}

export interface GridResult {
  frame: Box;
  children: (Box | null)[];
  /** Track boundaries in frame coordinates: [start, end] of each column and row. */
  columns: [number, number][];
  rows: [number, number][];
  /** Cell of each child (zero-based) as the grid placed it. */
  cells: ({ row: number; column: number } | null)[];
}

function track(t: GridTrack): TrackSizingFunction {
  if (t.type === 'FIXED') return { min: t.value ?? 0, max: t.value ?? 0 };
  if (t.type === 'HUG') return { min: 'max-content', max: 'max-content' };
  return { min: 0, max: `${Math.max(0.01, t.value ?? 1)}fr` };
}

const SELF: Record<GridAlign, AlignSelf> = {
  AUTO: AlignSelf.Start,
  MIN: AlignSelf.Start,
  CENTER: AlignSelf.Center,
  MAX: AlignSelf.End,
};

/** Lay out the children of a grid frame. Boxes are in frame coordinates (null for hidden and absolute children). */
export function computeGridLayout(frame: GridFrame, children: GridChild[]): GridResult {
  const tree = new TaffyTree();
  tree.disableRounding();
  const styles: Style[] = [];
  const ids: (bigint | null)[] = [];
  try {
    for (const c of children) {
      if (c.visible === false || c.absolute) {
        ids.push(null);
        continue;
      }
      const s = new Style();
      styles.push(s);
      if (c.fillWidth) s.justifySelf = AlignSelf.Stretch;
      else {
        s.width = c.width;
        s.justifySelf = SELF[c.hAlign ?? 'AUTO'];
      }
      if (c.fillHeight) s.alignSelf = AlignSelf.Stretch;
      else {
        s.height = c.height;
        s.alignSelf = SELF[c.vAlign ?? 'AUTO'];
      }
      const rs = Math.max(1, Math.round(c.rowSpan ?? 1));
      const cs = Math.max(1, Math.round(c.columnSpan ?? 1));
      s.gridRow = c.row !== undefined && c.row >= 0 ? { start: c.row + 1, end: { span: rs } } : { start: 'auto', end: { span: rs } };
      s.gridColumn = c.column !== undefined && c.column >= 0 ? { start: c.column + 1, end: { span: cs } } : { start: 'auto', end: { span: cs } };
      ids.push(tree.newLeaf(s));
    }
    const fs = new Style();
    styles.push(fs);
    fs.display = Display.Grid;
    fs.gridTemplateColumns = frame.columns.map(track);
    fs.gridTemplateRows = frame.rows.map(track);
    // Extra children go into new hug rows.
    fs.gridAutoRows = [{ min: 'max-content', max: 'max-content' }];
    fs.gridAutoFlow = GridAutoFlow.Row;
    fs.gap = { width: Math.max(0, frame.columnGap), height: Math.max(0, frame.rowGap) };
    fs.padding = { left: frame.padding.left, right: frame.padding.right, top: frame.padding.top, bottom: frame.padding.bottom };
    fs.alignItems = AlignItems.Start;
    fs.width = frame.hugWidth ? 'auto' : frame.width;
    fs.height = frame.hugHeight ? 'auto' : frame.height;
    if (frame.hugWidth && frame.minWidth != null) fs.minWidth = frame.minWidth;
    if (frame.hugWidth && frame.maxWidth != null) fs.maxWidth = frame.maxWidth;
    if (frame.hugHeight && frame.minHeight != null) fs.minHeight = frame.minHeight;
    if (frame.hugHeight && frame.maxHeight != null) fs.maxHeight = frame.maxHeight;
    const root = tree.newWithChildren(fs, ids.filter((x): x is bigint => x !== null));
    tree.computeLayout(root, { width: frame.hugWidth ? 'max-content' : frame.width, height: frame.hugHeight ? 'max-content' : frame.height });
    const rl = tree.getLayout(root);
    const frameBox: Box = {
      x: 0,
      y: 0,
      width: frame.hugWidth ? clamp(rl.width, frame.minWidth, frame.maxWidth) : frame.width,
      height: frame.hugHeight ? clamp(rl.height, frame.minHeight, frame.maxHeight) : frame.height,
    };
    rl.free();
    const out = ids.map((id) => {
      if (id === null) return null;
      const l = tree.getLayout(id);
      const box = { x: l.x, y: l.y, width: l.width, height: l.height };
      l.free();
      return box;
    });
    // Tracks and cells come from detailed grid info (if the Taffy build provides it).
    let columns: [number, number][] = [];
    let rows: [number, number][] = [];
    let cells: ({ row: number; column: number } | null)[] = ids.map(() => null);
    try {
      const info = (tree as unknown as { detailedLayoutInfo(n: bigint): unknown }).detailedLayoutInfo(root) as {
        rows: { positions: { start: number; end: number }[]; negativeImplicitTracks: number };
        columns: { positions: { start: number; end: number }[]; negativeImplicitTracks: number };
        items: { rowStart: number; columnStart: number }[];
      } | null;
      if (info) {
        columns = info.columns.positions.map((p) => [p.start, p.end]);
        rows = info.rows.positions.map((p) => [p.start, p.end]);
        let k = 0;
        cells = ids.map((id) => {
          if (id === null) return null;
          const it = info.items[k++];
          return it ? { row: it.rowStart - 1 - info.rows.negativeImplicitTracks, column: it.columnStart - 1 - info.columns.negativeImplicitTracks } : null;
        });
      }
    } catch {
      // No detailed info: grid lines are not shown.
    }
    return { frame: frameBox, children: out, columns, rows, cells };
  } finally {
    for (const s of styles) s.free();
    tree.free();
  }
}
