// Export by layer settings: each layer has a list of “format, size, suffix”.
// PNG and JPG — by scale, width or height; SVG — with text as outlines and layer ids optionally;
// PDF — as vectors (pdf-export.ts). A slice captures the area with everything under it; so does a layer with
// contentsOnly: false (together with the layers above and below it). useAbsoluteBounds — exactly the layer bounds
// (no shadows beyond them, text as a block rather than by glyphs).
// One file — directly; several — as a ZIP archive (browser) or into a chosen folder (desktop).

import { ZipWriter } from '@mfp/io-figma';
import { iccCmyk, naiveCmyk, parseIcc, type ExportSetting, type IccIntent } from '@mfp/core';
import { addProfile, listProfiles, profileTitle, readProfile } from './icc-store.ts';
import type { Editor } from './editor.ts';
import { exportSvg } from './svg-export.ts';
import { exportPdf, type PdfPrint } from './pdf-export.ts';
import { h, modal } from './dom.ts';
import { disk, isDesktop, joinPath, openDialog, saveDialog } from './platform.ts';
import { t } from './i18n/index.ts';

export interface ExportFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export const DEFAULT_EXPORT: ExportSetting = { format: 'PNG', suffix: '', constraint: { type: 'SCALE', value: 1 } };

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || t('Без названия');
const EXT: Record<ExportSetting['format'], string> = { PNG: 'png', JPG: 'jpg', WEBP: 'webp', AVIF: 'avif', SVG: 'svg', PDF: 'pdf' };
const MIME: Record<ExportSetting['format'], string> = { PNG: 'image/png', JPG: 'image/jpeg', WEBP: 'image/webp', AVIF: 'image/avif', SVG: 'image/svg+xml', PDF: 'application/pdf' };

/** Raster formats: size by scale, width or height. */
export const isRaster = (f: ExportSetting['format']) => f === 'PNG' || f === 'JPG' || f === 'WEBP' || f === 'AVIF';
/** Lossy: they have a quality setting. */
export const isLossy = (f: ExportSetting['format']) => f === 'JPG' || f === 'WEBP' || f === 'AVIF';
/** Default quality: JPG — 92, WebP — 90, AVIF — 80 (AV1 gives the same quality at a smaller file). */
export const defaultQuality = (f: ExportSetting['format']) => (f === 'AVIF' ? 80 : f === 'WEBP' ? 90 : 92);
const ENCODE: Record<'PNG' | 'JPG' | 'WEBP' | 'AVIF', 'PNG' | 'JPEG' | 'WEBP' | 'AVIF'> = { PNG: 'PNG', JPG: 'JPEG', WEBP: 'WEBP', AVIF: 'AVIF' };

/** Size label: “2x”, “512w”, “300h”. */
export function constraintLabel(c: ExportSetting['constraint']): string {
  if (!c) return '1x';
  return c.type === 'SCALE' ? `${+c.value.toFixed(2)}x` : `${Math.round(c.value)}${c.type === 'WIDTH' ? 'w' : 'h'}`;
}

/** “2x”, “2”, “512w”, “300h” → constraint (null — unparsable). */
export function parseConstraint(text: string): ExportSetting['constraint'] | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([xwh×]?)\s*$/i.exec(text);
  if (!m) return null;
  const v = Number(m[1]!.replace(',', '.'));
  if (!(v > 0)) return null;
  const u = m[2]!.toLowerCase();
  return u === 'w' ? { type: 'WIDTH', value: v } : u === 'h' ? { type: 'HEIGHT', value: v } : { type: 'SCALE', value: Math.min(v, 32) };
}

/** Files of one layer by its settings (no settings — fallback). */
export async function exportNode(ed: Editor, id: string, settings: ExportSetting[]): Promise<ExportFile[]> {
  const doc = ed.doc;
  const name = safe(doc.get(id, 'name') || t('Без названия'));
  const slice = doc.type(id) === 'SLICE';
  const box = ed.selectionBounds([id]) ?? undefined;
  // Everything on the page within the layer's area (except slices).
  const page = doc.children(ed.pageId).filter((c) => doc.type(c) !== 'SLICE' && doc.get(c, 'visible') !== false);
  const out: ExportFile[] = [];
  for (const s of settings) {
    const suffix = s.suffix ?? '';
    const overlap = slice || s.contentsOnly === false;
    const region = slice || s.useAbsoluteBounds ? box : overlap ? (ed.renderBounds([id]) ?? box) : undefined;
    const sources = overlap ? page : [id];
    if (s.format === 'PNG' || s.format === 'JPG' || s.format === 'WEBP' || s.format === 'AVIF') {
      const c = s.constraint ?? { type: 'SCALE', value: 1 };
      const w = region ? region[2] - region[0] : (doc.get(id, 'width') ?? 1);
      const h = region ? region[3] - region[1] : (doc.get(id, 'height') ?? 1);
      const scale = c.type === 'SCALE' ? c.value : c.type === 'WIDTH' ? c.value / Math.max(1e-6, w) : c.value / Math.max(1e-6, h);
      const r = await ed.exportImage(sources, scale, ENCODE[s.format], { region, quality: isLossy(s.format) ? (s.quality ?? defaultQuality(s.format)) : undefined });
      const tag = suffix || (c.type === 'SCALE' ? (c.value === 1 ? '' : `@${+c.value.toFixed(2)}x`) : `@${constraintLabel(c)}`);
      out.push({ name: `${name}${tag}.${EXT[s.format]}`, bytes: r.bytes, mime: MIME[s.format] });
    } else if (s.format === 'SVG') {
      const svg = await exportSvg(ed, sources, { outlineText: s.svgOutlineText !== false, idAttribute: !!s.svgIdAttribute, region });
      out.push({ name: `${name}${suffix}.svg`, bytes: new TextEncoder().encode(svg), mime: MIME.SVG });
    } else {
      const pdf = await exportPdf(ed, [{ ids: sources, rect: region }], doc.get(id, 'name') || 'MFP');
      out.push({ name: `${name}${suffix}.pdf`, bytes: pdf, mime: MIME.PDF });
    }
  }
  return out;
}

/** Selection files: for a layer without settings — fallback (Ctrl+Shift+E — PNG 1x). */
export async function exportSelectionFiles(ed: Editor, ids: string[], fallback: ExportSetting[] = [DEFAULT_EXPORT]): Promise<ExportFile[]> {
  const files: ExportFile[] = [];
  for (const id of ids) {
    const settings = ed.doc.get(id, 'exportSettings') ?? [];
    files.push(...(await exportNode(ed, id, settings.length ? settings : fallback)));
  }
  // Duplicate names get a number.
  const seen = new Map<string, number>();
  for (const f of files) {
    const k = seen.get(f.name) ?? 0;
    seen.set(f.name, k + 1);
    if (k) f.name = f.name.replace(/(\.[a-z]+)$/, ` (${k + 1})$1`);
  }
  return files;
}

/** Hand files to the user: one — save it, several — as an archive (browser) or into a folder (desktop). */
export async function deliver(files: ExportFile[], archiveName: string): Promise<string | null> {
  if (!files.length) return null;
  if (isDesktop) {
    if (files.length === 1) {
      const f = files[0]!;
      const ext = f.name.split('.').pop()!;
      const path = await saveDialog({ defaultPath: f.name, title: 'Экспорт', ext, label: ext.toUpperCase() });
      if (!path) return null;
      await disk.writeFile(path, f.bytes);
      return path;
    }
    const [dir] = await openDialog({ directory: true, title: `Папка для ${files.length} файлов` });
    if (!dir) return null;
    for (const f of files) await disk.writeFile(joinPath(dir, f.name), f.bytes);
    return dir;
  }
  if (files.length === 1) {
    download(files[0]!.bytes, files[0]!.name, files[0]!.mime);
    return files[0]!.name;
  }
  const zip = new ZipWriter();
  for (const f of files) zip.add(f.name, f.bytes, !/\.(png|jpg)$/i.test(f.name));
  const name = `${safe(archiveName)}.zip`;
  download(new Uint8Array(await zip.finish().arrayBuffer()), name, 'application/zip');
  return name;
}

export function download(bytes: Uint8Array, name: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Page frames to PDF, one page per frame (like “Export frames to PDF”). */
export async function exportFramesPdf(ed: Editor, title: string, print?: PdfPrint): Promise<ExportFile | null> {
  const doc = ed.doc;
  const frames: string[] = [];
  const walk = (id: string) => {
    for (const c of doc.children(id)) {
      if (doc.get(c, 'visible') === false) continue;
      const t = doc.type(c);
      if (t === 'SECTION') walk(c);
      else if (t === 'FRAME' || t === 'COMPONENT' || t === 'INSTANCE' || t === 'COMPONENT_SET') frames.push(c);
    }
  };
  walk(ed.pageId);
  if (!frames.length) return null;
  const bytes = await exportPdf(ed, frames.map((id) => ({ ids: [id] })), title, print);
  return { name: `${safe(title)}.pdf`, bytes, mime: MIME.PDF };
}

/** “Print PDF” window: bleed (mm) and crop marks. */
/** Last color choice in the print window (per device). */
const PRINT_PREFS = 'mfp-print-color';

export function openPrintDialog(go: (p: PdfPrint) => void) {
  const m = modal('PDF для печати');
  const bleed = h('input', { class: 'm-input', type: 'number', min: '0', max: '20', step: '0.5', value: '3', 'aria-label': 'Вылеты, мм' }) as HTMLInputElement;
  const marks = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  let prefs: { mode?: string; profile?: string; intent?: string; pureBlack?: boolean } = {};
  try {
    prefs = JSON.parse(localStorage.getItem(PRINT_PREFS) ?? '{}');
  } catch {
    // no saved choice
  }
  // Colors: as on screen (RGB) or inks (CMYK) — by a print profile or approximately.
  const mode = h('select', { class: 'm-input', 'aria-label': 'Цвета' }, h('option', { value: 'rgb' }, 'RGB — как на экране'), h('option', { value: 'icc' }, 'CMYK — по профилю печати'), h('option', { value: 'naive' }, 'CMYK — приблизительно, без профиля')) as HTMLSelectElement;
  mode.value = prefs.mode ?? 'rgb';
  const profile = h('select', { class: 'm-input', 'aria-label': 'Профиль печати' }) as HTMLSelectElement;
  const intent = h('select', { class: 'm-input', 'aria-label': 'Перевод цвета' }, h('option', { value: '1' }, 'Относительный колориметрический'), h('option', { value: '0' }, 'Перцептивный')) as HTMLSelectElement;
  intent.value = prefs.intent ?? '1';
  const pureBlack = h('input', { type: 'checkbox', checked: prefs.pureBlack !== false }) as HTMLInputElement;
  const fileInput = h('input', { type: 'file', accept: '.icc,.icm', hidden: true }) as HTMLInputElement;
  const status = h('div', { class: 'm-note' });
  const fillProfiles = async (select?: string) => {
    const names = await listProfiles();
    profile.replaceChildren(...(names.length ? await Promise.all(names.map(async (n) => h('option', { value: n }, await profileTitle(n)))) : [h('option', { value: '' }, 'Профилей нет — добавьте файл .icc')]));
    profile.value = select ?? prefs.profile ?? names[0] ?? '';
  };
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const name = await addProfile(file);
      await fillProfiles(name);
      status.textContent = '';
    } catch (e) {
      status.textContent = `Профиль не подходит: ${(e as Error).message}`;
    }
  });
  const profileRow = h('div', { class: 'm-row' }, h('label', { style: 'width:110px;flex:none' }, 'Профиль'), profile, h('button', { class: 'm-btn', onclick: () => fileInput.click() }, 'Файл .icc…'), fileInput);
  const intentRow = h('div', { class: 'm-row' }, h('label', { style: 'width:110px;flex:none' }, 'Перевод'), intent);
  const blackRow = h('label', { class: 'm-row' }, pureBlack, 'Чёрный — только краской K (текст и линии без сдвига красок)');
  const naiveNote = h('p', { class: 'm-note warn' }, 'Без профиля печати цвета переводятся «наивно» — на бумаге они будут другими. Годится для черновика; для тиража возьмите профиль у типографии (например, FOGRA39 или ISO Coated v2).');
  const sync = () => {
    profileRow.hidden = intentRow.hidden = mode.value !== 'icc';
    blackRow.hidden = mode.value === 'rgb';
    naiveNote.hidden = mode.value !== 'naive';
  };
  mode.addEventListener('change', sync);
  const run = async () => {
    const mm = Math.max(0, Math.min(20, Number(bleed.value.replace(',', '.')) || 0));
    const out: PdfPrint = { bleed: (mm * 72) / 25.4, marks: marks.checked };
    if (mode.value === 'naive') out.cmyk = { convert: naiveCmyk, pureBlack: pureBlack.checked };
    if (mode.value === 'icc') {
      const bytes = profile.value ? await readProfile(profile.value) : null;
      if (!bytes) {
        status.textContent = 'Выберите профиль печати (файл .icc от типографии)';
        return;
      }
      const p = parseIcc(bytes);
      const convert = iccCmyk(p, Number(intent.value) as IccIntent);
      if (!convert) {
        status.textContent = 'В профиле нет таблицы перевода в краски';
        return;
      }
      out.cmyk = { convert, profile: { name: p.description || profile.value, bytes }, pureBlack: pureBlack.checked };
    }
    try {
      localStorage.setItem(PRINT_PREFS, JSON.stringify({ mode: mode.value, profile: profile.value, intent: intent.value, pureBlack: pureBlack.checked }));
    } catch {
      // storage unavailable
    }
    m.close();
    go(out);
  };
  bleed.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && void run());
  m.body.append(
    h('p', { class: 'm-note' }, 'Страница на фрейм; единица документа — пункт (1/72 дюйма): фрейм 595 × 842 — лист A4. Фон фрейма и всё, что за его краем, уходит под обрез.'),
    h('div', { class: 'm-row' }, h('label', { style: 'width:110px;flex:none' }, 'Вылеты, мм'), bleed),
    h('label', { class: 'm-row' }, marks, 'Метки обреза'),
    h('div', { class: 'm-row' }, h('label', { style: 'width:110px;flex:none' }, 'Цвета'), mode),
    profileRow,
    intentRow,
    blackRow,
    naiveNote,
    status,
    h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => m.close() }, 'Отмена'), h('button', { class: 'm-btn primary', onclick: () => void run() }, 'Собрать PDF')),
  );
  sync();
  void fillProfiles();
  setTimeout(() => bleed.focus(), 0);
}

/**
 * “Export…” window (File → Export…, Ctrl+Shift+E): everything on the page that has
 * export settings, plus the selection (without settings — PNG 1x); checkboxes, thumbnails, “Export (N)”.
 */
export function openExportDialog(ed: Editor, run: (ids: string[]) => void) {
  const doc = ed.doc;
  const sel = ed.selection.filter((id) => doc.has(id));
  const withSettings = [...doc.descendants(ed.pageId)].filter((id) => (doc.get(id, 'exportSettings') ?? []).length > 0 && !sel.includes(id));
  const ids = [...sel, ...withSettings];
  const m = modal('Экспорт', { cls: 'export-dialog' });
  if (!ids.length) {
    m.body.append(h('p', { class: 'm-note' }, 'На странице нет слоёв с настройками экспорта. Выделите слой и добавьте экспорт в правой панели («Экспорт» → «+»).'));
    return;
  }
  const checked = new Set(ids);
  const count = h('span', {});
  const go = h('button', { class: 'pe-btn primary', onclick: () => (m.close(), run(ids.filter((id) => checked.has(id)))) }, count) as HTMLButtonElement;
  const update = () => {
    count.textContent = `Экспорт (${checked.size})`;
    go.disabled = !checked.size;
  };
  const urls: string[] = [];
  const rows = ids.map((id, i) => {
    const settings: ExportSetting[] = doc.get(id, 'exportSettings') ?? [];
    const what = (settings.length ? settings : [DEFAULT_EXPORT]).map((s) => `${s.format}${isRaster(s.format) ? ` ${constraintLabel(s.constraint)}` : ''}${s.suffix ? ` «${s.suffix}»` : ''}`).join(', ');
    const box = h('input', { type: 'checkbox', checked: true, onchange: () => (box.checked ? checked.add(id) : checked.delete(id), update()) }) as HTMLInputElement;
    const thumb = h('span', { class: 'export-thumb' });
    // Thumbnails — one by one, after the window is shown (first 40).
    if (i < 40)
      void exportNode(ed, id, [{ format: 'PNG', suffix: '', constraint: { type: 'HEIGHT', value: 64 } }]).then(([f]) => {
        if (!f) return;
        const url = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: f.mime }));
        urls.push(url);
        thumb.style.backgroundImage = `url(${url})`;
      }).catch(() => {});
    return h(
      'label',
      { class: 'export-row' },
      box,
      thumb,
      h('span', { class: 'export-text' }, h('span', { class: 'export-name', onclick: (e: MouseEvent) => (e.preventDefault(), ed.select([id])) }, doc.get(id, 'name') || t('Слой')), h('span', { class: 'export-what' }, what)),
    );
  });
  m.body.append(h('div', { class: 'export-list' }, ...rows), h('div', { class: 'pop-actions' }, go));
  update();
  const observer = new MutationObserver(() => {
    if (m.box.isConnected) return;
    observer.disconnect();
    for (const u of urls) URL.revokeObjectURL(u);
  });
  observer.observe(document.body, { childList: true });
}
