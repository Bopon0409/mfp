// Notifications (bell): mentions, thread replies, file shared with you, team invitation. The list
// comes from the server once a minute and when returning to the tab; click to open the file and
// thread. There can be several buttons (editor top bar, “Files”) — they share one counter.

import type { Account } from './account.ts';
import { avatar, h, iconBtn, popover } from './dom.ts';
import { relativeTime } from './home.ts';

interface Note {
  id: string;
  kind: 'mention' | 'reply' | 'share' | 'team' | string;
  file: { id: string; name: string } | null;
  thread: string | null;
  comment: string | null;
  actor: { name: string; color: string } | null;
  text: string | null;
  created: number;
  read: number | null;
}

export interface NotificationsHooks {
  /** Open a server file and thread (thread null: just the file). */
  open(fileId: string, thread: string | null): void;
  /** A notification without a file (team) — open “Files”. */
  home(): void;
  notify(message: string, kind?: 'info' | 'error'): void;
}

const ROLE: Record<string, string> = { view: 'смотреть', comment: 'комментировать', edit: 'редактировать' };

export class Notifications {
  private account: Account;
  private hooks: NotificationsHooks;
  private buttons: HTMLButtonElement[] = [];
  private items: Note[] = [];
  unread = 0;

  constructor(account: Account, hooks: NotificationsHooks) {
    this.account = account;
    this.hooks = hooks;
    account.onChange.push(() => void this.refresh());
    setInterval(() => document.visibilityState === 'visible' && void this.refresh(), 60_000);
    window.addEventListener('focus', () => void this.refresh());
  }

  /** New bell button (previous ones removed from the page are forgotten). */
  button(cls = 'icon-btn'): HTMLButtonElement {
    this.buttons = this.buttons.filter((b) => b.isConnected);
    const b = iconBtn('bell', 'Уведомления', () => this.open(b), `${cls} bell-btn`);
    b.append(h('span', { class: 'bell-n', 'aria-hidden': 'true' }));
    this.buttons.push(b);
    this.paint();
    return b;
  }

  async refresh() {
    if (!this.account.signedIn) {
      this.items = [];
      this.unread = 0;
      this.paint();
      return;
    }
    try {
      const r = await this.account.api<{ notifications: Note[]; unread: number }>('GET', '/api/notifications');
      this.items = r.notifications;
      this.unread = r.unread;
    } catch {
      // Server unavailable — show what we had.
    }
    this.paint();
  }

  private paint() {
    const on = this.account.signedIn;
    for (const b of this.buttons) {
      b.hidden = !on;
      b.classList.toggle('has', this.unread > 0);
      b.querySelector('.bell-n')!.textContent = this.unread ? (this.unread > 9 ? '9+' : String(this.unread)) : '';
      b.title = this.unread ? `Уведомления: непрочитанных ${this.unread}` : 'Уведомления';
    }
  }

  private line(n: Note): string {
    const who = n.actor?.name ?? 'Кто-то';
    const file = n.file ? `«${n.file.name}»` : '';
    if (n.kind === 'mention') return `${who} упоминает вас в ${file}`;
    if (n.kind === 'reply') return `${who} отвечает в треде ${file}`;
    if (n.kind === 'share') return `${who} открывает вам ${file}${n.text && ROLE[n.text] ? ` — можно ${ROLE[n.text]}` : ''}`;
    if (n.kind === 'team') return `${who} добавляет вас в команду «${n.text ?? ''}»`;
    return `${who}: ${file}`;
  }

  private async markRead(ids?: string[]) {
    await this.account.api('POST', '/api/notifications/read', ids ? { ids } : {}).catch(() => {});
    void this.refresh();
  }

  private open(anchor: HTMLElement) {
    const { box, close } = popover(anchor, 'notes-pop', { width: 340 });
    if (!box.isConnected) return;
    const render = () => {
      box.replaceChildren(
        h(
          'div',
          { class: 'pop-head row-head' },
          h('span', {}, 'Уведомления'),
          this.unread ? h('button', { class: 'm-link', onclick: () => void this.markRead().then(render) }, 'Прочитать все') : null,
        ),
        this.items.length
          ? h(
              'div',
              { class: 'notes-list' },
              ...this.items.map((n) =>
                h(
                  'button',
                  {
                    class: `note${n.read ? '' : ' unread'}`,
                    onclick: () => {
                      close();
                      if (!n.read) void this.markRead([n.id]);
                      if (n.file) this.hooks.open(n.file.id, n.kind === 'share' ? null : n.thread);
                      else this.hooks.home();
                    },
                  },
                  n.actor ? avatar(n.actor.name, n.actor.color, 'cavatar') : h('span', { class: 'cavatar' }),
                  h(
                    'span',
                    { class: 'note-body' },
                    h('span', { class: 'note-line' }, this.line(n)),
                    n.text && (n.kind === 'mention' || n.kind === 'reply') ? h('span', { class: 'note-text' }, n.text) : null,
                    h('span', { class: 'note-time' }, relativeTime(n.created)),
                  ),
                ),
              ),
            )
          : h('div', { class: 'cpanel-empty' }, 'Уведомлений нет. Здесь появятся упоминания (@), ответы в ваших тредах и открытые вам файлы.'),
      );
    };
    render();
    void this.refresh().then(() => box.isConnected && render());
  }
}
