// “Allow access” for MCP clients via OAuth (page /oauth/authorize, server — oauth.ts): an app
// (Claude, ChatGPT…) requests access to MFP; the user signs in (if not yet), sees who is asking and
// where they will be returned, and allows or denies. Then — back to the app.

import { whoIs, type Account } from './account.ts';
import { signIn } from './account-ui.ts';
import { fill, h, modal } from './dom.ts';

const PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const;

/** Is this the OAuth consent page? */
export const isOAuthPage = () => /\/oauth\/authorize\/?$/.test(location.pathname);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function openOAuthConsent(account: Account) {
  const q = new URLSearchParams(location.search);
  const params = Object.fromEntries(PARAMS.map((k) => [k, q.get(k) ?? undefined]));
  const m = modal('Доступ к MFP', { cls: 'oauth-dialog' });
  const status = (text: string) => fill(m.body, h('p', { class: 'm-note' }, text));
  if (!params.client_id || !params.redirect_uri) return status('В ссылке нет данных приложения — откройте подключение заново из приложения ИИ.');
  await account.whenReady();
  if (!account.signedIn) {
    // After sign-in (by any method) — straight to consent.
    const onSign = () => {
      if (!account.signedIn) return;
      account.onChange.splice(account.onChange.indexOf(onSign), 1);
      m.close();
      void openOAuthConsent(account);
    };
    account.onChange.push(onSign);
    fill(
      m.body,
      h('p', { class: 'm-note' }, 'Приложение ИИ просит доступ к MFP. Сначала войдите — затем вы увидите, кто просит доступ, и решите, разрешить ли.'),
      h(
        'div',
        { class: 'm-row end' },
        h('button', { class: 'm-btn primary', onclick: () => void signIn(account, 'Вход, чтобы подключить приложение ИИ') }, 'Войти'),
      ),
    );
    return;
  }
  let client: { name: string; host: string };
  try {
    client = await account.api<{ name: string; host: string }>('GET', `/api/oauth/client?client_id=${encodeURIComponent(params.client_id)}&redirect_uri=${encodeURIComponent(params.redirect_uri)}`);
  } catch (e) {
    return status(`Не удалось проверить приложение: ${message(e)}`);
  }
  const answer = async (deny: boolean) => {
    try {
      const r = await account.api<{ redirect: string }>('POST', '/api/oauth/approve', { ...params, deny });
      status(deny ? 'Отказано. Возвращаю в приложение…' : 'Доступ разрешён. Возвращаю в приложение…');
      location.href = r.redirect;
    } catch (e) {
      status(`Не удалось: ${message(e)}`);
    }
  };
  fill(
    m.body,
    h('p', { class: 'oauth-lead' }, h('b', {}, client.name), ' просит доступ к вашей учётной записи MFP', h('span', { class: 'm-note' }, ` (${whoIs(account.user!.email)})`), '.'),
    h(
      'ul',
      { class: 'oauth-list' },
      h('li', {}, 'видеть файлы, к которым у вас есть доступ, и комментарии;'),
      h('li', {}, 'открывать, смотреть и править их от вашего имени — правки сразу видят участники файла;'),
      h('li', {}, 'рендерить картинки и писать код по макетам.'),
    ),
    h('p', { class: 'm-note' }, `После разрешения вы вернётесь на ${client.host}. Отозвать доступ: учётная запись → Токены API → «ИИ: ${client.name}».`),
    h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => void answer(true) }, 'Отказать'), h('button', { class: 'm-btn primary', onclick: () => void answer(false) }, 'Разрешить')),
  );
}
