// “Share”: for a file on the server — access for people (by email, with a role), the project team and via
// link; for a file on this device — upload to the server or a room without accounts.

import { qrSvg } from './qr.ts';
import { FILE_ROLES, whoIs, type Account, type FileRole, type ServerFile } from './account.ts';
import { signIn } from './account-ui.ts';
import { avatar, fill, h, iconBtn, modal } from './dom.ts';

type Notify = (message: string, kind?: 'info' | 'error') => void;

interface Person {
  id: string;
  email: string;
  name: string;
  color: string;
}

interface Access {
  role: FileRole;
  owner: Person | null;
  people: (Person & { role: FileRole })[];
  invites: { id: string; email: string; role: FileRole }[];
  link: { role: FileRole | 'none'; token: string | null };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Account login (server with password sign-in): it can be entered instead of an email. */
const LOGIN = /^[a-z][a-z0-9_-]{2,31}$/;
const LINK_ROLES: [FileRole | 'none', string][] = [
  ['none', 'Только у кого есть доступ'],
  ['view', 'Все со ссылкой могут смотреть'],
  ['comment', 'Все со ссылкой могут комментировать'],
  ['edit', 'Все со ссылкой могут редактировать'],
];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const roleLabel = (r: FileRole) => (r === 'owner' ? 'владелец' : (FILE_ROLES.find(([k]) => k === r)?.[1] ?? r));

/** Access to a file on the server. */
export function shareServerFile(account: Account, fileId: string, notify: Notify) {
  const m = modal('Поделиться', { cls: 'wide' });
  const fail = (e: unknown) => notify(message(e), 'error');
  const after = async (p: Promise<unknown>) => {
    await p.catch(fail);
    await render();
  };
  const copy = (url: string) =>
    navigator.clipboard.writeText(url).then(
      () => notify('Ссылка скопирована'),
      () => prompt('Ссылка на файл:', url),
    );
  const render = async () => {
    let a: Access;
    let f: ServerFile;
    try {
      [a, f] = await Promise.all([account.api<Access>('GET', `/api/files/${fileId}/access`), account.api<ServerFile>('GET', `/api/files/${fileId}`)]);
    } catch (e) {
      fail(e);
      m.close();
      return;
    }
    m.setTitle(`Поделиться «${f.name}»`);
    const owner = a.role === 'owner';
    const me = account.user?.id;
    const select = <T extends string>(options: [T, string][], value: T, label: string, onChange: (v: T) => void) => {
      const s = h('select', { class: 'm-select', 'aria-label': label }, ...options.map(([k, l]) => h('option', { value: k, selected: k === value }, l))) as HTMLSelectElement;
      s.addEventListener('change', () => onChange(s.value as T));
      return s;
    };
    const email = h('input', { class: 'm-input', type: 'text', placeholder: 'Почта или логин — открыть доступ', 'aria-label': 'Почта или логин' }) as HTMLInputElement;
    let inviteRole: FileRole = 'edit';
    const invite = () => {
      const to = email.value.trim().toLowerCase();
      if (!EMAIL.test(to) && !LOGIN.test(to)) return notify('Проверьте почту или логин', 'error');
      void after(account.api<{ invited: boolean }>('POST', `/api/files/${fileId}/access`, { email: to, role: inviteRole }).then((r) => notify(r.invited ? `Приглашение отправлено на ${to}` : `Доступ открыт: ${to}`)));
    };
    email.addEventListener('keydown', (e) => e.key === 'Enter' && invite());
    const person = (p: Person, role: string | HTMLElement, remove?: () => void) =>
      h(
        'div',
        { class: 'person' },
        avatar(p.name, p.color),
        h('div', { class: 'person-text' }, h('div', { class: 'person-name' }, `${p.name}${p.id === me ? ' (вы)' : ''}`), h('div', { class: 'person-sub' }, whoIs(p.email))),
        typeof role === 'string' ? h('span', { class: 'person-role' }, role) : role,
        remove ? iconBtn('close', 'Закрыть доступ', remove) : null,
      );
    const linkOn = a.link.role !== 'none';
    fill(m.body,
      owner ? h('div', { class: 'm-row' }, email, select(FILE_ROLES, inviteRole, 'Роль', (r) => (inviteRole = r)), h('button', { class: 'm-btn primary', onclick: invite }, 'Пригласить')) : null,
      h(
        'p',
        { class: 'm-note' },
        f.teamName ? `Проект «${f.projectName ?? ''}» команды «${f.teamName}»: участники команды видят файл по своей роли в ней.` : 'Черновик: файл видят только владелец и те, кому открыт доступ.',
      ),
      h('div', { class: 'm-label' }, 'Доступ'),
      h(
        'div',
        { class: 'm-list' },
        a.owner ? person(a.owner, 'владелец') : null,
        ...a.people.map((p) =>
          owner
            ? person(p, select(FILE_ROLES, p.role, 'Роль', (r) => void after(account.api('POST', `/api/files/${fileId}/access`, { email: p.email, role: r }))), () => void after(account.api('DELETE', `/api/files/${fileId}/access/${p.id}`)))
            : person(p, roleLabel(p.role)),
        ),
        ...a.invites.map((i) =>
          h(
            'div',
            { class: 'person' },
            avatar(i.email, '', 'avatar invite'),
            h('div', { class: 'person-text' }, h('div', { class: 'person-name' }, i.email), h('div', { class: 'person-sub' }, 'приглашение — откроется после входа с этой почтой')),
            h('span', { class: 'person-role' }, roleLabel(i.role)),
            owner ? iconBtn('close', 'Отменить приглашение', () => void after(account.api('DELETE', `/api/files/${fileId}/invites/${i.id}`))) : null,
          ),
        ),
      ),
      h('hr', { class: 'm-sep' }),
      h('div', { class: 'm-label' }, 'Ссылка'),
      h(
        'div',
        { class: 'm-row' },
        owner
          ? select(LINK_ROLES, a.link.role, 'Доступ по ссылке', (r) => void after(account.api('PUT', `/api/files/${fileId}/link`, { role: r })))
          : h('span', { class: 'm-note', style: 'flex:1' }, LINK_ROLES.find(([k]) => k === a.link.role)?.[1] ?? ''),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'm-btn', onclick: () => void copy(account.fileUrl(fileId, linkOn ? a.link.token : null)) }, 'Копировать ссылку'),
      ),
      h('p', { class: 'm-note' }, linkOn ? 'Без входа по ссылке файл можно только смотреть; вошедшие получают роль ссылки (или свою, если она выше).' : 'Ссылка откроет файл тем, у кого уже есть доступ.'),
      // Presentation on a phone: QR code of the presentation link (the file opens straight into presentation).
      h('hr', { class: 'm-sep' }),
      h('div', { class: 'm-label' }, 'Показ на телефоне'),
      (() => {
        const url = `${account.fileUrl(fileId, linkOn ? a.link.token : null)}&present=1`;
        const qr = h('div', { class: 'qr', title: url });
        qr.innerHTML = qrSvg(url, 132);
        return h(
          'div',
          { class: 'qr-box' },
          qr,
          h(
            'div',
            {},
            h('p', { class: 'm-note' }, linkOn ? 'Наведите камеру телефона на код — откроется показ прототипа.' : 'Откроется у тех, у кого есть доступ к файлу (или включите доступ по ссылке).'),
            h('button', { class: 'm-btn', onclick: () => void copy(url) }, 'Копировать ссылку на показ'),
          ),
        );
      })(),
    );
  };
  void render();
}

/** “Share” a file from this device: upload to the server or join a room. */
export function shareLocalFile(account: Account, hooks: { name: string; notify: Notify; upload(): Promise<boolean>; room(): void }) {
  const m = modal(`Поделиться «${hooks.name}»`);
  const render = () => {
    const up = h('button', { class: 'm-btn primary' }, account.signedIn ? 'Загрузить на сервер…' : 'Войти…') as HTMLButtonElement;
    up.addEventListener('click', async () => {
      if (!account.signedIn) {
        if (await signIn(account)) render();
        return;
      }
      up.disabled = true;
      try {
        if (await hooks.upload()) m.close();
      } finally {
        up.disabled = false;
      }
    });
    fill(m.body,
      h('p', { class: 'm-note' }, 'Файл хранится только на этом устройстве. Чтобы работать вместе, загрузите его на сервер: появятся доступ по почте, роли, ссылка и команда.'),
      h('div', { class: 'm-row end' }, up),
      h('hr', { class: 'm-sep' }),
      h('p', { class: 'm-note' }, 'Комната без входа: все, кто знает её имя, правят файл вместе (для проверки на сервере разработки).'),
      h('div', { class: 'm-row end' }, h('button', { class: 'm-btn', onclick: () => (m.close(), hooks.room()) }, 'Комната…')),
    );
  };
  render();
}
