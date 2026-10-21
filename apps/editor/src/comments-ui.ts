// Comments on the canvas. Tool C: click on the canvas — a new thread at that point
// (it is attached to the frame under it and moves with it). Thread pins are over the canvas: in comment
// mode and via Shift+C outside it. Click a pin — the thread: replies, “resolved”, edit and delete;
// a pin can be dragged. On the right in comment mode — the thread list with search.
//
// Where comments come from is decided by the source (comment-store.ts): the document (file on this device,
// room — author by name) or the server (author — account). Server files also have
// mentions (@ — suggests people with access), reactions and attachments.

import { placePage, placePoint, type Document } from '@mfp/core';
import { authorColor, type Attachment, type CommentItem, type CommentStore, type Person } from './comment-store.ts';
import { fill, h, iconBtn, popover } from './dom.ts';
import { ICON } from './icons.ts';
import type { Editor } from './editor.ts';
import { relativeTime } from './home.ts';
import { showMenu } from './menu.ts';
import { t } from './i18n/index.ts';

export interface CommentsHooks {
  /** Author: name (without an account — the participant's name; named — set, otherwise we ask) and color. */
  me(): { name: string; named: boolean; color?: string };
  setName(name: string): void;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Exit comment mode (panel button, Esc). */
  exit(): void;
  /** Comment source of the document: server file — the server, otherwise the document itself. */
  storeFor(doc: Document): CommentStore;
}

const EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '🔥', '✅', '😮', '😢'];
const initial = (name: string) => (name.trim()[0] ?? '?').toUpperCase();
const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
const replies = (n: number) => `${n} ${plural(n, 'ответ', 'ответа', 'ответов')}`;
const size = (n: number) => (n < 1024 ? `${n} Б` : n < 2 ** 20 ? `${Math.round(n / 1024)} КБ` : `${(n / 2 ** 20).toFixed(1)} МБ`);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Pin size; the thread point is its bottom left corner. */
const PIN = 28;
/** Pin tail: the tip is the comment point (below the center of the circle). */
const TAIL = 6;
/** The toolbar is at the bottom: thread windows don't cover it. */
const BOTTOM = 64;

/**
 * Comment input field: Enter — send, Shift+Enter — new line, Esc — close; grows with the
 * text. For a server file: “@” — people suggestions (mention), paperclip and paste — attachments.
 */
class Composer {
  readonly el: HTMLElement;
  readonly text: HTMLTextAreaElement;
  private store: CommentStore;
  /** Mentioned: name → person (in the text — “@Name”). */
  private mentioned = new Map<string, { id: string; name: string }>();
  private files: Attachment[] = [];
  private pending = 0;
  private chips: HTMLElement;
  private pop: HTMLElement | null = null;
  private matches: Person[] = [];
  private active = 0;
  private notify: CommentsHooks['notify'];
  onInput: (() => void) | null = null;

  constructor(
    store: CommentStore,
    opts: { placeholder: string; value?: string; mentions?: { id: string; name: string }[]; submit: () => void; cancel: () => void; notify: CommentsHooks['notify'] },
  ) {
    this.store = store;
    this.notify = opts.notify;
    for (const m of opts.mentions ?? []) this.mentioned.set(m.name, m);
    const t = h('textarea', { class: 'cfield', placeholder: opts.placeholder, 'aria-label': opts.placeholder, rows: 1, value: opts.value ?? '' }) as HTMLTextAreaElement;
    this.text = t;
    const grow = () => {
      t.style.height = 'auto';
      t.style.height = `${Math.min(160, t.scrollHeight + 2)}px`;
      t.style.overflowY = t.scrollHeight + 2 > 160 ? 'auto' : 'hidden';
    };
    t.addEventListener('input', () => {
      grow();
      void this.suggest();
      this.onInput?.();
    });
    t.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (this.pop && this.matches.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.matches.length) % this.matches.length;
          this.renderPop();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          this.pick(this.matches[this.active]!);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closePop();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        opts.submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        opts.cancel();
      }
    });
    t.addEventListener('blur', () => setTimeout(() => this.closePop(), 150));
    this.chips = h('div', { class: 'catt-chips' });
    const server = store.kind === 'server';
    if (server && store.upload) {
      t.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        for (const f of files) void this.attach(f);
      });
    }
    this.clip = server && store.upload ? iconBtn('attach', 'Прикрепить файл (до 20 МБ)', () => this.choose(), 'icon-btn sm') : null;
    this.el = h('div', { class: 'ccomposer' }, t, this.chips);
    setTimeout(grow);
  }

  private clip: HTMLElement | null = null;

  /** Row under the field: emoji, “@”, attachment — on the left, round “send” — on the right. */
  bar(send: HTMLElement): HTMLElement {
    const insert = (text: string) => {
      const t = this.text;
      t.focus();
      t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end');
      t.dispatchEvent(new Event('input'));
    };
    const emoji = iconBtn('smile', 'Эмодзи', (e) => {
      const { box, close } = popover(e.currentTarget as HTMLElement, 'cemoji-pop');
      box.append(...EMOJI.map((x) => h('button', { class: 'cemoji', title: x, onclick: () => (close(), insert(x)) }, x)));
    }, 'icon-btn sm');
    const at = h('button', { class: 'icon-btn sm cat-btn', title: 'Упомянуть (@)', 'aria-label': 'Упомянуть' }, '@');
    at.addEventListener('click', () => insert(this.text.value && !/\s$/.test(this.text.value.slice(0, this.text.selectionStart)) ? ' @' : '@'));
    const bar = h('div', { class: 'ccomposer-bar' }, emoji, at, this.clip, h('span', { class: 'ccomposer-gap' }), send);
    this.el.append(bar);
    return bar;
  }

  get value() {
    return this.text.value.trim();
  }

  /** Mentioned people whose “@Name” is still in the text. */
  get mentions(): string[] {
    const text = this.text.value;
    return [...this.mentioned.values()].filter((m) => text.includes(`@${m.name}`)).map((m) => m.id);
  }

  get attachments(): string[] {
    return this.files.map((f) => f.id);
  }

  /** There is something to send (and attachments are already uploaded). */
  get ready() {
    return this.pending === 0 && (!!this.value || this.files.length > 0);
  }

  focus() {
    this.text.focus();
    this.text.setSelectionRange(this.text.value.length, this.text.value.length);
  }

  clear() {
    this.text.value = '';
    this.files = [];
    this.mentioned.clear();
    this.chips.replaceChildren();
    this.text.dispatchEvent(new Event('input'));
  }

  private choose() {
    const input = h('input', { type: 'file', multiple: true }) as HTMLInputElement;
    input.addEventListener('change', () => {
      for (const f of input.files ?? []) void this.attach(f);
    });
    input.click();
  }

  private async attach(file: File) {
    if (file.size > 20 * 2 ** 20) {
      this.notify(`«${file.name}» больше 20 МБ`, 'error');
      return;
    }
    const chip = h('span', { class: 'catt-chip loading' }, file.name);
    this.chips.append(chip);
    this.pending++;
    this.onInput?.();
    try {
      const a = await this.store.upload!(file, file.name || 'вставка.png');
      this.files.push(a);
      chip.classList.remove('loading');
      chip.replaceChildren(
        h('span', {}, `${a.name} · ${size(a.size)}`),
        iconBtn('close', 'Убрать', () => {
          this.files = this.files.filter((x) => x !== a);
          chip.remove();
          this.onInput?.();
        }, 'icon-btn sm'),
      );
    } catch (e) {
      chip.remove();
      this.notify(`Файл не прикрепился: ${message(e)}`, 'error');
    } finally {
      this.pending--;
      this.onInput?.();
    }
  }

  // ---------- Mentions ----------

  private async suggest() {
    if (!this.store.people) return;
    const t = this.text;
    const before = t.value.slice(0, t.selectionStart);
    const m = /(?:^|\s)@([^\s@]{0,40})$/u.exec(before);
    if (!m) return this.closePop();
    const q = m[1]!.toLowerCase();
    const me = this.store.me();
    const people = (await this.store.people()).filter((p) => p.id !== me);
    this.matches = people.filter((p) => !q || p.name.toLowerCase().includes(q) || p.email?.toLowerCase().startsWith(q)).slice(0, 6);
    if (!this.matches.length) return this.closePop();
    this.active = Math.min(this.active, this.matches.length - 1);
    this.renderPop();
  }

  private renderPop() {
    if (!this.pop) {
      this.pop = h('div', { class: 'cmention-pop', role: 'listbox', 'aria-label': 'Упомянуть' });
      this.el.append(this.pop);
    }
    this.pop.replaceChildren(
      ...this.matches.map((p, i) =>
        h(
          'button',
          {
            class: `cmention-item${i === this.active ? ' on' : ''}`,
            role: 'option',
            'aria-selected': String(i === this.active),
            onmousedown: (e: MouseEvent) => {
              e.preventDefault();
              this.pick(p);
            },
          },
          h('span', { class: 'cavatar', style: `background:${p.color}` }, initial(p.name)),
          h('span', { class: 'cmention-name' }, p.name),
          p.email ? h('span', { class: 'cmention-mail' }, p.email) : null,
        ),
      ),
    );
  }

  private closePop() {
    this.pop?.remove();
    this.pop = null;
    this.matches = [];
    this.active = 0;
  }

  /** Insert “@Name ” in place of the typed “@…”. */
  private pick(p: Person) {
    const t = this.text;
    const caret = t.selectionStart;
    const before = t.value.slice(0, caret).replace(/@([^\s@]{0,40})$/u, `@${p.name} `);
    t.value = before + t.value.slice(caret);
    t.setSelectionRange(before.length, before.length);
    this.mentioned.set(p.name, { id: p.id, name: p.name });
    this.closePop();
    t.dispatchEvent(new Event('input'));
    t.focus();
  }
}

export class Comments {
  private ed: Editor;
  private hooks: CommentsHooks;
  private store: CommentStore;
  private layer: HTMLElement;
  private panel: HTMLElement;
  private listEl: HTMLElement;
  private pins = new Map<string, HTMLButtonElement>();
  /** Pins are visible outside comment mode too (Shift+C). */
  private shown = false;
  private showResolved = false;
  private allPages = false;
  private query = '';
  private opened: { id: string; box: HTMLElement; reply: Composer | null } | null = null;
  private draft: { at: [number, number]; box: HTMLElement; pin: HTMLElement; composer: Composer } | null = null;
  /** The comment being edited in the open thread; deleting a thread waits for confirmation. */
  private editing: string | null = null;
  private confirming = false;
  private busy = false;
  /** Pin being dragged: offset on screen. */
  private dragging: { id: string; dx: number; dy: number } | null = null;
  private offStore: (() => void) | null = null;

  constructor(ed: Editor, hooks: CommentsHooks, stage: HTMLElement, side: HTMLElement) {
    this.ed = ed;
    this.hooks = hooks;
    this.layer = h('div', { id: 'comments' });
    stage.append(this.layer);
    this.listEl = h('div', { class: 'cpanel-list', role: 'list' });
    const search = h('input', { class: 'cpanel-search', type: 'search', placeholder: 'Поиск по комментариям', 'aria-label': 'Поиск по комментариям' }) as HTMLInputElement;
    search.addEventListener('keydown', (e) => e.stopPropagation());
    search.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.renderList();
    });
    this.panel = h(
      'div',
      { class: 'cpanel', hidden: true, role: 'region', 'aria-label': 'Комментарии' },
      h(
        'div',
        { class: 'cpanel-head' },
        h('span', { class: 'cpanel-title' }, 'Комментарии'),
        iconBtn('settings', 'Что показывать', (e) => this.filterMenu(e.currentTarget as HTMLElement)),
        iconBtn('close', 'Закрыть (Esc)', () => hooks.exit()),
      ),
      h('div', { class: 'cpanel-search-row' }, search),
      this.listEl,
      h('div', { class: 'cpanel-note' }, 'Щелчок по холсту — новый комментарий; значок можно перетащить. Shift+C — значки на холсте и вне этого режима.'),
    );
    side.append(this.panel);
    this.store = hooks.storeFor(ed.doc);
    this.bindStore();
    ed.overlays.push(() => this.place());
    ed.onPage.push(() => {
      // Another document — another comment source.
      if (this.store.doc !== ed.doc) this.setStore(hooks.storeFor(ed.doc));
      this.reset();
    });
    // Anchors move — pins follow; the source notices comments in the document itself.
    ed.onDocument.push(() => this.visible && this.syncPins());
  }

  get mode() {
    return this.ed.tool === 'comment';
  }

  private get visible() {
    return this.mode || this.shown;
  }

  /** Comment source of the open document. */
  get source(): CommentStore {
    return this.store;
  }

  /** Change the source (a server file was opened or closed). */
  setStore(store: CommentStore) {
    if (store === this.store) return;
    this.offStore?.();
    this.store.dispose();
    this.store = store;
    this.bindStore();
    this.reset();
  }

  private bindStore() {
    const cb = () => this.storeChanged();
    this.store.onChange.push(cb);
    const store = this.store;
    this.offStore = () => {
      const i = store.onChange.indexOf(cb);
      if (i >= 0) store.onChange.splice(i, 1);
    };
  }

  /** Comment mode was turned on or off (tool change). */
  setMode(on: boolean) {
    if (this.panel.hidden === !on) return;
    this.panel.hidden = !on;
    if (!on) {
      this.cancelDraft();
      if (!this.shown) this.closeThread();
    }
    this.syncPins();
    this.renderList();
  }

  /** Shift+C: pins on the canvas outside comment mode. */
  toggleShown() {
    this.shown = !this.shown;
    if (!this.visible) this.closeThread();
    this.syncPins();
    this.hooks.notify(this.shown ? 'Комментарии на холсте показаны (Shift+C — скрыть)' : 'Комментарии на холсте скрыты');
  }

  /** Esc: close a new comment or thread (true — there was something to close). */
  escape(): boolean {
    if (this.draft) {
      this.cancelDraft();
      return true;
    }
    if (this.opened) {
      this.closeThread(true);
      return true;
    }
    return false;
  }

  // ---------- Pointer on the canvas (comment mode) ----------

  /** Click on the canvas — a new thread at that point. */
  down(e: PointerEvent, x: number, y: number): boolean {
    if (!this.mode) return false;
    if (e.button !== 0) return true;
    // Don't lose text already typed: the window stays and blinks.
    if (this.draft?.composer.value || this.draft?.composer.attachments.length) {
      this.draft.box.classList.remove('flash');
      void this.draft.box.offsetWidth;
      this.draft.box.classList.add('flash');
      this.draft.composer.focus();
      return true;
    }
    if (this.opened) {
      this.closeThread();
      return true;
    }
    if (!this.store.canWrite()) {
      this.hooks.notify('Комментировать этот файл нельзя: доступ только на просмотр');
      return true;
    }
    this.startDraft([x, y]);
    return true;
  }

  move(): boolean {
    return this.mode;
  }

  up(): boolean {
    return this.mode;
  }

  // ---------- New thread ----------

  private startDraft(at: [number, number]) {
    this.cancelDraft();
    const local = this.store.kind === 'local';
    const me = this.hooks.me();
    const pin = h('div', { class: 'cpin draft', style: `--c:${this.myColor()}`, 'aria-hidden': 'true' }, initial(me.name));
    const name = local && !me.named ? (h('input', { class: 'cfield', placeholder: 'Ваше имя (увидят другие)', 'aria-label': 'Ваше имя' }) as HTMLInputElement) : null;
    name?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') composer.focus();
      if (e.key === 'Escape') this.cancelDraft();
    });
    const send = sendButton(() => void submit());
    const composer = new Composer(this.store, { placeholder: 'Добавить комментарий', submit: () => void submit(), cancel: () => this.cancelDraft(), notify: this.hooks.notify });
    composer.onInput = () => (send.disabled = !composer.ready);
    const submit = async () => {
      if (!composer.ready || this.busy) return;
      const n = name?.value.trim();
      if (n) this.hooks.setName(n);
      this.busy = true;
      send.disabled = true;
      try {
        const id = await this.store.create(this.ed.pageId, at, this.anchorAt(at), composer.value, { mentions: composer.mentions, attachments: composer.attachments });
        this.cancelDraft();
        this.openThread(id, false);
      } catch (e) {
        this.hooks.notify(`Комментарий не отправлен: ${message(e)}`, 'error');
        send.disabled = false;
      } finally {
        this.busy = false;
      }
    };
    composer.bar(send);
    const box = h(
      'div',
      { class: 'cthread cdraft', role: 'dialog', 'aria-label': 'Новый комментарий' },
      name,
      composer.el,
    );
    this.layer.append(pin, box);
    this.draft = { at, box, pin, composer };
    this.place();
    if (name) name.focus();
    else composer.focus();
  }

  private myColor() {
    const me = this.hooks.me();
    return me.color ?? authorColor(me.name);
  }

  private cancelDraft() {
    if (!this.draft) return;
    this.draft.box.remove();
    this.draft.pin.remove();
    this.draft = null;
    if (this.mode) this.ed.canvasEl.focus();
  }

  /** The layer the thread moves with: the top-level frame under the point (in a section — the frame in it). */
  private anchorAt([x, y]: [number, number]): string | null {
    const ed = this.ed;
    const path = ed.scene
      .hitPath(x, y, 0)
      .map((n) => ed.scene.id(n))
      .filter((id): id is string => !!id);
    return path.find((id) => ed.doc.type(id) !== 'SECTION') ?? path[path.length - 1] ?? null;
  }

  // ---------- Thread ----------

  /** Open a thread (focusReply — cursor in the reply field). */
  openThread(id: string, focusReply = true) {
    this.cancelDraft();
    if (this.opened?.id !== id) {
      this.closeThread();
      const box = h('div', { class: 'cthread', role: 'dialog', 'aria-label': 'Тред комментариев' });
      this.opened = { id, box, reply: null };
      this.layer.append(box);
      this.renderThread();
      this.syncPins();
      this.renderList();
    }
    if (focusReply) this.opened?.reply?.focus();
  }

  closeThread(focusPin = false) {
    if (!this.opened) return;
    const id = this.opened.id;
    this.opened.box.remove();
    this.opened = null;
    this.editing = null;
    this.confirming = false;
    this.syncPins();
    this.renderList();
    if (focusPin) (this.pins.get(id) ?? this.ed.canvasEl).focus();
  }

  private toggleThread(id: string) {
    if (this.opened?.id === id) this.closeThread(true);
    else this.openThread(id);
  }

  /** Go to a thread: its page, the point in the center of the screen, the thread open. */
  focusThread(id: string) {
    const ed = this.ed;
    const c = this.store.get(id);
    if (!c) return;
    const page = placePage(ed.doc, c.place ?? undefined);
    if (page && page !== ed.pageId && ed.doc.has(page)) ed.setPage(page);
    const [x, y] = placePoint(ed.doc, c.place ?? undefined);
    const z = ed.camera.zoom;
    ed.setCamera({ zoom: z, x: x - ed.viewW / 2 / z, y: y - ed.viewH / 2 / z });
    this.openThread(id);
  }

  /** Thread from a link or notification: wait for loading, show it (false — no such thread). */
  async reveal(id: string): Promise<boolean> {
    await this.store.ready;
    const c = this.store.get(id);
    const thread = c?.thread ?? (c ? id : null);
    if (!thread) return false;
    if (this.store.get(thread)?.resolved) this.showResolved = true;
    if (!this.visible) this.shown = true;
    this.syncPins();
    this.focusThread(thread);
    return true;
  }

  private run(p: Promise<unknown>, fail = 'Не получилось') {
    void p.catch((e) => this.hooks.notify(`${fail}: ${message(e)}`, 'error'));
  }

  private renderThread() {
    const o = this.opened;
    if (!o) return;
    const store = this.store;
    const root = store.get(o.id);
    if (!root) {
      this.closeThread();
      return;
    }
    // A started reply and focus survive a redraw (other participants' edits).
    const draftReply = o.reply?.text.value ?? '';
    const hadFocus = !!o.reply && document.activeElement === o.reply.text;
    const resolved = root.resolved;
    const items = [root, ...store.replies(o.id)];
    const write = store.canWrite();
    const resolve = write
      ? iconBtn('check', resolved ? 'Открыть снова' : 'Отметить решённым', () => {
          this.run(store.resolve(o.id, !resolved));
          if (!resolved) {
            this.hooks.notify('Тред решён — он скрыт с холста (показать: «Что показывать» → «Решённые»)');
            this.closeThread(true);
          }
        })
      : null;
    resolve?.classList.toggle('on', resolved);
    resolve?.setAttribute('aria-pressed', String(resolved));
    const copyText = () => void navigator.clipboard?.writeText(items.map((x) => `${x.author.name}: ${x.text}`).join('\n\n'));
    let foot: HTMLElement | null = null;
    o.reply = null;
    if (this.confirming) {
      foot = h(
        'div',
        { class: 'cconfirm', role: 'alert' },
        h('span', {}, items.length > 1 ? `Удалить тред и ${replies(items.length - 1)}?` : 'Удалить комментарий?'),
        h(
          'div',
          { class: 'cacts' },
          h('button', { class: 'cbtn', onclick: () => ((this.confirming = false), this.renderThread()) }, 'Отмена'),
          h('button', { class: 'cbtn danger', onclick: () => this.run(store.remove(o.id), 'Не удалилось') }, 'Удалить'),
        ),
      );
    } else if (write) {
      const send = sendButton(() => void submit());
      const reply = new Composer(store, { placeholder: 'Ответить…', value: draftReply, submit: () => void submit(), cancel: () => this.closeThread(true), notify: this.hooks.notify });
      reply.onInput = () => (send.disabled = !reply.ready);
      send.disabled = !reply.ready;
      const submit = async () => {
        if (!reply.ready || this.busy) return;
        const text = reply.value;
        const extra = { mentions: reply.mentions, attachments: reply.attachments };
        this.busy = true;
        try {
          reply.clear();
          await store.reply(o.id, text, extra);
          this.opened?.reply?.focus();
        } catch (e) {
          this.hooks.notify(`Ответ не отправлен: ${message(e)}`, 'error');
          reply.text.value = text;
        } finally {
          this.busy = false;
        }
      };
      o.reply = reply;
      reply.bar(send);
      foot = h('div', { class: 'creply' }, reply.el);
      if (hadFocus) setTimeout(() => reply.focus());
    }
    fill(
      o.box,
      h(
        'div',
        { class: 'cthread-head' },
        h('span', { class: 'cthread-title' }, resolved ? 'Решённый тред' : 'Комментарий'),
        resolve,
        iconBtn('more', 'Ещё', (e) =>
          showMenu(e.currentTarget as HTMLElement, [
            { label: 'Копировать текст', run: copyText },
            ...(store.jira && write
              ? [
                  {
                    label: 'Создать задачу в Jira',
                    run: () =>
                      void store.jira!(o.id).then(
                        (r) => this.hooks.notify(`Задача ${r.key} создана — ссылка в треде`),
                        (e) => this.hooks.notify(`Задача не создана: ${message(e)}`, 'error'),
                      ),
                  },
                ]
              : []),
            ...(store.canDelete(root) ? ['sep' as const, { label: 'Удалить тред', run: () => ((this.confirming = true), this.renderThread()) }] : []),
          ]),
        ),
        iconBtn('close', 'Закрыть (Esc)', () => this.closeThread(true)),
      ),
      h('div', { class: 'cthread-list' }, ...items.map((c) => this.commentEl(c, c.id === o.id))),
      foot,
    );
    this.place();
  }

  private avatar(c: CommentItem) {
    return h('span', { class: 'cavatar', style: `background:${c.author.color}`, 'aria-hidden': 'true' }, initial(c.author.name));
  }

  /** Text with mentions highlighted. */
  private textEl(c: CommentItem): HTMLElement {
    const el = h('div', { class: 'ccomment-text' });
    const names = c.mentions.map((m) => `@${m.name}`).sort((a, b) => b.length - a.length);
    if (!names.length) {
      el.textContent = c.text;
      return el;
    }
    const re = new RegExp(`(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gu');
    for (const part of c.text.split(re)) el.append(names.includes(part) ? h('span', { class: 'cmention' }, part) : part);
    return el;
  }

  /** Reactions: chips (click — toggle own) and “add”. */
  private reactionsEl(c: CommentItem): HTMLElement | null {
    const store = this.store;
    if (!store.react) return null;
    const me = store.me();
    const write = store.canWrite();
    if (!c.reactions.length && !write) return null;
    const toggle = (emoji: string, on: boolean) => this.run(store.react!(c.id, emoji, on), 'Реакция не поставилась');
    const add = write
      ? iconBtn('smile', 'Реакция', (e) => {
          const { box, close } = popover(e.currentTarget as HTMLElement, 'cemoji-pop');
          box.append(
            ...EMOJI.map((emoji) =>
              h('button', {
                class: 'cemoji',
                title: emoji,
                onclick: () => {
                  close();
                  toggle(emoji, true);
                },
              }, emoji),
            ),
          );
        }, 'icon-btn sm creact-add')
      : null;
    return h(
      'div',
      { class: 'creacts' },
      ...c.reactions.map((r) => {
        const mine = !!me && r.users.some((u) => u.id === me);
        return h(
          'button',
          {
            class: `creact${mine ? ' on' : ''}`,
            title: r.users.map((u) => u.name).join(', '),
            'aria-pressed': String(mine),
            disabled: !write,
            onclick: () => toggle(r.emoji, !mine),
          },
          h('span', {}, r.emoji),
          h('span', { class: 'creact-n' }, String(r.users.length)),
        );
      }),
      add,
    );
  }

  /** Attachments: images as thumbnails, the rest as download links. */
  private attachmentsEl(c: CommentItem): HTMLElement | null {
    const store = this.store;
    if (!c.attachments.length || !store.attachmentUrl) return null;
    return h(
      'div',
      { class: 'catts' },
      ...c.attachments.map((a) => {
        const image = /^image\/(png|jpeg|gif|webp)$/.test(a.type);
        const el = image
          ? h('button', { class: 'catt-img', title: `${a.name} · ${size(a.size)}` })
          : h('button', { class: 'catt-file', title: 'Скачать' }, h('span', { class: 'catt-name' }, a.name), h('span', { class: 'catt-size' }, size(a.size)));
        const url = store.attachmentUrl!(a);
        if (image) void url.then((u) => el.append(h('img', { src: u, alt: a.name })), () => el.append(a.name));
        el.addEventListener('click', () =>
          void url.then(
            (u) => {
              const link = h('a', { href: u, target: '_blank', rel: 'noopener', ...(image ? {} : { download: a.name }) }) as HTMLAnchorElement;
              link.click();
            },
            (e) => this.hooks.notify(`Вложение не открылось: ${message(e)}`, 'error'),
          ),
        );
        return el;
      }),
    );
  }

  private commentEl(c: CommentItem, root: boolean): HTMLElement {
    const store = this.store;
    const time = h('span', { class: 'ccomment-time', title: new Date(c.created).toLocaleString('ru-RU') }, relativeTime(c.created) + (c.edited ? ' · изменён' : ''));
    const head = h('div', { class: 'ccomment-head' }, this.avatar(c), h('span', { class: 'ccomment-name' }, c.author.name || t('Гость')), time);
    const actions = [
      ...(store.mine(c) ? [{ label: 'Изменить', run: () => ((this.editing = c.id), this.renderThread()) }] : []),
      ...(store.canDelete(c) ? [{ label: root ? 'Удалить тред' : 'Удалить', run: () => (root ? ((this.confirming = true), this.renderThread()) : this.run(store.remove(c.id), 'Не удалилось')) }] : []),
    ];
    if (actions.length) head.append(iconBtn('more', 'Действия с комментарием', (e) => showMenu(e.currentTarget as HTMLElement, actions), 'icon-btn sm ccomment-more'));
    if (this.editing !== c.id) return h('div', { class: 'ccomment' }, head, c.text ? this.textEl(c) : null, this.attachmentsEl(c), this.reactionsEl(c));
    const done = (save: boolean) => {
      const v = editor.value;
      const mentions = editor.mentions;
      this.editing = null;
      if (save && v && v !== c.text) this.run(store.edit(c.id, v, mentions), 'Не сохранилось');
      this.renderThread();
    };
    const editor = new Composer(store, { placeholder: 'Текст комментария', value: c.text, mentions: c.mentions, submit: () => done(true), cancel: () => done(false), notify: this.hooks.notify });
    setTimeout(() => editor.focus());
    return h(
      'div',
      { class: 'ccomment' },
      head,
      editor.el,
      h('div', { class: 'cacts' }, h('button', { class: 'cbtn', onclick: () => done(false) }, 'Отмена'), h('button', { class: 'cbtn primary', onclick: () => done(true) }, 'Сохранить')),
    );
  }

  // ---------- Pins ----------

  private makePin(id: string): HTMLButtonElement {
    const pin = h('button', { class: 'cpin' }) as HTMLButtonElement;
    pin.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pin.setPointerCapture(e.pointerId);
      const sx = e.clientX;
      const sy = e.clientY;
      const movable = (() => {
        const c = this.store.get(id);
        return !!c && this.store.canMove(c);
      })();
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (!movable || (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4)) return;
        moved = true;
        pin.classList.add('drag');
        this.dragging = { id, dx: ev.clientX - sx, dy: ev.clientY - sy };
        this.place();
      };
      const up = (ev: PointerEvent) => {
        pin.removeEventListener('pointermove', move);
        pin.removeEventListener('pointerup', up);
        pin.removeEventListener('pointercancel', up);
        pin.classList.remove('drag');
        const d = this.dragging;
        this.dragging = null;
        if (moved && d && ev.type === 'pointerup') {
          const c = this.store.get(id);
          const [px, py] = this.ed.worldToScreen(...placePoint(this.ed.doc, c?.place ?? undefined));
          const at = this.ed.screenToWorld(px + d.dx, py + d.dy);
          this.run(this.store.move(id, this.ed.pageId, at, this.anchorAt(at)), 'Тред не перенесён');
        } else if (!moved && ev.type === 'pointerup') this.toggleThread(id);
        this.place();
      };
      pin.addEventListener('pointermove', move);
      pin.addEventListener('pointerup', up);
      pin.addEventListener('pointercancel', up);
    });
    // From the keyboard (Enter, space) — same as a click.
    pin.addEventListener('click', (e) => {
      if (e.detail === 0) this.toggleThread(id);
    });
    return pin;
  }

  /** Page threads (all — without page). */
  private threadsOn(page?: string): CommentItem[] {
    const doc = this.ed.doc;
    const all = this.store.threads();
    return page ? all.filter((c) => placePage(doc, c.place ?? undefined) === page) : all;
  }

  /** Pins of the current page's (visible) threads. */
  private syncPins() {
    const want = new Set<string>();
    if (this.visible) {
      for (const c of this.threadsOn(this.ed.pageId)) {
        const open = this.opened?.id === c.id;
        if (c.resolved && !this.showResolved && !open) continue;
        want.add(c.id);
        let pin = this.pins.get(c.id);
        if (!pin) {
          pin = this.makePin(c.id);
          this.pins.set(c.id, pin);
          this.layer.prepend(pin);
        }
        const n = this.store.replies(c.id).length;
        pin.textContent = initial(c.author.name);
        pin.style.setProperty('--c', c.author.color);
        pin.classList.toggle('resolved', c.resolved);
        pin.classList.toggle('on', open);
        pin.setAttribute('aria-expanded', String(open));
        const text = c.text || (c.attachments.length ? `вложений: ${c.attachments.length}` : '');
        pin.setAttribute('aria-label', `Комментарий ${c.author.name || t('Гость')}: ${text.slice(0, 120)}${n ? `; ${replies(n)}` : ''}${c.resolved ? '; решён' : ''}`);
        pin.title = `${c.author.name || t('Гость')}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
      }
    }
    for (const [id, pin] of this.pins) {
      if (want.has(id)) continue;
      pin.remove();
      this.pins.delete(id);
    }
    if (this.opened && !want.has(this.opened.id)) this.closeThread();
    this.place();
  }

  /** Pins and windows go to their places (after every canvas frame). */
  private place() {
    const ed = this.ed;
    const doc = ed.doc;
    const at = (id: string): [number, number] => {
      const [x, y] = ed.worldToScreen(...placePoint(doc, this.store.get(id)?.place ?? undefined));
      return this.dragging?.id === id ? [x + this.dragging.dx, y + this.dragging.dy] : [x, y];
    };
    for (const [id, pin] of this.pins) {
      const [x, y] = at(id);
      pin.style.transform = `translate(${Math.round(x - PIN / 2)}px, ${Math.round(y - PIN - TAIL)}px)`;
    }
    const box = (el: HTMLElement, x: number, y: number) => {
      const W = this.layer.clientWidth;
      const H = this.layer.clientHeight;
      const w = el.offsetWidth;
      const hh = el.offsetHeight;
      let left = x + PIN / 2 + 8;
      if (left + w > W - 8) left = Math.max(8, x - PIN / 2 - 8 - w);
      const top = Math.max(8, Math.min(y - PIN - TAIL, H - BOTTOM - hh));
      el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    };
    if (this.draft) {
      const [x, y] = ed.worldToScreen(...this.draft.at);
      this.draft.pin.style.transform = `translate(${Math.round(x - PIN / 2)}px, ${Math.round(y - PIN - TAIL)}px)`;
      box(this.draft.box, x, y);
    }
    if (this.opened && this.store.get(this.opened.id)) {
      const [x, y] = at(this.opened.id);
      box(this.opened.box, x, y);
    }
  }

  // ---------- Changes ----------

  private storeChanged() {
    this.syncPins();
    if (this.opened && !this.editing) this.renderThread();
    this.renderList();
  }

  /** Another page or another document. */
  private reset() {
    this.cancelDraft();
    this.closeThread();
    this.syncPins();
    this.renderList();
  }

  // ---------- Panel ----------

  private filterMenu(anchor: HTMLElement) {
    showMenu(anchor, [
      { label: 'Только эта страница', checked: !this.allPages, run: () => ((this.allPages = false), this.renderList()) },
      { label: 'Все страницы', checked: this.allPages, run: () => ((this.allPages = true), this.renderList()) },
      'sep',
      {
        label: 'Решённые',
        checked: this.showResolved,
        run: () => {
          this.showResolved = !this.showResolved;
          this.syncPins();
          this.renderList();
        },
      },
      { label: 'Значки вне режима комментариев', hint: 'Shift+C', checked: this.shown, run: () => this.toggleShown() },
    ]);
  }

  private renderList() {
    if (this.panel.hidden) return;
    const doc = this.ed.doc;
    const store = this.store;
    const q = this.query;
    const match = (c: CommentItem) => c.text.toLowerCase().includes(q) || c.author.name.toLowerCase().includes(q);
    const all = this.threadsOn(this.allPages ? undefined : this.ed.pageId);
    const list = all.filter((c) => (this.showResolved || !c.resolved) && (!q || [c, ...store.replies(c.id)].some(match))).reverse();
    if (!list.length) {
      const text = q
        ? 'Ничего не найдено.'
        : all.length
          ? 'Все треды решены — они скрыты («Что показывать» → «Решённые»).'
          : store.threads().length && !this.allPages
            ? 'На этой странице комментариев нет — они есть на других («Что показывать» → «Все страницы»).'
            : store.canWrite()
              ? 'Комментариев пока нет. Щёлкните по холсту, чтобы оставить первый.'
              : 'Комментариев пока нет.';
      this.listEl.replaceChildren(h('div', { class: 'cpanel-empty' }, text));
      return;
    }
    this.listEl.replaceChildren(
      ...list.map((c) => {
        const n = store.replies(c.id).length;
        const page = this.allPages ? placePage(doc, c.place ?? undefined) : null;
        const sub = [n ? replies(n) : '', page && doc.has(page) ? (doc.get(page, 'name') ?? '') : '', c.attachments.length ? `📎 ${c.attachments.length}` : '', c.resolved ? 'решён' : ''].filter(Boolean).join(' · ');
        return h(
          'button',
          { class: `citem${c.resolved ? ' resolved' : ''}${this.opened?.id === c.id ? ' on' : ''}`, role: 'listitem', onclick: () => this.focusThread(c.id) },
          h('div', { class: 'citem-head' }, this.avatar(c), h('span', { class: 'citem-name' }, c.author.name || t('Гость')), h('span', { class: 'citem-time' }, relativeTime(c.created))),
          h('div', { class: 'citem-text' }, c.text),
          sub ? h('div', { class: 'citem-sub' }, sub) : null,
        );
      }),
    );
  }
}


/** Round blue “send” with an up arrow; Enter does the same. */
function sendButton(run: () => void): HTMLButtonElement {
  const b = h('button', { class: 'csend', title: 'Отправить (Enter)', 'aria-label': 'Отправить', disabled: true, onclick: run }) as HTMLButtonElement;
  b.innerHTML = ICON.arrowDown;
  return b;
}
