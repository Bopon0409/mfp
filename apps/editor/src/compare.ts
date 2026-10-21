// Compare changes (developer mode): a layer in the chosen file version and now — side by side or overlaid
// with a slider, changed layers highlighted, on the right — a list: what was added, removed and which
// properties changed. The default version is the one taken when marked “ready for development”.

import { diffSubtree, pageBounds, type Document } from '@mfp/core';
import { h, iconBtn } from './dom.ts';
import type { Editor, Rect } from './editor.ts';

export interface CompareHooks {
  /** File versions, newest first. */
  versions(): Promise<{ id: string; label: string }[]>;
  load(id: string): Promise<Document | null>;
  notify(message: string): void;
}

/** Properties in words (the rest — as is). */
const KEY_LABELS: Record<string, string> = {
  characters: 'текст',
  textRuns: 'оформление текста',
  fills: 'заливка',
  strokes: 'обводка',
  strokeWeight: 'толщина обводки',
  effects: 'эффекты',
  transform: 'положение',
  width: 'ширина',
  height: 'высота',
  name: 'имя',
  visible: 'видимость',
  opacity: 'непрозрачность',
  cornerRadius: 'скругление',
  fontName: 'шрифт',
  fontSize: 'кегль',
  lineHeight: 'интерлиньяж',
  letterSpacing: 'разрядка',
  itemSpacing: 'промежуток',
  paddingLeft: 'отступы',
  paddingRight: 'отступы',
  paddingTop: 'отступы',
  paddingBottom: 'отступы',
  layoutMode: 'раскладка',
  primaryAxisAlignItems: 'выравнивание',
  counterAxisAlignItems: 'выравнивание',
  componentId: 'компонент',
  componentProperties: 'свойства компонента',
  index: 'порядок',
  annotations: 'аннотации',
  devStatus: 'статус',
  boundVariables: 'переменные',
};

export async function openCompare(ed: Editor, id: string, hooks: CompareHooks, versionId?: string) {
  const after = ed.doc;
  const name = after.get(id, 'name') ?? '';
  const versions = await hooks.versions();
  if (!versions.length) {
    hooks.notify('Версий файла пока нет — сравнивать не с чем');
    return;
  }
  const urls: string[] = [];
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
  const select = h('select', { class: 'dv-select cmp-version', 'aria-label': 'Версия для сравнения' }, ...versions.map((v) => h('option', { value: v.id, selected: v.id === versionId }, v.label))) as HTMLSelectElement;
  if (!versionId || !versions.some((v) => v.id === versionId)) select.value = versions[0]!.id;
  let mode: 'side' | 'overlay' = 'side';
  const modeBtn = h('button', { class: 'cbtn' }, 'Наложением');
  const body = h('div', { class: 'cmp-body' }, h('div', { class: 'cmp-empty' }, 'Загрузка версии…'));
  const list = h('div', { class: 'cmp-list', role: 'list' });
  const root = h(
    'div',
    { class: 'cmp', role: 'dialog', 'aria-label': `Сравнение «${name}»` },
    h(
      'div',
      { class: 'cmp-box' },
      h('div', { class: 'cmp-head' }, h('span', { class: 'cmp-title' }, `Изменения «${name}»`), h('span', { class: 'dv-dim' }, 'с версией'), select, modeBtn, iconBtn('close', 'Закрыть (Esc)', close)),
      h('div', { class: 'cmp-main' }, body, list),
    ),
  );
  root.addEventListener('pointerdown', (e) => e.target === root && close());
  document.body.append(root);
  document.addEventListener('keydown', onKey, true);

  let state: { before: { url: string; rect: Rect } | null; after: { url: string; rect: Rect } | null; boxes: { side: 'before' | 'after'; rect: Rect; kind: string; key: string }[] } | null = null;
  let highlighted: string | null = null;

  const pane = (label: string, img: { url: string; rect: Rect } | null, side: 'before' | 'after', clip?: number) => {
    const wrap = h('div', { class: 'cmp-img' });
    if (!img) return h('div', { class: 'cmp-pane' }, h('div', { class: 'cmp-label' }, label), h('div', { class: 'cmp-empty' }, 'В этой версии слоя нет'));
    const pic = h('img', { src: img.url, alt: label, draggable: false });
    wrap.append(pic);
    if (clip !== undefined) wrap.style.clipPath = `inset(0 0 0 ${clip}%)`;
    const [rx0, ry0, rx1, ry1] = img.rect;
    for (const b of state!.boxes.filter((x) => x.side === side)) {
      const left = ((b.rect[0] - rx0) / (rx1 - rx0)) * 100;
      const top = ((b.rect[1] - ry0) / (ry1 - ry0)) * 100;
      const w = ((b.rect[2] - b.rect[0]) / (rx1 - rx0)) * 100;
      const hh = ((b.rect[3] - b.rect[1]) / (ry1 - ry0)) * 100;
      wrap.append(h('div', { class: `cmp-hl ${b.kind}${highlighted === b.key ? ' on' : ''}`, style: `left:${left}%;top:${top}%;width:${w}%;height:${hh}%` }));
    }
    return h('div', { class: 'cmp-pane' }, h('div', { class: 'cmp-label' }, label), wrap);
  };

  const render = () => {
    if (!state) return;
    if (mode === 'side') {
      body.replaceChildren(h('div', { class: 'cmp-side' }, pane('Было', state.before, 'before'), pane('Стало', state.after, 'after')));
      return;
    }
    // Overlay: “after” on top of “before”, the slider reveals the new one from right to left.
    const slider = h('input', { type: 'range', min: '0', max: '100', value: '50', class: 'cmp-slider', 'aria-label': 'Шторка' }) as HTMLInputElement;
    const stack = h('div', { class: 'cmp-stack' });
    const draw = () => {
      const b = pane('Было', state!.before, 'before');
      const a = pane('Стало', state!.after, 'after', Number(slider.value));
      a.classList.add('top');
      stack.replaceChildren(b, a);
    };
    slider.addEventListener('input', draw);
    draw();
    body.replaceChildren(stack, slider);
  };

  const load = async () => {
    body.replaceChildren(h('div', { class: 'cmp-empty' }, 'Загрузка версии…'));
    list.replaceChildren();
    const before = await hooks.load(select.value);
    if (!root.isConnected) return;
    if (!before) {
      body.replaceChildren(h('div', { class: 'cmp-empty' }, 'Версию не удалось открыть'));
      return;
    }
    const img = async (doc: Document) => {
      const r = doc.has(id) ? await ed.renderNode(id, 900, doc) : null;
      if (!r) return null;
      const url = URL.createObjectURL(r.blob);
      urls.push(url);
      return { url, rect: r.rect };
    };
    const [bi, ai] = [await img(before), await img(after)];
    const diff = diffSubtree(before, after, id);
    const boxes: NonNullable<typeof state>['boxes'] = [];
    const items: HTMLElement[] = [];
    const label = (doc: Document, nid: string) => doc.get(nid, 'name') || doc.type(nid) || nid;
    const push = (kind: 'added' | 'removed' | 'changed', doc: Document, nid: string, text: string) => {
      const r = pageBounds(doc, nid);
      const key = `${kind}:${nid}`;
      if (r) boxes.push({ side: kind === 'removed' ? 'before' : 'after', rect: r, kind, key });
      const item = h('button', { class: `cmp-item ${kind}`, role: 'listitem' }, h('span', { class: 'cmp-item-name' }, label(doc, nid)), h('span', { class: 'dv-dim' }, text));
      item.addEventListener('mouseenter', () => {
        highlighted = key;
        render();
      });
      item.addEventListener('mouseleave', () => {
        highlighted = null;
        render();
      });
      items.push(item);
    };
    // Only the topmost of the added and removed: children are inside anyway.
    const top = (ids: string[], doc: Document) => ids.filter((x) => !ids.includes(doc.parent(x) ?? ''));
    for (const nid of top(diff.added, after)) push('added', after, nid, 'добавлен');
    for (const nid of top(diff.removed, before)) push('removed', before, nid, 'удалён');
    for (const c of diff.changed) push('changed', after, c.id, [...new Set(c.keys.map((k) => KEY_LABELS[k] ?? k))].join(', '));
    state = { before: bi, after: ai, boxes };
    const total = diff.added.length + diff.removed.length + diff.changed.length;
    list.replaceChildren(
      h('div', { class: 'cmp-sum' }, total ? `Изменений: ${diff.changed.length}, добавлено: ${top(diff.added, after).length}, удалено: ${top(diff.removed, before).length}` : 'Без изменений'),
      ...items.slice(0, 300),
      ...(items.length > 300 ? [h('div', { class: 'dv-dim' }, `и ещё ${items.length - 300}`)] : []),
    );
    render();
  };
  select.addEventListener('change', () => void load());
  modeBtn.addEventListener('click', () => {
    mode = mode === 'side' ? 'overlay' : 'side';
    modeBtn.textContent = mode === 'side' ? 'Наложением' : 'Рядом';
    render();
  });
  await load();
}
