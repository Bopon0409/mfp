// Team libraries in the editor: a file on the server publishes its components,
// styles and variables (version + list of assets); in any file — add a team library
// (import its version, @mfp/core importLibrary), update to a new one, remove. Above the canvas —
// an “updates available” badge; for the author — where the library is used and how many instances.

import { importLibrary, libraryAssets, libraryChanges, libraryUsage, unlinkLibrary, type Document } from '@mfp/core';
import { openLibraryUpdate } from './library-update-ui.ts';
import { canEdit, type Account, type FileRole } from './account.ts';
import { fill, h, modal } from './dom.ts';
import type { Editor } from './editor.ts';
import { relativeTime } from './home.ts';
import { docFromLoro } from './loro-docs.ts';

export interface TeamLibrary {
  id: string;
  name: string;
  description: string | null;
  version: number;
  published: number;
  publishedBy: string | null;
  fileName: string;
  teamName: string | null;
  counts: { components: number; styles: number; variables: number };
}

/** Published library with assets. */
type Published = TeamLibrary & { assets: { key: string; name: string; type: string }[] };

export interface TeamLibrariesHooks {
  /** Open server file and the role in it (null — a file on this device). */
  file(): { id: string; role: FileRole; branch: boolean } | null;
  notify(message: string, kind?: 'info' | 'error'): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10;
  const b = n % 100;
  return `${n} ${a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many}`;
};
const what = (c: TeamLibrary['counts']) =>
  [c.components ? plural(c.components, 'компонент', 'компонента', 'компонентов') : '', c.styles ? plural(c.styles, 'стиль', 'стиля', 'стилей') : '', c.variables ? plural(c.variables, 'переменная', 'переменные', 'переменных') : '']
    .filter(Boolean)
    .join(', ') || 'пусто';

export class TeamLibraries {
  private account: Account;
  private ed: Editor;
  private hooks: TeamLibrariesHooks;
  private libs: TeamLibrary[] = [];
  private badge: HTMLButtonElement;
  /** The “Libraries” window is open — redraw after changes. */
  onChange: (() => void)[] = [];

  constructor(account: Account, ed: Editor, stage: HTMLElement, hooks: TeamLibrariesHooks) {
    this.account = account;
    this.ed = ed;
    this.hooks = hooks;
    this.badge = h('button', { class: 'lib-updates', hidden: true }) as HTMLButtonElement;
    stage.append(this.badge);
    account.onChange.push(() => void this.refresh());
    // Another document has its own added libraries: check versions.
    let doc = ed.doc;
    ed.onPage.push(() => {
      if (ed.doc === doc) return this.paint();
      doc = ed.doc;
      void this.refresh();
    });
    setInterval(() => document.visibilityState === 'visible' && void this.refresh(), 5 * 60_000);
  }

  /** Team libraries added to the document: id → name and version. */
  linked(): Record<string, { name: string; version: number }> {
    return this.ed.doc.get(this.ed.doc.root, 'teamLibraries') ?? {};
  }

  /** Libraries with a new version. */
  outdated(): TeamLibrary[] {
    const linked = this.linked();
    return this.libs.filter((l) => linked[l.id] && linked[l.id]!.version < l.version);
  }

  /** Another file opened or the list changed. */
  async refresh() {
    if (!this.account.signedIn) this.libs = [];
    else {
      try {
        this.libs = (await this.account.api<{ libraries: TeamLibrary[] }>('GET', '/api/libraries')).libraries;
      } catch {
        // Server unavailable — badge from the previous list.
      }
    }
    this.paint();
    for (const cb of [...this.onChange]) cb();
  }

  private paint() {
    const n = this.outdated().length;
    this.badge.hidden = !n;
    this.badge.textContent = n === 1 ? `Обновление библиотеки «${this.outdated()[0]!.name}»` : `Обновления библиотек: ${n}`;
    this.badge.onclick = () => this.reviewUpdates();
  }

  /** Updates window: what changed — versions, update all or one by one. */
  private reviewUpdates() {
    const m = modal('Обновления библиотек');
    const render = () => {
      const list = this.outdated();
      const linked = this.linked();
      if (!list.length) {
        m.close();
        return;
      }
      fill(
        m.body,
        h('p', { class: 'm-note' }, 'Авторы опубликовали новые версии. Обновление меняет компоненты, стили и переменные в этом файле — инстансы остаются связаны и получают изменения.'),
        h(
          'div',
          { class: 'm-list' },
          ...list.map((l) =>
            h(
              'div',
              { class: 'person' },
              h('span', { class: 'branch-ic', 'aria-hidden': 'true' }, '◆'),
              h('div', { class: 'person-text' }, h('div', { class: 'person-name' }, l.name), h('div', { class: 'person-sub' }, `версия ${linked[l.id]!.version} → ${l.version} · ${l.publishedBy ?? ''} ${relativeTime(l.published)}${l.description ? ` · ${l.description}` : ''}`)),
              h('button', { class: 'm-btn', title: 'Посмотреть, что изменилось, и взять выбранное', onclick: () => void this.review(l).then(render) }, 'Выбрать…'),
              h('button', { class: 'm-btn', onclick: () => void this.connect(l).then(render) }, 'Обновить'),
            ),
          ),
        ),
        h('div', { class: 'm-row end' }, h('button', { class: 'm-btn primary', onclick: async () => { for (const l of this.outdated()) await this.connect(l); render(); } }, 'Обновить все')),
      );
    };
    render();
  }

  /** Contents of a published library version. */
  private async source(lib: TeamLibrary): Promise<Document> {
    const bytes = await this.account.api<Uint8Array>('GET', `/api/libraries/${lib.id}/content`);
    const { doc, bridge } = await docFromLoro(bytes);
    bridge.dispose();
    return doc;
  }

  /** Review changes and take the selected ones. */
  async review(lib: TeamLibrary): Promise<void> {
    let source: Document;
    try {
      source = await this.source(lib);
    } catch (e) {
      this.hooks.notify(`Библиотека «${lib.name}» не загрузилась: ${message(e)}`, 'error');
      return;
    }
    await new Promise<void>((done) =>
      openLibraryUpdate(this.ed, {
        name: lib.name,
        source,
        prefix: `lib:${lib.id}`,
        note: lib.description ? `Версия ${lib.version}: ${lib.description}` : `Версия ${lib.version}`,
        apply: async (only) => {
          await this.connect(lib, only, source);
          done();
        },
      }),
    );
  }

  /**
   * Add or update: import the latest version into the open document. only — take only these
   * assets (the rest can wait: the version in the file stays the same until all changes are taken).
   */
  async connect(lib: TeamLibrary, only: Set<string> | null = null, given?: Document): Promise<boolean> {
    const ed = this.ed;
    try {
      const source = given ?? (await this.source(lib));
      const was = this.linked()[lib.id];
      const prefix = `lib:${lib.id}`;
      const r = ed.doc.transact(() => {
        // The library's previous name (it was renamed) — assets move to the new one.
        if (was && was.name !== lib.name) unlinkLibrary(ed.doc, was.name);
        const report = importLibrary(ed.doc, source, lib.name, prefix, only ? { only } : {});
        const rest = only ? libraryChanges(ed.doc, source, lib.name, prefix).length : 0;
        ed.doc.set(ed.doc.root, { teamLibraries: { ...this.linked(), [lib.id]: { name: lib.name, version: rest && was ? was.version : lib.version } } });
        return report;
      });
      // Asset images — from the server (for a file on this device — into its own storage).
      if (!this.hooks.file()) {
        for (const hash of r.images) {
          const res = await fetch(`${this.account.base}/image/${hash}`, { headers: this.account.token ? { authorization: `Bearer ${this.account.token}` } : {} }).catch(() => null);
          if (res?.ok) await ed.store.add(new Uint8Array(await res.arrayBuffer()));
        }
      }
      this.hooks.notify(`${was ? 'Обновлена' : 'Подключена'} библиотека «${lib.name}» (версия ${lib.version}): компонентов ${r.components}, стилей ${r.styles}, переменных ${r.variables}${r.updated ? `, обновлено ${r.updated}` : ''}`);
      void this.report();
      this.paint();
      for (const cb of [...this.onChange]) cb();
      return true;
    } catch (e) {
      this.hooks.notify(`Библиотека «${lib.name}» не подключилась: ${message(e)}`, 'error');
      return false;
    }
  }

  /** Remove: assets stay in the file as local ones. */
  disconnect(id: string) {
    const ed = this.ed;
    const was = this.linked()[id];
    if (!was) return;
    ed.doc.transact(() => {
      unlinkLibrary(ed.doc, was.name);
      const next = { ...this.linked() };
      delete next[id];
      ed.doc.set(ed.doc.root, { teamLibraries: next });
    });
    const f = this.hooks.file();
    if (f) void this.account.api('DELETE', `/api/libraries/${id}/usage?fileId=${f.id}`).catch(() => {});
    this.paint();
    for (const cb of [...this.onChange]) cb();
  }

  /** Tell the server how many component instances of each added library are in the file. */
  async report() {
    const f = this.hooks.file();
    if (!f || f.branch || !this.account.signedIn) return;
    for (const [id, l] of Object.entries(this.linked())) {
      await this.account.api('POST', `/api/libraries/${id}/usage`, { fileId: f.id, version: l.version, counts: libraryUsage(this.ed.doc, l.name) }).catch(() => {});
    }
  }

  /** “Team libraries” section for the “Libraries” window. */
  section(): HTMLElement {
    const box = h('div', { class: 'team-libs' });
    const render = () => {
      if (!this.account.signedIn) {
        fill(box, h('div', { class: 'fd-note' }, 'Командные библиотеки — после входа: «Файлы» → «Войти».'));
        return;
      }
      const linked = this.linked();
      const rows = this.libs.map((l) => {
        const on = linked[l.id];
        const self = this.hooks.file()?.id === l.id;
        return h(
          'div',
          { class: 'lint-row' },
          h('div', { class: 'lint-text' }, h('div', { class: 'lint-name' }, `${l.name}${l.teamName ? ` · ${l.teamName}` : ''}`), h('div', { class: 'lint-msg' }, `${what(l.counts)} · версия ${l.version}${on && on.version < l.version ? ` (у вас ${on.version})` : ''}`)),
          self
            ? h('span', { class: 'lint-msg' }, 'этот файл')
            : on
              ? h('button', { class: 'pe-btn', disabled: on.version >= l.version, onclick: () => void this.connect(l) }, on.version >= l.version ? 'Актуальна' : 'Обновить')
              : h('button', { class: 'pe-btn primary', onclick: () => void this.connect(l) }, 'Подключить'),
          on ? h('button', { class: 'pe-btn', onclick: () => this.disconnect(l.id) }, 'Отключить') : null,
        );
      });
      fill(box, h('div', { class: 'fd-sub' }, 'Командные библиотеки'), ...(rows.length ? rows : [h('div', { class: 'empty' }, 'Опубликованных библиотек в ваших командах нет. Опубликовать файл: «Дизайн-система» → «Опубликовать библиотеку…».')]));
    };
    render();
    const cb = () => (box.isConnected ? render() : this.onChange.splice(this.onChange.indexOf(cb), 1));
    this.onChange.push(cb);
    void this.refresh();
    return box;
  }

  /** Added team libraries — they are not in the list of “file” libraries. */
  names(): Set<string> {
    return new Set(Object.values(this.linked()).map((l) => l.name));
  }

  /** Publish the open file as a library (a new version) and view usage. */
  publishDialog() {
    const f = this.hooks.file();
    if (!f) {
      this.hooks.notify('Публикуют файлы на сервере — загрузите файл: «Поделиться» → «Загрузить на сервер»');
      return;
    }
    if (f.branch) {
      this.hooks.notify('Публикуют основной файл: слейте ветку и опубликуйте его');
      return;
    }
    const m = modal('Библиотека', { cls: 'wide' });
    const render = async () => {
      let lib: Published | null = null;
      try {
        lib = (await this.account.api<{ library: Published | null }>('GET', `/api/files/${f.id}/library`)).library;
      } catch (e) {
        this.hooks.notify(message(e), 'error');
      }
      const assets = libraryAssets(this.ed.doc, `lib:${f.id}`);
      const counts = {
        components: assets.filter((a) => a.type === 'COMPONENT' || a.type === 'COMPONENT_SET').length,
        styles: assets.filter((a) => a.type === 'STYLE').length,
        variables: assets.filter((a) => a.type === 'VARIABLE').length,
      };
      const before = new Set((lib?.assets ?? []).map((a) => a.key));
      const now = new Set(assets.map((a) => a.key));
      const added = assets.filter((a) => !before.has(a.key)).length;
      const removed = (lib?.assets ?? []).filter((a) => !now.has(a.key)).length;
      const name = h('input', { class: 'm-input', value: lib?.name ?? this.ed.doc.get(this.ed.doc.root, 'name') ?? '', placeholder: 'Название библиотеки', 'aria-label': 'Название библиотеки' }) as HTMLInputElement;
      if (!name.value) name.value = document.title.replace(/ — MFP$/, '');
      const desc = h('textarea', { class: 'desc', placeholder: 'Что изменилось (увидят при обновлении)', 'aria-label': 'Описание' }) as HTMLTextAreaElement;
      desc.addEventListener('keydown', (e) => e.stopPropagation());
      const publish = h('button', { class: 'm-btn primary', disabled: !assets.length || !canEdit(f.role) }, lib ? `Опубликовать версию ${lib.version + 1}` : 'Опубликовать') as HTMLButtonElement;
      publish.addEventListener('click', async () => {
        publish.disabled = true;
        try {
          const r = await this.account.api<TeamLibrary>('POST', `/api/files/${f.id}/publish`, { name: name.value.trim() || 'Библиотека', description: desc.value.trim(), assets });
          this.hooks.notify(`Библиотека «${r.name}» опубликована (версия ${r.version}) — команда увидит обновление`);
          void this.refresh();
          void render();
        } catch (e) {
          this.hooks.notify(message(e), 'error');
          publish.disabled = false;
        }
      });
      const usage = h('div', { class: 'm-list' });
      fill(
        m.body,
        h('p', { class: 'm-note' }, lib ? `Опубликована: версия ${lib.version}, ${relativeTime(lib.published)}${lib.publishedBy ? ` (${lib.publishedBy})` : ''}.` : 'Файл ещё не опубликован. Команда сможет подключить его компоненты, стили и переменные к своим файлам.'),
        h('p', { class: 'm-note' }, `Сейчас в файле: ${what(counts)}.${lib ? ` С прошлой версии: добавлено ${added}, убрано ${removed}.` : ''}`),
        h('div', { class: 'm-row' }, name),
        desc,
        h(
          'div',
          { class: 'm-row end' },
          lib && f.role === 'owner'
            ? h('button', {
                class: 'm-btn danger',
                onclick: async () => {
                  if (!confirm('Снять библиотеку с публикации? В файлах, где она подключена, ассеты останутся, но обновлений больше не будет.')) return;
                  await this.account.api('DELETE', `/api/files/${f.id}/publish`).catch((e) => this.hooks.notify(message(e), 'error'));
                  void this.refresh();
                  void render();
                },
              }, 'Снять с публикации')
            : null,
          h('span', { style: 'flex:1' }),
          publish,
        ),
        lib ? h('hr', { class: 'm-sep' }) : null,
        lib ? h('div', { class: 'm-label' }, 'Где используется') : null,
        lib ? usage : null,
      );
      if (!lib) return;
      try {
        const u = await this.account.api<{ files: { id: string; name: string; version: number; instances: number; updated: number }[]; hiddenFiles: number; components: { key: string; name: string; instances: number; files: number }[] }>('GET', `/api/libraries/${f.id}/usage`);
        fill(
          usage,
          ...(u.files.length || u.hiddenFiles
            ? [
                ...u.files.map((x) => h('div', { class: 'person' }, h('div', { class: 'person-text' }, h('div', { class: 'person-name' }, x.name), h('div', { class: 'person-sub' }, `версия ${x.version}${x.version < lib!.version ? ' (не обновлена)' : ''} · инстансов ${x.instances} · ${relativeTime(x.updated)}`)))),
                u.hiddenFiles ? h('p', { class: 'm-note' }, `И ещё файлов, к которым у вас нет доступа: ${u.hiddenFiles}.`) : null,
                u.components.length ? h('div', { class: 'm-label' }, 'Компоненты') : null,
                ...u.components.slice(0, 50).map((c) => h('div', { class: 'usage-row' }, h('span', { class: 'usage-name' }, c.name), h('span', { class: 'usage-n' }, `${c.instances} инст. · ${plural(c.files, 'файл', 'файла', 'файлов')}`))),
              ]
            : [h('p', { class: 'm-note' }, 'Библиотеку пока никто не подключил.')]),
        );
      } catch {
        fill(usage, h('p', { class: 'm-note' }, 'Статистика недоступна.'));
      }
    };
    void render();
  }
}
