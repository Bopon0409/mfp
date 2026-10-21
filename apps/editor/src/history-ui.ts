// Version history: a panel on the right. “Current version”, then versions grouped by
// day; click to view a version on the canvas (edits there are not saved); per version: rename,
// restore, copy to a new file. “+” (Ctrl+Alt+S) saves a named version.

import type { Document } from '@mfp/core';
import { h, iconBtn, popover, textInput } from './dom.ts';
import { relativeTime } from './home.ts';
import { showMenuAt, type MenuEntry } from './menu.ts';
import type { VersionMeta, Versions } from './versions.ts';

export interface HistoryHooks {
  /** Open file (null: no library). */
  fileId(): string | null;
  /** Show a version on the canvas (null: back to the current one). */
  preview(doc: Document | null, label: string): Promise<void>;
  /** Restore a version: it becomes the current one. */
  restore(doc: Document, label: string): Promise<void>;
  /** Copy of a version as a new file. */
  copyToNew(doc: Document, name: string): Promise<void>;
  /** Compare a version with the current state (selected frame). */
  compare?(versionId: string): void;
  notify(message: string, kind?: 'info' | 'error'): void;
}

const fmtTime = (t: number) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayLabel = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};
export const versionLabel = (v: VersionMeta) => v.name || `Версия от ${new Date(v.created).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;

export class HistoryPanel {
  private versions: Versions;
  private hooks: HistoryHooks;
  private root: HTMLElement;
  /** Version being viewed (null: the current one). */
  private active: string | null = null;

  constructor(versions: Versions, hooks: HistoryHooks, host: HTMLElement) {
    this.versions = versions;
    this.hooks = hooks;
    this.root = h('div', { id: 'history', class: 'history', hidden: true, role: 'region', 'aria-label': 'История версий' });
    host.append(this.root);
    versions.onChange.push(() => {
      if (!this.root.hidden) void this.render();
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  async toggle() {
    if (this.root.hidden) this.open();
    else await this.close();
  }

  open() {
    this.root.hidden = false;
    void this.render();
  }

  async close() {
    if (this.active) await this.back();
    this.root.hidden = true;
  }

  /** Return to the current version (from viewing). */
  async back() {
    if (!this.active) return;
    this.active = null;
    await this.hooks.preview(null, '');
    void this.render();
  }

  /** Dialog with the version name and description (instead of the native prompt). */
  private versionDialog(anchor: HTMLElement, title: string, name0: string, desc0: string, submit: (name: string, desc: string) => void) {
    const { box, close } = popover(anchor, 'version-pop', { width: 280, side: 'left' });
    const name = textInput(name0, () => {}, { placeholder: 'Название, например «Перед ревью»' }) as HTMLInputElement;
    const desc = textInput(desc0, () => {}, { placeholder: 'Что изменилось (необязательно)', multiline: true }) as HTMLTextAreaElement;
    const save = () => {
      const n = name.value.trim();
      if (!n) return name.focus();
      close();
      submit(n, desc.value.trim());
    };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    box.append(
      h('div', { class: 'pop-head' }, title),
      h('div', { class: 'field wide' }, name),
      h('div', { class: 'field wide textarea' }, desc),
      h('div', { class: 'pop-actions' }, h('button', { class: 'home-btn', onclick: close }, 'Отмена'), h('button', { class: 'home-btn primary', onclick: save }, 'Сохранить')),
    );
    requestAnimationFrame(() => {
      name.focus();
      name.select();
    });
  }

  /** “Save version” dialog: name and description. */
  saveDialog(anchor: HTMLElement) {
    const { box, close } = popover(anchor, 'version-pop', { width: 280, side: 'left' });
    const name = textInput('', () => {}, { placeholder: 'Название, например «Перед ревью»' }) as HTMLInputElement;
    const desc = textInput('', () => {}, { placeholder: 'Что изменилось (необязательно)', multiline: true }) as HTMLTextAreaElement;
    const save = async () => {
      const n = name.value.trim();
      if (!n) {
        name.focus();
        return;
      }
      close();
      const v = await this.versions.snapshot('named', n, desc.value.trim() || undefined);
      this.hooks.notify(v ? `Версия «${n}» сохранена` : 'Версию не сохранить: файл ещё не в библиотеке');
    };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && void save());
    box.append(
      h('div', { class: 'pop-head' }, 'Сохранить версию'),
      h('div', { class: 'field wide' }, name),
      h('div', { class: 'field wide textarea' }, desc),
      h('div', { class: 'pop-actions' }, h('button', { class: 'home-btn', onclick: close }, 'Отмена'), h('button', { class: 'home-btn primary', onclick: () => void save() }, 'Сохранить')),
    );
    requestAnimationFrame(() => name.focus());
  }

  private async render() {
    const file = this.hooks.fileId();
    const list = file ? (await this.versions.list(file)).slice().reverse() : [];
    const head = h(
      'div',
      { class: 'history-head' },
      h('span', { class: 'history-title' }, 'История версий'),
      iconBtn('plus', 'Сохранить версию (Ctrl+Alt+S)', (e) => this.saveDialog(e.currentTarget as HTMLElement)),
      iconBtn('close', 'Закрыть', () => void this.close()),
    );
    const items: HTMLElement[] = [];
    const current = h(
      'button',
      { class: `history-item current${this.active ? '' : ' on'}`, onclick: () => void this.back() },
      h('span', { class: 'history-name' }, 'Текущая версия'),
      h('span', { class: 'history-sub' }, this.active ? 'вернуться к текущей' : 'правки сохраняются сами'),
    );
    items.push(current);
    let day = '';
    for (const v of list) {
      const d = dayLabel(v.created);
      if (d !== day) {
        day = d;
        items.push(h('div', { class: 'history-day' }, d));
      }
      const item = h(
        'div',
        { class: `history-item${this.active === v.id ? ' on' : ''}${v.kind === 'named' ? ' named' : ''}`, tabIndex: 0, role: 'button' },
        h('span', { class: 'history-name', translate: v.kind !== 'named' }, v.kind === 'named' ? v.name! : 'Автосохранение'),
        v.description ? h('span', { class: 'history-desc' }, v.description) : null,
        h('span', { class: 'history-sub' }, `${fmtTime(v.created)}${v.author ? ` · ${v.author}` : ''}`),
      );
      const more = iconBtn('more', 'Действия с версией', (e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        showMenuAt(r.left, r.bottom, this.menu(file!, v, more));
      }, 'icon-btn sm history-more');
      item.append(more);
      item.addEventListener('click', () => void this.show(file!, v));
      item.addEventListener('keydown', (e) => e.key === 'Enter' && void this.show(file!, v));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMenuAt(e.clientX, e.clientY, this.menu(file!, v, more));
      });
      items.push(item);
    }
    const note = h(
      'div',
      { class: 'history-note' },
      file
        ? list.length
          ? 'Автосохранение — каждые 10 минут правок и при смене файла. Хранятся последние 30 сеансов и все версии с названием.'
          : 'Версий пока нет. Первая появится через 10 минут правок, при смене файла или по «+».'
        : 'История версий есть у файлов из «Файлов» (хранилище браузера недоступно).',
    );
    this.root.replaceChildren(head, h('div', { class: 'history-list' }, ...items), note);
  }

  private async load(file: string, v: VersionMeta): Promise<Document | null> {
    try {
      return await this.versions.load(file, v.id);
    } catch (e) {
      this.hooks.notify(`Версию не открыть: ${(e as Error).message}`, 'error');
      return null;
    }
  }

  private async show(file: string, v: VersionMeta) {
    const doc = await this.load(file, v);
    if (!doc) return;
    this.active = v.id;
    await this.hooks.preview(doc, versionLabel(v));
    void this.render();
  }

  private menu(file: string, v: VersionMeta, anchor: HTMLElement): MenuEntry[] {
    return [
      { label: 'Посмотреть', run: () => void this.show(file, v) },
      ...(this.hooks.compare ? [{ label: 'Сравнить с текущей…', run: () => this.hooks.compare!(v.id) }] : []),
      {
        label: v.kind === 'named' ? 'Изменить сведения о версии…' : 'Назвать версию…',
        run: () => this.versionDialog(anchor, v.kind === 'named' ? 'Сведения о версии' : 'Назвать версию', v.name ?? '', v.description ?? '', (name, desc) => void this.versions.rename(file, v.id, name, desc || undefined)),
      },
      ...(v.kind === 'named' ? [{ label: 'Удалить сведения о версии', run: () => void this.versions.rename(file, v.id, '') }] : []),
      'sep',
      {
        label: 'Восстановить эту версию',
        run: async () => {
          const doc = await this.load(file, v);
          if (!doc) return;
          this.active = null;
          await this.hooks.restore(doc, versionLabel(v));
          void this.render();
        },
      },
      {
        label: 'Копия в новый файл',
        run: async () => {
          const doc = await this.load(file, v);
          if (doc) await this.hooks.copyToNew(doc, versionLabel(v));
        },
      },
    ];
  }
}
