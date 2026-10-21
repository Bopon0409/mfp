// Help: the “?” button menu and the “Help and account” section of the main menu, the “About” dialog
// (Figma trademark disclaimer and a link to third-party license texts).

import { h, modal } from './dom.ts';
import type { MenuEntry } from './menu.ts';

export interface HelpHooks {
  shortcuts: () => void;
  customKeys: () => void;
  report: () => void;
  /** Desktop app only. */
  updates?: () => void;
}

/** Help items (without the account; it lives in the main menu). */
export function helpItems(hooks: HelpHooks): MenuEntry[] {
  return [
    { label: 'Сочетания клавиш', hint: 'Ctrl+Shift+?', run: hooks.shortcuts },
    { label: 'Свои сочетания клавиш…', run: hooks.customKeys },
    'sep',
    { label: 'Сообщить о проблеме…', run: hooks.report },
    ...(hooks.updates ? [{ label: 'Проверить обновления…', run: hooks.updates }] : []),
    'sep',
    { label: 'О программе MFP', run: openAbout },
  ];
}

/** MFP source code (GNU AGPL-3.0: a hosted service links its users to the sources). */
export const SOURCE_URL = 'https://github.com/Bopon0409/mfp';

export function openAbout() {
  const m = modal('О программе MFP', { cls: 'about-dialog' });
  m.body.append(
    h('p', { class: 'about-lead' }, h('b', {}, 'MFP — Make · Frame · Prototype.'), ' Редактор интерфейсов: макеты, прототипы, режим разработчика и совместная работа.'),
    h(
      'p',
      { class: 'm-note' },
      'Figma — товарный знак Figma, Inc. MFP — независимый продукт, не связан с Figma, Inc. и не одобрен ею. Упоминания Figma означают только совместимость с файлами .fig, буфером обмена и плагинами.',
    ),
    h('p', { class: 'm-note' }, 'MFP бесплатен, код открыт (GNU AGPL-3.0): ', h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener' }, SOURCE_URL.replace(/^https:\/\//, '')), '.'),
    h('p', { class: 'm-note' }, 'MFP использует библиотеки с открытым кодом и модели нейросетей — их лицензии: ', h('a', { href: '/licenses.txt', target: '_blank', rel: 'noopener' }, 'сторонние компоненты'), '.'),
  );
}
