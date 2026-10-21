// Widgets on the canvas (Figma widget API): inserting from the “Plugins” menu, clicks on elements with
// handlers, property menu above the selected widget. Widget code runs in a separate plugin
// sandbox (its own host: regular plugins run alongside); the sandbox starts on the first
// access to a widget of this plugin. The widget's code draws its layers; state lives in the node
// (shared among collaborators).

import type { PluginBundle } from '@mfp/plugin-host';
import type { PluginHost } from '@mfp/plugin-host/browser';
import type { WidgetMenuItem } from '@mfp/core';
import type { Editor } from './editor.ts';
import { h } from './dom.ts';
import type { PluginRegistry } from './plugin-registry.ts';

export class Widgets {
  private ed: Editor;
  private registry: PluginRegistry;
  private make: () => PluginHost;
  private host: PluginHost | null = null;
  private bar: HTMLElement;
  private barFor: string | null = null;
  private notify: (m: string, kind?: 'info' | 'error') => void;

  constructor(ed: Editor, registry: PluginRegistry, make: () => PluginHost, stage: HTMLElement, notify: (m: string, kind?: 'info' | 'error') => void) {
    this.ed = ed;
    this.registry = registry;
    this.make = make;
    this.notify = notify;
    this.bar = h('div', { class: 'widget-bar', hidden: true });
    stage.append(this.bar);
    ed.onSelection.push(() => this.updateBar());
    ed.onCamera.push(() => this.place());
    ed.onDocument.push((ops) => {
      const id = this.barFor;
      if (id && ops.some((o) => o.op !== 'blob' && o.id === id)) this.updateBar();
    });
  }

  /** Another document: the widget sandbox restarts on first access. */
  rebind() {
    this.host?.stop();
    this.host = null;
    this.updateBar();
  }

  private ensure(bundle: PluginBundle): PluginHost {
    this.host ??= this.make();
    if (this.host.pluginId !== bundle.manifest.id) this.host.run(bundle, { deferRun: true });
    return this.host;
  }

  private async bundleOf(widget: string): Promise<PluginBundle | null> {
    const w = this.ed.doc.get(widget, 'widget');
    if (!w) return null;
    const p = (await this.registry.list()).find((x) => x.bundle.manifest.id === w.pluginId);
    if (!p) this.notify(`Виджет «${w.name}»: плагин не установлен — виджет показывает последнее состояние`, 'error');
    return p?.bundle ?? null;
  }

  /** Place the widget at the center of the visible area. */
  insert(bundle: PluginBundle) {
    const ed = this.ed;
    if (ed.devMode) return;
    const v = ed.viewportRect();
    const id = ed.doc.create('FRAME', ed.pageId, {
      name: bundle.manifest.name,
      transform: [1, 0, Math.round((v[0] + v[2]) / 2 - 60), 0, 1, Math.round((v[1] + v[3]) / 2 - 30)],
      width: 120,
      height: 60,
      fills: [],
      widget: { pluginId: bundle.manifest.id, name: bundle.manifest.name, state: {} },
    });
    ed.select([id]);
    this.ensure(bundle).widget({ action: 'render', nodeId: id });
  }

  async click(widget: string, path: string) {
    const b = await this.bundleOf(widget);
    if (b && !this.ed.devMode) this.ensure(b).widget({ action: 'event', nodeId: widget, path, kind: 'onClick' });
  }

  /** Widget Input field: a real field over the text; Enter (without Shift) or blur — onTextEditEnd, Esc — cancel. */
  async editInput(widget: string, path: string, node: string) {
    const ed = this.ed;
    const b = await this.bundleOf(widget);
    const box = ed.selectionBounds([node]);
    if (!b || !box || ed.devMode) return;
    const [x0, y0] = ed.worldToScreen(box[0], box[1]);
    const [x1, y1] = ed.worldToScreen(box[2], box[3]);
    const r = ed.canvasEl.getBoundingClientRect();
    const z = ed.camera.zoom;
    const font = ed.doc.get(node, 'fontName') ?? { family: 'Inter', style: 'Regular' };
    const el = h('textarea', { class: 'widget-input', spellcheck: false }) as HTMLTextAreaElement;
    el.value = ed.doc.get(node, 'widgetInput') ?? '';
    Object.assign(el.style, {
      left: `${r.left + x0}px`,
      top: `${r.top + y0}px`,
      width: `${Math.max(60, x1 - x0)}px`,
      height: `${Math.max(20, y1 - y0)}px`,
      font: `${/bold/i.test(font.style) ? 700 : /medium/i.test(font.style) ? 500 : 400} ${(ed.doc.get(node, 'fontSize') ?? 14) * z}px "${font.family}", Inter, system-ui, sans-serif`,
    });
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      el.remove();
      ed.canvasEl.focus();
      if (commit && !ed.devMode) this.ensure(b).widget({ action: 'event', nodeId: widget, path, kind: 'onTextEditEnd', event: { characters: el.value } });
    };
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      }
    });
    el.addEventListener('blur', () => finish(true));
    document.body.append(el);
    el.focus();
    el.select();
  }

  async menu(widget: string, propertyName: string, propertyValue?: unknown) {
    const b = await this.bundleOf(widget);
    if (b && !this.ed.devMode) this.ensure(b).widget({ action: 'menu', nodeId: widget, propertyName, propertyValue });
  }

  // ---------- Property menu ----------

  private updateBar() {
    const ed = this.ed;
    const sel = ed.selection;
    const w = sel.length === 1 ? ed.doc.get(sel[0]!, 'widget') : undefined;
    const items = w?.menu ?? [];
    if (!w || !items.length || ed.devMode) {
      this.bar.hidden = true;
      this.barFor = null;
      return;
    }
    const id = sel[0]!;
    this.barFor = id;
    this.bar.replaceChildren(...items.map((it) => this.item(id, it)));
    this.bar.hidden = false;
    this.place();
  }

  /** Widget icon (SVG) — as an image: third-party code isn't embedded into the page. */
  private icon(svg: string | undefined): HTMLElement | null {
    if (!svg || !/^\s*<svg[\s>]/i.test(svg)) return null;
    const img = h('img', { class: 'wb-icon', alt: '' }) as HTMLImageElement;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return img;
  }

  private item(id: string, it: WidgetMenuItem): HTMLElement {
    const name = it.propertyName ?? '';
    const title = it.tooltip ?? name;
    switch (it.itemType) {
      case 'separator':
        return h('span', { class: 'wb-sep' });
      case 'dropdown': {
        const s = h('select', { title }, ...(it.options ?? []).map((o) => h('option', { value: o.option, selected: o.option === it.selectedOption }, o.label ?? o.option))) as HTMLSelectElement;
        s.addEventListener('change', () => void this.menu(id, name, s.value));
        s.addEventListener('keydown', (e) => e.stopPropagation());
        return s;
      }
      case 'color-selector':
        return h(
          'span',
          { class: 'wb-colors', title },
          ...(it.options ?? []).map((o) =>
            h('button', { class: `wb-color${o.option === it.selectedOption ? ' on' : ''}`, title: o.tooltip ?? o.option, style: `background:${/^#[0-9a-f]{3,8}$/i.test(o.option) ? o.option : '#888'}`, onclick: () => void this.menu(id, name, o.option) }),
          ),
        );
      case 'link':
        return h('button', { class: 'wb-btn', title, onclick: () => it.href && /^https?:\/\//.test(it.href) && window.open(it.href, '_blank', 'noopener') }, this.icon(it.icon) ?? title);
      case 'toggle':
        return h('button', { class: `wb-btn${it.isToggled ? ' on' : ''}`, title, onclick: () => void this.menu(id, name) }, this.icon(it.icon) ?? title);
      default:
        return h('button', { class: 'wb-btn', title, onclick: () => void this.menu(id, name) }, this.icon(it.icon) ?? title);
    }
  }

  /** Above the widget, centered. */
  private place() {
    const id = this.barFor;
    if (!id || this.bar.hidden) return;
    const b = this.ed.selectionBounds([id]);
    if (!b) return;
    const [x0, y0] = this.ed.worldToScreen(b[0], b[1]);
    const [x1] = this.ed.worldToScreen(b[2], b[3]);
    const w = this.bar.offsetWidth;
    this.bar.style.left = `${Math.round((x0 + x1) / 2 - w / 2)}px`;
    this.bar.style.top = `${Math.round(y0 - this.bar.offsetHeight - 14)}px`;
  }
}
