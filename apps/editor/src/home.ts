// Files: recent, all files by folder, trash; on desktop also the
// “Documents/MFP” folder on disk. Cards with thumbnails; search and sorting; new file, folder,
// import; per card: open, rename, duplicate, move, delete. A file can be
// dragged onto a folder on the left. Esc or “×” returns to the open file.
//
// With an account, also files on the server: drafts, shared with me, teams and their projects;
// sign-in and the account menu at the bottom left.

import { canEdit, whoIs, type Account, type ProjectRef, type ServerFile, type TeamRef } from './account.ts';
import { accountMenu, chooseDestination, teamDialog } from './account-ui.ts';
import { integrationsDialog } from './integrations-ui.ts';
import { avatar, h, iconBtn } from './dom.ts';
import { ICON } from './icons.ts';
import { showMenu, showMenuAt, type MenuEntry } from './menu.ts';
import { ancestors, folderName, Library, normalizeFolder, type FileMeta } from './library.ts';
import { disk, isDesktop, type DiskEntry } from './platform.ts';

type View =
  | { kind: 'recent' }
  | { kind: 'all'; folder: string }
  | { kind: 'trash' }
  | { kind: 'disk'; dir: string }
  | { kind: 'drafts' }
  | { kind: 'shared' }
  | { kind: 'team'; id: string }
  | { kind: 'project'; id: string };

const SERVER_VIEWS = new Set<View['kind']>(['drafts', 'shared', 'team', 'project']);
const TEAM_RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 } as const;

/** Server files (main.ts): open, create, upload your own, share. */
export interface ServerHooks {
  account: Account;
  /** Open a server file (false: it did not open). */
  openServer(id: string, name?: string): Promise<boolean>;
  /** New file on the server (null: drafts). */
  newServerFile(projectId: string | null): Promise<void>;
  /** Upload a library file to the server (asks where). */
  upload(localId: string): Promise<boolean>;
  share(id: string): void;
  signIn(): void;
  /** A server file was renamed (if it is open, update the title). */
  renamed(id: string, name: string): void;
  /** Notifications bell. */
  bell?(): HTMLElement;
}

export interface HomeHooks {
  openId(id: string): Promise<void>;
  openPath(path: string): Promise<void>;
  /** New file in a folder. */
  newFile(folder: string): void;
  /** Import from disk (file picker). */
  importFiles(): void;
  /** Currently open file (highlighted; “×” returns to it). */
  currentId(): string | null;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Files folder on disk (desktop). */
  workspace(): string | null;
  server?: ServerHooks;
}

const SORTS = [
  ['modified', 'По изменению'],
  ['opened', 'По открытию'],
  ['name', 'По имени'],
] as const;

export function relativeTime(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  const d = new Date(t);
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === y.toDateString()) return `вчера в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export class Home {
  private lib: Library;
  private hooks: HomeHooks;
  private root: HTMLElement;
  private view: View = { kind: 'recent' };
  private query = '';
  private sort: (typeof SORTS)[number][0] = 'modified';
  private urls: string[] = [];
  /** Server file thumbnails: “id:modified” → URL (until the list closes). */
  private serverThumbs = new Map<string, string>();
  private renaming: string | null = null;
  /** Render number: a server reply for an older render does not overwrite a newer one. */
  private drawing = 0;

  constructor(lib: Library, hooks: HomeHooks) {
    this.lib = lib;
    this.hooks = hooks;
    this.root = h('div', { id: 'home', class: 'home', hidden: true, role: 'dialog', 'aria-label': 'Файлы' });
    document.body.append(this.root);
    lib.onChange.push(() => {
      if (!this.root.hidden) void this.render();
    });
    hooks.server?.account.onChange.push(() => {
      if (this.root.hidden) return;
      // Signed out: server sections are gone.
      if (!hooks.server!.account.signedIn && SERVER_VIEWS.has(this.view.kind)) this.view = { kind: 'recent' };
      void this.render();
    });
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.hooks.currentId() && !this.renaming) {
        e.stopPropagation();
        this.close();
      }
    });
  }

  /** Opened or closed (file tabs). */
  onToggle: (() => void)[] = [];

  get isOpen() {
    return !this.root.hidden;
  }

  open(view?: View) {
    if (view) this.view = view;
    this.root.hidden = false;
    document.body.classList.add('home-open');
    for (const cb of this.onToggle) cb();
    void this.render().then(() => this.root.querySelector<HTMLElement>('.home-search')?.focus());
  }

  close() {
    this.root.hidden = true;
    document.body.classList.remove('home-open');
    for (const cb of this.onToggle) cb();
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    for (const u of this.serverThumbs.values()) URL.revokeObjectURL(u);
    this.serverThumbs.clear();
    document.getElementById('canvas')?.focus();
  }

  /** Open a section (from main.ts: a team's “Files”, etc.). */
  show(view: View) {
    if (this.isOpen) this.go(view);
    else this.open(view);
  }

  async render() {
    const seq = ++this.drawing;
    const { folders, files } = await this.lib.list();
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    const v = this.view;
    const live = files.filter((f) => !f.trashed);
    const q = this.query.toLowerCase();
    const match = (f: FileMeta) => !q || f.name.toLowerCase().includes(q);
    let list: FileMeta[];
    let subfolders: string[] = [];
    let title: (string | HTMLElement)[];
    if (v.kind === 'recent') {
      list = live.filter(match).sort((a, b) => b.opened - a.opened).slice(0, 60);
      title = ['Недавние'];
    } else if (v.kind === 'trash') {
      list = files.filter((f) => f.trashed && match(f)).sort((a, b) => (b.trashed ?? 0) - (a.trashed ?? 0));
      title = ['Корзина'];
    } else if (v.kind === 'all') {
      const inFolder = (f: FileMeta) => (q ? f.folder === v.folder || f.folder.startsWith(`${v.folder}/`) || !v.folder : f.folder === v.folder);
      list = live.filter((f) => inFolder(f) && match(f));
      const key = this.sort === 'name' ? null : this.sort;
      list.sort(key ? (a, b) => b[key] - a[key] : (a, b) => a.name.localeCompare(b.name, 'ru'));
      subfolders = q ? [] : folders.filter((f) => f.startsWith(v.folder ? `${v.folder}/` : '') && !f.slice(v.folder ? v.folder.length + 1 : 0).includes('/') && f !== v.folder);
      title = this.crumbs(v.folder);
    } else {
      list = [];
      title = v.kind === 'disk' ? ['Папка на диске'] : [];
    }

    // Search is in the sidebar under the account.
    const search = h('input', { class: 'home-search', placeholder: 'Поиск файлов', value: this.query, 'aria-label': 'Поиск файлов' }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.query = search.value.trim();
      void this.render().then(() => {
        const s = this.root.querySelector<HTMLInputElement>('.home-search');
        s?.focus();
        s?.setSelectionRange(s.value.length, s.value.length);
      });
    });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    // Sidebar.
    const nav = (label: string, icon: string, target: View, active: boolean, drop?: string) => {
      const b = h('button', { class: `home-nav${active ? ' on' : ''}`, onclick: () => this.go(target) }, icon.startsWith('<svg') ? h('span', { class: 'home-ic', innerHTML: icon }) : h('span', { class: 'home-ic' }, icon), h('span', {}, label));
      if (drop !== undefined) this.dropTarget(b, drop);
      return b;
    };
    const side = h(
      'aside',
      { class: 'home-side' },
      // At the top: the account and notifications (without a server, the MFP mark), search below them.
      this.hooks.server
        ? h('div', { class: 'home-top' }, this.accountButton(this.hooks.server), this.hooks.server.account.signedIn ? (this.hooks.server.bell?.() ?? null) : null)
        : h('div', { class: 'home-brand' }, h('span', { class: 'home-ic', innerHTML: ICON.logo }), h('span', {}, 'MFP')),
      h('div', { class: 'home-search-wrap' }, search),
      nav('Недавние', ICON.clock, { kind: 'recent' }, v.kind === 'recent'),
      nav('Все файлы', ICON.page, { kind: 'all', folder: '' }, v.kind === 'all' && v.folder === '', ''),
      ...folders.map((f) => {
        const depth = f.split('/').length;
        const b = nav(folderName(f), ICON.folder, { kind: 'all', folder: f }, v.kind === 'all' && v.folder === f, f);
        b.style.paddingLeft = `${12 + depth * 14}px`;
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showMenuAt(e.clientX, e.clientY, this.folderMenu(f));
        });
        return b;
      }),
      nav('Корзина', ICON.trash, { kind: 'trash' }, v.kind === 'trash'),
      isDesktop && this.hooks.workspace() ? nav('Папка на диске', ICON.drive, { kind: 'disk', dir: this.hooks.workspace()! }, v.kind === 'disk') : null,
      ...(this.hooks.server ? this.serverNav(this.hooks.server, nav) : []),
    );

    const sortSel = h('select', { class: 'home-sort', 'aria-label': 'Порядок' }, ...SORTS.map(([k, l]) => h('option', { value: k, selected: k === this.sort }, l))) as HTMLSelectElement;
    sortSel.addEventListener('change', () => {
      this.sort = sortSel.value as typeof this.sort;
      void this.render();
    });
    const srv = this.hooks.server;
    if (srv && SERVER_VIEWS.has(v.kind)) {
      const main = await this.serverMain(v, srv, search);
      if (seq === this.drawing) this.root.replaceChildren(side, main);
      return;
    }
    const folderNow = v.kind === 'all' ? v.folder : '';
    const head = h(
      'header',
      { class: 'home-head' },
      h('h1', { class: 'home-title' }, ...title),
      h('div', { class: 'home-tools' },
        v.kind === 'all' ? sortSel : null,
        v.kind !== 'trash' ? h('button', { class: 'home-btn primary', onclick: () => this.hooks.newFile(folderNow) }, '+ Новый файл') : null,
        v.kind === 'all' ? h('button', { class: 'home-btn', onclick: () => void this.newFolder(folderNow) }, '+ Папка') : null,
        h('button', { class: 'home-btn', onclick: () => this.hooks.importFiles(), title: isDesktop ? 'Открыть .mfp или .fig с диска' : 'Импорт .fig или .mfp' }, isDesktop ? 'Открыть…' : 'Импорт…'),
        this.hooks.currentId() ? iconBtn('close', 'Вернуться к файлу (Esc)', () => this.close(), 'icon-btn home-close') : null,
      ),
    );

    const grid = h('div', { class: 'home-grid', role: 'list' });
    for (const f of subfolders) grid.append(this.folderCard(f, files));
    for (const f of list) grid.append(await this.card(f, v.kind === 'trash'));
    if (v.kind === 'disk') for (const e of await this.diskEntries(v.dir)) grid.append(this.diskCard(e));
    // Trash on the server (own files).
    if (v.kind === 'trash' && srv?.account.signedIn) {
      const gone = (await srv.account.files('trash').catch(() => [] as ServerFile[])).filter((f) => match({ name: f.name } as FileMeta));
      if (gone.length) grid.append(h('div', { class: 'home-group', style: 'grid-column: 1 / -1; padding-left: 0' }, 'На сервере'));
      for (const f of gone) grid.append(await this.serverCard(f, srv, true));
    }
    const empty =
      !grid.childElementCount &&
      h(
        'div',
        { class: 'home-empty' },
        v.kind === 'trash' ? 'Корзина пуста.' : q ? 'Ничего не найдено.' : v.kind === 'disk' ? 'В папке нет файлов .mfp и .fig.' : 'Здесь пока нет файлов. «+ Новый файл» — начать, «Импорт…» — открыть .fig или .mfp.',
      );
    if (v.kind === 'trash' && list.length) {
      grid.before(h('div', { class: 'home-note' }, 'Файлы из корзины можно вернуть. «Удалить навсегда» стирает файл и его историю версий.'));
    }
    // The browser has not persisted storage; when space runs low it may delete files.
    const risky = !isDesktop && !(await Library.persist());
    const note = risky ? h('div', { class: 'home-note warn', role: 'note' }, 'Браузер не закрепил хранилище за MFP: при нехватке места он может удалить файлы. Скачивайте копии (.mfp) важных файлов или работайте в приложении для компьютера.') : null;
    const main = h('main', { class: 'home-main' }, head, note, empty || grid);
    if (seq === this.drawing) this.root.replaceChildren(side, main);
  }

  private crumbs(folder: string): (string | HTMLElement)[] {
    const out: (string | HTMLElement)[] = [h('button', { class: 'home-crumb', onclick: () => this.go({ kind: 'all', folder: '' }) }, 'Все файлы')];
    for (const f of ancestors(folder)) out.push(' / ', h('button', { class: 'home-crumb', onclick: () => this.go({ kind: 'all', folder: f }) }, folderName(f)));
    return out;
  }

  private go(view: View) {
    this.view = view;
    this.query = '';
    void this.render();
  }

  private dropTarget(el: HTMLElement, folder: string) {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('text/x-mfp-file')) return;
      e.preventDefault();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      const id = e.dataTransfer?.getData('text/x-mfp-file');
      el.classList.remove('drop');
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      void this.lib.update(id, { folder });
    });
  }

  private async card(f: FileMeta, trashed: boolean): Promise<HTMLElement> {
    const thumb = await this.lib.thumbnail(f.id);
    const url = thumb ? URL.createObjectURL(thumb) : null;
    if (url) this.urls.push(url);
    const name =
      this.renaming === f.id
        ? (() => {
            const input = h('input', { class: 'home-rename', value: f.name }) as HTMLInputElement;
            const done = (save: boolean) => {
              if (this.renaming !== f.id) return;
              this.renaming = null;
              if (save && input.value.trim() && input.value.trim() !== f.name) void this.lib.update(f.id, { name: input.value.trim() });
              else void this.render();
            };
            input.addEventListener('keydown', (e) => {
              e.stopPropagation();
              if (e.key === 'Enter') done(true);
              if (e.key === 'Escape') done(false);
            });
            input.addEventListener('blur', () => done(true));
            requestAnimationFrame(() => {
              input.focus();
              input.select();
            });
            return input;
          })()
        : h('div', { class: 'home-name', title: f.name }, f.name);
    const sub = trashed ? `в корзине ${relativeTime(f.trashed ?? 0)}` : `изменён ${relativeTime(f.modified)}${f.path ? ' · на диске' : ''}`;
    const card = h(
      'div',
      {
        class: `home-card${this.hooks.currentId() === f.id ? ' current' : ''}`,
        role: 'listitem',
        tabIndex: 0,
        draggable: !trashed,
        title: f.path ?? '',
        'aria-label': `${f.name}, ${sub}`,
      },
      h('div', { class: 'home-thumb' }, url ? h('img', { src: url, alt: '' }) : h('span', { class: 'home-thumb-empty', innerHTML: ICON.frame })),
      h('div', { class: 'home-meta' }, name, h('div', { class: 'home-sub' }, sub)),
    );
    const open = () => {
      if (trashed) return;
      void this.hooks.openId(f.id).then(() => this.close());
    };
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('input')) return;
      open();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
      if (e.key === 'F2') this.startRename(f.id);
      if (e.key === 'Delete') void (trashed ? this.purge(f) : this.lib.trash(f.id));
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenuAt(e.clientX, e.clientY, trashed ? this.trashMenu(f) : this.fileMenu(f));
    });
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/x-mfp-file', f.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    return card;
  }

  private folderCard(folder: string, files: FileMeta[]): HTMLElement {
    const n = files.filter((f) => !f.trashed && (f.folder === folder || f.folder.startsWith(`${folder}/`))).length;
    const card = h(
      'div',
      { class: 'home-card folder', role: 'listitem', tabIndex: 0, 'aria-label': `Папка ${folderName(folder)}` },
      h('div', { class: 'home-thumb folder' }, h('span', { class: 'home-folder-ic', innerHTML: ICON.folder })),
      h('div', { class: 'home-meta' }, h('div', { class: 'home-name' }, folderName(folder)), h('div', { class: 'home-sub' }, `${n} ${plural(n, 'файл', 'файла', 'файлов')}`)),
    );
    card.addEventListener('click', () => this.go({ kind: 'all', folder }));
    card.addEventListener('keydown', (e) => e.key === 'Enter' && this.go({ kind: 'all', folder }));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenuAt(e.clientX, e.clientY, this.folderMenu(folder));
    });
    this.dropTarget(card, folder);
    return card;
  }

  private startRename(id: string) {
    this.renaming = id;
    void this.render();
  }

  private async moveMenu(f: FileMeta): Promise<MenuEntry[]> {
    const { folders } = await this.lib.list();
    return [
      { label: 'Все файлы (корень)', checked: f.folder === '', run: () => void this.lib.update(f.id, { folder: '' }) },
      ...folders.map((d) => ({ label: d.replace(/\//g, ' / '), checked: f.folder === d, run: () => void this.lib.update(f.id, { folder: d }) })),
    ];
  }

  private fileMenu(f: FileMeta): MenuEntry[] {
    return [
      { label: 'Открыть', run: () => void this.hooks.openId(f.id).then(() => this.close()) },
      'sep',
      { label: 'Переименовать', hint: 'F2', run: () => this.startRename(f.id) },
      { label: 'Дублировать', run: () => void this.duplicate(f) },
      { label: 'Переместить в папку', submenu: () => this.moveMenu(f) },
      ...(this.hooks.server?.account.signedIn ? [{ label: 'Загрузить на сервер…', run: () => void this.hooks.server!.upload(f.id) }] : []),
      'sep',
      { label: 'В корзину', hint: 'Delete', disabled: this.hooks.currentId() === f.id, run: () => void this.lib.trash(f.id) },
    ];
  }

  private trashMenu(f: FileMeta): MenuEntry[] {
    return [
      { label: 'Восстановить', run: () => void this.lib.restore(f.id) },
      { label: 'Удалить навсегда', run: () => void this.purge(f) },
    ];
  }

  private folderMenu(folder: string): MenuEntry[] {
    return [
      { label: 'Открыть', run: () => this.go({ kind: 'all', folder }) },
      { label: 'Новая папка внутри', run: () => void this.newFolder(folder) },
      {
        label: 'Переименовать',
        run: () => {
          const name = prompt('Новое имя папки:', folderName(folder))?.trim();
          if (!name) return;
          const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
          void this.lib.moveFolder(folder, normalizeFolder(`${parent}/${name.replace(/\//g, '-')}`));
        },
      },
      'sep',
      {
        label: 'Удалить папку',
        run: () => {
          if (confirm(`Удалить папку «${folderName(folder)}»? Файлы из неё уйдут в корзину.`)) void this.lib.removeFolder(folder).then(() => this.go({ kind: 'all', folder: '' }));
        },
      },
    ];
  }

  private async newFolder(parent: string) {
    const name = prompt('Имя папки:', 'Новая папка')?.trim();
    if (!name) return;
    const path = normalizeFolder(`${parent}/${name.replace(/\//g, '-')}`);
    await this.lib.makeFolder(path);
    this.go({ kind: 'all', folder: path });
  }

  private async duplicate(f: FileMeta) {
    const { newFileId } = await import('./library.ts');
    const id = newFileId();
    await this.lib.copyWorkCopy(f.id, id);
    const now = Date.now();
    const copy: FileMeta = { id, name: `${f.name} (копия)`, folder: f.folder, created: now, modified: now, opened: now - 1 };
    await this.lib.put(copy);
  }

  private async purge(f: FileMeta) {
    if (!confirm(`Удалить «${f.name}» навсегда? Файл и его история версий будут стёрты.`)) return;
    await this.lib.purge(f.id);
  }

  // ---------- Server: teams, projects, files ----------

  /** Server sections in the sidebar and the account at the bottom. */
  private serverNav(srv: ServerHooks, nav: (label: string, icon: string, target: View, active: boolean) => HTMLElement): HTMLElement[] {
    const acc = srv.account;
    const v = this.view;
    const out: HTMLElement[] = [];
    if (acc.signedIn) {
      out.push(
        h('div', { class: 'home-group' }, h('span', {}, 'На сервере')),
        nav('Черновики', ICON.page, { kind: 'drafts' }, v.kind === 'drafts'),
        nav('Доступные мне', ICON.link, { kind: 'shared' }, v.kind === 'shared'),
      );
      for (const t of acc.teams) {
        const b = nav(t.name, ICON.users, { kind: 'team', id: t.id }, v.kind === 'team' && v.id === t.id);
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showMenuAt(e.clientX, e.clientY, this.teamMenu(t, srv));
        });
        out.push(b);
        for (const p of acc.projects.filter((x) => x.teamId === t.id)) {
          const pb = nav(p.name, ICON.folder, { kind: 'project', id: p.id }, v.kind === 'project' && v.id === p.id);
          pb.style.paddingLeft = '28px';
          pb.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showMenuAt(e.clientX, e.clientY, this.projectMenu(p, srv));
          });
          out.push(pb);
        }
      }
      out.push(h('button', { class: 'home-nav', onclick: () => void this.newTeam(srv) }, h('span', { class: 'home-ic', innerHTML: ICON.plus }), h('span', {}, 'Новая команда')));
    }
    return out;
  }

  private accountButton(srv: ServerHooks): HTMLElement {
    const acc = srv.account;
    const u = acc.user;
    const sub = u ? whoIs(u.email) : acc.token && !acc.online ? 'сервер недоступен — повторить' : 'команды и общие файлы';
    const b = h(
      'button',
      { class: 'acct-btn', title: u ? 'Учётная запись' : `Сервер ${acc.base}` },
      u ? avatar(u.name, u.color) : h('span', { class: 'home-ic', innerHTML: ICON.users }),
      h('span', { class: 'acct-text' }, h('span', {}, u ? u.name : 'Войти'), h('span', { class: 'acct-sub' }, sub)),
      u ? h('span', { class: 'acct-chev', innerHTML: ICON.chevronDown }) : null,
    );
    b.addEventListener('click', async () => {
      if (u) showMenu(b, accountMenu(acc, { notify: this.hooks.notify, signIn: () => srv.signIn() }));
      else if (acc.token && !acc.online) {
        await acc.refresh();
        if (!acc.signedIn && !acc.online) this.hooks.notify(`Сервер ${acc.base} недоступен`, 'error');
      } else srv.signIn();
    });
    return b;
  }

  /** Server section: drafts, shared with me, a team (its projects), a project (its files). */
  private async serverMain(v: View, srv: ServerHooks, search: HTMLElement): Promise<HTMLElement> {
    const acc = srv.account;
    const q = this.query.toLowerCase();
    const match = (name: string) => !q || name.toLowerCase().includes(q);
    const grid = h('div', { class: 'home-grid', role: 'list' });
    let title: (string | HTMLElement)[] = [];
    let tools: (HTMLElement | null)[] = [];
    let empty = '';
    const newFile = (projectId: string | null) => h('button', { class: 'home-btn primary', onclick: () => void srv.newServerFile(projectId).then(() => this.close()) }, '+ Новый файл');
    try {
      if (v.kind === 'drafts') {
        title = ['Черновики'];
        tools = [newFile(null)];
        for (const f of (await acc.files('drafts')).filter((x) => match(x.name))) grid.append(await this.serverCard(f, srv));
        empty = 'Черновиков на сервере нет. «+ Новый файл» — начать; свой файл — правый щелчок по нему → «Загрузить на сервер…».';
      } else if (v.kind === 'shared') {
        title = ['Доступные мне'];
        for (const f of (await acc.files('shared')).filter((x) => match(x.name))) grid.append(await this.serverCard(f, srv));
        empty = 'Вам пока не открывали файлов по почте. Файлы команд — в их проектах слева.';
      } else if (v.kind === 'team') {
        const team = acc.teams.find((t) => t.id === v.id);
        title = [team ? `Команда «${team.name}»` : 'Команда'];
        const editor = !!team && TEAM_RANK[team.role] >= TEAM_RANK.editor;
        tools = [
          h('button', { class: 'home-btn', onclick: () => teamDialog(acc, v.id, { notify: this.hooks.notify, changed: () => void this.render() }) }, 'Участники…'),
          team && TEAM_RANK[team.role] >= TEAM_RANK.admin ? h('button', { class: 'home-btn', onclick: () => integrationsDialog(acc, v.id, team.name, this.hooks.notify) }, 'Интеграции…') : null,
          editor ? h('button', { class: 'home-btn primary', onclick: () => void this.newProject(v.id, srv) }, '+ Проект') : null,
        ];
        for (const p of acc.projects.filter((x) => x.teamId === v.id && match(x.name))) grid.append(this.projectCard(p, srv));
        empty = 'В команде нет проектов.';
      } else if (v.kind === 'project') {
        const r = await acc.api<{ project: { id: string; team_id: string; name: string }; files: ServerFile[] }>('GET', `/api/projects/${v.id}`);
        const team = acc.teams.find((t) => t.id === r.project.team_id);
        title = [h('button', { class: 'home-crumb', onclick: () => this.go({ kind: 'team', id: r.project.team_id }) }, team?.name ?? 'Команда'), ' / ', r.project.name];
        tools = [team && TEAM_RANK[team.role] >= TEAM_RANK.editor ? newFile(v.id) : null];
        for (const f of r.files.filter((x) => match(x.name))) grid.append(await this.serverCard(f, srv));
        empty = 'В проекте нет файлов.';
      }
    } catch (e) {
      empty = `Сервер не ответил: ${(e as Error).message}`;
    }
    const head = h(
      'header',
      { class: 'home-head' },
      h('h1', { class: 'home-title' }, ...title),
      h('div', { class: 'home-tools' }, ...tools, this.hooks.currentId() ? iconBtn('close', 'Вернуться к файлу (Esc)', () => this.close(), 'icon-btn home-close') : null),
    );
    return h('main', { class: 'home-main' }, head, grid.childElementCount ? grid : h('div', { class: 'home-empty' }, q ? 'Ничего не найдено.' : empty));
  }

  private async serverThumb(f: ServerFile, srv: ServerHooks): Promise<string | null> {
    const key = `${f.id}:${f.modified}`;
    const ready = this.serverThumbs.get(key);
    if (ready) return ready;
    const blob = await srv.account.thumbnail(f.id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.serverThumbs.set(key, url);
    return url;
  }

  private async serverCard(f: ServerFile, srv: ServerHooks, trashed = false): Promise<HTMLElement> {
    const url = f.thumb ? await this.serverThumb(f, srv) : null;
    const badge = f.role === 'view' ? 'просмотр' : f.role === 'comment' ? 'комментарии' : '';
    const sub = trashed ? `в корзине ${relativeTime(f.trashed ?? 0)}` : `изменён ${relativeTime(f.modified)}`;
    const card = h(
      'div',
      { class: `home-card${this.hooks.currentId() === `srv:${f.id}` ? ' current' : ''}`, role: 'listitem', tabIndex: 0, 'aria-label': `${f.name}, ${sub}${badge ? `, ${badge}` : ''}` },
      h('div', { class: 'home-thumb' }, url ? h('img', { src: url, alt: '' }) : h('span', { class: 'home-thumb-empty', innerHTML: ICON.frame })),
      h('div', { class: 'home-meta' }, h('div', { class: 'home-name', title: f.name }, f.name, badge ? h('span', { class: 'home-badge' }, badge) : null), h('div', { class: 'home-sub' }, sub)),
    );
    const open = () => {
      if (!trashed) void srv.openServer(f.id, f.name).then((ok) => ok && this.close());
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => e.key === 'Enter' && open());
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenuAt(e.clientX, e.clientY, trashed ? this.serverTrashMenu(f, srv) : this.serverFileMenu(f, srv));
    });
    return card;
  }

  private serverFileMenu(f: ServerFile, srv: ServerHooks): MenuEntry[] {
    const acc = srv.account;
    const owner = f.role === 'owner';
    const run = (p: Promise<unknown>, done?: string) =>
      void p.then(
        () => {
          if (done) this.hooks.notify(done);
          void this.render();
        },
        (e: Error) => this.hooks.notify(e.message, 'error'),
      );
    return [
      { label: 'Открыть', run: () => void srv.openServer(f.id, f.name).then((ok) => ok && this.close()) },
      { label: 'Поделиться…', run: () => srv.share(f.id) },
      { label: 'Копировать ссылку', run: () => void navigator.clipboard.writeText(acc.fileUrl(f.id)).then(() => this.hooks.notify('Ссылка скопирована')) },
      'sep',
      {
        label: 'Переименовать',
        disabled: !canEdit(f.role),
        run: () => {
          const name = prompt('Новое имя файла:', f.name)?.trim();
          if (name && name !== f.name) run(acc.api('PATCH', `/api/files/${f.id}`, { name }).then(() => srv.renamed(f.id, name)));
        },
      },
      {
        label: 'Переместить…',
        disabled: !owner,
        run: () =>
          void chooseDestination(acc, `Переместить «${f.name}»`, f.projectId).then((to) => {
            if (to !== undefined && to !== f.projectId) run(acc.api('PATCH', `/api/files/${f.id}`, { projectId: to }), `Перемещён: ${acc.projectLabel(to)}`);
          }),
      },
      'sep',
      { label: 'В корзину', disabled: !owner || this.hooks.currentId() === `srv:${f.id}`, run: () => run(acc.api('DELETE', `/api/files/${f.id}`)) },
    ];
  }

  private serverTrashMenu(f: ServerFile, srv: ServerHooks): MenuEntry[] {
    const acc = srv.account;
    const run = (p: Promise<unknown>) => void p.then(() => this.render(), (e: Error) => this.hooks.notify(e.message, 'error'));
    return [
      { label: 'Восстановить', run: () => run(acc.api('POST', `/api/files/${f.id}/restore`)) },
      { label: 'Удалить навсегда', run: () => confirm(`Удалить «${f.name}» навсегда? Файл будет стёрт с сервера для всех.`) && run(acc.api('DELETE', `/api/files/${f.id}?forever=1`)) },
    ];
  }

  private projectCard(p: ProjectRef, srv: ServerHooks): HTMLElement {
    const card = h(
      'div',
      { class: 'home-card folder', role: 'listitem', tabIndex: 0, 'aria-label': `Проект ${p.name}` },
      h('div', { class: 'home-thumb folder' }, h('span', { class: 'home-folder-ic', innerHTML: ICON.folder })),
      h('div', { class: 'home-meta' }, h('div', { class: 'home-name' }, p.name), h('div', { class: 'home-sub' }, 'проект')),
    );
    card.addEventListener('click', () => this.go({ kind: 'project', id: p.id }));
    card.addEventListener('keydown', (e) => e.key === 'Enter' && this.go({ kind: 'project', id: p.id }));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenuAt(e.clientX, e.clientY, this.projectMenu(p, srv));
    });
    return card;
  }

  private teamRank(srv: ServerHooks, teamId: string): number {
    const t = srv.account.teams.find((x) => x.id === teamId);
    return t ? TEAM_RANK[t.role] : 0;
  }

  /** Teams or projects changed: reload the account (sidebar) and re-render. */
  private async refreshServer(srv: ServerHooks, p: Promise<unknown>, then?: View) {
    try {
      await p;
      await srv.account.refresh();
      if (then) this.view = then;
    } catch (e) {
      this.hooks.notify((e as Error).message, 'error');
    }
    await this.render();
  }

  private projectMenu(p: ProjectRef, srv: ServerHooks): MenuEntry[] {
    const acc = srv.account;
    const rank = this.teamRank(srv, p.teamId);
    return [
      { label: 'Открыть', run: () => this.go({ kind: 'project', id: p.id }) },
      { label: 'Новый файл в проекте', disabled: rank < TEAM_RANK.editor, run: () => void srv.newServerFile(p.id).then(() => this.close()) },
      'sep',
      {
        label: 'Переименовать',
        disabled: rank < TEAM_RANK.editor,
        run: () => {
          const name = prompt('Новое имя проекта:', p.name)?.trim();
          if (name && name !== p.name) void this.refreshServer(srv, acc.api('PATCH', `/api/projects/${p.id}`, { name }));
        },
      },
      {
        label: 'Удалить проект',
        disabled: rank < TEAM_RANK.admin,
        run: () => {
          if (confirm(`Удалить проект «${p.name}»? Его файлы уйдут в корзину владельцев.`)) void this.refreshServer(srv, acc.api('DELETE', `/api/projects/${p.id}`), { kind: 'team', id: p.teamId });
        },
      },
    ];
  }

  private teamMenu(t: TeamRef, srv: ServerHooks): MenuEntry[] {
    const acc = srv.account;
    return [
      { label: 'Открыть', run: () => this.go({ kind: 'team', id: t.id }) },
      { label: 'Участники…', run: () => teamDialog(acc, t.id, { notify: this.hooks.notify, changed: () => void this.render() }) },
      { label: 'Интеграции…', disabled: TEAM_RANK[t.role] < TEAM_RANK.admin, run: () => integrationsDialog(acc, t.id, t.name, this.hooks.notify) },
      { label: 'Новый проект…', disabled: TEAM_RANK[t.role] < TEAM_RANK.editor, run: () => void this.newProject(t.id, srv) },
      'sep',
      {
        label: 'Переименовать',
        disabled: TEAM_RANK[t.role] < TEAM_RANK.admin,
        run: () => {
          const name = prompt('Новое имя команды:', t.name)?.trim();
          if (name && name !== t.name) void this.refreshServer(srv, acc.api('PATCH', `/api/teams/${t.id}`, { name }));
        },
      },
    ];
  }

  private async newTeam(srv: ServerHooks) {
    const name = prompt('Название команды:', 'Моя команда')?.trim();
    if (!name) return;
    let id = '';
    await this.refreshServer(
      srv,
      srv.account.api<{ id: string }>('POST', '/api/teams', { name }).then((r) => (id = r.id)),
    );
    if (id) this.go({ kind: 'team', id });
  }

  private async newProject(teamId: string, srv: ServerHooks) {
    const name = prompt('Название проекта:', 'Новый проект')?.trim();
    if (!name) return;
    let id = '';
    await this.refreshServer(
      srv,
      srv.account.api<{ id: string }>('POST', `/api/teams/${teamId}/projects`, { name }).then((r) => (id = r.id)),
    );
    if (id) this.go({ kind: 'project', id });
  }

  // ---------- Desktop: folder on disk ----------

  private async diskEntries(dir: string): Promise<DiskEntry[]> {
    try {
      const list = await disk.listDir(dir);
      return list.filter((e) => e.dir || /\.(mfp|fig)$/i.test(e.name)).sort((a, b) => Number(b.dir) - Number(a.dir) || b.modified - a.modified);
    } catch (e) {
      this.hooks.notify(`Папку не прочитать: ${(e as Error).message}`, 'error');
      return [];
    }
  }

  private diskCard(e: DiskEntry): HTMLElement {
    const card = h(
      'div',
      { class: `home-card${e.dir ? ' folder' : ''}`, role: 'listitem', tabIndex: 0, title: e.path, 'aria-label': e.name },
      h('div', { class: `home-thumb${e.dir ? ' folder' : ''}` }, e.dir ? h('span', { class: 'home-folder-ic', innerHTML: ICON.folder }) : h('span', { class: 'home-thumb-empty', innerHTML: ICON.frame })),
      h('div', { class: 'home-meta' }, h('div', { class: 'home-name' }, e.name.replace(/\.mfp$/i, '')), h('div', { class: 'home-sub' }, e.dir ? 'папка' : `${/\.fig$/i.test(e.name) ? 'Figma · ' : ''}изменён ${relativeTime(e.modified)} · ${(e.size / 2 ** 20).toFixed(1)} МБ`)),
    );
    const open = () => (e.dir ? this.go({ kind: 'disk', dir: e.path }) : void this.hooks.openPath(e.path).then(() => this.close()));
    card.addEventListener('click', open);
    card.addEventListener('keydown', (ev) => ev.key === 'Enter' && open());
    return card;
  }
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
