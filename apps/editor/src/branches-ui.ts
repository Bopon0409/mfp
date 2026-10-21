// File branches on the server: list, new branch, open. Inside a branch — “Update from
// main” and “Merge into main…”: comparing with the branch base (a snapshot of main at creation)
// shows what changed in the branch — by screen, side by side “main now” and “branch”; conflicts
// (a layer changed in both) — choose whose version stays. The merge is computed here: main +
// branch in Loro (CRDT), with the values chosen in conflicts on top; an update goes to the server.

import { diffSubtree, pageBounds, screenOf, type Document, type NodeDiff } from '@mfp/core';
import { canEdit, type Account, type ServerFile } from './account.ts';
import { fill, h, iconBtn, modal } from './dom.ts';
import type { Editor, Rect } from './editor.ts';
import { relativeTime } from './home.ts';
import { docFromLoro as docFrom } from './loro-docs.ts';
import { t } from './i18n/index.ts';

type Notify = (message: string, kind?: 'info' | 'error') => void;

export interface BranchesHooks {
  account: Account;
  editor: Editor;
  /** Open server file (id) or null. */
  current(): string | null;
  open(id: string): Promise<boolean>;
  notify: Notify;
}

interface BranchRow {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  created: number;
  modified: number;
  merged: number | null;
}

type Info = ServerFile & { parentId: string | null; mainName: string | null; merged: number | null };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Branches window of the open server file. */
export async function branchesDialog(hooks: BranchesHooks) {
  const { account } = hooks;
  const id = hooks.current();
  if (!id) {
    hooks.notify('Ветки есть у файлов на сервере — загрузите файл: «Поделиться» → «Загрузить на сервер»');
    return;
  }
  const m = modal('Ветки', { cls: 'wide' });
  const render = async () => {
    let info: Info;
    let list: { main: { id: string; name: string }; branches: BranchRow[] };
    try {
      info = await account.api<Info>('GET', `/api/files/${id}`);
      list = await account.api('GET', `/api/files/${id}/branches`);
    } catch (e) {
      hooks.notify(message(e), 'error');
      m.close();
      return;
    }
    const inBranch = !!info.parentId;
    m.setTitle(`Ветки «${list.main.name}»`);
    const name = h('input', { class: 'm-input', placeholder: 'Название ветки (например, «Новая кнопка»)', 'aria-label': 'Название ветки' }) as HTMLInputElement;
    const create = async () => {
      const n = name.value.trim();
      if (!n) return name.focus();
      try {
        const b = await account.api<ServerFile>('POST', `/api/files/${list.main.id}/branches`, { name: n });
        m.close();
        hooks.notify(`Ветка «${n}» создана — правки в ней не трогают основной файл, пока её не сольют`);
        await hooks.open(b.id);
      } catch (e) {
        hooks.notify(message(e), 'error');
      }
    };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && void create());
    const canBranch = !inBranch && canEdit(info.role);
    const row = (b: BranchRow) =>
      h(
        'div',
        { class: 'person' },
        h('span', { class: 'branch-ic', 'aria-hidden': 'true' }, '⑂'),
        h(
          'div',
          { class: 'person-text' },
          h('div', { class: 'person-name' }, `${b.name}${b.id === id ? ' (открыта)' : ''}`),
          h('div', { class: 'person-sub' }, `${b.ownerName} · ${b.merged ? `слита ${relativeTime(b.merged)}` : `изменена ${relativeTime(b.modified)}`}`),
        ),
        b.id === id ? null : h('button', { class: 'm-btn', onclick: () => (m.close(), void hooks.open(b.id)) }, 'Открыть'),
        b.ownerId === account.user?.id || info.role === 'owner'
          ? iconBtn('trash', 'Удалить ветку', async () => {
              if (!confirm(`Удалить ветку «${b.name}»? ${b.merged ? 'Она уже слита.' : 'Её изменения пропадут.'}`)) return;
              try {
                await account.api('DELETE', `/api/files/${b.id}`);
                if (b.id === id) {
                  m.close();
                  await hooks.open(list.main.id);
                } else void render();
              } catch (e) {
                hooks.notify(message(e), 'error');
              }
            })
          : null,
      );
    fill(
      m.body,
      inBranch
        ? h(
            'div',
            { class: 'branch-here' },
            h('p', { class: 'm-note' }, `Вы в ветке «${info.name}» файла «${list.main.name}». Правки ветки не попадают в основной файл, пока её не сольют.`),
            h(
              'div',
              { class: 'm-row' },
              h('button', { class: 'm-btn', onclick: () => (m.close(), void hooks.open(list.main.id)) }, 'Открыть основной'),
              h('span', { style: 'flex:1' }),
              canEdit(info.role) ? h('button', { class: 'm-btn', onclick: () => void updateFromMain(hooks, id, list.main.id).then(() => m.close()) }, 'Обновить из основного') : null,
              h('button', { class: 'm-btn primary', disabled: !!info.merged, onclick: () => (m.close(), void mergeDialog(hooks, id)) }, info.merged ? 'Слита' : 'Слить в основной…'),
            ),
          )
        : null,
      canBranch ? h('div', { class: 'm-row' }, name, h('button', { class: 'm-btn primary', onclick: () => void create() }, 'Создать ветку')) : null,
      !inBranch && !canBranch ? h('p', { class: 'm-note' }, 'Ветки создают те, у кого есть право на правку файла.') : null,
      h('div', { class: 'm-label' }, list.branches.length ? `Ветки (${list.branches.length})` : 'Веток нет'),
      list.branches.length ? h('div', { class: 'm-list' }, ...list.branches.map(row)) : h('p', { class: 'm-note' }, 'Ветка — копия файла для смелых правок: её сравнивают с основным и сливают, когда готово.'),
    );
    if (canBranch) requestAnimationFrame(() => name.focus());
  };
  void render();
}

/** Branch ← main: whatever the branch doesn't have yet goes into it (the CRDT merges it with its edits). */
export async function updateFromMain(hooks: BranchesHooks, branchId: string, mainId: string) {
  const { account } = hooks;
  try {
    const [mainBytes, branchBytes] = await Promise.all([account.api<Uint8Array>('GET', `/api/files/${mainId}/doc`), account.api<Uint8Array>('GET', `/api/files/${branchId}/doc`)]);
    const [main, branch] = await Promise.all([docFrom(mainBytes), docFrom(branchBytes)]);
    const update = main.bridge.loro.export({ mode: 'update', from: branch.bridge.loro.oplogVersion() });
    main.bridge.dispose();
    branch.bridge.dispose();
    await account.api('POST', `/api/files/${branchId}/doc`, update);
    hooks.notify('Ветка обновлена из основного файла');
  } catch (e) {
    hooks.notify(`Не обновилась: ${message(e)}`, 'error');
  }
}

interface Change {
  id: string;
  kind: 'added' | 'removed' | 'changed';
  keys: string[];
}

interface Conflict {
  id: string;
  name: string;
  /** both — changed in both; removedInMain / removedInBranch — deleted in one, changed in the other. */
  kind: 'both' | 'removedInMain' | 'removedInBranch';
  keys: string[];
}

/** Property value for comparison (order — parent and position among siblings). */
function valueOf(doc: Document, id: string, key: string): string {
  if (!doc.has(id)) return '∅';
  if (key === 'index') return `${doc.parent(id)}:${doc.children(doc.parent(id) ?? doc.root).indexOf(id)}`;
  return JSON.stringify((doc.node(id)!.props as Record<string, unknown>)[key]);
}

/** Change group: a screen (frame on the page or in a section), otherwise a top-level layer; null — internal. */
function groupOf(doc: Document, id: string): string | null {
  const s = screenOf(doc, id);
  if (s) return s;
  let n: string | null = id;
  while (n) {
    const p = doc.parent(n);
    if (!p) return null;
    if (doc.type(p) === 'PAGE') return doc.get(p, 'internal') ? null : n;
    n = p;
  }
  return null;
}

/** Branch merge: comparison and choice on conflicts, then into the main file. */
export async function mergeDialog(hooks: BranchesHooks, branchId: string) {
  const { account, editor } = hooks;
  const urls: string[] = [];
  const box = h('div', { class: 'cmp-box' });
  const root = h('div', { class: 'cmp', role: 'dialog', 'aria-label': 'Слияние ветки' }, box);
  const close = () => {
    for (const u of urls) URL.revokeObjectURL(u);
    root.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  root.addEventListener('pointerdown', (e) => e.target === root && close());
  box.append(h('div', { class: 'cmp-empty' }, 'Сравниваю ветку с основным файлом…'));
  document.body.append(root);

  let info: Info;
  let mainBytes: Uint8Array;
  let branchBytes: Uint8Array;
  let baseDoc: Document;
  let mainDoc: Document;
  let branchDoc: Document;
  try {
    info = await account.api<Info>('GET', `/api/files/${branchId}`);
    if (!info.parentId) throw new Error('это не ветка');
    const [base, main, branch] = await Promise.all([
      account.api<Uint8Array>('GET', `/api/files/${branchId}/base`),
      account.api<Uint8Array>('GET', `/api/files/${info.parentId}/doc`),
      account.api<Uint8Array>('GET', `/api/files/${branchId}/doc`),
    ]);
    mainBytes = main;
    branchBytes = branch;
    [baseDoc, mainDoc, branchDoc] = (await Promise.all([docFrom(base), docFrom(main), docFrom(branch)])).map((x) => x.doc) as [Document, Document, Document];
  } catch (e) {
    close();
    hooks.notify(`Сравнить не удалось: ${message(e)}`, 'error');
    return;
  }
  const mainId = info.parentId!;
  const dB: NodeDiff = diffSubtree(baseDoc, branchDoc, branchDoc.root);
  const dM: NodeDiff = diffSubtree(baseDoc, mainDoc, mainDoc.root);

  // Branch changes by screen.
  const groups = new Map<string, Change[]>();
  const other: Change[] = [];
  const add = (doc: Document, c: Change) => {
    const g = groupOf(doc, c.id);
    if (!g) other.push(c);
    else groups.set(g, [...(groups.get(g) ?? []), c]);
  };
  const topOnly = (ids: string[], doc: Document) => ids.filter((x) => !ids.includes(doc.parent(x) ?? ''));
  for (const id of topOnly(dB.added, branchDoc)) add(branchDoc, { id, kind: 'added', keys: [] });
  for (const id of topOnly(dB.removed, baseDoc)) add(baseDoc, { id, kind: 'removed', keys: [] });
  for (const c of dB.changed) add(branchDoc, { id: c.id, kind: 'changed', keys: c.keys });

  // Conflicts: in both the branch and main.
  const mChanged = new Map(dM.changed.map((c) => [c.id, new Set(c.keys)]));
  const mRemoved = new Set(dM.removed);
  const nameOf = (id: string) => branchDoc.get(id, 'name') || mainDoc.get(id, 'name') || baseDoc.get(id, 'name') || id;
  const conflicts: Conflict[] = [];
  for (const c of dB.changed) {
    if (mRemoved.has(c.id)) conflicts.push({ id: c.id, name: nameOf(c.id), kind: 'removedInMain', keys: c.keys });
    const mk = mChanged.get(c.id);
    if (!mk) continue;
    const keys = c.keys.filter((k) => mk.has(k) && valueOf(branchDoc, c.id, k) !== valueOf(mainDoc, c.id, k));
    if (keys.length) conflicts.push({ id: c.id, name: nameOf(c.id), kind: 'both', keys });
  }
  for (const id of dB.removed) if (mChanged.has(id)) conflicts.push({ id, name: nameOf(id), kind: 'removedInBranch', keys: [...mChanged.get(id)!] });
  const choice = new Map<string, 'branch' | 'main'>(conflicts.map((c) => [c.id, 'branch']));

  // Screen images: main now and the branch (with the changes highlighted).
  const shot = async (doc: Document, id: string): Promise<{ url: string; rect: Rect } | null> => {
    if (!doc.has(id)) return null;
    const r = await editor.renderNode(id, 900, doc);
    if (!r) return null;
    const url = URL.createObjectURL(r.blob);
    urls.push(url);
    return { url, rect: r.rect };
  };
  const body = h('div', { class: 'cmp-body' });
  const pane = (label: string, img: { url: string; rect: Rect } | null, boxes: { rect: Rect; kind: string }[]) => {
    if (!img) return h('div', { class: 'cmp-pane' }, h('div', { class: 'cmp-label' }, label), h('div', { class: 'cmp-empty' }, 'Здесь экрана нет'));
    const wrap = h('div', { class: 'cmp-img' }, h('img', { src: img.url, alt: label, draggable: false }));
    const [x0, y0, x1, y1] = img.rect;
    for (const b of boxes) {
      const style = `left:${((b.rect[0] - x0) / (x1 - x0)) * 100}%;top:${((b.rect[1] - y0) / (y1 - y0)) * 100}%;width:${((b.rect[2] - b.rect[0]) / (x1 - x0)) * 100}%;height:${((b.rect[3] - b.rect[1]) / (y1 - y0)) * 100}%`;
      wrap.append(h('div', { class: `cmp-hl ${b.kind}`, style }));
    }
    return h('div', { class: 'cmp-pane' }, h('div', { class: 'cmp-label' }, label), wrap);
  };
  let shown: string | null = null;
  const show = async (screen: string) => {
    shown = screen;
    for (const el of box.querySelectorAll('.merge-screen')) el.classList.toggle('on', (el as HTMLElement).dataset.id === screen);
    body.replaceChildren(h('div', { class: 'cmp-empty' }, 'Рисую…'));
    const changes = groups.get(screen) ?? [];
    const boxes = (doc: Document, kinds: Change['kind'][]) =>
      changes
        .filter((c) => kinds.includes(c.kind) && doc.has(c.id))
        .map((c) => ({ rect: pageBounds(doc, c.id), kind: c.kind }))
        .filter((b): b is { rect: Rect; kind: Change['kind'] } => !!b.rect);
    const [m, b] = [await shot(mainDoc, screen), await shot(branchDoc, screen)];
    if (shown !== screen || !root.isConnected) return;
    body.replaceChildren(h('div', { class: 'cmp-side' }, pane(`Основной «${info.mainName ?? ''}» сейчас`, m, boxes(mainDoc, ['removed', 'changed'])), pane(`Ветка «${info.name}»`, b, boxes(branchDoc, ['added', 'changed']))));
  };

  const labelOf = (id: string) => branchDoc.get(id, 'name') || baseDoc.get(id, 'name') || t('Слой');
  const screenItems = [...groups].map(([screen, changes]) => {
    const added = changes.length === 1 && changes[0]!.id === screen && changes[0]!.kind === 'added';
    const removed = changes.length === 1 && changes[0]!.id === screen && changes[0]!.kind === 'removed';
    const sub = added ? 'новый экран' : removed ? 'удалён' : `изменений: ${changes.length}`;
    const el = h('button', { class: `cmp-item merge-screen ${added ? 'added' : removed ? 'removed' : 'changed'}`, 'data-id': screen, onclick: () => void show(screen) }, h('span', { class: 'cmp-item-name' }, labelOf(screen)), h('span', { class: 'dv-dim' }, sub));
    return el;
  });
  const conflictItems = conflicts.map((c) => {
    const what = c.kind === 'removedInMain' ? 'удалён в основном, изменён в ветке' : c.kind === 'removedInBranch' ? 'удалён в ветке, изменён в основном' : `изменён и там, и там: ${c.keys.join(', ')}`;
    const radio = (side: 'branch' | 'main', label: string) => {
      const input = h('input', { type: 'radio', name: `cf-${c.id}`, checked: choice.get(c.id) === side }) as HTMLInputElement;
      input.addEventListener('change', () => input.checked && choice.set(c.id, side));
      return h('label', { class: 'merge-choice' }, input, label);
    };
    return h(
      'div',
      { class: 'merge-conflict' },
      h('div', { class: 'cmp-item-name' }, c.name),
      h('div', { class: 'dv-dim' }, what),
      h('div', { class: 'merge-choices' }, radio('branch', 'Ветка'), radio('main', 'Основной')),
    );
  });
  const total = dB.added.length + dB.removed.length + dB.changed.length;
  const go = h('button', { class: 'cbtn primary', disabled: !total }, 'Слить') as HTMLButtonElement;
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = 'Сливаю…';
    try {
      // Main + branch: the CRDT merges without loss; on conflicts the chosen values go on top.
      const { doc, bridge } = await docFrom(mainBytes);
      const from = bridge.loro.oplogVersion();
      bridge.importUpdate(branchBytes);
      doc.transact(() => {
        for (const c of conflicts) {
          const src = choice.get(c.id) === 'main' ? mainDoc : branchDoc;
          if (!src.has(c.id)) {
            if (doc.has(c.id)) doc.delete(c.id);
            continue;
          }
          if (!doc.has(c.id)) {
            restore(src, doc, c.id);
            continue;
          }
          const props: Record<string, unknown> = {};
          for (const k of c.keys) if (k !== 'index') props[k] = (src.node(c.id)!.props as Record<string, unknown>)[k];
          if (Object.keys(props).length) doc.set(c.id, props as never);
          const parent = src.parent(c.id);
          if (c.keys.includes('index') && parent && doc.has(parent)) doc.move(c.id, parent, src.children(parent).indexOf(c.id));
        }
      }, 'merge');
      const update = bridge.loro.export({ mode: 'update', from });
      bridge.dispose();
      await account.api('POST', `/api/files/${branchId}/merge`, update);
      close();
      hooks.notify(`Ветка «${info.name}» слита в «${info.mainName ?? 'основной файл'}»`);
      await hooks.open(mainId);
    } catch (e) {
      go.disabled = false;
      go.textContent = 'Слить';
      hooks.notify(`Не слилось: ${message(e)}`, 'error');
    }
  });

  const list = h(
    'div',
    { class: 'cmp-list' },
    h('div', { class: 'cmp-sum' }, total ? `Изменено в ветке экранов: ${groups.size}${other.length ? `, прочего: ${other.length}` : ''}` : 'В ветке нет изменений — сливать нечего'),
    ...screenItems,
    other.length ? h('div', { class: 'dv-dim merge-other' }, `Ещё изменения вне экранов (стили, переменные, страницы): ${other.length}`) : null,
    conflicts.length ? h('div', { class: 'cmp-sum merge-conflicts-head' }, `Конфликты: ${conflicts.length} — чья версия остаётся`) : null,
    ...conflictItems,
  );
  fill(
    box,
    h('div', { class: 'cmp-head' }, h('span', { class: 'cmp-title' }, `Слить «${info.name}» в «${info.mainName ?? ''}»`), go, iconBtn('close', 'Закрыть (Esc)', close)),
    h('div', { class: 'cmp-main' }, body, list),
  );
  const first = groups.keys().next().value;
  if (first) void show(first);
  else body.replaceChildren(h('div', { class: 'cmp-empty' }, total ? 'Изменения — вне экранов: стили, переменные, страницы.' : 'Ветка не отличается от своей базы.'));
}

/** A layer with its subtree from one document into another (with the same ids). */
function restore(src: Document, dst: Document, id: string) {
  const parent = src.parent(id);
  if (!parent || !dst.has(parent)) return;
  const copy = (nid: string, p: string, index?: number) => {
    const n = src.node(nid);
    if (!n) return;
    dst.createWithId(nid, n.type, p, structuredClone(n.props), index);
    for (const c of src.children(nid)) copy(c, nid);
  };
  copy(id, parent, src.children(parent).indexOf(id));
}
