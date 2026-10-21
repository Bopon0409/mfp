// Selective library update: what is new and what changed:
// components (with a count of copies in the file), styles, variables; checkboxes for what to take now.
// The rest can wait: the update badge stays until everything is taken.

import { libraryChanges, type Document, type LibraryChange } from '@mfp/core';
import type { Editor } from './editor.ts';
import { h, modal } from './dom.ts';

const GROUPS: [string, (c: LibraryChange) => boolean][] = [
  ['Компоненты', (c) => c.type === 'COMPONENT' || c.type === 'COMPONENT_SET'],
  ['Стили', (c) => c.type === 'STYLE'],
  ['Переменные', (c) => c.type === 'VARIABLE'],
];

/**
 * Picker dialog. apply(only) takes the selected items (null: everything); remaining is how many changes
 * will be left afterwards (0: the library is fully updated).
 */
export function openLibraryUpdate(ed: Editor, opts: { name: string; source: Document; prefix: string; note?: string; apply(only: Set<string> | null): Promise<void> }) {
  const changes = libraryChanges(ed.doc, opts.source, opts.name, opts.prefix);
  const m = modal(`Обновление «${opts.name}»`, { cls: 'lib-update' });
  if (!changes.length) {
    m.body.append(
      h('p', { class: 'm-note' }, 'Ассеты в файле уже как в библиотеке.'),
      h('div', { class: 'modal-actions' }, h('button', { class: 'pe-btn', onclick: () => m.close() }, 'Закрыть'), h('button', { class: 'pe-btn primary', onclick: () => void opts.apply(null).then(() => m.close()) }, 'Отметить обновлённой')),
    );
    return;
  }
  const chosen = new Set(changes.map((c) => c.key));
  const count = h('span', {});
  const update = h('button', { class: 'pe-btn primary' }) as HTMLButtonElement;
  const refresh = () => {
    update.textContent = chosen.size === changes.length ? 'Обновить всё' : `Обновить выбранные (${chosen.size})`;
    update.disabled = !chosen.size;
    count.textContent = `${chosen.size} из ${changes.length}`;
  };
  const row = (c: LibraryChange) => {
    const box = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    box.addEventListener('change', () => {
      if (box.checked) chosen.add(c.key);
      else chosen.delete(c.key);
      refresh();
    });
    const sub = [c.status === 'new' ? 'новый' : 'изменён', c.instances ? `копий в файле: ${c.instances}` : ''].filter(Boolean).join(' · ');
    return h('label', { class: 'lib-update-row' }, box, h('span', { class: 'lib-update-name' }, c.name), h('span', { class: `lib-update-sub${c.status === 'new' ? ' new' : ''}` }, sub));
  };
  const all = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  all.addEventListener('change', () => {
    for (const el of m.body.querySelectorAll<HTMLInputElement>('.lib-update-row input')) el.checked = all.checked;
    chosen.clear();
    if (all.checked) for (const c of changes) chosen.add(c.key);
    refresh();
  });
  update.addEventListener('click', () => {
    update.disabled = true;
    void opts.apply(chosen.size === changes.length ? null : new Set(chosen)).then(() => m.close());
  });
  m.body.append(
    ...(opts.note ? [h('p', { class: 'm-note' }, opts.note)] : []),
    h('label', { class: 'lib-update-row head' }, all, h('span', { class: 'lib-update-name' }, 'Все изменения'), count),
    h(
      'div',
      { class: 'lib-update-list' },
      ...GROUPS.flatMap(([title, test]) => {
        const list = changes.filter(test);
        return list.length ? [h('div', { class: 'lib-update-group' }, title), ...list.map(row)] : [];
      }),
    ),
    h('p', { class: 'm-note' }, 'Невыбранное подождёт: значок обновления останется. Копии компонентов в файле получают изменения своих главных.'),
    h('div', { class: 'modal-actions' }, h('button', { class: 'pe-btn', onclick: () => m.close() }, 'Позже'), update),
  );
  refresh();
}
