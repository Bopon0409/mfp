// “Connect an AI agent (MCP)”: the team's MCP server URL, an API token for the agent and ready-made
// settings for popular clients (Claude Code, Claude Desktop, Cursor, VS Code and others).
// The server is POST /mcp (Streamable HTTP, apps/server/src/public-api.ts): the agent sees the files
// you have access to, opens, views, edits and renders them; edits reach everyone immediately.

import type { Account } from './account.ts';
import { fill, h, modal } from './dom.ts';

type Notify = (message: string, kind?: 'info' | 'error') => void;

interface Client {
  id: string;
  name: string;
  /** Where to paste it. */
  where: string;
  snippet: (url: string, token: string) => string;
  /** Sign-in via OAuth: no token is needed, the app asks for permission itself. */
  oauth?: boolean;
}

const CLIENTS: Client[] = [
  {
    id: 'claude-ai',
    name: 'Claude.ai',
    where: 'Claude (сайт и приложения): Настройки → Коннекторы → «Добавить свой коннектор», вставьте адрес. Claude откроет MFP — войдите и нажмите «Разрешить».',
    snippet: (url) => url,
    oauth: true,
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    where: 'ChatGPT: Настройки → Приложения и коннекторы → Дополнительно → режим разработчика; затем «Создать», адрес сервера — ниже, аутентификация — OAuth. ChatGPT откроет MFP — войдите и нажмите «Разрешить».',
    snippet: (url) => url,
    oauth: true,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    where: 'Выполните в терминале:',
    snippet: (url, token) => `claude mcp add --transport http mfp ${url} --header "Authorization: Bearer ${token}"`,
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    where: 'Настройки → Разработчик → Изменить конфигурацию (claude_desktop_config.json), нужен Node.js:',
    snippet: (url, token) =>
      JSON.stringify({ mcpServers: { mfp: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${MFP_AUTH}'], env: { MFP_AUTH: `Bearer ${token}` } } } }, null, 2),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    where: 'Файл ~/.cursor/mcp.json (или .cursor/mcp.json в проекте):',
    snippet: (url, token) => JSON.stringify({ mcpServers: { mfp: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    where: 'Файл .vscode/mcp.json в проекте (агент Copilot):',
    snippet: (url, token) => JSON.stringify({ servers: { mfp: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
  },
  {
    id: 'other',
    name: 'Другие',
    where: 'Любой клиент MCP с транспортом Streamable HTTP и своими заголовками:',
    snippet: (url, token) => `Адрес: ${url}\nЗаголовок: Authorization: Bearer ${token}`,
  },
];

const PLACEHOLDER = '<токен>';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function openMcpDialog(account: Account, hooks: { notify: Notify; signIn: () => void }) {
  const m = modal('Подключить ИИ-агента (MCP)', { cls: 'wide mcp-dialog' });
  const url = `${account.base || location.origin}/mcp`;
  if (!account.signedIn) {
    fill(
      m.body,
      h('p', { class: 'm-note' }, 'ИИ-агенты (Claude, Cursor, Copilot и другие клиенты MCP) работают с файлами на сервере команды. Войдите — и здесь появятся адрес, токен и готовые настройки.'),
      h('div', { class: 'm-row end' }, h('button', { class: 'm-btn primary', onclick: () => (m.close(), hooks.signIn()) }, 'Войти')),
    );
    return;
  }
  let token: string | null = null;
  let client = CLIENTS[0]!;
  const render = () => {
    const shown = token ?? PLACEHOLDER;
    const code = client.snippet(url, shown);
    const needToken = !client.oauth;
    const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => hooks.notify(`${what} скопирован`), () => hooks.notify('Не удалось скопировать', 'error'));
    fill(
      m.body,
      h('p', { class: 'm-note' }, 'Агент получает ваши права: видит файлы, к которым у вас есть доступ, открывает их, смотрит дерево слоёв и картинку, правит, пишет код по макету и комментарии. Правки агента сразу видят все участники файла, их можно отменить.'),
      h('div', { class: 'm-label' }, 'Адрес MCP-сервера'),
      h('div', { class: 'm-row' }, h('div', { class: 'm-token mcp-url' }, url), h('button', { class: 'm-btn', onclick: () => copy(url, 'Адрес') }, 'Копировать')),
      ...(needToken ? [h('div', { class: 'm-label' }, '1. Токен для агента'),
      token
        ? h('div', { class: 'm-list' }, h('div', { class: 'm-note' }, 'Токен показан один раз — он уже подставлен в настройки ниже. Отозвать: учётная запись → Токены API.'), h('div', { class: 'm-token' }, token))
        : h(
            'div',
            { class: 'm-row' },
            h('div', { class: 'm-note', style: 'flex:1' }, 'Отдельный токен для агента — его можно отозвать, не трогая остальные.'),
            h(
              'button',
              {
                class: 'm-btn primary',
                onclick: async () => {
                  try {
                    token = (await account.api<{ token: string }>('POST', '/api/tokens', { name: 'ИИ-агент (MCP)' })).token;
                    render();
                  } catch (e) {
                    hooks.notify(message(e), 'error');
                  }
                },
              },
              'Создать токен',
            ),
          )] : []),
      h('div', { class: 'm-label' }, needToken ? '2. Настройки клиента' : 'Клиент'),
      h(
        'div',
        { class: 'mcp-tabs', role: 'tablist' },
        ...CLIENTS.map((c) => h('button', { class: c === client ? 'on' : '', role: 'tab', 'aria-selected': String(c === client), onclick: () => ((client = c), render()) }, c.name)),
      ),
      h('div', { class: 'm-note' }, client.where),
      h('pre', { class: 'mcp-code' }, code),
      h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', disabled: needToken && !token, title: needToken && !token ? 'Сначала создайте токен' : '', onclick: () => copy(code, needToken ? 'Текст настроек' : 'Адрес') }, 'Копировать')),
      h('p', { class: 'm-note' }, 'Claude.ai и ChatGPT входят через OAuth: откроется окно «Доступ к MFP», доступ можно отозвать в «Токенах API». Остальным клиентам нужен токен.'),
    );
  };
  render();
}
