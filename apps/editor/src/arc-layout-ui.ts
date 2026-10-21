// “Along an arc or circle” window (our own): selected layers are placed with their centers on a circle around
// their common center. Radius, start angle, arc sweep, rotate outward — with a preview on the canvas (outside
// history); “Arrange” — one undo step, “Cancel” restores everything as it was.

import { invert, multiply, withRotationKeepShape, type Matrix } from '@mfp/core';
import { arcOrder, arcPlaces, type ArcOptions } from '@mfp/editing';
import { h, modal } from './dom.ts';
import type { Editor } from './editor.ts';

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0];

/** Layer center on the page. */
function centerOf(ed: Editor, id: string): [number, number] {
  const m = ed.worldMatrix(id) as Matrix;
  const w = (ed.doc.get(id, 'width') ?? 0) / 2;
  const hh = (ed.doc.get(id, 'height') ?? 0) / 2;
  return [m[0] * w + m[1] * hh + m[2], m[3] * w + m[4] * hh + m[5]];
}

export function openArcLayout(ed: Editor, notify: (m: string) => void) {
  const doc = ed.doc;
  const sel = ed.selection.filter((id) => doc.has(id) && doc.type(id) !== 'PAGE');
  if (sel.length < 2) return notify('Выделите два слоя или больше');
  const origin = new Map(sel.map((id) => [id, [...(doc.get(id, 'transform') ?? IDENTITY)] as Matrix]));
  const b = ed.selectionBounds(sel)!;
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  const items = arcOrder(
    sel.map((id) => {
      const [x, y] = centerOf(ed, id);
      return { id, x, y };
    }),
    cx,
    cy,
  );
  const opts: ArcOptions = { cx, cy, radius: Math.round(Math.max(40, Math.min(b[2] - b[0], b[3] - b[1]) / 2, Math.max(b[2] - b[0], b[3] - b[1]) / 3)), start: -90, sweep: 360, rotate: false };

  const restore = () => {
    for (const [id, t] of origin) if (doc.has(id)) doc.set(id, { transform: t });
  };
  const place = () => {
    const places = arcPlaces(items.length, opts);
    items.forEach((it, i) => {
      if (!doc.has(it.id)) return;
      const p = places[i]!;
      const parent = doc.parent(it.id)!;
      const pw = (parent === ed.pageId ? IDENTITY : ed.worldMatrix(parent)) as Matrix;
      // Layer world matrix: rotation (if needed) with the original shape, center at the arc point.
      let wm = multiply(pw, origin.get(it.id)!);
      if (p.rotation !== undefined) wm = withRotationKeepShape(wm, p.rotation);
      const w = (doc.get(it.id, 'width') ?? 0) / 2;
      const hh = (doc.get(it.id, 'height') ?? 0) / 2;
      wm = [wm[0], wm[1], p.x - (wm[0] * w + wm[1] * hh), wm[3], wm[4], p.y - (wm[3] * w + wm[4] * hh)];
      const local = multiply(invert(pw), wm);
      doc.set(it.id, { transform: local.map((v) => Math.round(v * 1e4) / 1e4) as Matrix });
    });
  };
  const preview = () =>
    doc.transact(() => {
      restore();
      place();
    }, 'preview');

  const m = modal('По дуге или кругу', {
    onClose: () => {
      if (!done) doc.transact(restore, 'preview');
    },
  });
  let done = false;
  const num = (label: string, title: string, get: () => number, set: (v: number) => void) => {
    const input = h('input', { class: 'm-input', type: 'number', value: String(get()), 'aria-label': title }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const v = Number(input.value.replace(',', '.'));
      if (!Number.isFinite(v)) return;
      set(v);
      preview();
    });
    return h('div', { class: 'm-row' }, h('label', { style: 'width:150px;flex:none', title }, label), input);
  };
  const rotate = h('input', { type: 'checkbox' }) as HTMLInputElement;
  rotate.addEventListener('change', () => {
    opts.rotate = rotate.checked;
    preview();
  });
  const apply = () => {
    doc.transact(restore, 'preview');
    doc.transact(place);
    done = true;
    m.close();
  };
  m.body.append(
    num('Радиус, px', 'Расстояние от центра до центров слоёв', () => opts.radius, (v) => (opts.radius = Math.max(0, v))),
    num('Начало, °', 'Угол первого слоя: −90 — сверху, 0 — справа', () => opts.start, (v) => (opts.start = v)),
    num('Дуга, °', '360 — полный круг; меньше — дуга от начала, слои по её краям', () => opts.sweep, (v) => (opts.sweep = Math.max(-360, Math.min(360, v)))),
    h('label', { class: 'm-row' }, rotate, 'Повернуть слои верхом наружу'),
    h('p', { class: 'm-note' }, `Слоёв: ${items.length}. Центр — середина выделения; порядок — по нынешнему положению вокруг центра.`),
    h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => m.close() }, 'Отмена'), h('button', { class: 'm-btn primary', onclick: apply }, 'Расставить')),
  );
  preview();
}
