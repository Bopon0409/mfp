// “Move to another file” (page menu): the page with everything it needs to work (components from
// other pages, styles, variables, images, comments) goes to a file on this device or to a new one.
// It can also be kept here (copy). If the page's main components are used on other pages of this
// file — copy only: otherwise their instances here would be left without a main component.

import { commentPages, Document, instancesElsewhere, threadPage, transferPage, userPages } from '@mfp/core';
import { writeMfp } from '@mfp/io-figma';
import type { Editor } from './editor.ts';
import type { Files } from './files.ts';
import { h, modal, searchInput } from './dom.ts';
import { newFileId, type FileMeta } from './library.ts';
import { disk, isDesktop } from './platform.ts';
import { t } from './i18n/index.ts';

export interface PageMoveDeps {
  editor: Editor;
  files: Files;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Open the library file in the editor. */
  openFile(id: string): void;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
};

export async function openPageMove(deps: PageMoveDeps, pageId: string) {
  const { editor, files } = deps;
  const lib = files.lib;
  const doc = editor.doc;
  if (!lib) return deps.notify('Файлы этого устройства недоступны (приватный режим браузера) — переносить некуда', 'error');
  const pageName = doc.get(pageId, 'name') ?? t('Страница');
  const elsewhere = instancesElsewhere(doc, pageId);
  const all = (await lib.list()).files.filter((f) => !f.trashed && f.id !== files.current.id).sort((a, b) => b.opened - a.opened);
  const { body, close, setTitle } = modal(`Перенести «${pageName}» в другой файл`, { cls: 'page-move' });
  const keep = h('input', { type: 'checkbox', checked: elsewhere > 0, disabled: elsewhere > 0 }) as HTMLInputElement;
  const keepRow = h(
    'label',
    { class: 'chk-row' },
    keep,
    h('span', {}, elsewhere > 0 ? `Только копия: главные компоненты страницы используются на других страницах (копий: ${elsewhere})` : 'Оставить страницу и здесь (копировать)'),
  );
  const list = h('div', { class: 'page-move-list' });
  const render = (q: string) => {
    list.replaceChildren(
      h('button', { class: 'page-move-row new', onclick: () => void run('new') }, h('b', {}, '+ Новый файл'), h('span', {}, `«${pageName}»`)),
      ...all
        .filter((f) => !q || f.name.toLowerCase().includes(q) || (f.folder ?? '').toLowerCase().includes(q))
        .map((f) => h('button', { class: 'page-move-row', onclick: () => void run(f) }, h('b', {}, f.name), h('span', {}, f.folder || 'Без папки'))),
    );
  };
  body.append(searchInput('Поиск файла', render), list, keepRow, h('div', { class: 'empty' }, 'С ней — компоненты с других страниц, стили, переменные, картинки и комментарии. Одноимённые стили и переменные файла-получателя берутся его.'));
  render('');

  const run = async (target: FileMeta | 'new') => {
    body.replaceChildren(h('div', { class: 'empty' }, 'Переношу…'));
    try {
      let tDoc: Document;
      let meta: FileMeta;
      const now = Date.now();
      if (target === 'new') {
        tDoc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
        meta = { id: newFileId(), name: pageName, folder: files.current.folder ?? '', created: now, modified: now, opened: now };
      } else {
        const r = await lib.readDocument(target.id);
        if (!r) throw new Error('рабочая копия файла не читается');
        tDoc = r.doc;
        meta = target;
      }
      const report = tDoc.transact(() => transferPage(doc, pageId, tDoc, { sourceName: files.name, componentsTitle: t('Компоненты — {0}', files.name) }));
      let missing = 0;
      for (const hash of report.images) {
        const bytes = await editor.store.readImage(hash);
        if (bytes) await lib.writeImage(meta.id, hash, bytes);
        else missing++;
      }
      if (target === 'new') await lib.put(meta);
      await lib.writeWorkCopy(meta.id, meta.name, tDoc);
      // Desktop: the file has an .mfp on disk — write that too.
      if (isDesktop && meta.path) {
        const { blob } = await writeMfp(tDoc, await lib.images(meta.id));
        await disk.writeFile(meta.path, new Uint8Array(await blob.arrayBuffer()));
      }
      await lib.update(meta.id, { modified: Date.now() });
      // Move (not copy): the page and its comments leave this file.
      const moved = !keep.checked;
      if (moved) {
        const pages = userPages(doc);
        if (editor.pageId === pageId) editor.setPage(pages.find((p) => p !== pageId) ?? pages[0]!);
        doc.transact(() => {
          for (const t of commentPages(doc).flatMap((p) => doc.children(p))) if (doc.type(t) === 'COMMENT' && threadPage(doc, t) === pageId) doc.delete(t);
          if (userPages(doc).length > 1) doc.delete(pageId);
        });
      }
      const parts = [
        report.components ? plural(report.components, 'компонент', 'компонента', 'компонентов') : '',
        report.styles ? plural(report.styles, 'стиль', 'стиля', 'стилей') : '',
        report.variables ? plural(report.variables, 'переменная', 'переменные', 'переменных') : '',
        report.images.size ? plural(report.images.size, 'картинка', 'картинки', 'картинок') : '',
        report.comments ? plural(report.comments, 'тред', 'треда', 'тредов') : '',
      ].filter(Boolean);
      setTitle(moved ? 'Страница перенесена' : 'Страница скопирована');
      body.replaceChildren(
        h('div', { class: 'page-move-done' }, `«${pageName}» → «${meta.name}»${parts.length ? `: с ней ${parts.join(', ')}` : ''}.`),
        ...(report.reused ? [h('div', { class: 'empty' }, `Уже были в файле и взяты его: ${report.reused}.`)] : []),
        ...(report.droppedLinks ? [h('div', { class: 'empty' }, `Переходы прототипа на другие страницы убраны: ${report.droppedLinks}.`)] : []),
        ...(missing ? [h('div', { class: 'empty' }, `Не нашлось байтов картинок: ${missing}.`)] : []),
        ...(files.remote ? [h('div', { class: 'empty' }, 'Комментарии файла на сервере остаются в нём.')] : []),
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'pe-btn', onclick: () => close() }, 'Закрыть'),
          h('button', {
            class: 'pe-btn primary',
            onclick: () => {
              close();
              deps.openFile(meta.id);
            },
          }, 'Открыть файл'),
        ),
      );
    } catch (e) {
      body.replaceChildren(h('div', { class: 'empty' }, `Не удалось: ${(e as Error).message}`), h('div', { class: 'modal-actions' }, h('button', { class: 'pe-btn', onclick: () => close() }, 'Закрыть')));
    }
  };
}
