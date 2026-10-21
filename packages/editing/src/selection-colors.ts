// Selection colors: solid fill and stroke paints of the selected
// layers and everything inside them — one row per distinct color, style or variable. Editing a row
// changes the color in all places at once; text runs have their own fills.

import { isAlias, type Document, type Paint, type Props, type RGB, type TextRun } from '@mfp/core';

/** Paint location: layer, fills or strokes, paint index; run — text run index. */
export interface ColorUse {
  id: string;
  key: 'fills' | 'strokes';
  index: number;
  run?: number;
}

export interface SelectionColor {
  /** style — paint style, variable — color variable, color — a custom color. */
  kind: 'style' | 'variable' | 'color';
  /** Style or variable. */
  ref?: string;
  color: RGB;
  opacity: number;
  uses: ColorUse[];
}

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
const colorKey = (c: RGB, opacity: number) => `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}:${Math.round(opacity * 100)}`;

/**
 * Selection colors: at most limit layers.
 * Order — by first appearance (top to bottom through the tree).
 */
export function selectionColors(doc: Document, ids: string[], limit = 1000): SelectionColor[] | null {
  const groups = new Map<string, SelectionColor>();
  let n = 0;
  const add = (key: string, make: () => Omit<SelectionColor, 'uses'>, use: ColorUse) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ...make(), uses: [] }));
    g.uses.push(use);
  };
  const paints = (id: string, key: 'fills' | 'strokes', list: readonly Paint[] | undefined, style: string | undefined, run?: number) => {
    (list ?? []).forEach((p, index) => {
      if (p.type !== 'SOLID' || p.visible === false) return;
      const use: ColorUse = run === undefined ? { id, key, index } : { id, key, index, run };
      const opacity = p.opacity ?? 1;
      const v = p.boundVariables?.color;
      if (style && doc.has(style)) add(`s:${style}`, () => ({ kind: 'style', ref: style, color: p.color, opacity }), use);
      else if (v && isAlias(v) && doc.has(v.id)) add(`v:${v.id}`, () => ({ kind: 'variable', ref: v.id, color: p.color, opacity }), use);
      else add(`c:${colorKey(p.color, opacity)}`, () => ({ kind: 'color', color: p.color, opacity }), use);
    });
  };
  const visit = (id: string): boolean => {
    if (++n > limit) return false;
    const p = doc.props(id);
    if (p.visible !== false) {
      paints(id, 'fills', p.fills, p.fillStyleId || undefined);
      paints(id, 'strokes', p.strokes, p.strokeStyleId || undefined);
      (p.textRuns ?? []).forEach((r, run) => {
        if (r.style.fills) paints(id, 'fills', r.style.fills as Paint[], (r.style as { fillStyleId?: string }).fillStyleId || undefined, run);
      });
    }
    for (const c of doc.children(id)) if (!visit(c)) return false;
    return true;
  };
  for (const id of ids) if (doc.has(id) && !visit(id)) return null;
  return [...groups.values()];
}

/** Edits per layer: one set entry per layer, however many places it has. */
function editUses(doc: Document, uses: ColorUse[], edit: (p: Paint) => Paint) {
  const byNode = new Map<string, ColorUse[]>();
  for (const u of uses) {
    const list = byNode.get(u.id);
    if (list) list.push(u);
    else byNode.set(u.id, [u]);
  }
  for (const [id, list] of byNode) {
    if (!doc.has(id)) continue;
    const props: Props = {};
    for (const key of ['fills', 'strokes'] as const) {
      const at = list.filter((u) => u.key === key && u.run === undefined).map((u) => u.index);
      if (at.length) props[key] = (doc.get(id, key) ?? []).map((p, i) => (at.includes(i) ? edit(p) : p));
    }
    const runs = list.filter((u) => u.run !== undefined);
    if (runs.length) {
      props.textRuns = (doc.get(id, 'textRuns') ?? []).map((r: TextRun, k) => {
        const at = runs.filter((u) => u.run === k).map((u) => u.index);
        if (!at.length || !r.style.fills) return r;
        return { ...r, style: { ...r.style, fills: (r.style.fills as Paint[]).map((p, i) => (at.includes(i) ? edit(p) : p)) } };
      });
    }
    doc.set(id, props);
  }
}

/** New color (and opacity) in all places of the row; the variable binding is removed. */
export function recolorUses(doc: Document, uses: ColorUse[], color: RGB, opacity?: number) {
  editUses(doc, uses, (p) => {
    if (p.type !== 'SOLID') return p;
    const { boundVariables: _, ...rest } = p;
    return { ...rest, color: { r: color.r, g: color.g, b: color.b }, ...(opacity !== undefined ? { opacity } : {}) };
  });
}
