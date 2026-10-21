// Inspect (the right panel in developer mode): layer path, code (CSS,
// Tailwind, SwiftUI, UIKit, Compose, Android XML; px or rem), dimensions and auto layout with a spacing
// diagram, text (and runs with different styling), colors (HEX, RGB, HSL) and effects, variables
// with a collection mode picker (values and code in that mode, the file is not changed), and assets for
// download. Clicking a value copies it.

import { isRaster } from './export.ts';
import {
  CODE_LANGUAGES,
  formatColor,
  generateCode,
  inspectNode,
  styleTokens,
  type CodeLanguage,
  type ColorValue,
  type FillValue,
  type NodeStyle,
  type NumberValue,
  type TextValue,
  type Token,
} from '@mfp/editing';
import { ANNOTATION_COLORS, categoryOf, codeConnectHolder, codeConnectOf, codeConnectPlaceholders, renderCodeConnect, type ExportSetting } from '@mfp/core';
import { showMenu } from './menu.ts';
import { h, iconBtn, popover, svgEl } from './dom.ts';
import type { Editor } from './editor.ts';
import { ICON, NODE_ICON, NODE_LABEL } from './icons.ts';

export interface InspectHooks {
  notify(message: string): void;
  /** Download the layer's files according to its export settings. */
  exportNode(id: string, settings: ExportSetting[]): Promise<void>;
  /** Go to a layer (another page, reveal and select it). */
  goTo(id: string): void;
  /** Dev status: menu items, focus, comparison. */
  status?: { markable(id: string): boolean; menu(ids: string[]): import('./menu.ts').MenuEntry[]; focus(id: string): void; compare(id: string, versionId?: string): void };
  /** Layer annotations: add, edit. */
  annotations?: { add(id: string): void; edit(id: string, index: number): void };
  /** Component playground (live properties, the file is not changed). */
  playground?(id: string): void;
  /** Codegen plugins: their languages (key “plugin:…”) and the layer code. */
  pluginLanguages?(): { key: string; label: string }[];
  pluginCode?(key: string, nodeId: string): Promise<{ title: string; code: string; language: string }[]>;
  /** The “Export” section (as in design mode), at the end of inspect. */
  exportSection?(ids: string[]): HTMLElement | null;
}

/** “Layout” CSS properties (the rest is “style”): code blocks. */
const LAYOUT_CSS = /^(position|left|top|right|bottom|inset|width|height|min-width|max-width|min-height|max-height|display|flex|flex-[a-z-]+|gap|row-gap|column-gap|padding|padding-[a-z]+|margin|margin-[a-z]+|align-[a-z]+|justify-[a-z]+|place-[a-z]+|grid|grid-[a-z-]+|order|overflow|box-sizing|z-index|aspect-ratio)$/;

type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'oklch';
const store = {
  get<T extends string>(key: string, fallback: T, allowed: readonly string[]): T {
    try {
      const v = localStorage.getItem(key);
      return v && allowed.includes(v) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, v: string) {
    try {
      localStorage.setItem(key, v);
    } catch {
      // No storage: until reload.
    }
  },
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const SIZING: Record<string, string> = { FIXED: 'фикс.', HUG: 'по содерж.', FILL: 'заполн.' };
const VECTORISH = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE']);

/** Link label by URL: known services by name, everything else by domain. */
export function resourceName(url: string): string {
  let host = '';
  try {
    host = new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
  const known: [RegExp, string][] = [
    [/github\.com$/, 'GitHub'],
    [/gitlab\./, 'GitLab'],
    [/storybook|chromatic\.com$/, 'Storybook'],
    [/atlassian\.net$|jira/, 'Jira'],
    [/tracker\.yandex/, 'Яндекс Трекер'],
    [/notion\.(so|site)$/, 'Notion'],
    [/confluence/, 'Confluence'],
    [/npmjs\.com$/, 'npm'],
    [/figma\.com$/, 'Figma'],
  ];
  return known.find(([re]) => re.test(host))?.[1] ?? host;
}

export class InspectPanel {
  private ed: Editor;
  private hooks: InspectHooks;
  /** Code language: built-in or a plugin language (“plugin:id:language”). */
  language: string = store.get('mfp-code-lang', 'css', CODE_LANGUAGES.map((l) => l.id));
  unit: 'px' | 'rem' = store.get('mfp-code-unit', 'px', ['px', 'rem']);
  colorFormat: ColorFormat = store.get('mfp-color-format', 'hex', ['hex', 'rgb', 'hsl', 'oklch']);
  nested: 'auto' | 'on' | 'off' = 'auto';
  /** “List | Code” in “Layer properties”. */
  view: 'list' | 'code' = store.get('mfp-dev-view', 'code', ['list', 'code']);
  /** Collapsed inspect sections (by heading). */
  private collapsed = new Set<string>(((): string[] => {
    try {
      return JSON.parse(localStorage.getItem('mfp-dev-collapsed') ?? '[]') as string[];
    } catch {
      return [];
    }
  })());
  /** Collection modes for viewing (collection → mode). */
  modes: Record<string, string> = {};
  /** Asset thumbnails (Blob URLs), released on re-render. */
  private urls: string[] = [];
  /** Re-render the panel (language or mode change). */
  onRefresh: (() => void) | null = null;

  constructor(ed: Editor, hooks: InspectHooks) {
    this.ed = ed;
    this.hooks = hooks;
  }

  private copy(text: string, what = 'Скопировано') {
    void navigator.clipboard?.writeText(text).then(
      () => this.hooks.notify(`${what}: ${text.length > 60 ? text.slice(0, 60) + '…' : text}`),
      () => this.hooks.notify('Не удалось скопировать'),
    );
  }

  /** The value copied on click. */
  private val(text: string, copy = text, title?: string) {
    return h('button', { class: 'dv-val', title: title ?? 'Щелчок — скопировать', onclick: () => this.copy(copy) }, text);
  }

  private row(label: string, ...value: (Node | string | null)[]) {
    return h('div', { class: 'dv-row' }, h('span', { class: 'dv-label' }, label), h('span', { class: 'dv-value' }, ...value.filter((v): v is Node | string => v !== null)));
  }

  private section(title: string, ...body: (Node | null)[]) {
    return h('div', { class: 'section dv-section' }, h('h3', {}, title), ...body.filter((b): b is Node => !!b));
  }

  private token(t: Token | undefined) {
    if (!t) return null;
    return h('button', { class: 'dv-token', title: `Переменная «${t.name}»${t.collection ? ` (${t.collection})` : ''} — щелчок скопирует ${t.web}`, onclick: () => this.copy(t.web) }, t.name);
  }

  private num(v: NumberValue, suffix = '') {
    return [this.val(`${r2(v.value)}${suffix}`), this.token(v.token)];
  }

  private colorRow(label: string, c: ColorValue) {
    const sw = h('span', { class: 'dv-swatch' });
    sw.style.background = `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
    const text = formatColor(c, this.colorFormat);
    return this.row(label, sw, this.val(text), this.token(c.token));
  }

  private fillRows(label: string, fills: FillValue[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const f of fills) {
      if (f.kind === 'solid') out.push(this.colorRow(label, f.color));
      else if (f.kind === 'image') out.push(this.row(label, this.val(`Картинка «${f.name}»`, f.name), h('span', { class: 'dv-dim' }, { FILL: 'заполнить', FIT: 'вписать', CROP: 'обрезать', TILE: 'плиткой' }[f.scaleMode] ?? f.scaleMode)));
      else {
        const kind = { linear: 'Линейный', radial: 'Радиальный', angular: 'Угловой' }[f.kind];
        out.push(this.row(label, h('span', { class: 'dv-dim' }, `${kind} градиент${f.kind === 'linear' ? `, ${f.angle}°` : ''}`)));
        for (const s of f.stops) out.push(this.colorRow(`  ${Math.round(s.position * 100)}%`, s.color));
      }
    }
    return out;
  }

  /** Build the panel in root (panels.ts calls it instead of the design properties). */
  build(root: HTMLElement) {
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    const ed = this.ed;
    const sel = ed.selection.filter((id) => ed.doc.has(id));
    if (!sel.length) {
      root.append(this.section('Инспект', h('div', { class: 'empty' }, 'Выберите слой на холсте или в списке слоёв: здесь будут его размеры, цвета, текст, код и ассеты. Щелчок по значению копирует его.')));
      root.append(this.settingsSection());
      return;
    }
    if (sel.length > 1) {
      root.append(
        this.section(
          `Выделено: ${sel.length}`,
          h('div', { class: 'dv-list' }, ...sel.map((id) => h('button', { class: 'dv-item', onclick: () => ed.select([id]) }, svgEl('span', { class: 'icon' }, NODE_ICON[ed.doc.type(id)!] ?? ICON.rect), h('span', {}, ed.doc.get(id, 'name') ?? '')))),
        ),
      );
      root.append(this.assetsSection(sel));
      return;
    }
    const id = sel[0]!;
    const s = inspectNode(ed.doc, id, { modes: this.modes });
    root.append(this.headSection(s));
    const link = this.componentCodeSection(id);
    if (link) root.append(link);
    root.append(this.propertiesSection(id, s));
    if (s.text) root.append(this.textSection(s.text));
    const colors = this.colorsSection(s);
    if (colors) root.append(colors);
    const fx = this.effectsSection(s);
    if (fx) root.append(fx);
    const vars = this.variablesSection(s);
    if (vars) root.append(vars);
    root.append(this.devResourcesSection(s.id));
    root.append(this.annotationsSection(s.id));
    root.append(this.assetsSection(sel));
    const exp = this.hooks.exportSection?.(sel);
    if (exp) root.append(exp);
    root.append(this.settingsSection());
    this.collapsible(root);
  }

  /** Sections collapse on a click on the heading (arrow on the left); remembered. */
  private collapsible(root: HTMLElement) {
    for (const sec of root.querySelectorAll<HTMLElement>(':scope > .section')) {
      const head = sec.querySelector<HTMLElement>(':scope > h3');
      if (!head) continue;
      const key = (head.firstChild?.textContent ?? head.textContent ?? '').replace(/\s*\(.*\)$/, '').trim();
      if (!key) continue;
      head.classList.add('dv-fold');
      sec.classList.toggle('folded', this.collapsed.has(key));
      head.addEventListener('click', (e) => {
        if ((e.target as Element).closest('button, select, input, .h-acts')) return;
        const on = !this.collapsed.has(key);
        if (on) this.collapsed.add(key);
        else this.collapsed.delete(key);
        sec.classList.toggle('folded', on);
        try {
          localStorage.setItem('mfp-dev-collapsed', JSON.stringify([...this.collapsed]));
        } catch {
          /* will not be remembered */
        }
      });
    }
  }

  /**
   * “Layer properties”: a “padding — size” diagram, “List | Code”;
   * in CSS code, “Layout” and “Style” blocks, each with its own “Copy”.
   */
  private propertiesSection(id: string, s: NodeStyle): HTMLElement {
    const seg = h(
      'div',
      { class: 'seg dv-view' },
      ...(['list', 'code'] as const).map((v) =>
        h('button', {
          class: this.view === v ? 'on' : '',
          onclick: () => {
            if (this.view === v) return;
            this.view = v;
            store.set('mfp-dev-view', v);
            this.onRefresh?.();
          },
        }, v === 'list' ? 'Список' : 'Код'),
      ),
    );
    const code = this.view === 'code' ? this.codeParts(id) : null;
    const top = h('div', { class: 'dv-view-row' }, seg, ...(code ? code.acts : []));
    const body: (HTMLElement | null)[] = code ? code.body : this.layoutRows(s);
    return h('div', { class: 'section dv-section' }, h('h3', {}, 'Свойства слоя'), this.boxModel(s), top, ...body.filter((b): b is HTMLElement => !!b));
  }

  /**
   * Dev resources: a layer has its own, an instance also shows those of its main
   * component (view only). “+” adds one: a URL and, optionally, a name.
   */
  private devResourcesSection(id: string): HTMLElement {
    const doc = this.ed.doc;
    const own = doc.get(id, 'devResources') ?? [];
    // Main layer: for an instance, its component; for a layer inside an instance, the component's layer.
    const main = doc.type(id) === 'INSTANCE' ? doc.get(id, 'componentId') : doc.get(id, 'componentRef');
    const inherited = main && doc.has(main) ? (doc.get(main, 'devResources') ?? []) : [];
    const set = (list: { name: string; url: string }[]) => doc.transact(() => doc.set(id, { devResources: list.length ? list : undefined }));
    const row = (r: { name: string; url: string }, i: number | null) => {
      let host = '';
      try {
        host = new URL(r.url).host.replace(/^www\./, '');
      } catch {
        host = r.url;
      }
      return h(
        'div',
        { class: 'dv-res' },
        svgEl('span', { class: 'prop-ic' }, ICON.link),
        h('a', { class: 'dv-res-name', href: r.url, target: '_blank', rel: 'noopener noreferrer', title: r.url }, r.name || host),
        h('span', { class: 'dv-dim' }, i === null ? 'из компонента' : host),
        ...(i === null ? [] : [iconBtn('minus', 'Убрать ссылку', () => set(own.filter((_, k) => k !== i)))]),
      );
    };
    const form = h('div', { class: 'dv-res-form', hidden: true });
    const url = h('input', { class: 'cfield', placeholder: 'https://… (Storybook, GitHub, задача)' }) as HTMLInputElement;
    const name = h('input', { class: 'cfield', placeholder: 'Название (необязательно)' }) as HTMLInputElement;
    const submit = () => {
      let u = url.value.trim();
      if (!u) return;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
      // The field loses focus: the panel is not re-rendered while someone is typing in it.
      url.blur();
      name.blur();
      form.hidden = true;
      set([...own, { name: name.value.trim() || resourceName(u), url: u }]);
    };
    for (const input of [url, name])
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') form.hidden = true;
      });
    form.append(url, name, h('div', { class: 'pop-actions' }, h('button', { class: 'cbtn', onclick: () => (form.hidden = true) }, 'Отмена'), h('button', { class: 'cbtn primary', onclick: submit }, 'Добавить')));
    const add = iconBtn('plus', 'Добавить ссылку для разработки', () => {
      form.hidden = false;
      url.focus();
    });
    const count = own.length + inherited.length;
    return h(
      'div',
      { class: 'section dv-section' },
      h('h3', {}, `Ссылки для разработки${count ? ` (${count})` : ''}`, h('span', { class: 'h-acts' }, add)),
      ...own.map((r, i) => row(r, i)),
      ...inherited.map((r) => row(r, null)),
      ...(count ? [] : [h('div', { class: 'empty' }, 'Storybook, репозиторий, задача — «+». Видны всем, кто смотрит макет в режиме разработчика.')]),
      form,
    );
  }

  private headSection(s: NodeStyle): HTMLElement {
    const ed = this.ed;
    const doc = ed.doc;
    // Path: ancestors up to the page; a click selects.
    const crumbs: HTMLElement[] = [];
    for (let p = doc.parent(s.id); p && doc.type(p) !== 'PAGE'; p = doc.parent(p)) {
      const pid = p;
      crumbs.unshift(h('button', { class: 'dv-crumb', title: 'Выделить', onclick: () => ed.select([pid]) }, doc.get(pid, 'name') ?? ''));
    }
    const head = h(
      'div',
      { class: 'dv-head' },
      crumbs.length ? h('div', { class: 'dv-crumbs' }, ...crumbs.flatMap((c, i) => (i ? [h('span', { class: 'dv-sep' }, '/'), c] : [c]))) : null,
      h('div', { class: 'dv-title' }, svgEl('span', { class: 'icon' }, NODE_ICON[s.type] ?? ICON.rect), h('span', { class: 'dv-name', title: s.name }, s.name), h('span', { class: 'dv-type' }, NODE_LABEL[s.type] ?? s.type)),
    );
    if (s.type === 'INSTANCE') {
      const comp = doc.get(s.id, 'componentId');
      head.append(
        h(
          'div',
          { class: 'dv-comp' },
          svgEl('span', { class: 'icon' }, ICON.component),
          h('span', {}, s.component ?? 'Компонент'),
          comp && doc.has(comp) ? h('button', { class: 'dv-link', onclick: () => this.hooks.goTo(comp) }, 'Главный компонент') : null,
        ),
      );
    }
    if ((s.type === 'INSTANCE' || s.type === 'COMPONENT' || s.type === 'COMPONENT_SET') && this.hooks.playground) {
      const open = this.hooks.playground;
      head.append(h('div', { class: 'dv-status-row' }, h('button', { class: 'dv-link', onclick: () => open(s.id) }, 'Площадка: свойства вживую')));
    }
    const desc = doc.get(s.id, 'description');
    if (desc) head.append(h('div', { class: 'dv-desc' }, desc));
    // Dev status: mark, focus, compare changes.
    const status = this.hooks.status;
    if (status?.markable(s.id)) {
      const st = doc.get(s.id, 'devStatus');
      const label = st ? (st.type === 'COMPLETED' ? 'Сделано' : 'Готово к разработке') : 'Без статуса';
      const btn = h('button', { class: `dv-status ${st ? (st.type === 'COMPLETED' ? 'done' : 'ready') : ''}`, title: 'Изменить статус' }, label);
      btn.addEventListener('click', () => showMenu(btn, status.menu([s.id])));
      head.append(
        h(
          'div',
          { class: 'dv-status-row' },
          btn,
          h('button', { class: 'dv-link', onclick: () => status.focus(s.id) }, 'Фокус'),
          h('button', { class: 'dv-link', onclick: () => status.compare(s.id, st?.versionId) }, 'Сравнить изменения'),
        ),
      );
    }
    return h('div', { class: 'section dv-section' }, head);
  }

  /** Component code from the code connection (for an instance and a component) and editing it. */
  private componentCodeSection(id: string): HTMLElement | null {
    const doc = this.ed.doc;
    const holder = codeConnectHolder(doc, id);
    if (!holder) return null;
    const links = codeConnectOf(doc, id);
    const edit = iconBtn('settings', 'Связать с кодом…', (e) => this.editCodeConnect(e.currentTarget as HTMLElement, holder, id));
    const sec = h('div', { class: 'section dv-section' }, h('h3', {}, 'Код компонента', h('span', { class: 'h-acts' }, edit)));
    if (!links.length) {
      sec.append(h('div', { class: 'empty' }, 'Связи с кодом нет: шестерёнка — указать шаблон кода компонента и где он лежит.'));
      return sec;
    }
    for (const l of links) {
      const text = renderCodeConnect(doc, id, l);
      const pre = h('pre', { class: 'dv-code' });
      pre.innerHTML = highlight(text, hlLanguage(l.language));
      sec.append(
        h('div', { class: 'dv-row' }, h('span', { class: 'dv-label' }, l.language), l.source ? (/^https?:\/\//.test(l.source) ? h('a', { class: 'dv-link', href: l.source, target: '_blank', rel: 'noopener noreferrer' }, l.source) : this.val(l.source)) : null, iconBtn('copy', 'Скопировать', () => this.copy(text, 'Код скопирован'), 'icon-btn sm')),
        pre,
      );
    }
    return sec;
  }

  /** Code connection dialog: templates per language ({{Property}} is the instance value), path in code. */
  private editCodeConnect(anchor: HTMLElement, holder: string, id: string) {
    const doc = this.ed.doc;
    const { box, close } = popover(anchor, 'ann-pop cc-pop', { width: 360, side: 'left' });
    let list = [...(doc.get(holder, 'codeConnect') ?? [])];
    const save = () => doc.set(holder, { codeConnect: list.length ? list : undefined });
    const places = codeConnectPlaceholders(doc, id);
    const render = () => {
      box.replaceChildren(
        h('div', { class: 'ann-pop-title' }, `Связь с кодом «${doc.get(holder, 'name') ?? ''}»`),
        h('div', { class: 'ann-pop-sub' }, 'Подстановки:', h('div', { class: 'dv-tokens' }, ...places.map((p) => h('code', { class: 'cc-ph' }, `{{${p}}}`)))),
        ...list.map((l, i) => {
          const lang = h('input', { class: 'cfield', value: l.language, placeholder: 'react, vue, swiftui, compose…', list: 'cc-langs', 'aria-label': 'Язык' }) as HTMLInputElement;
          const tpl = h('textarea', { class: 'cfield cc-tpl', rows: 4, placeholder: '<Button size="{{Size}}">{{Label}}</Button>', 'aria-label': 'Шаблон' }) as HTMLTextAreaElement;
          tpl.value = l.template;
          const src = h('input', { class: 'cfield', value: l.source ?? '', placeholder: 'src/ui/Button.tsx или ссылка', 'aria-label': 'Где в коде' }) as HTMLInputElement;
          for (const el of [lang, tpl, src]) el.addEventListener('keydown', (e) => e.stopPropagation());
          const upd = () => {
            list[i] = { language: lang.value.trim() || 'react', template: tpl.value, ...(src.value.trim() ? { source: src.value.trim() } : {}) };
            save();
          };
          lang.addEventListener('change', upd);
          tpl.addEventListener('change', upd);
          src.addEventListener('change', upd);
          const del = iconBtn('trash', 'Убрать', () => {
            list = list.filter((_, k) => k !== i);
            save();
            render();
          });
          return h('div', { class: 'cc-entry' }, h('div', { class: 'ann-pop-head' }, lang, del), tpl, src);
        }),
        h('datalist', { id: 'cc-langs' }, ...['react', 'vue', 'angular', 'svelte', 'html', 'swiftui', 'uikit', 'compose', 'flutter'].map((v) => h('option', { value: v }))),
        h(
          'div',
          { class: 'cacts' },
          h(
            'button',
            {
              class: 'cbtn',
              onclick: () => {
                list.push({ language: 'react', template: '' });
                save();
                render();
              },
            },
            '+ Язык',
          ),
          h('button', { class: 'cbtn primary', onclick: () => close() }, 'Готово'),
        ),
      );
    };
    render();
  }

  private codeParts(id: string): { acts: HTMLElement[]; body: HTMLElement[] } {
    const plugins = this.hooks.pluginLanguages?.() ?? [];
    const plugin = plugins.find((p) => p.key === this.language);
    if (plugin) {
      const sec = this.pluginCodeSection(id, plugin, plugins);
      const acts = [...sec.querySelectorAll<HTMLElement>(':scope > h3 .h-acts > *')];
      const body = [...sec.children].filter((c) => c.tagName !== 'H3') as HTMLElement[];
      return { acts, body };
    }
    const lang = CODE_LANGUAGES.find((l) => l.id === this.language) ?? CODE_LANGUAGES[0]!;
    const nested = this.nested === 'auto' ? undefined : this.nested === 'on';
    let code = '';
    try {
      code = generateCode(this.ed.doc, id, { language: lang.id, unit: this.unit, modes: this.modes, nested });
    } catch (e) {
      code = `// Не удалось построить код: ${(e as Error).message}`;
    }
    const select = this.languageSelect(lang.id, plugins);
    const unit = lang.web
      ? (h('select', { class: 'dv-select', title: 'Единицы', 'aria-label': 'Единицы' }, h('option', { value: 'px', selected: this.unit === 'px' }, 'px'), h('option', { value: 'rem', selected: this.unit === 'rem' }, 'rem')) as HTMLSelectElement)
      : null;
    unit?.addEventListener('change', () => {
      this.unit = unit.value as 'px' | 'rem';
      store.set('mfp-code-unit', this.unit);
      this.onRefresh?.();
    });
    const nestedOn = nested ?? lang.id !== 'css';
    const nestBtn = iconBtn('layers', nestedOn ? 'Только этот слой' : 'С вложенными слоями', () => {
      this.nested = nestedOn ? 'off' : 'on';
      this.onRefresh?.();
    });
    nestBtn.classList.toggle('on', nestedOn);
    nestBtn.setAttribute('aria-pressed', String(nestedOn));
    const copyBtn = iconBtn('copy', 'Скопировать весь код', () => this.copy(code, 'Код скопирован'));
    const acts = [select, ...(unit ? [unit] : []), nestBtn, copyBtn];
    // CSS of a single layer in “Layout” and “Style” blocks; otherwise as one block.
    const lines = code.split('\n');
    const simple = lang.id === 'css' && !nestedOn && lines.every((l) => !l.includes('{') && !l.includes('}'));
    const block = (title: string, text: string) => {
      const pre = h('pre', { class: 'dv-code', tabIndex: 0, 'aria-label': `${title}: ${lang.label}` });
      pre.innerHTML = highlight(text, lang.id);
      return h('div', { class: 'pg-block' }, h('div', { class: 'pg-block-head' }, h('span', {}, title), iconBtn('copy', `Скопировать: ${title.toLowerCase()}`, () => this.copy(text, 'Код скопирован'), 'icon-btn sm')), pre);
    };
    if (simple) {
      const decl = lines.filter((l) => /^\s*[a-z-]+\s*:/.test(l));
      const layout = decl.filter((l) => LAYOUT_CSS.test(l.trim().split(':')[0]!.trim()));
      const style = decl.filter((l) => !layout.includes(l));
      return { acts, body: [...(layout.length ? [block('Раскладка', layout.join('\n'))] : []), ...(style.length ? [block('Стиль', style.join('\n'))] : [])] };
    }
    const pre = h('pre', { class: 'dv-code', tabIndex: 0, 'aria-label': `Код ${lang.label}` });
    pre.innerHTML = highlight(code, lang.id);
    return { acts, body: [pre] };
  }

  /** Language picker: built-in languages and codegen plugin languages. */
  private languageSelect(current: string, plugins: { key: string; label: string }[]): HTMLSelectElement {
    const select = h(
      'select',
      { class: 'dv-select', title: 'Язык', 'aria-label': 'Язык кода' },
      ...CODE_LANGUAGES.map((l) => h('option', { value: l.id, selected: l.id === current }, l.label)),
      ...(plugins.length ? [h('optgroup', { label: 'Плагины' }, ...plugins.map((p) => h('option', { value: p.key, selected: p.key === current }, p.label)))] : []),
    ) as HTMLSelectElement;
    select.addEventListener('change', () => {
      this.language = select.value;
      if (!select.value.startsWith('plugin:')) store.set('mfp-code-lang', this.language);
      this.onRefresh?.();
    });
    return select;
  }

  /** Code from a codegen plugin: blocks arrive asynchronously. */
  private pluginCodeSection(id: string, plugin: { key: string; label: string }, plugins: { key: string; label: string }[]): HTMLElement {
    const body = h('div', {}, h('pre', { class: 'dv-code' }, 'Плагин считает…'));
    const sec = h('div', { class: 'section dv-section' }, h('h3', {}, 'Код', h('span', { class: 'h-acts' }, this.languageSelect(plugin.key, plugins))), body);
    void this.hooks.pluginCode?.(plugin.key, id).then(
      (blocks) => {
        if (!sec.isConnected) return;
        body.replaceChildren(
          ...(blocks.length
            ? blocks.map((b) => {
                const pre = h('pre', { class: 'dv-code' });
                pre.innerHTML = highlight(b.code, /JSON|JAVASCRIPT|TYPESCRIPT|KOTLIN|SWIFT|DART|PYTHON/i.test(b.language) ? 'compose' : /HTML|XML|JSX/i.test(b.language) ? 'tailwind' : /CSS/i.test(b.language) ? 'css' : 'compose');
                return h('div', { class: 'pg-block' }, h('div', { class: 'pg-block-head' }, h('span', {}, b.title || plugin.label), iconBtn('copy', 'Скопировать', () => this.copy(b.code, 'Код скопирован'), 'icon-btn sm')), pre);
              })
            : [h('div', { class: 'empty' }, 'Плагин не вернул кода для этого слоя.')]),
        );
      },
      (e: Error) => {
        if (sec.isConnected) body.replaceChildren(h('div', { class: 'empty' }, `Плагин: ${e.message}`));
      },
    );
    return sec;
  }

  /** Diagram: padding (for auto layout) around the size; click a number to copy it. */
  private boxModel(s: NodeStyle): HTMLElement {
    const P = s.layout?.padding;
    const cell = (v: NumberValue, cls: string) => h('button', { class: `dv-box-v ${cls}`, title: v.token ? `Переменная «${v.token.name}»` : 'Щелчок — скопировать', onclick: () => this.copy(v.token?.web ?? String(r2(v.value))) }, String(r2(v.value)));
    const size = h('div', { class: 'dv-box-in' }, `${r2(s.width.value)} × ${r2(s.height.value)}`);
    if (!P) return h('div', { class: 'dv-box plain', 'aria-label': `Размер ${r2(s.width.value)} на ${r2(s.height.value)}` }, size);
    return h(
      'div',
      { class: 'dv-box', 'aria-label': `Поля: сверху ${P.top.value}, справа ${P.right.value}, снизу ${P.bottom.value}, слева ${P.left.value}` },
      h('span', { class: 'dv-box-cap' }, 'Поля'),
      cell(P.top, 't'),
      cell(P.right, 'r'),
      cell(P.bottom, 'b'),
      cell(P.left, 'l'),
      size,
    );
  }

  private layoutRows(s: NodeStyle): HTMLElement[] {
    const rows: (HTMLElement | null)[] = [
      this.row('Ширина', ...this.num(s.width), h('span', { class: 'dv-dim' }, SIZING[s.sizing.width] ?? '')),
      this.row('Высота', ...this.num(s.height), h('span', { class: 'dv-dim' }, SIZING[s.sizing.height] ?? '')),
      s.position !== 'flow' ? this.row('X, Y', this.val(`${r2(s.x)}`), this.val(`${r2(s.y)}`), h('span', { class: 'dv-dim' }, s.position === 'absolute' ? 'вне потока' : 'в родителе')) : null,
      s.rotation ? this.row('Поворот', this.val(`${s.rotation}°`)) : null,
      s.limits.minWidth ? this.row('Мин. ширина', ...this.num(s.limits.minWidth)) : null,
      s.limits.maxWidth ? this.row('Макс. ширина', ...this.num(s.limits.maxWidth)) : null,
      s.limits.minHeight ? this.row('Мин. высота', ...this.num(s.limits.minHeight)) : null,
      s.limits.maxHeight ? this.row('Макс. высота', ...this.num(s.limits.maxHeight)) : null,
      s.opacity.value < 1 || s.opacity.token ? this.row('Непрозрачность', this.val(`${Math.round(s.opacity.value * 100)}%`), this.token(s.opacity.token)) : null,
      s.radius === 'ellipse' ? this.row('Скругление', h('span', { class: 'dv-dim' }, 'эллипс')) : null,
    ];
    if (s.radius && s.radius !== 'ellipse') {
      const R = s.radius;
      const same = [R.tr, R.br, R.bl].every((x) => x.value === R.tl.value);
      rows.push(same ? this.row('Скругление', ...this.num(R.tl)) : this.row('Скругление', this.val(`${r2(R.tl.value)} ${r2(R.tr.value)} ${r2(R.br.value)} ${r2(R.bl.value)}`)));
    }
    const L = s.layout;
    if (L) {
      const dir = { row: 'в строку', column: 'в столбец', grid: 'сеткой' }[L.direction];
      const J = { start: 'в начало', center: 'по центру', end: 'в конец', 'space-between': 'между', 'space-around': 'вокруг', 'space-evenly': 'равномерно' }[L.justify];
      const A = { start: 'в начало', center: 'по центру', end: 'в конец', baseline: 'по базовой линии' }[L.align];
      rows.push(
        this.row('Автораскладка', h('span', { class: 'dv-plain' }, dir), L.wrap ? h('span', { class: 'dv-dim' }, 'с переносом') : null),
        this.row('Промежуток', ...(L.justify.startsWith('space') ? [h('span', { class: 'dv-plain' }, 'авто')] : this.num(L.gap))),
        L.crossGap ? this.row('Между строками', ...this.num(L.crossGap)) : null,
        this.row('Распределение', h('span', { class: 'dv-plain' }, J), h('span', { class: 'dv-dim' }, A)),
      );
      if (L.direction === 'grid' && (L.columns.length || L.rows.length)) rows.push(this.row('Колонки', this.val(L.columns.join(' ') || '—')), this.row('Строки', this.val(L.rows.join(' ') || '—')));
    }
    return rows.filter((r): r is HTMLElement => !!r);
  }

  private textRows(t: TextValue, base?: TextValue): HTMLElement[] {
    const out: HTMLElement[] = [];
    const diff = (k: keyof TextValue) => !base || JSON.stringify(base[k]) !== JSON.stringify(t[k]);
    if (!base && t.textStyle) out.push(this.row('Стиль текста', this.val(t.textStyle)));
    if (diff('family')) out.push(this.row('Шрифт', this.val(t.family)));
    if (diff('style')) out.push(this.row('Начертание', this.val(t.style), h('span', { class: 'dv-dim' }, String(t.weight))));
    if (diff('size')) out.push(this.row('Кегль', ...this.num(t.size)));
    if (diff('lineHeight')) out.push(this.row('Интерлиньяж', t.lineHeight ? this.val(t.lineHeight.unit === 'PERCENT' ? `${r2(t.lineHeight.value)}%` : `${r2(t.lineHeight.value)}`) : h('span', { class: 'dv-plain' }, 'авто'), this.token(t.lineHeight?.token)));
    if (diff('letterSpacing') && (t.letterSpacing.value || base)) out.push(this.row('Разрядка', ...this.num(t.letterSpacing)));
    if (!base && t.align !== 'left') out.push(this.row('Выравнивание', h('span', { class: 'dv-plain' }, { center: 'по центру', right: 'вправо', justify: 'по ширине', left: 'влево' }[t.align])));
    if (diff('textCase') && t.textCase !== 'none') out.push(this.row('Регистр', h('span', { class: 'dv-plain' }, { upper: 'прописные', lower: 'строчные', title: 'с прописной', 'small-caps': 'капитель', none: '' }[t.textCase])));
    if (diff('decoration') && t.decoration !== 'none') out.push(this.row('Оформление', h('span', { class: 'dv-plain' }, t.decoration === 'underline' ? 'подчёркнутый' : 'зачёркнутый')));
    if (!base && t.truncate) out.push(this.row('Обрезка', h('span', { class: 'dv-plain' }, `«…» после ${t.truncate} стр.`)));
    if (diff('fills')) out.push(...this.fillRows('Цвет', t.fills));
    if (t.link && diff('link')) out.push(this.row('Ссылка', this.val(t.link)));
    return out;
  }

  private textSection(t: TextValue & { characters: string; segments: { characters: string; style: TextValue }[] }): HTMLElement {
    const sec = h('div', { class: 'section dv-section' }, h('h3', {}, 'Текст', h('span', { class: 'h-acts' }, iconBtn('text', 'Скопировать текст', () => this.copy(t.characters, 'Текст скопирован')))), ...this.textRows(t));
    if (t.segments.length) {
      sec.append(h('div', { class: 'dv-sub' }, `Куски с другим оформлением: ${t.segments.length}`));
      for (const seg of t.segments) {
        const rows = this.textRows(seg.style, t);
        if (!rows.length) continue;
        const excerpt = seg.characters.replace(/\s+/g, ' ').trim();
        sec.append(h('div', { class: 'dv-seg' }, h('div', { class: 'dv-seg-text' }, `«${excerpt.length > 32 ? excerpt.slice(0, 32) + '…' : excerpt}»`), ...rows));
      }
    }
    return sec;
  }

  private colorsSection(s: NodeStyle): HTMLElement | null {
    const rows: HTMLElement[] = [...this.fillRows('Заливка', s.fills)];
    if (s.stroke) {
      rows.push(...this.fillRows('Обводка', s.stroke.fills));
      const w = s.stroke.weight;
      rows.push(this.row('Толщина', ...('value' in w ? this.num(w) : [this.val(`${w.top} ${w.right} ${w.bottom} ${w.left}`)]), h('span', { class: 'dv-dim' }, { inside: 'внутри', outside: 'снаружи', center: 'по центру' }[s.stroke.align])));
      if (s.stroke.dash.length) rows.push(this.row('Штрих', this.val(s.stroke.dash.join(' '))));
    }
    if (!rows.length) return null;
    return h('div', { class: 'section dv-section' }, h('h3', {}, 'Цвета'), ...rows);
  }

  private effectsSection(s: NodeStyle): HTMLElement | null {
    const rows: HTMLElement[] = [];
    for (const sh of s.shadows) {
      rows.push(this.row(sh.inset ? 'Внутр. тень' : 'Тень', this.val(`${r2(sh.x)}, ${r2(sh.y)}`), h('span', { class: 'dv-dim' }, `размытие ${r2(sh.blur)}${sh.spread ? `, растяж. ${r2(sh.spread)}` : ''}`)));
      rows.push(this.colorRow('', sh.color));
    }
    if (s.blur) rows.push(this.row('Размытие', this.val(`${r2(s.blur)}`)));
    if (s.backdropBlur) rows.push(this.row('Размытие фона', this.val(`${r2(s.backdropBlur)}`)));
    if (s.blend) rows.push(this.row('Наложение', h('span', { class: 'dv-plain' }, s.blend)));
    if (!rows.length) return null;
    return h('div', { class: 'section dv-section' }, h('h3', {}, 'Эффекты'), ...rows);
  }

  /** Layer variables and the mode picker for their collections (view only, the file is not edited). */
  private variablesSection(s: NodeStyle): HTMLElement | null {
    const tokens = styleTokens(s);
    if (!tokens.length) return null;
    const doc = this.ed.doc;
    const colls = new Map<string, string>();
    for (const t of tokens) {
      const c = doc.parent(t.id);
      if (c && doc.type(c) === 'VARIABLE_COLLECTION') colls.set(c, doc.get(c, 'name') ?? '');
    }
    const modes: HTMLElement[] = [];
    for (const [c, name] of colls) {
      const list = doc.get(c, 'modes') ?? [];
      if (list.length < 2) continue;
      const sel = h('select', { class: 'dv-select', 'aria-label': `Режим коллекции «${name}»` }, h('option', { value: '' }, 'Как в файле'), ...list.map((m) => h('option', { value: m.modeId, selected: this.modes[c] === m.modeId }, m.name))) as HTMLSelectElement;
      sel.addEventListener('change', () => {
        if (sel.value) this.modes[c] = sel.value;
        else delete this.modes[c];
        this.onRefresh?.();
      });
      modes.push(this.row(name || 'Коллекция', sel));
    }
    return h(
      'div',
      { class: 'section dv-section' },
      h('h3', {}, 'Переменные'),
      ...modes,
      h('div', { class: 'dv-tokens' }, ...tokens.map((t) => h('button', { class: 'dv-token', title: `${t.collection ? `${t.collection} · ` : ''}${t.web} — щелчок скопирует`, onclick: () => this.copy(t.web) }, t.name))),
    );
  }

  /** Layer annotations: text and pinned properties; click to edit, “+” for a new one. */
  private annotationsSection(id: string): HTMLElement {
    const doc = this.ed.doc;
    const list = doc.get(id, 'annotations') ?? [];
    const hooks = this.hooks.annotations;
    const add = hooks ? iconBtn('plus', 'Добавить аннотацию (T)', () => hooks.add(id)) : null;
    return h(
      'div',
      { class: 'section dv-section' },
      h('h3', {}, `Аннотации${list.length ? ` (${list.length})` : ''}`, h('span', { class: 'h-acts' }, add)),
      ...(list.length
        ? list.map((a, i) => {
            const cat = categoryOf(doc, a.categoryId);
            return h(
              'button',
              { class: 'dv-ann', style: `--ann:${cat ? ANNOTATION_COLORS[cat.color] : '#8a8a8a'}`, onclick: () => hooks?.edit(id, i) },
              cat ? h('span', { class: 'ann-cat-chip' }, cat.label) : null,
              h('span', { class: 'dv-ann-text' }, (a.labelMarkdown ?? '').replace(/\s+/g, ' ').slice(0, 140) || (a.properties?.length ? `Свойств: ${a.properties.length}` : 'Пустая')),
            );
          })
        : [h('div', { class: 'empty' }, 'Аннотаций нет. «+» или инструмент T — добавить.')]),
    );
  }

  /** Assets: layers with export settings, icons and images inside the selection. */
  private assetsSection(sel: string[]): HTMLElement {
    const doc = this.ed.doc;
    const found: { id: string; kind: 'export' | 'icon' | 'image'; key: string }[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    const visit = (id: string) => {
      if (++scanned > 3000 || found.length >= 40 || doc.get(id, 'visible') === false) return;
      const type = doc.type(id)!;
      const settings = doc.get(id, 'exportSettings') ?? [];
      const comp = type === 'INSTANCE' ? doc.get(id, 'componentId') : null;
      const key = comp ?? `${doc.get(id, 'name')}:${type}`;
      if (settings.length) {
        if (!seen.has(key)) found.push({ id, kind: 'export', key });
        seen.add(key);
        return;
      }
      if (VECTORISH.has(type) || (type === 'INSTANCE' && isIcon(doc, id))) {
        if (!seen.has(key)) found.push({ id, kind: 'icon', key });
        seen.add(key);
        return;
      }
      if ((doc.get(id, 'fills') ?? []).some((f) => f.type === 'IMAGE' && f.visible !== false)) {
        const hash = (doc.get(id, 'fills') ?? []).find((f) => f.type === 'IMAGE');
        const k = hash && 'imageHash' in hash ? (hash.imageHash ?? key) : key;
        if (!seen.has(k)) found.push({ id, kind: 'image', key: k });
        seen.add(k);
      }
      for (const c of doc.children(id)) visit(c);
    };
    for (const id of sel) visit(id);
    if (!found.length) return h('div', { class: 'section dv-section' }, h('h3', {}, 'Ассеты'), h('div', { class: 'empty' }, 'Иконок, картинок и слоёв с настройками экспорта нет.'));
    const items = found.map((a) => {
      const name = doc.get(a.id, 'name') ?? '';
      const settings: ExportSetting[] =
        a.kind === 'export' ? (doc.get(a.id, 'exportSettings') ?? []) : a.kind === 'icon' ? [{ format: 'SVG', suffix: '', svgOutlineText: true }] : [{ format: 'PNG', suffix: '', constraint: { type: 'SCALE', value: 2 } }];
      const thumb = h('span', { class: 'dv-thumb' });
      void this.ed.renderThumbnail(a.id, 64).then((blob) => {
        if (!blob || !thumb.isConnected) return;
        const url = URL.createObjectURL(blob);
        this.urls.push(url);
        thumb.style.backgroundImage = `url(${url})`;
      });
      const fmt = settings.map((s) => (isRaster(s.format) ? `${s.format} ${s.constraint?.type === 'SCALE' ? `${s.constraint.value}x` : ''}` : s.format)).join(', ');
      return h(
        'div',
        { class: 'dv-asset' },
        thumb,
        h('button', { class: 'dv-asset-name', title: 'Выделить', onclick: () => this.ed.select([a.id]) }, name),
        h('span', { class: 'dv-dim' }, fmt.trim()),
        iconBtn('export', `Скачать ${fmt.trim()}`, () => void this.hooks.exportNode(a.id, settings)),
      );
    });
    return h('div', { class: 'section dv-section' }, h('h3', {}, `Ассеты (${found.length}${found.length >= 40 ? '+' : ''})`), ...items);
  }

  private settingsSection(): HTMLElement {
    const fmt = h('select', { class: 'dv-select', 'aria-label': 'Формат цвета' }, ...(['hex', 'rgb', 'hsl', 'oklch'] as const).map((f) => h('option', { value: f, selected: this.colorFormat === f }, f.toUpperCase()))) as HTMLSelectElement;
    fmt.addEventListener('change', () => {
      this.colorFormat = fmt.value as ColorFormat;
      store.set('mfp-color-format', this.colorFormat);
      this.onRefresh?.();
    });
    return h('div', { class: 'section dv-section' }, h('h3', {}, 'Настройки'), this.row('Формат цвета', fmt));
  }
}

/** An instance is an icon: only vectors and shapes inside. */
function isIcon(doc: Editor['doc'], id: string): boolean {
  let n = 0;
  for (const d of doc.descendants(id)) {
    const t = doc.type(d)!;
    if (t === 'TEXT' || ++n > 200) return false;
    if (!VECTORISH.has(t) && t !== 'GROUP' && t !== 'FRAME' && t !== 'ELLIPSE' && t !== 'RECTANGLE' && t !== 'INSTANCE') return false;
  }
  return n > 0;
}

// ---------- Syntax highlighting ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const KEYWORDS: Partial<Record<CodeLanguage, RegExp>> = {
  swiftui: /\b(struct|var|let|some|View|Color|Text|Image|true|false)\b/g,
  uikit: /\b(let|var|true|false|UIView|UILabel|UIStackView|UIImageView|UIColor|UIFont|UIImage|CGRect|CGSize|CGPoint)\b/g,
  compose: /\b(Modifier|Row|Column|Box|Text|Image|Icon|Color|TextStyle|Arrangement|Alignment|true|false)\b/g,
};

/** Highlighting language for a code connection language (react, vue: markup; swift, kotlin: their own). */
export function hlLanguage(language: string): CodeLanguage {
  const l = language.toLowerCase();
  if (/react|vue|html|angular|svelte|jsx|tsx|xml/.test(l)) return 'tailwind';
  if (/swift|uikit/.test(l)) return 'swiftui';
  if (/css/.test(l)) return 'css';
  return 'compose';
}

/** Highlighting: comments, strings, numbers, CSS property names, keywords, markup tags. */
export function highlight(code: string, lang: CodeLanguage): string {
  const parts: string[] = [];
  const re = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->)|("(?:[^"\\\n]|\\.)*")|(#[0-9A-Fa-f]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|dp|sp|%|deg|f)?\b)/g;
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    parts.push(plain(code.slice(last, m.index), lang));
    const cls = m[1] ? 'c' : m[2] ? 's' : 'n';
    parts.push(`<span class="hl-${cls}">${esc(m[0])}</span>`);
    last = m.index + m[0].length;
  }
  parts.push(plain(code.slice(last), lang));
  return parts.join('');
}

function plain(text: string, lang: CodeLanguage): string {
  let s = esc(text);
  if (lang === 'css') s = s.replace(/(^|\n)([\w-]+)(?=:)/g, '$1<span class="hl-p">$2</span>');
  // Attributes first, then tags: otherwise an attribute would also be found in the highlighting markup itself.
  else if (lang === 'tailwind' || lang === 'android-xml') s = s.replace(/([\w:-]+)(?==)/g, '<span class="hl-p">$1</span>').replace(/(&lt;\/?)([\w.-]+)/g, '$1<span class="hl-k">$2</span>');
  else {
    const kw = KEYWORDS[lang];
    if (kw) s = s.replace(kw, '<span class="hl-k">$1</span>');
    s = s.replace(/(\.)([a-zA-Z]\w*)(?=\()/g, '$1<span class="hl-p">$2</span>');
  }
  return s;
}
