// Team integrations: Slack (channel incoming webhook), Telegram (bot and chat), Jira (issue keys in
// comments and “create issue” from a thread), webhook (JSON with an HMAC signature). Add, enable
// and disable, test, view the delivery log.

import type { Account } from './account.ts';
import { fill, h, iconBtn, modal } from './dom.ts';
import { relativeTime } from './home.ts';

type Notify = (message: string, kind?: 'info' | 'error') => void;

interface Hook {
  id: string;
  kind: 'webhook' | 'slack' | 'telegram' | 'jira';
  events: string[];
  config: Record<string, string>;
  description: string | null;
  active: boolean;
  created: number;
}

const EVENTS: [string, string][] = [
  ['FILE_COMMENT', 'комментарии'],
  ['FILE_UPDATE', 'правки файлов'],
  ['LIBRARY_PUBLISH', 'публикация библиотек'],
  ['BRANCH_MERGED', 'слияние веток'],
  ['FILE_DELETE', 'удаление файлов'],
];
const KIND: Record<Hook['kind'], string> = { slack: 'Slack', telegram: 'Telegram', jira: 'Jira', webhook: 'Вебхук' };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Form fields per integration type: configuration key, label, hint. */
const FIELDS: Record<Hook['kind'], [string, string, string][]> = {
  slack: [['url', 'Адрес входящего вебхука', 'https://hooks.slack.com/services/…']],
  telegram: [
    ['token', 'Токен бота', 'от @BotFather'],
    ['chatId', 'Чат', 'id чата или канала, например -100…'],
  ],
  jira: [
    ['baseUrl', 'Адрес Jira', 'https://компания.atlassian.net'],
    ['email', 'Почта учётной записи', 'бот@компания.рф'],
    ['apiToken', 'API-токен', 'id.atlassian.com → Security → API tokens'],
    ['projectKey', 'Проект для новых задач', 'ключ, например DES'],
  ],
  webhook: [
    ['endpoint', 'Адрес', 'https://…'],
    ['passcode', 'Секрет подписи (необязательно)', 'пусто — сгенерировать'],
  ],
};

export function integrationsDialog(account: Account, teamId: string, teamName: string, notify: Notify) {
  const m = modal(`Интеграции «${teamName}»`, { cls: 'wide' });
  let adding: Hook['kind'] | null = null;
  let log: string | null = null;
  const render = async () => {
    let hooks: Hook[] = [];
    try {
      hooks = (await account.api<{ hooks: Hook[] }>('GET', `/api/hooks?teamId=${teamId}`)).hooks;
    } catch (e) {
      notify(message(e), 'error');
      m.close();
      return;
    }
    const row = (hk: Hook) => {
      const target = hk.config.url ?? hk.config.endpoint ?? hk.config.baseUrl ?? (hk.config.chatId ? `чат ${hk.config.chatId}` : '');
      const toggle = h('button', { class: `toggle${hk.active ? ' on' : ''}`, title: hk.active ? 'Включена — выключить' : 'Выключена — включить', 'aria-pressed': String(hk.active) }) as HTMLButtonElement;
      toggle.addEventListener('click', () => void account.api('PATCH', `/api/hooks/${hk.id}`, { active: !hk.active }).then(render, (e) => notify(message(e), 'error')));
      return h(
        'div',
        { class: 'hook-row' },
        h(
          'div',
          { class: 'person' },
          h('span', { class: `hook-kind ${hk.kind}` }, KIND[hk.kind]),
          h('div', { class: 'person-text' }, h('div', { class: 'person-name' }, target), h('div', { class: 'person-sub' }, hk.events.map((e) => EVENTS.find(([k]) => k === e)?.[1] ?? e).join(', '))),
          toggle,
          h('button', {
            class: 'm-btn',
            onclick: async () => {
              try {
                const r = await account.api<{ requests: { status: string; error: string | null; responseStatus: number | null }[] }>('POST', `/api/hooks/${hk.id}/test`);
                const x = r.requests[0];
                if (x?.status === 'ok') notify(`${KIND[hk.kind]}: проверка дошла (${x.responseStatus})`);
                else notify(`${KIND[hk.kind]}: проверка не дошла — ${x?.error ?? 'нет ответа'}${x?.status === 'pending' ? ' (будет повтор)' : ''}`, 'error');
              } catch (e) {
                notify(message(e), 'error');
              }
              log = hk.id;
              void render();
            },
          }, 'Проверить'),
          iconBtn('history', 'Журнал доставки', () => ((log = log === hk.id ? null : hk.id), void render())),
          iconBtn('trash', 'Удалить', () => confirm(`Удалить интеграцию ${KIND[hk.kind]}?`) && void account.api('DELETE', `/api/hooks/${hk.id}`).then(render, (e) => notify(message(e), 'error'))),
        ),
        log === hk.id ? h('div', { class: 'hook-log' }, h('div', { class: 'm-note' }, 'Загрузка…')) : null,
      );
    };
    fill(
      m.body,
      h('p', { class: 'm-note' }, 'События файлов команды уходят в чаты и трекер. В Jira ключ задачи в комментарии (ABC-12) — комментарий и ссылка в задаче; из треда можно создать задачу.'),
      hooks.length ? h('div', { class: 'm-list' }, ...hooks.map(row)) : h('p', { class: 'm-note' }, 'Интеграций нет.'),
      adding ? form(adding) : h('div', { class: 'm-row' }, ...(['slack', 'telegram', 'jira', 'webhook'] as const).map((k) => h('button', { class: 'm-btn', onclick: () => ((adding = k), void render()) }, `+ ${KIND[k]}`))),
    );
    // The log comes after rendering (its own request).
    if (log) {
      const box = m.body.querySelector('.hook-log');
      try {
        const r = await account.api<{ requests: { event: string; status: string; attempts: number; responseStatus: number | null; error: string | null; created: number }[] }>('GET', `/api/hooks/${log}/requests`);
        if (box)
          fill(
            box as HTMLElement,
            ...(r.requests.length
              ? r.requests.slice(0, 20).map((x) => h('div', { class: `hook-req ${x.status}` }, h('span', {}, x.event), h('span', {}, x.status === 'ok' ? `доставлено (${x.responseStatus})` : x.status === 'failed' ? `не доставлено: ${x.error}` : `повтор: ${x.error ?? ''}`), h('span', { class: 'dv-dim' }, `${relativeTime(x.created)}${x.attempts > 1 ? ` · попыток ${x.attempts}` : ''}`)))
              : [h('div', { class: 'm-note' }, 'Запросов ещё не было.')]),
          );
      } catch (e) {
        if (box) fill(box as HTMLElement, h('div', { class: 'm-error' }, message(e)));
      }
    }
  };

  const form = (kind: Hook['kind']) => {
    const inputs = FIELDS[kind].map(([key, label, hint]) => [key, h('input', { class: 'm-input', placeholder: hint, 'aria-label': label, spellcheck: false }) as HTMLInputElement, label] as const);
    const checks = EVENTS.map(([k, label]) => {
      const box = h('input', { type: 'checkbox', checked: k === 'FILE_COMMENT' || (kind !== 'jira' && k === 'LIBRARY_PUBLISH') }) as HTMLInputElement;
      return [k, box, h('label', { class: 'merge-choice' }, box, label)] as const;
    });
    const save = async () => {
      const config = Object.fromEntries(inputs.map(([k, el]) => [k, el.value.trim()]).filter(([, v]) => v));
      const events = checks.filter(([, el]) => el.checked).map(([k]) => k);
      try {
        const r = await account.api<{ passcode?: string }>('POST', '/api/hooks', { kind, teamId, events, config });
        if (r.passcode && !config.passcode) prompt('Секрет подписи вебхука (заголовок X-MFP-Signature: sha256=HMAC тела). Сохраните — больше он не покажется:', r.passcode);
        adding = null;
        notify(`${KIND[kind]}: подключено — нажмите «Проверить»`);
        void render();
      } catch (e) {
        notify(message(e), 'error');
      }
    };
    return h(
      'div',
      { class: 'hook-form' },
      h('div', { class: 'm-label' }, `Новая интеграция: ${KIND[kind]}`),
      ...inputs.map(([, el, label]) => h('label', { class: 'hook-field' }, h('span', {}, label), el)),
      kind === 'jira' ? null : h('div', { class: 'merge-choices' }, ...checks.map(([, , el]) => el)),
      h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => ((adding = null), void render()) }, 'Отмена'), h('button', { class: 'm-btn primary', onclick: () => void save() }, 'Подключить')),
    );
  };
  void render();
}
