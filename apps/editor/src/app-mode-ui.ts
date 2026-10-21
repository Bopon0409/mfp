// Choosing the desktop app's working mode (first launch and Settings → “Mode…”):
// “On this computer” — files in the Documents/MFP folder, no account, no internet by default;
// “With a team server” — sign-in to a company (or MFP) server, collaboration and files on the server.

import type { Account } from './account.ts';
import { serverDialog } from './account-ui.ts';
import { h, modal } from './dom.ts';
import { appMode, network } from './network.ts';

export interface AppModeHooks {
  account: Account;
  signIn: () => void;
  notify: (message: string, kind?: 'info' | 'error') => void;
  /** First launch: different wording; closing without a choice means “on this computer”. */
  first?: boolean;
}

export function chooseAppMode(hooks: AppModeHooks) {
  const m = modal(hooks.first ? 'Добро пожаловать в MFP' : 'Режим работы', {
    cls: 'app-mode-dialog',
    onClose: () => {
      if (hooks.first && !appMode.chosen) pick('local', false);
    },
  });
  const pick = (mode: 'local' | 'server', close = true) => {
    appMode.set(mode);
    document.body.classList.toggle('app-local', mode === 'local');
    if (close) m.close();
    if (mode === 'local') hooks.notify(network.allowed ? 'На этом компьютере: файлы — в папке Документы/MFP' : 'На этом компьютере: файлы — в папке Документы/MFP, без интернета (включить — в Настройках)');
    else if (!hooks.account.signedIn) void serverDialog(hooks.account).then((ok) => ok && hooks.signIn());
  };
  const card = (mode: 'local' | 'server', title: string, text: string) =>
    h(
      'button',
      { class: `mode-card${!hooks.first && appMode.value === mode ? ' on' : ''}`, onclick: () => pick(mode) },
      h('span', { class: 'mode-title' }, title),
      h('span', { class: 'mode-text' }, text),
    );
  m.body.append(
    h('p', { class: 'm-note' }, hooks.first ? 'Как вы будете работать? Это можно поменять потом: Главное меню → Настройки → «Режим».' : 'Режим можно поменять в любой момент — файлы на диске остаются на месте.'),
    h(
      'div',
      { class: 'mode-cards' },
      card('local', 'На этом компьютере', 'Файлы — в папке «Документы/MFP» и где угодно на диске. Без учётной записи и без интернета: шрифты и все инструменты — в комплекте. Интернет можно включить в Настройках.'),
      card('server', 'С сервером команды', 'Вход на сервер компании или MFP: совместная работа, комментарии, общие библиотеки и файлы на сервере. Адрес сервера — в окне входа.'),
    ),
  );
}
