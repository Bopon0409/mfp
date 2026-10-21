// “Design system” menu items: variables, assets, design check, DTCG tokens (import and
// export), libraries (connect a .mfp / .fig file, update, disconnect).

import { Document, cssVariables, exportDtcg, importDtcg, importLibrary, linkedLibraries, localCollections, unlinkLibrary, type TokenFile } from '@mfp/core';
import { BlobSource, ZipWriter, buildScene, decodeFigKiwi, openFig, readMfp, readZipDirectory, readZipEntry, sceneToCore, type ImageBytesSource } from '@mfp/io-figma';
import type { Editor } from './editor.ts';
import type { MenuEntry } from './menu.ts';
import { h } from './dom.ts';
import { openLibraryUpdate } from './library-update-ui.ts';
import type { TeamLibraries } from './team-libraries.ts';
import { t } from './i18n/index.ts';

/** Pick files (without keeping handles). */
function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, hidden: true }) as HTMLInputElement;
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Export variables and styles to DTCG: one file — JSON, several — ZIP. */
function exportTokens(ed: Editor) {
  const files = exportDtcg(ed.doc, { styles: t('Стили'), collection: t('Коллекция') });
  if (!files.length) return ed.notify?.('Нечего экспортировать: нет переменных и стилей');
  if (files.length === 1) return save(new Blob([files[0]!.json], { type: 'application/json' }), files[0]!.name);
  const zip = new ZipWriter();
  for (const f of files) zip.add(f.name, new TextEncoder().encode(f.json), true);
  save(zip.finish(), 'tokens.zip');
  ed.notify?.(`Токены: файлов ${files.length} (коллекция × режим, стили)`);
}

/** Variables to CSS: a block per mode (first — :root, others — [data-mode="…"]); colors — hex or oklch(). */
function exportCss(ed: Editor, colorFormat: 'hex' | 'oklch') {
  if (!localCollections(ed.doc).length) return ed.notify?.('Нечего экспортировать: нет переменных');
  const css = cssVariables(ed.doc, { colorFormat, header: `Переменные файла — режимы коллекций; цвета ${colorFormat === 'oklch' ? 'OKLCH' : 'HEX'}` });
  save(new Blob([css], { type: 'text/css' }), 'variables.css');
}

/** Token import: .json files or a ZIP with them. */
async function importTokens(ed: Editor) {
  const picked = await pickFiles('.json,.zip', true);
  if (!picked.length) return;
  const files: TokenFile[] = [];
  for (const f of picked) {
    if (/\.zip$/i.test(f.name)) {
      const src = new BlobSource(f);
      for (const e of await readZipDirectory(src)) if (/\.json$/i.test(e.name)) files.push({ name: e.name.split('/').pop()!, json: new TextDecoder().decode(await readZipEntry(src, e)) });
    } else files.push({ name: f.name, json: await f.text() });
  }
  const r = ed.doc.transact(() => importDtcg(ed.doc, files));
  ed.notify?.(`Импорт токенов: коллекций ${r.collections}, переменных ${r.variables}, стилей ${r.styles}${r.warnings.length ? ` · замечаний ${r.warnings.length}` : ''}`);
  if (r.warnings.length) console.warn('Импорт DTCG:', r.warnings);
}

/** Library files in this session (for “Update” without picking again, where the browser gives a handle). */
const handles = new Map<string, FileSystemFileHandle | File>();

/** Read a library document (the whole .mfp or .fig). */
async function readLibrary(file: File): Promise<{ doc: Document; images: ImageBytesSource | null }> {
  if (/\.fig$/i.test(file.name)) {
    const archive = await openFig(new BlobSource(file));
    const { doc } = sceneToCore(buildScene(decodeFigKiwi(archive.kiwi).message), new Document({ clientId: 1 }));
    return { doc, images: { readImage: archive.readImage } };
  }
  return readMfp(new BlobSource(file));
}

/** Connect (or update) a library from a file. */
async function linkFile(ed: Editor, file: File, name = file.name.replace(/\.(mfp|fig)$/i, ''), review = false) {
  try {
    const lib = await readLibrary(file);
    // Update: first — what changed, take the selected items.
    if (review) {
      await new Promise<void>((done) =>
        openLibraryUpdate(ed, {
          name,
          source: lib.doc,
          prefix: name,
          apply: async (only) => {
            await take(ed, lib, name, only);
            done();
          },
        }),
      );
      return;
    }
    await take(ed, lib, name, null);
  } catch (e) {
    ed.notify?.(`Не удалось подключить «${file.name}»: ${(e as Error).message}`);
  }
}

/** Import a library (only — only the selected assets) and its images. */
async function take(ed: Editor, lib: { doc: Document; images: ImageBytesSource | null }, name: string, only: Set<string> | null) {
  const r = ed.doc.transact(() => importLibrary(ed.doc, lib.doc, name, name, only ? { only } : {}));
  // Asset images go into the document.
  for (const hash of r.images) {
    const bytes = await lib.images?.readImage(hash);
    if (bytes) await ed.store.add(bytes);
  }
  ed.notify?.(`Библиотека «${name}»: компонентов ${r.components}, стилей ${r.styles}, переменных ${r.variables}${r.updated ? `, обновлено ${r.updated}` : ''}`);
}

async function chooseLibrary(ed: Editor, name?: string, review = false) {
  const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> };
  let file: File | undefined;
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ types: [{ description: 'Документ MFP или Figma', accept: { 'application/octet-stream': ['.mfp', '.fig'] } }] });
      if (!handle) return;
      file = await handle.getFile();
      handles.set(name ?? file.name.replace(/\.(mfp|fig)$/i, ''), handle);
    } catch {
      return;
    }
  } else {
    [file] = await pickFiles('.mfp,.fig');
    if (file) handles.set(name ?? file.name.replace(/\.(mfp|fig)$/i, ''), file);
  }
  if (file) await linkFile(ed, file, name, review);
}

/** The “Libraries” window: team ones (from the server) and from .mfp / .fig files. */
export function openLibraries(ed: Editor, team?: TeamLibraries) {
  document.querySelector('.libs-dialog')?.remove();
  const box = h('div', { class: 'fonts-dialog libs-dialog' });
  const close = () => box.remove();
  const teamSection = team?.section() ?? null;
  const render = () => {
    const libs = linkedLibraries(ed.doc);
    const fromTeam = team?.names() ?? new Set<string>();
    const rows = [...libs].filter(([name]) => !fromTeam.has(name)).map(([name, n]) =>
      h(
        'div',
        { class: 'lint-row' },
        h('div', { class: 'lint-text' }, h('div', { class: 'lint-name' }, name), h('div', { class: 'lint-msg' }, `ассетов: ${n}`)),
        h('button', {
          class: 'pe-btn',
          onclick: async () => {
            const known = handles.get(name);
            if (known) {
              const file = 'getFile' in known ? await known.getFile() : known;
              await linkFile(ed, file, name, true);
            } else await chooseLibrary(ed, name, true);
            render();
          },
        }, 'Обновить'),
        h('button', {
          class: 'pe-btn',
          onclick: () => {
            ed.doc.transact(() => unlinkLibrary(ed.doc, name));
            render();
          },
        }, 'Отключить'),
      ),
    );
    box.replaceChildren(
      h('div', { class: 'fd-head' }, 'Библиотеки', h('button', { class: 'pe-close', onclick: close }, '×')),
      h('p', { class: 'fd-note' }, 'Компоненты, стили и переменные другого файла — в этом документе. «Обновить» показывает, что изменилось, и берёт выбранное: изменения доходят до инстансов, связи сохраняются.'),
      ...(team ? [h('div', { class: 'fd-sub' }, 'Этот файл'), h('div', { class: 'pop-actions' }, h('button', { class: 'pe-btn', onclick: () => (close(), team.publishDialog()) }, 'Опубликовать как библиотеку…'))] : []),
      ...(teamSection ? [teamSection, h('div', { class: 'fd-sub' }, 'Из файлов (.mfp, .fig)')] : []),
      ...(rows.length ? rows : [h('div', { class: 'empty' }, 'Библиотек из файлов нет.')]),
      h('div', { class: 'pop-actions' }, h('button', { class: 'pe-btn primary', onclick: async () => (await chooseLibrary(ed), render()) }, 'Подключить файл…')),
    );
  };
  document.body.append(box);
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  render();
}

/** Tokens: DTCG import and export, variables to CSS (our own — in the “File” menu). */
export function tokensMenu(ed: Editor): MenuEntry[] {
  return [
    { label: 'Импорт токенов (DTCG)…', run: () => void importTokens(ed) },
    { label: 'Экспорт токенов (DTCG)', run: () => exportTokens(ed) },
    { label: 'Переменные в CSS', submenu: [{ label: 'Цвета HEX', run: () => exportCss(ed, 'hex') }, { label: 'Цвета OKLCH', run: () => exportCss(ed, 'oklch') }] },
  ];
}
