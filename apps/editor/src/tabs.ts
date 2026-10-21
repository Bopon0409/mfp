// File tabs (desktop): above the window — “Files” and the open files. Click — open the
// file, × or middle button — close the tab, “+” — new file. Ctrl+Tab and Ctrl+Shift+Tab —
// adjacent tab, Ctrl+W — close, Ctrl+T — new file. The tab list is remembered.
// In the browser the tabs are its own; here they are enabled only for testing (?tabs).

import { h, svgEl } from './dom.ts';
import { ICON } from './icons.ts';
import type { Library } from './library.ts';

export interface TabsHooks {
  /** Open file; dirty — has edits not yet written to the file on disk. */
  current(): { id: string; name: string; dirty: boolean };
  /** Open a library file (false — it no longer exists). */
  open(id: string, canReplace?: () => boolean): Promise<boolean>;
  newFile(): void;
  home(): { isOpen: boolean; open(): void; close(): void } | null;
  notify(message: string): void;
}

const KEY = 'mfp-tabs';
const HEIGHT = 36;

export class FileTabs {
  private ids: string[] = [];
  private names = new Map<string, string>();
  private bar: HTMLElement;
  private lib: Library | null;
  private hooks: TabsHooks;
  /** Opening a file; a later choice replaces the pending tab. */
  private busy = false;
  /** Tab of the open file (a new one goes to its right). */
  private active: string | null = null;
  /** What is drawn: redraw only if something changed (sync is called often). */
  private drawn = '';
  /** Open file whose tab was closed while there was no other (file list shown): don't return to it. */
  private detached: string | null = null;
  private views = new Map<string, { name: string; frame: HTMLIFrameElement }>();
  private activeView: string | null = null;
  private pendingFile: string | null = null;
  private loading: HTMLElement | null = null;

  get viewActive() { return this.activeView !== null; }
  get fileLoading() { return this.busy; }

  private cancelOpen() {
    this.pendingFile = null;
    this.loading?.remove();
    this.loading = null;
  }

  openView(id: string, name: string, url: string) {
    this.cancelOpen();
    let view = this.views.get(id);
    if (!view) {
      const frame = h('iframe', { title: name, src: url, class: 'presentation-tab', allow: 'fullscreen', hidden: true }) as HTMLIFrameElement;
      Object.assign(frame.style, { position: 'fixed', top: `${HEIGHT}px`, left: '0', width: '100%', height: `calc(100% - ${HEIGHT}px)`, border: '0', zIndex: '70', background: 'var(--bg)' });
      document.body.append(frame);
      view = { name, frame };
      this.views.set(id, view);
    } else if (view.frame.getAttribute('src') !== url) view.frame.src = url;
    this.showView(id);
    this.render();
  }

  private showView(id: string | null) {
    this.activeView = id;
    for (const [key, v] of this.views) {
      v.frame.hidden = key !== id;
      v.frame.contentWindow?.postMessage({ type: 'mfp-player-visible', visible: key === id }, location.origin);
    }
    if (id) this.views.get(id)?.frame.focus();
  }

  constructor(lib: Library | null, hooks: TabsHooks) {
    this.lib = lib;
    this.hooks = hooks;
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
      if (Array.isArray(saved)) this.ids = saved.filter((x): x is string => typeof x === 'string');
    } catch {
      // Corrupted list — start with an empty one.
    }
    this.bar = h('div', { id: 'filetabs', role: 'tablist', 'aria-label': 'Открытые файлы' });
    document.body.prepend(this.bar);
    document.documentElement.style.setProperty('--tabs-h', `${HEIGHT}px`);
    lib?.onChange.push(() => void this.refreshNames());
    addEventListener('keydown', (e) => this.key(e), true);
    addEventListener('message', (e) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === 'mfp-player-ready') {
        for (const [id, view] of this.views) if (e.source === view.frame.contentWindow) {
          view.frame.contentWindow?.postMessage({ type: 'mfp-player-visible', visible: id === this.activeView }, location.origin);
        }
        return;
      }
      if (e.source !== this.views.get(this.activeView ?? '')?.frame.contentWindow || e.data?.type !== 'mfp-tab-key') return;
      if (e.data.key === 'w') void this.close(this.activeView!);
      else if (e.data.key === 'Tab') this.cycle(e.data.shift ? -1 : 1);
    });
    void this.refreshNames();
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.ids));
    } catch {
      // No storage — tabs last until restart.
    }
  }

  /** The open file is always in a tab (a new one goes to the right of the previously active one). */
  sync() {
    const cur = this.hooks.current();
    // A server file isn't listed in the library — remember its tab name while it is open.
    if (cur.id.startsWith('srv:')) this.names.set(cur.id, cur.name);
    if (this.detached && (cur.id !== this.detached || !this.hooks.home()?.isOpen)) this.detached = null;
    // During a switch, the file being closed also reports itself — don't bring it back.
    if (!this.ids.includes(cur.id) && !this.busy && cur.id !== this.detached) {
      const prev = this.ids.indexOf(this.active ?? '');
      this.ids.splice(prev >= 0 ? prev + 1 : this.ids.length, 0, cur.id);
      this.save();
      // The previous file may never have made it into the library (new, empty) — remove its tab.
      void this.refreshNames();
    }
    this.active = cur.id;
    this.render();
  }

  /** Tab file names; tabs of files removed from the library (and abandoned empty new ones) are closed. */
  private async refreshNames() {
    if (!this.lib) return;
    const cur = this.hooks.current().id;
    const keep: string[] = [];
    for (const id of this.ids) {
      const meta = await this.lib.get(id);
      if (meta && !meta.trashed) {
        this.names.set(id, meta.name);
        keep.push(id);
      } else if (id === cur || id.startsWith('srv:')) keep.push(id);
    }
    if (keep.length !== this.ids.length) {
      this.ids = keep;
      this.save();
    }
    this.render();
  }

  render() {
    const cur = this.hooks.current();
    const home = this.hooks.home();
    const homeOpen = !!home?.isOpen;
    const sig = JSON.stringify([this.ids, cur, homeOpen, this.busy, this.pendingFile, this.activeView, [...this.views.keys()], this.ids.map((id) => this.names.get(id))]);
    if (sig === this.drawn) return;
    this.drawn = sig;
    const homeBtn = svgEl('button', { class: `ftab-home${homeOpen && !this.activeView ? ' on' : ''}`, role: 'tab', 'aria-selected': String(homeOpen && !this.activeView), title: 'Файлы', onclick: () => { this.cancelOpen(); this.showView(null); home?.open(); this.render(); } }, ICON.folder);
    const tabs = this.ids.map((id) => {
      const on = !this.activeView && (!homeOpen || !!this.pendingFile) && id === (this.pendingFile ?? cur.id);
      const name = id === cur.id ? cur.name : (this.names.get(id) ?? 'Файл');
      const close = svgEl(
        'button',
        {
          class: 'ftab-close',
          title: 'Закрыть вкладку (Ctrl+W)',
          tabIndex: -1,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            void this.close(id);
          },
        },
        ICON.close,
      );
      return h(
        'div',
        {
          class: `ftab${on ? ' on' : ''}`,
          role: 'tab',
          'aria-selected': String(on),
          tabIndex: on ? 0 : -1,
          title: name,
          onclick: () => void this.activate(id),
          onauxclick: (e: MouseEvent) => e.button === 1 && void this.close(id),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void this.activate(id);
            }
          },
        },
        h('span', { class: 'ftab-name' }, `${name}${id === this.pendingFile ? ' · загрузка' : id === cur.id && cur.dirty ? ' •' : ''}`),
        close,
      );
    });
    const viewTabs = [...this.views].map(([id, v]) => h('div', { class: `ftab${this.activeView === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(this.activeView === id), tabIndex: this.activeView === id ? 0 : -1, onclick: () => void this.activate(id), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void this.activate(id); } } },
      h('span', { class: 'ftab-name' }, `▷ ${v.name}`), svgEl('button', { class: 'ftab-close', title: 'Закрыть показ (Ctrl+W)', onclick: (e: MouseEvent) => { e.stopPropagation(); void this.close(id); } }, ICON.close)));
    const plus = svgEl('button', { class: 'ftab-plus', title: 'Новый файл (Ctrl+T)', disabled: this.busy, onclick: () => { if (!this.busy) { this.showView(null); this.hooks.newFile(); } } }, ICON.plus);
    this.bar.replaceChildren(homeBtn, ...tabs, ...viewTabs, plus);
    this.bar.querySelector('.ftab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Switch to a tab (the file opens from the library; if it's gone, the tab closes). */
  private async activate(id: string) {
    if (this.views.has(id)) { this.cancelOpen(); this.showView(id); this.render(); return; }
    this.showView(null);
    const home = this.hooks.home();
    if (id === this.hooks.current().id) {
      if (this.busy) this.pendingFile = id;
      this.loading?.remove(); this.loading = null;
      home?.close();
      this.render();
      return;
    }
    this.pendingFile = id;
    this.render();
    if (!this.loading) {
      this.loading = h('div', { role: 'status', 'aria-live': 'polite' }, 'Открываем файл… Слои и изображения появятся по мере загрузки.');
      Object.assign(this.loading.style, { position: 'fixed', inset: `${HEIGHT}px 0 0`, zIndex: '65', background: 'var(--bg)', display: 'grid', placeItems: 'center', color: 'var(--text)' });
      document.body.append(this.loading);
    }
    this.loading.textContent = `Открываем «${this.names.get(id) ?? 'Файл'}»…`;
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      // Let the browser paint the selected tab before snapshot restore / scene work.
      await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      if (await this.hooks.open(id, () => this.pendingFile === id)) { if (this.pendingFile === id) home?.close(); }
      else {
        if (this.pendingFile === id) this.hooks.notify('Файл не удалось открыть; предыдущая вкладка сохранена');
      }
    } catch (error) {
      this.hooks.notify(`Не удалось открыть файл: ${(error as Error).message}`);
    } finally {
      this.busy = false;
      const next = this.pendingFile;
      this.pendingFile = null;
      this.loading?.remove(); this.loading = null;
      this.render();
      if (next && next !== id) void this.activate(next);
    }
  }

  /** Close a tab: the active one — switch to a neighbor, the last one — go to the file list. */
  private async close(id: string) {
    if (this.busy) return;
    const view = this.views.get(id);
    if (view) {
      view.frame.remove(); this.views.delete(id);
      if (this.activeView === id) this.showView(null);
      this.render(); return;
    }
    const i = this.ids.indexOf(id);
    if (i < 0) return;
    const home = this.hooks.home();
    this.ids.splice(i, 1);
    this.save();
    if (id === this.hooks.current().id) {
      const next = home?.isOpen ? undefined : (this.ids[i] ?? this.ids[i - 1]);
      if (next) await this.activate(next);
      else {
        this.detached = id;
        home?.open();
      }
    }
    this.render();
  }

  private key(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const cur = this.activeView ?? this.hooks.current().id;
    if (e.key === 'Tab' && this.ids.length + this.views.size > 1) {
      this.cycle(e.shiftKey ? -1 : 1);
    } else if (e.code === 'KeyW' && !e.shiftKey) void this.close(cur);
    else if (e.code === 'KeyT' && !e.shiftKey) { if (!this.busy) { this.showView(null); this.hooks.newFile(); } }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private cycle(dir: number) {
    const all = [...this.ids, ...this.views.keys()];
    const i = Math.max(0, all.indexOf(this.activeView ?? this.pendingFile ?? this.hooks.current().id));
    if (all.length) void this.activate(all[(i + dir + all.length) % all.length]!);
  }
}
