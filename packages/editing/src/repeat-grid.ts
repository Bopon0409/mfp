// Grid repeat (MFP extension).
// The container frame (a FRAME with the repeatGrid property) holds the main component in the first cell
// and its instances in the others: editing the first cell applies to all at once, texts and images of
// individual cells are instance overrides. Stretching the frame gives as many cells as fit (rounded,
// as in XD), and the frame snaps exactly to the grid. Columns, rows and gaps are in the panel.
//
// The layout is our own (not auto layout): cell i is column i % columns, row ⌊i / columns⌋.

import { instantiate, type Document, type Matrix, type Props } from '@mfp/core';

export interface RepeatGrid {
  columns: number;
  rows: number;
  gapX: number;
  gapY: number;
}

/** The frame is a grid repeat. */
export function isRepeatGrid(doc: Document, id: string): boolean {
  return doc.has(id) && doc.type(id) === 'FRAME' && !!doc.get(id, 'repeatGrid');
}

/** Template cell: the main component (the first component child), otherwise the first child. */
export function repeatMaster(doc: Document, id: string): string | undefined {
  const kids = doc.children(id);
  return kids.find((k) => doc.type(k) === 'COMPONENT') ?? kids[0];
}

/**
 * Wrap a component in a grid repeat in its place: columns × rows cells with gaps.
 * The caller opens the transaction. Returns the frame.
 */
export function createRepeatGrid(doc: Document, componentId: string, grid: Partial<RepeatGrid> = {}): string {
  const parent = doc.parent(componentId)!;
  const index = doc.children(parent).indexOf(componentId);
  const t = (doc.get(componentId, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
  const cfg: RepeatGrid = { columns: grid.columns ?? 3, rows: grid.rows ?? 2, gapX: grid.gapX ?? 16, gapY: grid.gapY ?? 16 };
  const frame = doc.create(
    'FRAME',
    parent,
    {
      name: 'Повтор сеткой',
      transform: [1, 0, t[2], 0, 1, t[5]],
      width: doc.get(componentId, 'width') ?? 100,
      height: doc.get(componentId, 'height') ?? 100,
      fills: [],
      clipsContent: false,
      repeatGrid: cfg,
    },
    index,
  );
  doc.move(componentId, frame);
  doc.set(componentId, { transform: [t[0], t[1], 0, t[3], t[4], 0] });
  syncRepeatGrid(doc, frame);
  return frame;
}

/**
 * Bring the cells in line with the settings: add or remove instances (from the end), arrange them on the
 * grid, fit the frame. fromSize — first recompute columns and rows from the current frame size
 * (it was stretched). Changes only what differs.
 */
export function syncRepeatGrid(doc: Document, id: string, fromSize = false) {
  if (!isRepeatGrid(doc, id)) return;
  const master = repeatMaster(doc, id);
  if (!master) return;
  const cfg = { ...(doc.get(id, 'repeatGrid') as RepeatGrid) };
  const cw = Math.max(1, doc.get(master, 'width') ?? 1);
  const ch = Math.max(1, doc.get(master, 'height') ?? 1);
  if (fromSize) {
    const fit = (size: number, cell: number, gap: number) => Math.max(1, Math.min(200, Math.round((size + gap) / (cell + gap))));
    cfg.columns = fit(doc.get(id, 'width') ?? cw, cw, cfg.gapX);
    cfg.rows = fit(doc.get(id, 'height') ?? ch, ch, cfg.gapY);
  }
  cfg.columns = Math.max(1, Math.round(cfg.columns));
  cfg.rows = Math.max(1, Math.round(cfg.rows));
  const n = cfg.columns * cfg.rows;
  // The template goes first; extra cells are removed from the end (only instances of this component).
  if (doc.children(id)[0] !== master) doc.move(master, id, 0);
  let kids = doc.children(id);
  for (let i = kids.length - 1; i >= n; i--) if (kids[i] !== master) doc.delete(kids[i]!);
  kids = doc.children(id);
  const masterId = doc.type(master) === 'COMPONENT' ? master : null;
  for (let i = kids.length; i < n; i++) {
    if (masterId) instantiate(doc, masterId, id, [1, 0, 0, 0, 1, 0]);
    else break;
  }
  doc.children(id).forEach((k, i) => {
    const x = (i % cfg.columns) * (cw + cfg.gapX);
    const y = Math.floor(i / cfg.columns) * (ch + cfg.gapY);
    const t = (doc.get(k, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
    if (t[2] !== x || t[5] !== y) doc.set(k, { transform: [t[0], t[1], x, t[3], t[4], y] });
  });
  const width = cfg.columns * cw + (cfg.columns - 1) * cfg.gapX;
  const height = cfg.rows * ch + (cfg.rows - 1) * cfg.gapY;
  const props: Props = {};
  if (doc.get(id, 'width') !== width) props.width = width;
  if (doc.get(id, 'height') !== height) props.height = height;
  const old = doc.get(id, 'repeatGrid') as RepeatGrid;
  if (old.columns !== cfg.columns || old.rows !== cfg.rows || old.gapX !== cfg.gapX || old.gapY !== cfg.gapY) props.repeatGrid = cfg;
  if (Object.keys(props).length) doc.set(id, props);
}

/** Change the repeat settings (columns, rows, gaps) and rebuild. */
export function setRepeatGrid(doc: Document, id: string, patch: Partial<RepeatGrid>) {
  if (!isRepeatGrid(doc, id)) return;
  doc.set(id, { repeatGrid: { ...(doc.get(id, 'repeatGrid') as RepeatGrid), ...patch } });
  syncRepeatGrid(doc, id);
}

/** Which repeats to rebuild after edits: the frame was stretched (by size) or a cell was changed. */
export function repeatGridsToSync(doc: Document, ops: readonly { op: string; id?: string; props?: Record<string, unknown> }[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const o of ops) {
    if (o.op !== 'set' || !o.id || !o.props || !doc.has(o.id)) continue;
    const keys = Object.keys(o.props);
    if (isRepeatGrid(doc, o.id) && (keys.includes('width') || keys.includes('height')) && !keys.includes('repeatGrid')) out.set(o.id, true);
    const p = doc.parent(o.id);
    if (p && isRepeatGrid(doc, p) && (keys.includes('width') || keys.includes('height')) && repeatMaster(doc, p) === o.id && !out.has(p)) out.set(p, false);
  }
  return out;
}
