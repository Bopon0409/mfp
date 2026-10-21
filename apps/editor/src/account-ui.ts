// Account windows: sign-in with an email code, account menu, API tokens, team
// (members, roles, invitations), choosing a place on the server (drafts or a team project).

import { ApiError, TEAM_ROLES, whoIs, type Account, type TeamRole } from './account.ts';
import { avatar, fill, h, iconBtn, modal } from './dom.ts';
import { ICON } from './icons.ts';
import type { MenuEntry } from './menu.ts';
import { openMcpDialog } from './mcp-ui.ts';
import { trustServer } from './network.ts';
import { t as tl } from './i18n/index.ts';

type Notify = (message: string, kind?: 'info' | 'error') => void;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Account login (server with password sign-in): can be entered instead of an email. */
const LOGIN = /^[a-z][a-z0-9_-]{2,31}$/;
const TEAM_RANK: Record<TeamRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(url);

/** Sign-in window: email → code from the email. true — signed in. */
export async function signIn(account: Account, reason?: string): Promise<boolean> {
  const config = await account.api<{ mode: string; setup?: boolean }>('GET', '/api/auth/config').catch(() => ({ mode: 'email', setup: false }));
  if (config.setup) return setupServer(account);
  if (config.mode === 'password') return passwordSignIn(account, reason);
  return new Promise((resolve) => {
    let done = false;
    /** Another server: sign in again — it may have a different sign-in method. */
    let switched: Promise<boolean> | null = null;
    const m = modal('Вход в MFP', { onClose: () => resolve(switched ?? done) });
    const changeServer = () => {
      switched = serverDialog(account).then((ok) => (ok ? signIn(account, reason) : false));
      m.close();
    };
    let email = account.user?.email ?? '';
    try {
      email ||= localStorage.getItem('mfp-email') ?? '';
    } catch {
      // Without storage — the email is entered again.
    }

    const stepEmail = () => {
      const err = h('p', { class: 'm-error', role: 'alert' });
      const input = h('input', { class: 'm-input', type: 'email', name: 'email', placeholder: 'Почта', value: email, autocomplete: 'email', 'aria-label': 'Почта', required: true }) as HTMLInputElement;
      const serverLine = h('p', { class: 'm-note' }, `Сервер: ${account.base} · `, h('button', { type: 'button', class: 'm-link', onclick: changeServer }, 'изменить'));
      const go = h('button', { class: 'm-btn primary', type: 'submit' }, 'Получить код') as HTMLButtonElement;
      // Company SSO (if configured on the server): its own button; emails on its domains — only this way.
      const ssoRow = h('div', { class: 'm-row', hidden: true });
      let ssoDomains: string[] = [];
      void account.sso().then((sso) => {
        if (!sso) return;
        ssoDomains = sso.domains;
        ssoRow.hidden = false;
        fill(ssoRow, h('button', { type: 'button', class: 'm-btn sso-btn', onclick: () => (location.href = account.ssoUrl(input.value.trim() || undefined)) }, sso.name));
      });
      const form = h(
        'form',
        { class: 'modal-body', novalidate: true },
        h('p', { class: 'm-note' }, reason ?? 'Вход нужен для файлов на сервере: команды, проекты, общий доступ. Пароля нет — пришлём код на почту.'),
        ssoRow,
        input,
        serverLine,
        err,
        h('div', { class: 'm-row end' }, go),
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        email = input.value.trim().toLowerCase();
        if (!EMAIL.test(email)) {
          err.textContent = 'Проверьте адрес почты';
          input.focus();
          return;
        }
        if (ssoDomains.includes(email.split('@')[1] ?? '')) {
          location.href = account.ssoUrl(email);
          return;
        }
        go.disabled = true;
        err.textContent = '';
        try {
          await account.requestCode(email);
          stepCode('');
        } catch (e2) {
          // A code was already sent less than half a minute ago — that one is still valid.
          if (e2 instanceof ApiError && e2.status === 429) stepCode(e2.message);
          else err.textContent = message(e2);
        } finally {
          go.disabled = false;
        }
      });
      m.body.replaceWith(form);
      m.body = form;
      requestAnimationFrame(() => input.focus());
    };

    const stepCode = (note: string) => {
      try {
        localStorage.setItem('mfp-email', email);
      } catch {
        // If it isn't remembered — no big deal.
      }
      const err = h('p', { class: 'm-error', role: 'alert' }, note);
      const code = h('input', { class: 'm-input code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, placeholder: '••••••', 'aria-label': 'Код из письма' }) as HTMLInputElement;
      const go = h('button', { class: 'm-btn primary', type: 'submit' }, 'Войти') as HTMLButtonElement;
      const again = h('button', { type: 'button', class: 'm-link' }, 'Отправить код ещё раз') as HTMLButtonElement;
      let wait = 30;
      const tick = () => {
        if (!again.isConnected) return;
        again.disabled = wait > 0;
        again.textContent = wait > 0 ? `Отправить ещё раз через ${wait} с` : 'Отправить код ещё раз';
        if (wait-- > 0) setTimeout(tick, 1000);
      };
      again.addEventListener('click', async () => {
        try {
          await account.requestCode(email);
          err.textContent = '';
          wait = 30;
          tick();
        } catch (e) {
          err.textContent = message(e);
        }
      });
      const form = h(
        'form',
        { class: 'modal-body', novalidate: true },
        h('p', { class: 'm-note' }, `Код отправлен на ${email}. Введите 6 цифр из письма — код действует 10 минут.`),
        isLocal(account.base) ? h('p', { class: 'm-note' }, 'Сервер разработки писем не отправляет: код — в консоли сервера и в файле outbox.jsonl в его папке данных.') : null,
        code,
        err,
        h('div', { class: 'm-row' }, h('div', { style: 'flex:1;display:flex;flex-direction:column;gap:4px;align-items:flex-start' }, again, h('button', { type: 'button', class: 'm-link', onclick: () => stepEmail() }, 'Другая почта')), go),
      );
      const submit = async () => {
        const v = code.value.replace(/\D/g, '');
        if (v.length !== 6) {
          err.textContent = 'Нужно 6 цифр';
          return;
        }
        go.disabled = true;
        try {
          await account.verify(email, v);
          done = true;
          m.close();
        } catch (e) {
          err.textContent = message(e);
          code.select();
        } finally {
          go.disabled = false;
        }
      };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void submit();
      });
      code.addEventListener('input', () => {
        code.value = code.value.replace(/\D/g, '').slice(0, 6);
        if (code.value.length === 6) void submit();
      });
      m.body.replaceWith(form);
      m.body = form;
      tick();
      requestAnimationFrame(() => code.focus());
    };

    stepEmail();
  });
}

function passwordSignIn(account: Account, reason?: string): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    let change = false;
    let switched: Promise<boolean> | null = null;
    const m = modal('Вход в MFP', { onClose: () => resolve(switched ?? done) });
    const serverLine = h(
      'p',
      { class: 'm-note' },
      `Сервер: ${account.base} · `,
      h('button', { type: 'button', class: 'm-link', onclick: () => ((switched = serverDialog(account).then((ok) => (ok ? signIn(account, reason) : false))), m.close()) }, 'изменить'),
    );
    const login = h('input', { class: 'm-input', autocomplete: 'username', placeholder: 'Логин', 'aria-label': 'Логин', required: true }) as HTMLInputElement;
    const password = h('input', { class: 'm-input', type: 'password', autocomplete: 'current-password', placeholder: 'Пароль', 'aria-label': 'Пароль', required: true }) as HTMLInputElement;
    const next = h('input', { class: 'm-input', type: 'password', autocomplete: 'new-password', placeholder: 'Новый пароль — от 12 символов', 'aria-label': 'Новый пароль', minLength: 12, maxLength: 128 }) as HTMLInputElement;
    const repeat = h('input', { class: 'm-input', type: 'password', autocomplete: 'new-password', placeholder: 'Повторите новый пароль', 'aria-label': 'Повторите новый пароль' }) as HTMLInputElement;
    const fields = h('div', { hidden: true }, next, repeat);
    const note = h('p', { class: 'm-note' }, reason ?? 'Введите логин и временный пароль, полученные от администратора.');
    const error = h('p', { class: 'm-error', role: 'alert' });
    const go = h('button', { class: 'm-btn primary', type: 'submit' }, 'Войти') as HTMLButtonElement;
    const form = h('form', { class: 'modal-body' }, note, login, password, fields, serverLine, error, go);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (change && next.value !== repeat.value) { error.textContent = 'Новые пароли не совпадают'; return; }
      go.disabled = true; error.textContent = '';
      try {
        done = await account.passwordLogin(login.value, password.value, change ? next.value : undefined);
        if (done) { password.value = next.value = repeat.value = ''; m.close(); }
        else {
          change = true; fields.hidden = false; next.required = repeat.required = true;
          note.textContent = 'Перед первым входом установите собственный пароль. Временный больше не будет действовать.';
          go.textContent = 'Сменить пароль и войти'; next.focus();
        }
      } catch (e) { error.textContent = message(e); }
      finally { go.disabled = false; }
    });
    m.body.replaceWith(form); m.body = form; requestAnimationFrame(() => login.focus());
  });
}

/** Team server address (company, a colleague's computer with open access): check and remember. */
export function serverDialog(account: Account): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const m = modal('Сервер команды', { onClose: () => resolve(ok) });
    const input = h('input', { class: 'm-input', placeholder: 'Например, http://192.168.1.10:8686', value: isLocal(account.base) ? '' : account.base, 'aria-label': 'Адрес сервера', spellcheck: false, autocomplete: 'url' }) as HTMLInputElement;
    const error = h('p', { class: 'm-error', role: 'alert' });
    const go = h('button', { class: 'm-btn primary', type: 'submit' }, 'Подключиться') as HTMLButtonElement;
    const form = h('form', { class: 'modal-body' }, h('p', { class: 'm-note' }, 'Адрес сервера компании или компьютера коллеги, который открыл доступ в сети (у него: Настройки → «Доступ для коллег в сети…»).'), input, error, h('div', { class: 'm-row end' }, go));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let url = input.value.trim().replace(/\/+$/, '');
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
      go.disabled = true;
      error.textContent = '';
      try {
        // The person entered the address themselves — it is a team server, allowed even without internet access.
        trustServer(url);
        const r = await fetch(`${url}/api/auth/config`);
        if (!r.ok) throw new Error(String(r.status));
      } catch {
        error.textContent = 'Сервер не отвечает: проверьте адрес и что компьютер с MFP включён и в той же сети';
        go.disabled = false;
        return;
      }
      account.setServer(url);
      ok = true;
      m.close();
    });
    m.body.replaceWith(form);
    m.body = form;
    requestAnimationFrame(() => input.focus());
  });
}

/** First setup of a company server: code from the server log, the first administrator and their password. */
function setupServer(account: Account): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal('Первая настройка сервера', { onClose: () => resolve(done) });
    const input = (attrs: Record<string, unknown>) => h('input', { class: 'm-input', required: true, ...attrs }) as HTMLInputElement;
    const code = input({ placeholder: 'Код из журнала сервера', 'aria-label': 'Код первой настройки', autocomplete: 'off', spellcheck: false });
    const name = input({ placeholder: 'Ваше имя', 'aria-label': 'Имя', autocomplete: 'name' });
    const login = input({ placeholder: 'Логин администратора (латиницей)', 'aria-label': 'Логин', autocomplete: 'username' });
    const password = input({ type: 'password', placeholder: 'Пароль — от 12 символов', 'aria-label': 'Пароль', autocomplete: 'new-password', minLength: 12, maxLength: 128 });
    const repeat = input({ type: 'password', placeholder: 'Повторите пароль', 'aria-label': 'Повторите пароль', autocomplete: 'new-password' });
    const error = h('p', { class: 'm-error', role: 'alert' });
    const go = h('button', { class: 'm-btn primary', type: 'submit' }, 'Создать администратора') as HTMLButtonElement;
    const form = h(
      'form',
      { class: 'modal-body' },
      h('p', { class: 'm-note' }, `На сервере ${account.base.replace(/^https?:\/\//, '')} ещё нет учётных записей. Код первой настройки сервер напечатал в журнал при запуске (docker compose logs mfp) — он подтверждает, что настраивает администратор.`),
      code,
      name,
      login,
      password,
      repeat,
      error,
      h('div', { class: 'm-row end' }, go),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (password.value !== repeat.value) {
        error.textContent = 'Пароли не совпадают';
        return;
      }
      go.disabled = true;
      error.textContent = '';
      try {
        await account.setupServer(code.value.trim(), login.value.trim(), name.value.trim() || login.value.trim(), password.value);
        done = true;
        m.close();
      } catch (e) {
        error.textContent = message(e);
      } finally {
        go.disabled = false;
      }
    });
    m.body.replaceWith(form);
    m.body = form;
    requestAnimationFrame(() => code.focus());
  });
}

/** Account menu (in “Files” and in the main menu). */
export function accountMenu(account: Account, hooks: { notify: Notify; signIn: () => void }): MenuEntry[] {
  const u = account.user;
  if (!u) return [{ label: 'Войти…', run: hooks.signIn }];
  return [
    { label: `${u.name} · ${whoIs(u.email)}`, disabled: true },
    'sep',
    {
      label: 'Изменить имя…',
      run: () => {
        const name = prompt('Ваше имя (его видят участники):', u.name)?.trim();
        if (name && name !== u.name) void account.rename(name).catch((e) => hooks.notify(message(e), 'error'));
      },
    },
    { label: 'Токены API…', run: () => tokensDialog(account, hooks.notify) },
    { label: 'Подключить ИИ-агента (MCP)…', run: () => openMcpDialog(account, { notify: hooks.notify, signIn: hooks.signIn }) },
    ...(u.admin ? [{ label: 'Учётные записи…', run: () => usersDialog(account, hooks.notify) }] : []),
    ...(u.admin ? [{ label: 'Журнал аудита…', run: () => auditDialog(account, hooks.notify) }] : []),
    'sep',
    { label: `Выйти (${account.base.replace(/^https?:\/\//, '')})`, run: () => void account.signOut() },
  ];
}

/** Audit log (Enterprise, server administrator): latest actions, CSV export. */
export function auditDialog(account: Account, notify: Notify) {
  const m = modal('Журнал аудита', { cls: 'wide' });
  const query = h('input', { class: 'm-input', placeholder: 'Почта или действие (file., team., login…)', 'aria-label': 'Отбор' }) as HTMLInputElement;
  const list = h('div', { class: 'audit-list' });
  const params = () => {
    const q = query.value.trim();
    return q.includes('@') ? `user=${encodeURIComponent(q.toLowerCase())}` : q ? `action=${encodeURIComponent(q)}` : '';
  };
  const load = async () => {
    try {
      const r = await account.api<{ entries: { time: string; email: string | null; action: string; target: string | null; status: number; ip: string | null }[] }>('GET', `/api/admin/audit?limit=300&${params()}`);
      fill(
        list,
        ...(r.entries.length
          ? r.entries.map((e) => h('div', { class: `audit-row${e.status >= 400 ? ' failed' : ''}` }, h('span', { class: 'dv-dim' }, new Date(e.time).toLocaleString('ru-RU')), h('span', {}, e.email ?? '—'), h('span', { class: 'audit-action' }, e.action), h('span', { class: 'dv-dim' }, e.target ?? ''), h('span', { class: 'dv-dim' }, e.ip ?? '')))
          : [h('p', { class: 'm-note' }, 'Записей нет.')]),
      );
    } catch (e) {
      fill(list, h('p', { class: 'm-error' }, message(e)));
    }
  };
  query.addEventListener('keydown', (e) => e.key === 'Enter' && void load());
  const csv = async () => {
    try {
      const res = await fetch(`${account.base}/api/admin/audit?limit=10000&format=csv&${params()}`, { headers: { authorization: `Bearer ${account.token}` } });
      if (!res.ok) throw new Error(`ответ ${res.status}`);
      const a = h('a', { href: URL.createObjectURL(await res.blob()), download: `audit-${new Date().toISOString().slice(0, 10)}.csv` }) as HTMLAnchorElement;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      notify(`Выгрузка не удалась: ${message(e)}`, 'error');
    }
  };
  fill(m.body, h('div', { class: 'm-row' }, query, h('button', { class: 'm-btn', onclick: () => void load() }, 'Найти'), h('button', { class: 'm-btn', onclick: () => void csv() }, 'CSV')), list);
  void load();
}

/** Personal API tokens: for scripts, REST and MCP. The token is shown once. */
export function tokensDialog(account: Account, notify: Notify) {
  const m = modal('Токены API', { cls: 'wide' });
  let fresh: string | null = null;
  const render = async () => {
    let tokens: { id: string; name: string; created: number; last_used: number | null }[] = [];
    try {
      tokens = (await account.api<{ tokens: typeof tokens }>('GET', '/api/tokens')).tokens;
    } catch (e) {
      notify(message(e), 'error');
    }
    const name = h('input', { class: 'm-input', placeholder: 'Название (например, «CI» или «Агент»)', 'aria-label': 'Название токена' }) as HTMLInputElement;
    const create = async () => {
      try {
        fresh = (await account.api<{ token: string }>('POST', '/api/tokens', { name: name.value.trim() || tl('Токен') })).token;
        void render();
      } catch (e) {
        notify(message(e), 'error');
      }
    };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && void create());
    const date = (t: number) => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
    fill(m.body,
      h('p', { class: 'm-note' }, 'Токен даёт программам (скриптам, REST API, MCP) те же права, что у вас. Передайте его в заголовке Authorization: Bearer <токен>.'),
      fresh
        ? h(
            'div',
            { class: 'm-list' },
            h('div', { class: 'm-label' }, 'Новый токен — скопируйте сейчас, больше он не покажется:'),
            h('div', { class: 'm-token' }, fresh),
            h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => void navigator.clipboard.writeText(fresh!).then(() => notify('Токен скопирован')) }, 'Копировать')),
          )
        : null,
      h('div', { class: 'm-row' }, name, h('button', { class: 'm-btn primary', onclick: () => void create() }, 'Создать')),
      h(
        'div',
        { class: 'm-list' },
        ...(tokens.length
          ? tokens.map((t) =>
              h(
                'div',
                { class: 'person' },
                h('div', { class: 'person-text' }, h('div', { class: 'person-name' }, t.name || tl('Токен')), h('div', { class: 'person-sub' }, `создан ${date(t.created)} · ${t.last_used ? `использован ${date(t.last_used)}` : 'не использовался'}`)),
                h(
                  'button',
                  {
                    class: 'm-btn danger',
                    onclick: async () => {
                      if (!confirm(`Отозвать токен «${t.name}»? Программы с ним перестанут работать.`)) return;
                      await account.api('DELETE', `/api/tokens/${t.id}`).catch((e) => notify(message(e), 'error'));
                      fresh = null;
                      void render();
                    },
                  },
                  'Отозвать',
                ),
              ),
            )
          : [h('p', { class: 'm-note' }, 'Токенов нет.')]),
      ),
    );
  };
  void render();
}

/** Temporary password: 16 characters without look-alikes (give it to the person directly; they change it on sign-in). */
function tempPassword(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

/** Server accounts (administrator): add by login, disable, permissions, password reset. */
export function usersDialog(account: Account, notify: Notify) {
  const m = modal('Учётные записи', { cls: 'wide' });
  /** A freshly issued temporary password — show it once. */
  let issued: { login: string; password: string } | null = null;
  const render = async () => {
    let data: { passwords: boolean; users: { id: string; email: string; name: string; login: string | null; admin: boolean; disabled: boolean; created: number }[] } = { passwords: false, users: [] };
    try {
      data = await account.api<typeof data>('GET', '/api/admin/users');
    } catch (e) {
      notify(message(e), 'error');
    }
    const act = async (method: string, path: string, body: unknown) => {
      try {
        await account.api(method, path, body);
      } catch (e) {
        notify(message(e), 'error');
      }
      void render();
    };
    const login = h('input', { class: 'm-input', placeholder: 'Логин (латиницей)', 'aria-label': 'Логин', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
    const name = h('input', { class: 'm-input', placeholder: 'Имя', 'aria-label': 'Имя', autocomplete: 'off' }) as HTMLInputElement;
    const add = async () => {
      const password = tempPassword();
      try {
        await account.api('POST', '/api/admin/users', { login: login.value.trim(), name: name.value.trim() || login.value.trim(), password });
        issued = { login: login.value.trim().toLowerCase(), password };
      } catch (e) {
        notify(message(e), 'error');
        return;
      }
      void render();
    };
    const reset = async (u: { id: string; login: string | null }) => {
      if (!confirm(`Выдать «${u.login}» новый временный пароль? Прежний перестанет действовать, открытые сеансы завершатся.`)) return;
      const password = tempPassword();
      try {
        await account.api('POST', `/api/admin/users/${u.id}/password`, { password });
        issued = { login: u.login ?? '', password };
      } catch (e) {
        notify(message(e), 'error');
      }
      void render();
    };
    const me = account.user?.id;
    fill(
      m.body,
      h('p', { class: 'm-note' }, data.passwords ? 'Вход по логину и паролю. Новой учётной записи выдаётся временный пароль — передайте его человеку лично, при первом входе он установит свой.' : 'Вход по почте (или SSO): учётная запись появляется при первом входе. Здесь её можно отключить или дать права администратора.'),
      issued
        ? h(
            'div',
            { class: 'm-list' },
            h('div', { class: 'm-label' }, `Временный пароль для «${issued.login}» — скопируйте сейчас, больше он не покажется:`),
            h('div', { class: 'm-token' }, issued.password),
            h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => void navigator.clipboard.writeText(issued!.password).then(() => notify('Пароль скопирован')) }, 'Копировать')),
          )
        : null,
      data.passwords ? h('div', { class: 'm-row' }, login, name, h('button', { class: 'm-btn primary', onclick: () => void add() }, 'Добавить')) : null,
      h(
        'div',
        { class: 'm-list' },
        ...data.users.map((u) =>
          h(
            'div',
            { class: 'person' },
            h(
              'div',
              { class: 'person-text' },
              h('div', { class: 'person-name' }, u.name, u.admin ? ' · администратор' : '', u.disabled ? ' · отключена' : ''),
              h('div', { class: 'person-sub' }, u.login ? `логин ${u.login}` : u.email),
            ),
            u.id === me
              ? h('span', { class: 'person-sub' }, 'это вы')
              : h(
                  'div',
                  { class: 'm-row' },
                  data.passwords && u.login ? h('button', { class: 'm-btn', onclick: () => void reset(u) }, 'Сбросить пароль') : null,
                  h('button', { class: 'm-btn', onclick: () => void act('PATCH', `/api/admin/users/${u.id}`, { admin: !u.admin }) }, u.admin ? 'Снять права' : 'Сделать администратором'),
                  h('button', { class: `m-btn${u.disabled ? '' : ' danger'}`, onclick: () => void act('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled }) }, u.disabled ? 'Включить' : 'Отключить'),
                ),
          ),
        ),
      ),
    );
  };
  void render();
}

interface TeamInfo {
  team: { id: string; name: string };
  role: TeamRole;
  members: { id: string; email: string; name: string; color: string; role: TeamRole }[];
  invites: { id: string; email: string; role: TeamRole }[];
  projects: { id: string; name: string }[];
}

/** Team: name, members and roles, invitations; leave or delete. */
export function teamDialog(account: Account, teamId: string, hooks: { notify: Notify; changed: () => void }) {
  const m = modal('Команда', { cls: 'wide' });
  const fail = (e: unknown) => hooks.notify(message(e), 'error');
  const after = async (p: Promise<unknown>) => {
    try {
      await p;
      await account.refresh();
      hooks.changed();
    } catch (e) {
      fail(e);
    }
    await render();
  };
  const render = async () => {
    let t: TeamInfo;
    try {
      t = await account.api<TeamInfo>('GET', `/api/teams/${teamId}`);
    } catch (e) {
      fail(e);
      m.close();
      return;
    }
    const mine = t.role;
    const admin = TEAM_RANK[mine] >= TEAM_RANK.admin;
    const roles = TEAM_ROLES.filter(([r]) => TEAM_RANK[r] <= TEAM_RANK[mine]);
    m.setTitle(`Команда «${t.team.name}»`);
    const roleSelect = (value: TeamRole, onChange: (r: TeamRole) => void) => {
      const s = h('select', { class: 'm-select', 'aria-label': 'Роль' }, ...roles.map(([r, label]) => h('option', { value: r, selected: r === value }, label))) as HTMLSelectElement;
      s.addEventListener('change', () => onChange(s.value as TeamRole));
      return s;
    };
    const email = h('input', { class: 'm-input', type: 'text', placeholder: 'Почта или логин участника', 'aria-label': 'Почта или логин участника' }) as HTMLInputElement;
    let inviteRole: TeamRole = 'editor';
    const invite = () => {
      const to = email.value.trim().toLowerCase();
      if (!EMAIL.test(to) && !LOGIN.test(to)) return hooks.notify('Проверьте почту или логин', 'error');
      void after(account.api('POST', `/api/teams/${teamId}/members`, { email: to, role: inviteRole }).then((r) => hooks.notify((r as { invited?: boolean }).invited ? `Приглашение отправлено на ${to}` : `${to} — в команде`)));
    };
    email.addEventListener('keydown', (e) => e.key === 'Enter' && invite());
    const name = h('input', { class: 'm-input', value: t.team.name, 'aria-label': 'Название команды' }) as HTMLInputElement;
    name.addEventListener('change', () => name.value.trim() && void after(account.api('PATCH', `/api/teams/${teamId}`, { name: name.value.trim() })));
    const me = account.user?.id;
    fill(m.body,
      admin ? h('div', { class: 'm-row' }, name) : null,
      admin ? h('div', { class: 'm-row' }, email, roleSelect(inviteRole, (r) => (inviteRole = r)), h('button', { class: 'm-btn primary', onclick: invite }, 'Пригласить')) : null,
      admin ? h('p', { class: 'm-note' }, 'Участники видят все файлы проектов команды: «смотрит» — просмотр и комментарии, «редактирует» — правка и новые файлы, администратор — ещё участники и проекты.') : null,
      h('div', { class: 'm-label' }, `Участники (${t.members.length})`),
      h(
        'div',
        { class: 'm-list' },
        ...t.members.map((u) => {
          const self = u.id === me;
          const manage = admin && !self && TEAM_RANK[u.role] <= TEAM_RANK[mine];
          return h(
            'div',
            { class: 'person' },
            avatar(u.name, u.color),
            h('div', { class: 'person-text' }, h('div', { class: 'person-name' }, `${u.name}${self ? ' (вы)' : ''}`), h('div', { class: 'person-sub' }, whoIs(u.email))),
            manage ? roleSelect(u.role, (r) => void after(account.api('PATCH', `/api/teams/${teamId}/members/${u.id}`, { role: r }))) : h('span', { class: 'person-role' }, TEAM_ROLES.find(([r]) => r === u.role)?.[1] ?? u.role),
            manage ? iconBtn('close', 'Убрать из команды', () => confirm(`Убрать ${u.name} из команды?`) && void after(account.api('DELETE', `/api/teams/${teamId}/members/${u.id}`))) : null,
          );
        }),
        ...t.invites.map((i) =>
          h(
            'div',
            { class: 'person' },
            avatar(i.email, '', 'avatar invite'),
            h('div', { class: 'person-text' }, h('div', { class: 'person-name' }, i.email), h('div', { class: 'person-sub' }, 'приглашение — войдёт с этой почтой и окажется в команде')),
            h('span', { class: 'person-role' }, TEAM_ROLES.find(([r]) => r === i.role)?.[1] ?? i.role),
            admin ? iconBtn('close', 'Отменить приглашение', () => void after(account.api('DELETE', `/api/teams/${teamId}/invites/${i.id}`))) : null,
          ),
        ),
      ),
      h('hr', { class: 'm-sep' }),
      h(
        'div',
        { class: 'm-row end' },
        h(
          'button',
          {
            class: 'm-btn',
            onclick: async () => {
              if (!me || !confirm(`Покинуть команду «${t.team.name}»? Файлы команды станут недоступны.`)) return;
              try {
                await account.api('DELETE', `/api/teams/${teamId}/members/${me}`);
                await account.refresh();
                hooks.changed();
                m.close();
              } catch (e) {
                fail(e);
              }
            },
          },
          'Покинуть команду',
        ),
        mine === 'owner'
          ? h(
              'button',
              {
                class: 'm-btn danger',
                onclick: async () => {
                  if (prompt(`Удалить команду со всеми проектами? Файлы останутся у владельцев черновиками.\nВведите название команды «${t.team.name}» для подтверждения:`)?.trim() !== t.team.name) return;
                  try {
                    await account.api('DELETE', `/api/teams/${teamId}`);
                    await account.refresh();
                    hooks.changed();
                    m.close();
                  } catch (e) {
                    fail(e);
                  }
                },
              },
              'Удалить команду',
            )
          : null,
      ),
    );
  };
  void render();
}

/**
 * Where to put the file on the server: drafts (visible only to you and anyone you share with) or a
 * team project where you are an editor. Returns the project id, null — drafts, undefined — cancel.
 */
export function chooseDestination(account: Account, title: string, current?: string | null): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let result: string | null | undefined;
    const m = modal(title, { onClose: () => resolve(result) });
    const pick = (id: string | null) => {
      result = id;
      m.close();
    };
    const writable = account.teams.filter((t) => TEAM_RANK[t.role] >= TEAM_RANK.editor);
    const dest = (label: string, id: string | null, indent: boolean, sub = '') =>
      h(
        'button',
        { class: `m-dest${indent ? ' indent' : ''}${current === id ? ' on' : ''}`, onclick: () => pick(id) },
        h('span', { class: 'home-ic', innerHTML: id ? ICON.folder : ICON.page }),
        h('span', {}, label),
        sub ? h('span', { class: 'sub' }, sub) : null,
      );
    fill(m.body,
      h(
        'div',
        { class: 'm-list' },
        dest('Черновики', null, false, 'видны вам и тем, кому откроете'),
        ...writable.flatMap((t) => [
          h('div', { class: 'm-label' }, t.name),
          ...account.projects.filter((p) => p.teamId === t.id).map((p) => dest(p.name, p.id, true)),
        ]),
      ),
      writable.length ? null : h('p', { class: 'm-note' }, 'Команд, где вы можете создавать файлы, нет — создайте команду в «Файлах».'),
    );
  });
}
