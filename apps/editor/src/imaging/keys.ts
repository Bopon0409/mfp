// “Image enhancements” connections: Google AI (Nano Banana) and Magnific/Freepik keys.
// Stored only in this browser, like the assistant key; they reach the MFP server only to be forwarded to Magnific.

import { h, modal } from '../dom.ts';
import { listImageModels } from './gemini.ts';
import { checkMagnific, type MagnificHost, type ServerLink } from './magnific.ts';

export interface ImagingSettings {
  geminiKey: string;
  geminiModel: string;
  magnificKey: string;
  magnificHost: MagnificHost;
}

const STORE = 'mfp-imaging';
export const DEFAULT_GEMINI_MODEL = 'gemini-nano-banana-2.1';

export function loadSettings(): ImagingSettings {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<ImagingSettings> | null;
    return {
      geminiKey: v?.geminiKey ?? '',
      geminiModel: v?.geminiModel || DEFAULT_GEMINI_MODEL,
      magnificKey: v?.magnificKey ?? '',
      magnificHost: v?.magnificHost === 'freepik' ? 'freepik' : 'magnific',
    };
  } catch {
    return { geminiKey: '', geminiModel: DEFAULT_GEMINI_MODEL, magnificKey: '', magnificHost: 'magnific' };
  }
}

export function saveSettings(s: ImagingSettings) {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    // No storage: keys last until reload.
  }
}

/** Keys dialog; onSave runs after saving (re-render the model picker). */
export function openSettings(server: ServerLink, onSave: (s: ImagingSettings) => void) {
  const s = loadSettings();
  const m = modal('Подключения', { cls: 'img-settings' });

  const gemKey = h('input', { type: 'password', value: s.geminiKey, placeholder: 'Ключ Google AI Studio', autocomplete: 'off', class: 'img-input' }) as HTMLInputElement;
  const gemModel = h('select', { class: 'img-input' }) as HTMLSelectElement;
  const fillModels = (ids: string[]) => {
    const all = [...new Set([s.geminiModel, ...ids])];
    gemModel.replaceChildren(...all.map((id) => h('option', { value: id, selected: id === s.geminiModel }, id)));
  };
  fillModels([]);
  const gemStatus = h('div', { class: 'img-note' }, 'Nano Banana — модели Gemini с выводом картинок.');
  const gemCheck = h('button', {
    class: 'img-btn',
    onclick: async () => {
      gemStatus.textContent = 'Проверяю…';
      gemStatus.className = 'img-note';
      try {
        const ids = await listImageModels(gemKey.value.trim());
        fillModels(ids);
        gemStatus.textContent = ids.length ? `Ключ работает, моделей с картинками: ${ids.length}` : 'Ключ работает, но моделей с картинками нет';
        gemStatus.classList.add('ok');
      } catch (e) {
        gemStatus.textContent = (e as Error).message;
        gemStatus.classList.add('error');
      }
    },
  }, 'Проверить');

  const magKey = h('input', { type: 'password', value: s.magnificKey, placeholder: 'Ключ Magnific или Freepik API', autocomplete: 'off', class: 'img-input' }) as HTMLInputElement;
  const magHost = h(
    'select',
    { class: 'img-input' },
    h('option', { value: 'magnific', selected: s.magnificHost === 'magnific' }, 'Magnific (api.magnific.com)'),
    h('option', { value: 'freepik', selected: s.magnificHost === 'freepik' }, 'Freepik (api.freepik.com)'),
  ) as HTMLSelectElement;
  const magStatus = h('div', { class: 'img-note' }, 'Запросы идут через сервер MFP: браузеру напрямую Magnific недоступен. Ключ сервер не хранит.');
  const magCheck = h('button', {
    class: 'img-btn',
    onclick: async () => {
      magStatus.textContent = 'Проверяю…';
      magStatus.className = 'img-note';
      try {
        await checkMagnific({ key: magKey.value.trim(), host: magHost.value as MagnificHost, server });
        magStatus.textContent = 'Ключ работает';
        magStatus.classList.add('ok');
      } catch (e) {
        magStatus.textContent = (e as Error).message;
        magStatus.classList.add('error');
      }
    },
  }, 'Проверить');

  const save = h('button', {
    class: 'img-btn primary',
    onclick: () => {
      const next: ImagingSettings = {
        geminiKey: gemKey.value.trim(),
        geminiModel: gemModel.value || DEFAULT_GEMINI_MODEL,
        magnificKey: magKey.value.trim(),
        magnificHost: magHost.value as MagnificHost,
      };
      saveSettings(next);
      onSave(next);
      m.close();
    },
  }, 'Сохранить');

  m.body.append(
    h('div', { class: 'img-form' },
      h('div', { class: 'img-form-title' }, 'Nano Banana (Google AI)'),
      h('label', { class: 'img-row' }, h('span', {}, 'Ключ'), gemKey, gemCheck),
      h('label', { class: 'img-row' }, h('span', {}, 'Модель'), gemModel),
      gemStatus,
      h('div', { class: 'img-form-title' }, 'Magnific'),
      h('label', { class: 'img-row' }, h('span', {}, 'Ключ'), magKey, magCheck),
      h('label', { class: 'img-row' }, h('span', {}, 'Сервис'), magHost),
      magStatus,
      h('div', { class: 'img-note' }, 'Ключи хранятся только в этом браузере. Оплата — по тарифам Google и Magnific на вашем аккаунте.'),
      h('div', { class: 'img-actions' }, save),
    ),
  );
  setTimeout(() => gemKey.focus(), 0);
}
