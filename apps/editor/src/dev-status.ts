// Development statuses: a frame or section is marked “ready for development” or
// “completed”. When marked “ready”, a file version is taken — changes are later compared against it.
// In developer mode on the left — the list of marked items on the page; “Focus” leaves one
// frame on screen (the rest dimmed) with a bar on top: status, compare changes, exit (Esc).

import { devStatusNodes, type DevStatus, type Op } from '@mfp/core';
import type { Canvas, Paint } from 'canvaskit-wasm';
import { h, iconBtn, svgEl } from './dom.ts';
import type { Editor } from './editor.ts';
import { relativeTime } from './home.ts';
import { ICON } from './icons.ts';
import type { MenuEntry } from './menu.ts';

export interface DevStatusHooks {
  /** Take a file version (for comparison); version id or null (no library). */
  markVersion(label: string): Promise<string | null>;
  /** Compare a layer with a version (compare window). */
  compare(id: string, versionId?: string): void;
  notify(message: string): void;
}

export const STATUS_LABEL: Record<DevStatus['type'], string> = { READY_FOR_DEV: 'Готово к разработке', COMPLETED: 'Сделано' };
/** What can be marked: frames, sections, components (on the page and in sections). */
const MARKABLE = new Set(['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP']);

export class DevStatusUI {
  private ed: Editor;
  private hooks: DevStatusHooks;
  private section: HTMLElement;
  private list: HTMLElement;
  private bar: HTMLElement;
  /** Frame in focus (the rest dimmed). */
  focused: string | null = null;
  private shade: Paint | null = null;
  private timer = 0;

  constructor(ed: Editor, hooks: DevStatusHooks, left: HTMLElement, stage: HTMLElement) {
    this.ed = ed;
    this.hooks = hooks;
    this.list = h('div', { class: 'dv-ready', role: 'list' });
    this.section = h('div', { class: 'section', id: 'dev-ready', hidden: true }, h('h3', {}, 'Готово к разработке'), this.list);
    const layers = left.querySelector('#layers-section');
    left.insertBefore(this.section, layers);
    this.bar = h('div', { class: 'focus-bar', hidden: true, role: 'toolbar', 'aria-label': 'Фокус на фрейме' });
    stage.append(this.bar);
    ed.overlays.push((canvas) => this.draw(canvas));
    ed.onPage.push(() => {
      this.unfocus();
      this.refresh();
    });
    ed.onDocument.push((ops) => this.changed(ops));
  }

  /** Whether a layer can be marked (a top-level frame or one in a section, a section, a component). */
  markable(id: string): boolean {
    const doc = this.ed.doc;
    const t = doc.type(id);
    if (!t || !MARKABLE.has(t)) return false;
    const p = doc.parent(id);
    return !!p && (doc.type(p) === 'PAGE' || doc.type(p) === 'SECTION');
  }

  /** Mark (or unmark). “Ready” takes a file version — changes are compared against it. */
  async set(ids: string[], type: DevStatus['type'] | null, description?: string) {
    const doc = this.ed.doc;
    const targets = ids.filter((id) => this.markable(id));
    if (!targets.length) return;
    doc.transact(() => {
      for (const id of targets) doc.set(id, { devStatus: type ? { type, updated: Date.now(), ...(description ? { description } : {}) } : null });
    });
    if (type === 'READY_FOR_DEV') {
      const name = targets.length === 1 ? (doc.get(targets[0]!, 'name') ?? '') : `${targets.length} фреймов`;
      const version = await this.hooks.markVersion(`Готово к разработке: ${name}`);
      if (version) doc.transact(() => targets.forEach((id) => doc.has(id) && doc.set(id, { devStatus: { ...doc.get(id, 'devStatus')!, versionId: version } })));
    }
    this.hooks.notify(type ? `${STATUS_LABEL[type]}: ${targets.length === 1 ? `«${doc.get(targets[0]!, 'name') ?? ''}»` : `${targets.length} фреймов`}` : 'Отметка снята');
  }

  /** Status menu items for the selection (context menu, inspect). */
  menuItems(ids: string[]): MenuEntry[] {
    const doc = this.ed.doc;
    const ok = ids.filter((id) => this.markable(id));
    if (!ok.length) return [];
    const st = ok.map((id) => doc.get(id, 'devStatus')?.type ?? null);
    const all = (t: DevStatus['type']) => st.every((s) => s === t);
    return [
      { label: 'Готово к разработке', checked: all('READY_FOR_DEV'), icon: ICON.code, run: () => void this.set(ok, all('READY_FOR_DEV') ? null : 'READY_FOR_DEV') },
      { label: 'Сделано', checked: all('COMPLETED'), run: () => void this.set(ok, all('COMPLETED') ? null : 'COMPLETED') },
    ];
  }

  private changed(ops: Op[]) {
    if (!this.ed.devMode) return;
    if (!ops.some((o) => (o.op === 'set' && ('devStatus' in o.props || 'name' in o.props)) || o.op === 'delete' || o.op === 'create')) return;
    if (this.focused && !this.ed.doc.has(this.focused)) this.unfocus();
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 100);
  }

  /** List of marked items on the page (on the left, in developer mode). */
  refresh() {
    const ed = this.ed;
    this.section.hidden = !ed.devMode;
    if (!ed.devMode) return;
    const doc = ed.doc;
    const ids = devStatusNodes(doc, ed.pageId);
    if (!ids.length) {
      this.list.replaceChildren(h('div', { class: 'empty' }, 'На странице нет фреймов «Готово к разработке». Отметить — правый щелчок по фрейму или в инспекте.'));
      return;
    }
    this.list.replaceChildren(
      ...ids.map((id) => {
        const st = doc.get(id, 'devStatus')!;
        const icon = svgEl('span', { class: `dv-st ${st.type === 'COMPLETED' ? 'done' : 'ready'}`, title: STATUS_LABEL[st.type] }, st.type === 'COMPLETED' ? ICON.check : ICON.code);
        return h(
          'div',
          { class: `dv-ready-item${this.focused === id ? ' on' : ''}`, role: 'listitem' },
          icon,
          h(
            'button',
            {
              class: 'dv-ready-name',
              title: `${STATUS_LABEL[st.type]}${st.updated ? `, ${relativeTime(st.updated)}` : ''} — показать`,
              onclick: () => {
                ed.select([id]);
                ed.fitRect(ed.selectionBounds([id]));
              },
            },
            doc.get(id, 'name') ?? '',
          ),
          iconBtn('target', 'Фокус: только этот фрейм', () => this.focus(id), 'icon-btn sm'),
        );
      }),
    );
  }

  // ---------- Focus ----------

  focus(id: string) {
    const ed = this.ed;
    if (!ed.doc.has(id)) return;
    this.focused = id;
    const b = ed.selectionBounds([id]);
    if (b) {
      const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.06;
      ed.fitRect([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]);
    }
    ed.select([id]);
    this.renderBar();
    this.refresh();
    ed.dirty = true;
  }

  /** Exit focus (true — there was focus). */
  unfocus(): boolean {
    if (!this.focused) return false;
    this.focused = null;
    this.bar.hidden = true;
    this.ed.dirty = true;
    this.refresh();
    return true;
  }

  private renderBar() {
    const id = this.focused;
    if (!id) return;
    const doc = this.ed.doc;
    const st = doc.get(id, 'devStatus');
    this.bar.hidden = false;
    this.bar.replaceChildren(
      h('span', { class: 'focus-name' }, doc.get(id, 'name') ?? ''),
      ...(st ? [h('span', { class: `focus-status ${st.type === 'COMPLETED' ? 'done' : 'ready'}` }, STATUS_LABEL[st.type])] : []),
      h('button', { class: 'cbtn', onclick: () => this.hooks.compare(id, st?.versionId) }, 'Сравнить изменения'),
      h('button', { class: 'cbtn', onclick: () => this.unfocus() }, 'Выйти (Esc)'),
    );
  }

  private draw(canvas: Canvas) {
    const ed = this.ed;
    if (!this.focused || !ed.devMode || !ed.doc.has(this.focused)) return;
    const b = ed.selectionBounds([this.focused]);
    if (!b) return;
    const ck = ed.ck;
    if (!this.shade) {
      this.shade = new ck.Paint();
      this.shade.setColor(ck.Color(20, 20, 20, 0.82));
    }
    const [x0, y0] = ed.worldToScreen(b[0], b[1]);
    const [x1, y1] = ed.worldToScreen(b[2], b[3]);
    const pb = new ck.PathBuilder();
    pb.addRect(ck.LTRBRect(-10, -10, ed.viewW + 10, ed.viewH + 10));
    pb.addRect(ck.LTRBRect(x0, y0, x1, y1));
    const path = pb.detachAndDelete();
    path.setFillType(ck.FillType.EvenOdd);
    canvas.drawPath(path, this.shade);
    path.delete();
  }

  /** In focus, selection is allowed only inside the frame. */
  inScope(id: string): boolean {
    if (!this.focused) return true;
    for (let p: string | null = id; p; p = this.ed.doc.parent(p)) if (p === this.focused) return true;
    return false;
  }
}
