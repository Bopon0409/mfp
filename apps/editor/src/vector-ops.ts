// “Offset path” and “Simplify path”.
//
// Offset: the layer's shape thickened by a 2·d stroke (Skia) — union with the shape (outward) or
// difference (inward); for an open path without a fill — a stroke on both sides. The new vector goes
// above the layer, with its fills and strokes (for an open one — filled with the stroke color).
// Simplify: each network chain is redrawn as curves within a tolerance (@mfp/editing simplify.ts).

import { adjacency, networkChains, networkFromSvg, networkOf, networkProps, type Matrix, type NodeType, type Props } from '@mfp/core';
import { simplifyNetwork } from '@mfp/editing';
import type { Editor } from './editor.ts';
import { h, modal } from './dom.ts';

export type OffsetJoin = 'ROUND' | 'MITER' | 'BEVEL';

/** Layers that have a shape to offset. */
const OFFSETABLE = new Set<NodeType>(['VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'BOOLEAN_OPERATION', 'TEXT', 'FRAME', 'COMPONENT', 'INSTANCE']);

/** The vector path is open (has ends) and not filled — offset by a stroke on both sides. */
function openStroke(ed: Editor, id: string): string | null {
  const doc = ed.doc;
  if (doc.type(id) !== 'VECTOR' && doc.type(id) !== 'LINE') return null;
  if ((doc.get(id, 'fills') ?? []).some((f) => f.visible !== false)) return null;
  if (doc.type(id) === 'LINE') return `M0 0L${doc.get(id, 'width') ?? 0} 0`;
  const net = networkOf(doc, id);
  if (!net || !adjacency(net).some((ks) => ks.length === 1)) return null;
  return networkChains(net).map((c) => c.data).join('');
}

/** Offset the paths of the selected layers by d (positive — outward); new vectors go above them. */
export function offsetSelection(ed: Editor, d: number, join: OffsetJoin, keep: boolean): string[] {
  const ck = ed.ck;
  const doc = ed.doc;
  const out: string[] = [];
  if (!d) return out;
  const ckJoin = join === 'ROUND' ? ck.StrokeJoin.Round : join === 'BEVEL' ? ck.StrokeJoin.Bevel : ck.StrokeJoin.Miter;
  doc.transact(() => {
    for (const id of ed.selection) {
      const type = doc.type(id);
      if (!type || !OFFSETABLE.has(type)) continue;
      const open = openStroke(ed, id);
      const svg = open ?? ed.scene.flattenSvg(id);
      if (!svg) continue;
      const base = ck.Path.MakeFromSVGString(svg);
      if (!base) continue;
      const stroked = base.makeStroked({ width: 2 * Math.abs(d), join: ckJoin, cap: ck.StrokeCap.Round, miter_limit: 4 });
      let result = stroked;
      if (stroked && !open) {
        result = ck.Path.MakeFromOp(base, stroked, d > 0 ? ck.PathOp.Union : ck.PathOp.Difference);
        stroked.delete();
      }
      base.delete();
      if (!result) continue;
      const data = result.toSVGString();
      const evenOdd = result.getFillType() === ck.FillType.EvenOdd;
      result.delete();
      const net = data ? networkFromSvg(data, evenOdd ? 'EVENODD' : 'NONZERO') : null;
      if (!net || !net.segments.length) continue;
      const p = doc.props(id);
      const parent = doc.parent(id)!;
      const index = doc.children(parent).indexOf(id);
      const props: Props = {
        name: p.name,
        transform: (p.transform ?? [1, 0, 0, 0, 1, 0]) as Matrix,
        opacity: p.opacity,
        blendMode: p.blendMode,
        effects: p.effects,
        constraints: p.constraints,
        // An open path becomes a shape: its color is the stroke color.
        fills: open ? p.strokes : p.fills,
        strokes: open ? [] : p.strokes,
        ...(open ? {} : { strokeWeight: p.strokeWeight, strokeAlign: p.strokeAlign, strokeJoin: p.strokeJoin, dashPattern: p.dashPattern }),
        // Next to a layer in auto layout, the vector must not push the neighbors.
        ...(keep && parent !== ed.pageId && doc.get(parent, 'layoutMode') && doc.get(parent, 'layoutMode') !== 'NONE' ? { layoutPositioning: 'ABSOLUTE' as const } : {}),
      };
      const v = doc.create('VECTOR', parent, props, index + 1);
      doc.set(v, networkProps(doc, v, net, { shared: true }));
      if (!keep) doc.delete(id);
      out.push(v);
    }
  });
  if (out.length) ed.select(out);
  return out;
}

/** “Offset path” window: by how much, which corners, whether to keep the original layer. */
export function openOffsetDialog(ed: Editor, notify: (m: string) => void) {
  if (!ed.selection.some((id) => OFFSETABLE.has(ed.doc.type(id)!))) {
    notify('Выделите вектор или фигуру');
    return;
  }
  const m = modal('Сместить контур');
  const amount = h('input', { class: 'm-input', type: 'number', value: '10', step: '1', 'aria-label': 'Смещение, px' }) as HTMLInputElement;
  const join = h(
    'select',
    { class: 'm-select', 'aria-label': 'Углы', style: 'flex:1' },
    h('option', { value: 'ROUND' }, 'Скруглённые'),
    h('option', { value: 'MITER' }, 'Острые'),
    h('option', { value: 'BEVEL' }, 'Срезанные'),
  ) as HTMLSelectElement;
  const keep = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const apply = () => {
    const d = Number(amount.value.replace(',', '.'));
    if (!Number.isFinite(d) || !d) {
      amount.focus();
      return;
    }
    const made = offsetSelection(ed, d, join.value as OffsetJoin, keep.checked);
    m.close();
    if (!made.length) notify('Сместить не удалось: у выделения нет формы');
  };
  amount.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') apply();
  });
  const label = (text: string) => h('label', { style: 'width:110px;flex:none' }, text);
  m.body.append(
    h('div', { class: 'm-row' }, label('Смещение, px'), amount),
    h('p', { class: 'm-note' }, 'Плюс — наружу, минус — внутрь. У открытого контура — в обе стороны.'),
    h('div', { class: 'm-row' }, label('Углы'), join),
    h('label', { class: 'm-row' }, keep, 'Оставить исходный слой'),
    h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => m.close() }, 'Отмена'), h('button', { class: 'm-btn primary', onclick: apply }, 'Сместить')),
  );
  setTimeout(() => {
    amount.focus();
    amount.select();
  }, 0);
}

/** Simplify the paths of the selected vectors; the message — how many points there were and are now. */
export function simplifySelection(ed: Editor, tolerance = 0.5): string {
  const doc = ed.doc;
  let before = 0;
  let after = 0;
  doc.transact(() => {
    for (const id of ed.selection) {
      if (doc.type(id) !== 'VECTOR') continue;
      const net = networkOf(doc, id);
      if (!net || !net.segments.length) continue;
      const s = simplifyNetwork(net, tolerance);
      before += net.vertices.length;
      after += s.vertices.length;
      if (s.vertices.length < net.vertices.length) doc.set(id, networkProps(doc, id, s, { shared: true }));
    }
  });
  if (!before) return 'Выделите вектор';
  return after < before ? `Точек: ${before} → ${after}` : 'Контур уже простой';
}
