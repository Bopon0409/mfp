// “Design check” window: issues on the current page in groups — colors and numbers that exist
// in variables and styles, low contrast, detached components, deleted variables.
// “Show” — select the layer; “Fix” — one issue, “Fix all” — the whole group.

import { LINT_LABEL, lintDesign, type LintIssue, type LintKind } from '@mfp/core';
import type { Editor } from './editor.ts';
import { h } from './dom.ts';

let open: HTMLElement | null = null;

export function openCheckDesigns(ed: Editor) {
  open?.remove();
  const box = h('div', { class: 'fonts-dialog lint-dialog' });
  open = box;
  const close = () => {
    box.remove();
    open = null;
  };
  const show = (id: string) => {
    if (!ed.doc.has(id)) return;
    ed.select([id]);
    const b = ed.selectionBounds([id]);
    if (b) ed.fitRect([b[0] - 60, b[1] - 60, b[2] + 60, b[3] + 60]);
  };
  const render = () => {
    const doc = ed.doc;
    const t0 = performance.now();
    const issues = lintDesign(doc, ed.pageId);
    const ms = Math.round(performance.now() - t0);
    const groups = new Map<LintKind, LintIssue[]>();
    for (const i of issues) {
      const list = groups.get(i.kind) ?? [];
      list.push(i);
      groups.set(i.kind, list);
    }
    const head = h('div', { class: 'fd-head' }, 'Проверка дизайна', h('button', { class: 'pe-close', onclick: close }, '×'));
    const body: HTMLElement[] = [];
    if (!issues.length) body.push(h('p', { class: 'fd-note' }, 'Замечаний нет: цвета и числа — из переменных и стилей, контраст достаточный, отсоединённых компонентов нет.'));
    else body.push(h('p', { class: 'fd-note' }, `Страница «${doc.get(ed.pageId, 'name') ?? ''}»: замечаний ${issues.length}${issues.length >= 2000 ? '+' : ''} · ${ms} мс`));
    for (const [kind, list] of groups) {
      const fixable = list.filter((i) => i.fix);
      const fixAll = fixable.length
        ? h('button', {
            class: 'pe-btn',
            onclick: () => {
              ed.doc.transact(() => fixable.forEach((i) => ed.doc.has(i.id) && i.fix!.apply(ed.doc)));
              render();
            },
          }, `Исправить все (${fixable.length})`)
        : '';
      const rows = list.slice(0, 200).map((i) =>
        h(
          'div',
          { class: 'lint-row' },
          h('div', { class: 'lint-text' }, h('div', { class: 'lint-name' }, ed.doc.get(i.id, 'name') ?? ''), h('div', { class: 'lint-msg' }, i.message)),
          h('button', { class: 'pe-btn', onclick: () => show(i.id) }, 'Показать'),
          i.fix
            ? h('button', {
                class: 'pe-btn primary',
                onclick: () => {
                  ed.doc.transact(() => i.fix!.apply(ed.doc));
                  render();
                },
              }, i.fix.label)
            : '',
        ),
      );
      body.push(h('div', { class: 'lint-group' }, h('div', { class: 'lint-ghead' }, h('span', {}, `${LINT_LABEL[kind]} · ${list.length}`), fixAll), ...rows, list.length > 200 ? h('div', { class: 'empty' }, `…и ещё ${list.length - 200}`) : ''));
    }
    box.replaceChildren(head, h('div', { class: 'lint-body' }, ...body), h('div', { class: 'pop-actions' }, h('button', { class: 'pe-btn', onclick: render }, 'Проверить снова')));
  };
  document.body.append(box);
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  render();
}
