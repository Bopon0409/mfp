// “Protect page” (our own): for a file on the server, the owner chooses which people with edit
// access may edit this page; the rest see it as view-only (and can comment). Both the editor
// (Document.guard) and the server enforce it.

import { canEditPage, pageGuard, protectionOf, type Document } from '@mfp/core';
import type { Account, FileRole } from './account.ts';
import type { Editor } from './editor.ts';
import { h, modal } from './dom.ts';
import { t } from './i18n/index.ts';

interface Access {
  role: FileRole;
  owner: { id: string; name: string; email?: string } | null;
  people: { id: string; name: string; email?: string; role: FileRole }[];
}

/** Who is editing: server id and whether they own the file. */
export function pageEditor(account: Account, role: FileRole | null) {
  return { id: account.user?.id ?? null, owner: role === 'owner' };
}

/** Document guard of a server file: edits to protected pages are reverted. */
export function installPageGuard(doc: Document, account: Account, role: () => FileRole | null, notify: (m: string) => void) {
  doc.guard = pageGuard(doc, () => pageEditor(account, role()));
  doc.onGuard = (page) => notify(page === 'защита страниц' ? 'Защиту страниц меняет владелец файла' : `Страница «${page}» защищена: править её могут владелец файла и те, кого он выбрал`);
}

/** The page is closed for editing by this person. */
export function pageLocked(doc: Document, page: string, account: Account, role: FileRole | null): boolean {
  return !canEditPage(doc, page, pageEditor(account, role));
}

/** Page protection dialog (file owner only). */
export async function openPageProtection(opts: { editor: Editor; account: Account; fileId: string; notify(m: string, kind?: 'info' | 'error'): void }, page: string) {
  const { editor, account } = opts;
  const doc = editor.doc;
  const name = doc.get(page, 'name') ?? t('Страница');
  const m = modal(`Защита страницы «${name}»`, { cls: 'page-protect' });
  let access: Access;
  try {
    access = await account.api<Access>('GET', `/api/files/${opts.fileId}/access`);
  } catch (e) {
    m.body.append(h('p', { class: 'm-note' }, `Список людей не загрузился: ${(e as Error).message}`));
    return;
  }
  if (access.role !== 'owner') {
    m.body.append(h('p', { class: 'm-note' }, 'Защиту страниц меняет владелец файла.'));
    return;
  }
  const current = protectionOf(doc, page);
  const chosen = new Set(current?.editors ?? []);
  const editors = access.people.filter((p) => p.role === 'edit' || p.role === 'owner');
  const rows = editors.map((p) => {
    const box = h('input', { type: 'checkbox', checked: chosen.has(p.id) }) as HTMLInputElement;
    box.addEventListener('change', () => (box.checked ? chosen.add(p.id) : chosen.delete(p.id)));
    return h('label', { class: 'lib-update-row' }, box, h('span', { class: 'lib-update-name' }, p.name), h('span', { class: 'lib-update-sub' }, p.email ?? ''));
  });
  const save = (protect: boolean) => {
    doc.transact(() => doc.set(page, { pageProtection: protect ? { editors: [...chosen] } : undefined }));
    opts.notify(protect ? `Страница «${name}» защищена` : `Защита со страницы «${name}» снята`);
    m.close();
  };
  m.body.append(
    h('p', { class: 'm-note' }, 'Править страницу смогут владелец файла и отмеченные люди; остальные — только смотреть и комментировать. Скрыть страницу от тех, у кого есть доступ к файлу, нельзя — для этого перенесите её в другой файл.'),
    h('div', { class: 'lib-update-list' }, ...(rows.length ? rows : [h('div', { class: 'empty' }, 'Кроме владельца, править файл никто не может — отметить некого.')])),
    h(
      'div',
      { class: 'modal-actions' },
      ...(current ? [h('button', { class: 'pe-btn', onclick: () => save(false) }, 'Снять защиту')] : []),
      h('button', { class: 'pe-btn', onclick: () => m.close() }, 'Отмена'),
      h('button', { class: 'pe-btn primary', onclick: () => save(true) }, current ? 'Сохранить' : 'Защитить'),
    ),
  );
}
