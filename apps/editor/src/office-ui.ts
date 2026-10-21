// “Share with colleagues on the network”: this computer becomes an MFP server for the office
// (desktop app).
//
// Turning sharing on — the app starts its own server (Node.js and the MFP server from the office
// folder next to the program; data in the app's data folder), connects to it itself and creates the
// owner account on the first launch. Colleagues on the same network open this computer's address
// in a browser or in the app (“With a team server”); the owner creates their accounts.

import { whoIs, type Account } from './account.ts';
import { usersDialog } from './account-ui.ts';
import { fill, h, modal } from './dom.ts';
import { appMode } from './network.ts';
import { office, type OfficeInfo } from './platform.ts';

type Notify = (message: string, kind?: 'info' | 'error') => void;

export interface OfficeHooks {
  account: Account;
  signIn: () => Promise<boolean>;
  notify: Notify;
}

const KEY = 'mfp.office';
const PORT = 8686;

/** Turn sharing on when the app starts. */
export const officeAuto = {
  get on(): boolean {
    try {
      return localStorage.getItem(KEY) === 'on';
    } catch {
      return false;
    }
  },
  set(on: boolean) {
    try {
      if (on) localStorage.setItem(KEY, 'on');
      else localStorage.removeItem(KEY);
    } catch {
      // No storage — until restart.
    }
  },
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The server responds (up to 15 s: first launch creates the database). */
async function ready(port: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) return true;
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Start our own server and connect this computer to it (“With a team server” mode). */
export async function startOffice(account: Account): Promise<OfficeInfo> {
  const started = await office.start(PORT);
  if (!(await ready(started.port))) throw new Error('Сервер не запустился — подробности в журнале (Справка → Сообщить о проблеме)');
  const base = `http://localhost:${started.port}`;
  // The same server (started with the app): sign-in may not have been confirmed while the server was starting.
  if (account.base === base) await account.refresh().catch(() => {});
  else account.setServer(base);
  appMode.set('server');
  document.body.classList.remove('app-local');
  return office.status();
}

/**
 * Whether initial setup is needed. The app remembers the code until the server restarts, but
 * whether the server is set up (the owner already created, e.g. in a browser) only the server knows.
 */
async function needsSetup(info: OfficeInfo): Promise<boolean> {
  if (!info.setupCode) return false;
  try {
    const c = (await (await fetch(`http://localhost:${info.port}/api/auth/config`)).json()) as { setup?: boolean };
    return !!c.setup;
  } catch {
    return false;
  }
}

const urls = (info: OfficeInfo) => info.addresses.map((a) => `http://${a}:${info.port}`);

export function openOfficeDialog(hooks: OfficeHooks) {
  const { account, notify } = hooks;
  const m = modal('Доступ для коллег в сети', { cls: 'wide' });
  const auto = () => {
    const box = h('input', { type: 'checkbox', checked: officeAuto.on, onchange: (e: Event) => officeAuto.set((e.target as HTMLInputElement).checked) });
    return h('label', { class: 'm-row' }, box, 'Открывать доступ при запуске MFP');
  };

  const off = () => {
    const go = h('button', { class: 'm-btn primary' }, 'Открыть доступ') as HTMLButtonElement;
    const error = h('p', { class: 'm-error', role: 'alert' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Запуск…';
      error.textContent = '';
      try {
        const info = await startOffice(account);
        if (!(await needsSetup(info)) && !account.signedIn) await hooks.signIn();
        void render();
      } catch (e) {
        error.textContent = message(e);
        go.disabled = false;
        go.textContent = 'Открыть доступ';
      }
    });
    fill(
      m.body,
      h('p', { class: 'm-note' }, 'Этот компьютер станет сервером MFP для коллег в той же сети (офис, дом): они откроют его адрес в браузере или в приложении и будут работать с файлами вместе. Интернет не нужен.'),
      h('p', { class: 'm-note' }, 'Файлы хранятся на этом компьютере — пока он выключен, коллеги работать не смогут. Windows при первом запуске спросит, разрешить ли доступ к сети, — разрешите для частной сети.'),
      auto(),
      error,
      h('div', { class: 'm-row end' }, go),
    );
  };

  /** First launch: the server owner's account. */
  const setup = (info: OfficeInfo) => {
    const input = (attrs: Record<string, unknown>) => h('input', { class: 'm-input', required: true, ...attrs }) as HTMLInputElement;
    const name = input({ placeholder: 'Ваше имя', 'aria-label': 'Имя', autocomplete: 'name' });
    const login = input({ placeholder: 'Логин (латиницей)', 'aria-label': 'Логин', autocomplete: 'username' });
    const password = input({ type: 'password', placeholder: 'Пароль — от 12 символов', 'aria-label': 'Пароль', autocomplete: 'new-password' });
    const repeat = input({ type: 'password', placeholder: 'Повторите пароль', 'aria-label': 'Повторите пароль', autocomplete: 'new-password' });
    const error = h('p', { class: 'm-error', role: 'alert' });
    const go = h('button', { class: 'm-btn primary', type: 'submit' }, 'Создать') as HTMLButtonElement;
    const form = h('form', { class: 'modal-body' }, h('p', { class: 'm-note' }, 'Сервер запущен. Создайте свою учётную запись владельца — с ней вы заводите учётные записи коллегам.'), name, login, password, repeat, error, h('div', { class: 'm-row end' }, go));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (password.value !== repeat.value) {
        error.textContent = 'Пароли не совпадают';
        return;
      }
      go.disabled = true;
      try {
        await account.setupServer(info.setupCode!, login.value.trim(), name.value.trim() || login.value.trim(), password.value);
        void render();
      } catch (err) {
        error.textContent = message(err);
        go.disabled = false;
      }
    });
    m.body.replaceWith(form);
    m.body = form;
    requestAnimationFrame(() => name.focus());
  };

  const on = (info: OfficeInfo) => {
    const list = urls(info);
    const stop = h('button', { class: 'm-btn danger' }, 'Закрыть доступ') as HTMLButtonElement;
    stop.addEventListener('click', async () => {
      if (!confirm('Закрыть доступ? Коллеги отключатся; файлы останутся на этом компьютере.')) return;
      await office.stop().catch((e) => notify(message(e), 'error'));
      officeAuto.set(false);
      void render();
    });
    fill(
      m.body,
      h('p', { class: 'm-note' }, 'Доступ открыт. Коллеги в этой сети открывают адрес в браузере или в приложении MFP («Режим: с сервером команды» → адрес сервера) и входят по логину, который вы им выдали.'),
      list.length
        ? h(
            'div',
            { class: 'm-list' },
            ...list.map((u) => h('div', { class: 'm-row' }, h('div', { class: 'm-token', style: 'flex:1' }, u), h('button', { class: 'm-btn', onclick: () => void navigator.clipboard.writeText(u).then(() => notify('Адрес скопирован')) }, 'Копировать'))),
          )
        : h('p', { class: 'm-error' }, 'Компьютер не подключён к сети — коллеги его не увидят. Подключитесь к сети офиса.'),
      account.user ? h('p', { class: 'm-note' }, `Вы вошли как ${whoIs(account.user.email)}. `, account.user.admin ? h('button', { class: 'm-link', onclick: () => usersDialog(account, notify) }, 'Учётные записи коллег…') : null) : null,
      auto(),
      h('div', { class: 'm-row end' }, stop),
    );
  };

  const render = async () => {
    // After the initial setup form the dialog body is a <form>: buttons in it would submit it again.
    if (m.body.tagName === 'FORM') {
      const div = h('div', { class: 'modal-body' });
      m.body.replaceWith(div);
      m.body = div;
    }
    const info = await office.status().catch(() => null);
    if (info?.running && (await needsSetup(info))) setup(info);
    else if (info?.running) on(info);
    else off();
  };
  void render();
}
