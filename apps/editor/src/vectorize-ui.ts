// “Vectorize” window:
// the layer is captured as it appears on the canvas (crop, adjustments, corner radius), up to ~640 px on
// the longer side; colors, detail, background and overlap — with a preview. “Vectorize” puts a
// group of vectors (one layer per color) above the layer and hides the layer itself — it can be restored.

import { invert, multiply, networkFromSvg, networkProps, transformNetwork, type ImagePaint, type Matrix, type Paint } from '@mfp/core';
import { fitGroup, vectorize, type VectorLayer } from '@mfp/editing';
import { h, modal } from './dom.ts';
import type { Editor } from './editor.ts';

const TRACE_PX = 640;

const hex = (c: { r: number; g: number; b: number }) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Layers with an image fill (any visible layer can be vectorized, but it makes sense for images). */
export function hasImageFill(ed: Editor, id: string): boolean {
  return ((ed.doc.get(id, 'fills') ?? []) as { type: string; visible?: boolean }[]).some((p) => (p.type === 'IMAGE' || p.type === 'VIDEO') && p.visible !== false);
}

/** Image pixels per page unit (from the image fill; null — can't tell). */
async function nativeScale(ed: Editor, id: string, w: number, hgt: number): Promise<number | null> {
  const p = ((ed.doc.get(id, 'fills') ?? []) as Paint[]).filter((f) => f.type === 'IMAGE' && f.visible !== false && f.imageHash).pop() as ImagePaint | undefined;
  if (!p?.imageHash) return null;
  const bytes = await ed.store.readImage(p.imageHash);
  const bmp = bytes ? await createImageBitmap(new Blob([bytes as BlobPart])).catch(() => null) : null;
  if (!bmp) return null;
  const iw = bmp.width;
  const ih = bmp.height;
  bmp.close();
  const quarter = Math.round((p.rotation ?? 0) / 90) % 2 !== 0;
  const [rw, rh] = quarter ? [ih, iw] : [iw, ih];
  // How many layer units per image pixel — depends on the fill mode.
  let unit: number;
  if (p.scaleMode === 'FIT') unit = Math.min(w / rw, hgt / rh);
  else if (p.scaleMode === 'TILE') unit = p.scalingFactor ?? 1;
  else if (p.scaleMode === 'CROP' && p.imageTransform) unit = w / (Math.abs(p.imageTransform[0][0]) * iw || 1);
  else unit = Math.max(w / rw, hgt / rh);
  const m = ed.worldMatrix(id);
  return 1 / (unit * Math.hypot(m[0], m[3]) || 1);
}

export async function openVectorizeDialog(ed: Editor, id: string, notify: (m: string, kind?: 'error') => void) {
  const doc = ed.doc;
  const w = doc.get(id, 'width') ?? 0;
  const hgt = doc.get(id, 'height') ?? 0;
  if (!(w > 0 && hgt > 0)) return notify('У слоя нет размера');
  // The layer's box on the page (without shadows) and the capture scale.
  const m = ed.worldMatrix(id);
  const xs = [0, w, 0, w].map((x, i) => m[0] * x + m[1] * [0, 0, hgt, hgt][i]! + m[2]);
  const ys = [0, w, 0, w].map((x, i) => m[3] * x + m[4] * [0, 0, hgt, hgt][i]! + m[5]);
  const region: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  // No larger than the image itself: an upscaled capture produces jagged steps.
  const side = Math.max(region[2] - region[0], region[3] - region[1]);
  const native = await nativeScale(ed, id, w, hgt);
  const scale = Math.max(Math.min(160 / side, 8), Math.min(8, TRACE_PX / side, native ?? Infinity));
  let shot: Awaited<ReturnType<Editor['exportImage']>>;
  try {
    shot = await ed.exportImage([id], scale, 'RGBA', { region });
  } catch (e) {
    return notify(e instanceof Error ? e.message : String(e), 'error');
  }
  const { bytes, width: W, height: H } = shot;

  const dlg = modal('Векторизовать', { cls: 'vz-modal' });
  const original = h('img', { class: 'vz-img', alt: 'Картинка' }) as HTMLImageElement;
  {
    const oc = new OffscreenCanvas(W, H);
    oc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bytes), W, H), 0, 0);
    void oc.convertToBlob({ type: 'image/png' }).then((b) => (original.src = URL.createObjectURL(b)));
  }
  const preview = h('div', { class: 'vz-svg' });
  const colors = h('input', { type: 'range', min: '2', max: '16', step: '1', value: '6', 'aria-label': 'Цветов' }) as HTMLInputElement;
  const colorsOut = h('span', { class: 'vz-val' }, '6');
  const detail = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '50', 'aria-label': 'Детали' }) as HTMLInputElement;
  const detailOut = h('span', { class: 'vz-val' }, '50');
  const removeBg = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const stacked = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const info = h('p', { class: 'm-note' });
  const apply = h('button', { class: 'm-btn primary' }, 'Векторизовать') as HTMLButtonElement;
  let layers: VectorLayer[] = [];

  const run = () => {
    colorsOut.textContent = colors.value;
    detailOut.textContent = detail.value;
    const t0 = performance.now();
    layers = vectorize(bytes, W, H, { colors: Number(colors.value), detail: Number(detail.value) / 100, removeBackground: removeBg.checked, stacked: stacked.checked });
    const ms = Math.round(performance.now() - t0);
    const points = layers.reduce((n, l) => n + (l.d.match(/[MLC]/g)?.length ?? 0), 0);
    preview.innerHTML = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${layers.map((l) => `<path d="${l.d}" fill="${hex(l.color)}" fill-rule="evenodd"/>`).join('')}</svg>`;
    info.textContent = layers.length ? `Цветов: ${layers.length} · узлов: ${points} · ${ms} мс` : 'Ничего не нашлось: всё прозрачное или фон';
    apply.disabled = !layers.length;
  };
  let timer = 0;
  const schedule = () => {
    colorsOut.textContent = colors.value;
    detailOut.textContent = detail.value;
    clearTimeout(timer);
    timer = window.setTimeout(run, 120);
  };
  for (const c of [colors, detail]) c.addEventListener('input', schedule);
  for (const c of [removeBg, stacked]) c.addEventListener('change', run);

  apply.addEventListener('click', () => {
    if (!layers.length || !doc.has(id)) return;
    const parent = doc.parent(id)!;
    // Capture pixels → layer parent coordinates.
    const r = shot.rect;
    const s = shot.scale;
    const toPage: Matrix = [1 / s, 0, r[0], 0, 1 / s, r[1]];
    const pw = parent === ed.pageId ? null : ed.worldMatrix(parent);
    const toParent = pw ? multiply(invert(pw), toPage) : toPage;
    const index = doc.children(parent).indexOf(id);
    let group = '';
    doc.transact(() => {
      group = doc.create('GROUP', parent, { name: `${doc.get(id, 'name') ?? 'Картинка'} — вектор` }, index + 1);
      for (const l of layers) {
        const net = networkFromSvg(l.d, 'EVENODD');
        if (!net?.segments.length) continue;
        const v = doc.create('VECTOR', group, { name: hex(l.color), fills: [{ type: 'SOLID', color: l.color }], transform: [1, 0, 0, 0, 1, 0] });
        doc.set(v, networkProps(doc, v, transformNetwork(net, toParent), { shared: true }));
      }
      fitGroup(doc, group);
      doc.set(id, { visible: false });
    });
    dlg.close();
    if (group) ed.select([group]);
    notify(`Готово: ${layers.length} ${layers.length === 1 ? 'цвет' : layers.length < 5 ? 'цвета' : 'цветов'}. Исходный слой скрыт под векторами`);
  });

  const row = (label: string, ...el: (HTMLElement | string)[]) => h('div', { class: 'm-row' }, h('label', { style: 'width:90px;flex:none' }, label), ...el);
  dlg.body.append(
    h('div', { class: 'vz-panes' }, h('figure', {}, original, h('figcaption', {}, 'Картинка')), h('figure', {}, preview, h('figcaption', {}, 'Вектор'))),
    row('Цветов', colors, colorsOut),
    row('Детали', detail, detailOut),
    h('label', { class: 'm-row' }, removeBg, 'Убрать фон (цвет края картинки)'),
    h('label', { class: 'm-row', title: 'Нижние цвета лежат и под верхними: между цветами нет щелей. Выключите, чтобы каждый цвет был только своей формой' }, stacked, 'Без щелей между цветами'),
    info,
    h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => dlg.close() }, 'Отмена'), apply),
  );
  run();
}
