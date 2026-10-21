// Assistant window (AI with your own key): conversation, one-click skills (rename layers,
// fill with data, assemble a screen from components, check the design), provider settings.
// The key is stored only in this browser and goes directly to the provider.

import type { Editor } from '../editor.ts';
import { h } from '../dom.ts';
import { Agent } from './agent.ts';
import { DEFAULT_MODELS, loadConfig, saveConfig, type AiConfig, type Block } from './providers.ts';
import { isLocalUrl, network } from '../network.ts';

/** Without internet the assistant can only use a model on this computer (Ollama, LM Studio). */
function offlineNote(): HTMLElement | null {
  const base = loadConfig().baseUrl;
  if (network.allowed || (base && isLocalUrl(base))) return null;
  return h('p', { class: 'ai-note' }, (network.locked ? 'Нужен интернет: он запрещён в вашей организации (закрытая сеть).' : 'Нужен интернет: он выключен в Настройках («Доступ в интернет»).') + ' Без него ассистент работает с моделью на этом компьютере — Ollama или LM Studio (адрес http://localhost:…).');
}

const SKILLS: [string, string][] = [
  ['Переименовать слои', 'Переименуй выделенные слои и их детей осмысленными именами по-русски — по содержимому и роли (Кнопка, Заголовок, Карточка товара, Иконка…). Ничего, кроме имён, не меняй.'],
  ['Заполнить данными', 'Заполни тексты выделенного экрана правдоподобными данными на русском: имена, цены, даты, описания — по смыслу каждого поля, примерно той же длины.'],
  ['Экран из компонентов', 'Собери справа от выделенного новый экран из компонентов этого файла: '],
  ['Проверить макет', 'Проверь выделенный экран: контраст текста, отступы и выравнивание, размеры шрифтов, единообразие. Перечисли проблемы и как их исправить; сам ничего не меняй.'],
];

const TOOL_LABEL: Record<string, string> = {
  get_selection: 'смотрю выделение',
  get_tree: 'смотрю слои',
  get_node: 'смотрю свойства',
  set_properties: 'меняю свойства',
  rename: 'переименовываю',
  set_text: 'меняю тексты',
  create_tree: 'создаю слои',
  delete_nodes: 'удаляю слои',
  select: 'выделяю',
  list_components: 'смотрю компоненты',
  get_variables: 'смотрю переменные',
  screenshot: 'смотрю, как вышло',
};

export class AiPanel {
  private ed: Editor;
  private el: HTMLElement;
  private body: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  readonly agent: Agent;
  private settings = false;
  open = false;

  constructor(ed: Editor, host: HTMLElement) {
    this.ed = ed;
    this.agent = new Agent(ed);
    this.agent.onUpdate = () => this.render();
    this.body = h('div', { class: 'ai-body' });
    this.input = h('textarea', { class: 'ai-input', rows: '2', placeholder: 'Что сделать? Enter — отправить, Shift+Enter — новая строка' }) as HTMLTextAreaElement;
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') this.close();
    });
    this.sendBtn = h('button', { class: 'ai-send', onclick: () => (this.agent.running ? this.agent.stop() : this.submit()) }, 'Отправить') as HTMLButtonElement;
    const head = h(
      'div',
      { class: 'ai-head' },
      h('span', { class: 'ai-title' }, 'Ассистент'),
      h('button', { title: 'Новый разговор', onclick: () => this.agent.reset() }, '＋'),
      h('button', { title: 'Настройки: провайдер, ключ, модель', onclick: () => ((this.settings = !this.settings), this.render()) }, '⚙'),
      h('button', { title: 'Закрыть', onclick: () => this.close() }, '×'),
    );
    this.el = h('div', { class: 'ai-win', hidden: true }, head, this.body, h('div', { class: 'ai-foot' }, this.input, this.sendBtn));
    host.append(this.el);
  }

  /** The window was opened or closed (button highlight). */
  onToggle: (open: boolean) => void = () => {};

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    this.open = true;
    this.el.hidden = false;
    this.onToggle(true);
    if (!loadConfig().apiKey && !loadConfig().baseUrl) this.settings = true;
    this.render();
    this.input.focus();
  }

  close() {
    this.open = false;
    this.el.hidden = true;
    this.onToggle(false);
  }

  /** Open straight to the settings (provider, key, model). */
  showSettings() {
    this.settings = true;
    this.show();
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text) return;
    if (!loadConfig().apiKey && !loadConfig().baseUrl) {
      this.settings = true;
      this.render();
      return;
    }
    this.input.value = '';
    void this.agent.send(text);
  }

  private settingsForm(): HTMLElement {
    const c = loadConfig();
    const provider = h(
      'select',
      {},
      h('option', { value: 'anthropic', selected: c.provider === 'anthropic' }, 'Anthropic (Claude)'),
      h('option', { value: 'openai', selected: c.provider === 'openai' }, 'OpenAI-совместимый (OpenAI, Ollama, LM Studio)'),
    ) as HTMLSelectElement;
    const key = h('input', { type: 'password', value: c.apiKey, placeholder: 'Ключ API', autocomplete: 'off' }) as HTMLInputElement;
    const list = h('datalist', { id: 'ai-models' });
    const fillModels = () => list.replaceChildren(...DEFAULT_MODELS[provider.value as AiConfig['provider']].map((m) => h('option', { value: m })));
    fillModels();
    const model = h('input', { value: c.model, list: 'ai-models', placeholder: 'Модель' }) as HTMLInputElement;
    const base = h('input', { value: c.baseUrl ?? '', placeholder: 'Адрес API (пусто — по умолчанию)' }) as HTMLInputElement;
    provider.addEventListener('change', () => {
      fillModels();
      model.value = DEFAULT_MODELS[provider.value as AiConfig['provider']][0]!;
      if (provider.value === 'openai' && !base.value) base.placeholder = 'https://api.openai.com/v1 или http://localhost:11434/v1';
    });
    for (const i of [key, model, base]) i.addEventListener('keydown', (e) => e.stopPropagation());
    const save = h(
      'button',
      {
        class: 'ai-save',
        onclick: () => {
          saveConfig({ provider: provider.value as AiConfig['provider'], apiKey: key.value.trim(), model: model.value.trim() || DEFAULT_MODELS[provider.value as AiConfig['provider']][0]!, baseUrl: base.value.trim() });
          this.settings = false;
          this.render();
          this.input.focus();
        },
      },
      'Сохранить',
    );
    return h(
      'div',
      { class: 'ai-settings' },
      h('label', {}, 'Провайдер', provider),
      h('label', {}, 'Ключ', key),
      h('label', {}, 'Модель', model, list),
      h('label', {}, 'Адрес', base),
      h('p', { class: 'ai-note' }, 'Ключ хранится только в этом браузере и уходит напрямую провайдеру — не на сервер MFP. Локальной модели (Ollama) ключ не нужен.'),
      offlineNote(),
      save,
    );
  }

  private block(b: Block): HTMLElement | null {
    if (b.type === 'text') return b.text.trim() ? h('div', { class: 'ai-text' }, b.text) : null;
    if (b.type === 'tool_use') {
      const n = Array.isArray((b.input as { changes?: unknown[] }).changes) ? ` (${(b.input as { changes: unknown[] }).changes.length})` : '';
      return h('div', { class: 'ai-tool', title: JSON.stringify(b.input).slice(0, 400) }, `• ${TOOL_LABEL[b.name] ?? b.name}${n}`);
    }
    if (b.type === 'tool_result' && b.is_error) return h('div', { class: 'ai-tool err' }, `  ${b.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ').slice(0, 200)}`);
    return null;
  }

  render() {
    if (!this.open) return;
    const a = this.agent;
    this.sendBtn.textContent = a.running ? 'Остановить' : 'Отправить';
    this.sendBtn.classList.toggle('stop', a.running);
    if (this.settings) {
      this.body.replaceChildren(this.settingsForm());
      return;
    }
    const items: HTMLElement[] = [];
    const note = offlineNote();
    if (note) items.push(note);
    if (!a.messages.length) {
      items.push(
        h('div', { class: 'ai-hello' }, 'Опишите, что сделать с макетом, или выберите навык. Ассистент видит слои файла и меняет их — всё за один шаг отмены (Ctrl+Z).'),
        h(
          'div',
          { class: 'ai-skills' },
          ...SKILLS.map(([label, prompt]) =>
            h(
              'button',
              {
                onclick: () => {
                  this.input.value = prompt;
                  this.input.focus();
                  this.input.setSelectionRange(prompt.length, prompt.length);
                },
              },
              label,
            ),
          ),
        ),
      );
    }
    for (const m of a.messages) {
      const blocks = m.content.map((b) => this.block(b)).filter((x): x is HTMLElement => !!x);
      if (!blocks.length) continue;
      const isUser = m.role === 'user' && m.content.some((b) => b.type === 'text');
      items.push(h('div', { class: `ai-msg ${isUser ? 'user' : 'bot'}` }, ...blocks));
    }
    if (a.running) items.push(h('div', { class: 'ai-wait' }, 'Думаю…'));
    if (a.error) items.push(h('div', { class: 'ai-error' }, a.error));
    this.body.replaceChildren(...items);
    this.body.scrollTop = this.body.scrollHeight;
  }
}
