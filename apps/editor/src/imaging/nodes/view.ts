// The “Graphs” tab: on the left, own graphs (in the browser), this file's graphs (for the whole team) and own nodes;
// in the center, the canvas; on the right, batch run, queue, and export of results as frames onto pages.

import { fill, h, modal } from '../../dom.ts';
import type { Editor } from '../../editor.ts';
import { showMenuAt, type MenuEntry } from '../../menu.ts';
import { PagePlacer, findOrCreatePage, pages } from '../document.ts';
import type { ImagingEngine } from '../engine.ts';
import type { ImagingSettings } from '../keys.ts';
import type { ServerLink } from '../magnific.ts';
import { pickImages } from '../picker.ts';
import { ImageWriter, baseName, topImage, type Cloud, type ImageOrigin } from '../projects.ts';
import type { GpuProbe } from '../protocol.ts';
import { GraphCanvas, nodesWord, plural } from './canvas.ts';
import { BUILTIN_MAP } from './defs.ts';
import { chainToGraph, loadLibrary, newId, saveLibrary, usedMacros, type Graph, type GraphNode, type Library, type MacroDef, type Preset } from './model.ts';
import { GraphError, batchItems, runItem, type NodeDef, type PageOutput, type ReplaceOutput } from './runner.ts';
import { createServices } from './services.ts';
import { fileGraph, fileGraphJson, fileGraphs, removeFileGraph, touchesShared, writeFileGraph } from './shared.ts';
import { t } from '../../i18n/index.ts';

export interface NodesDeps {
  editor: Editor;
  engine: ImagingEngine;
  probe: () => GpuProbe | null;
  settings: () => ImagingSettings;
  server: ServerLink;
  cloud: Cloud;
  notify: (message: string, kind?: 'info' | 'error') => void;
  openSettings: () => void;
}

type Where = { scope: 'mine' | 'file'; id: string };

interface Row {
  name: string;
  state: 'wait' | 'run' | 'done' | 'error' | 'stopped';
  text: string;
  thumb?: string;
  el: HTMLElement;
}

const FORMAT = 'mfp-imaging';
const FILE_SAVE_MS = 600;

const iconsGraph = () =>
  chainToGraph({
    id: newId(),
    name: t('Иконки'),
    page: t('Иконки'),
    steps: [
      { kind: 'generate', template: '{prompt}. Single object, centered, isolated on a plain light background, soft studio lighting, game UI icon', aspectRatio: '1:1', imageSize: '1K', engine: 'auto', steps: 2 },
      { kind: 'remove-bg', trim: true },
      { kind: 'sizes', sizes: [{ width: 200, height: 200 }, { width: 450, height: 450 }], padding: 6 },
    ],
  });

const sizeText = (o: { width: number; height: number }) => (o.width === o.height ? `${o.width}` : `${o.width}×${o.height}`);

function askName(title: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, { cls: 'img-settings', onClose: () => !done && resolve(null) });
    const input = h('input', { class: 'img-input', value }) as HTMLInputElement;
    const ok = () => {
      const v = input.value.trim();
      if (!v) return input.focus();
      done = true;
      m.close();
      resolve(v);
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), ok()));
    m.body.append(h('div', { class: 'img-form' }, input, h('div', { class: 'img-actions' }, h('button', { class: 'img-btn primary', onclick: ok }, 'Сохранить'))));
    setTimeout(() => (input.focus(), input.select()));
  });
}

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  h('a', { href: url, download: `${name.replace(/[\\/:*?"<>|]+/g, '') || 'схема'}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export class NodesView {
  readonly el: HTMLElement;
  private readonly deps: NodesDeps;
  private readonly lib: Library;
  private readonly canvas: GraphCanvas;
  private where: Where;
  private graph: Graph;
  /** The file graph JSON we wrote last, to tell our own edit from someone else's. */
  private written = '';
  private fileTimer = 0;
  private boundDoc: Editor['doc'] | null = null;
  private unbind: (() => void) | null = null;
  /** Images for the “Images” node (by node id), in memory only. */
  private images = new Map<string, { name: string; blob: Blob; origin?: ImageOrigin }[]>();
  /** Replacements from the last run, for “Revert replacements”. */
  private writer: ImageWriter | null = null;
  private thumbs: string[] = [];
  private rows: Row[] = [];
  private abort: AbortController | null = null;
  private lastPage: string | null = null;

  private readonly mine: HTMLElement;
  private readonly inFile: HTMLElement;
  private readonly custom: HTMLElement;
  private readonly name: HTMLInputElement;
  private readonly scope: HTMLElement;
  private readonly barActions: HTMLElement;
  private readonly source: HTMLElement;
  private readonly engines: HTMLElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly openBtn: HTMLButtonElement;
  private readonly revertBtn: HTMLButtonElement;
  private readonly queue: HTMLElement;
  private readonly files: HTMLInputElement;
  private readonly importInput: HTMLInputElement;

  constructor(deps: NodesDeps) {
    this.deps = deps;
    this.lib = loadLibrary();
    if (!this.lib.graphs.length) {
      this.lib.graphs.push(iconsGraph());
      saveLibrary(this.lib);
    }
    this.graph = this.lib.graphs[0]!;
    this.where = { scope: 'mine', id: this.graph.id };
    this.canvas = new GraphCanvas({
      macros: () => this.lib.macros,
      presets: () => this.lib.presets,
      changed: () => this.saveCurrent(),
      savePreset: (node, def) => void this.savePreset(node, def),
      addMacro: (m) => this.addMacro(m),
      ask: askName,
      notify: deps.notify,
    });

    this.mine = h('div', { class: 'nde-list' });
    this.inFile = h('div', { class: 'nde-list' });
    this.custom = h('div', { class: 'nde-list' });
    this.importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => this.importInput.files?.[0] && void this.importFile(this.importInput.files[0]) });
    const group = (title: string, list: HTMLElement, add?: [string, () => void]) =>
      h('section', { class: 'nde-group' }, h('div', { class: 'nde-group-head' }, h('span', {}, title), add ? h('button', { class: 'nde-add', title: add[0], onclick: add[1] }, '+') : null), list);
    const side = h(
      'aside',
      { class: 'nde-side' },
      group('Мои схемы', this.mine, ['Новая схема', () => this.newGraph()]),
      group('В этом файле', this.inFile),
      group('Мои ноды', this.custom),
      h(
        'div',
        { class: 'nde-side-foot' },
        h('button', { class: 'ups-btn', title: 'Схемы, свои ноды и пресеты из файла JSON', onclick: () => this.importInput.click() }, 'Импорт…'),
        h('button', { class: 'ups-btn', title: 'Все свои схемы, ноды и пресеты одним файлом — для другого браузера или проекта', onclick: () => download('Улучшения изображений — схемы', { ...this.lib, format: FORMAT }) }, 'Экспорт всего'),
        this.importInput,
      ),
    );

    this.name = h('input', { class: 'img-input nde-name', title: 'Название схемы', onchange: () => this.rename(this.name.value) }) as HTMLInputElement;
    this.scope = h('span', { class: 'nde-scope' });
    this.barActions = h('div', { class: 'nde-bar-actions' });
    const center = h('section', { class: 'nde-center' }, h('div', { class: 'nde-bar' }, this.name, this.scope, this.barActions), this.canvas.el);

    this.source = h('div', { class: 'nde-source' });
    this.engines = h('div', { class: 'img-note' });
    this.runBtn = h('button', { class: 'ups-run', onclick: () => (this.abort ? this.stop() : void this.run()) }, 'Запустить');
    this.bar = h('div', { class: 'ups-bar-fill' });
    this.status = h('div', { class: 'ups-status' });
    this.openBtn = h('button', { class: 'ups-btn', hidden: true, onclick: () => this.lastPage && this.deps.editor.doc.has(this.lastPage) && this.deps.editor.setPage(this.lastPage) }, 'Открыть страницу');
    this.revertBtn = h('button', { class: 'ups-btn', hidden: true, onclick: () => void this.revert() }, 'Вернуть замены');
    this.queue = h('div', { class: 'nde-queue' });
    this.files = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: () => this.addFiles([...(this.files.files ?? [])]) });
    const run = h(
      'aside',
      { class: 'nde-run' },
      h('div', { class: 'ups-label' }, 'Запуск'),
      this.source,
      this.engines,
      this.runBtn,
      h('div', { class: 'ups-bar' }, this.bar),
      this.status,
      this.openBtn,
      this.revertBtn,
      this.queue,
      this.files,
    );

    this.el = h('div', { class: 'nde-view' }, side, center, run);
    this.el.addEventListener('dragover', (e) => {
      if (!this.imageSource()) return;
      e.preventDefault();
      e.stopPropagation();
    });
    this.el.addEventListener('drop', (e) => {
      if (!this.imageSource()) return;
      e.preventDefault();
      e.stopPropagation();
      this.addFiles([...(e.dataTransfer?.files ?? [])]);
    });
    deps.editor.onDocumentSet.push(() => this.el.isConnected && this.bindDoc());
    this.canvas.setGraph(this.graph);
  }

  /** The tab was shown: the file may have changed, pages may have appeared, keys may have changed. */
  show() {
    this.bindDoc();
    this.canvas.setPageNames(pages(this.deps.editor).map((id) => String(this.deps.editor.doc.get(id, 'name'))));
    this.renderAll();
    this.canvas.el.focus({ preventScroll: true });
  }

  key(e: KeyboardEvent) {
    return this.canvas.key(e);
  }

  paste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length || !this.imageSource()) return;
    e.preventDefault();
    this.addFiles(files);
  }

  // ---------- storage ----------

  private bindDoc() {
    const doc = this.deps.editor.doc;
    if (doc === this.boundDoc) return;
    this.flushFile();
    this.unbind?.();
    this.boundDoc = doc;
    this.unbind = doc.onChange((ops) => touchesShared(doc, ops) && this.sharedChanged());
    if (this.where.scope === 'file') this.open({ scope: 'mine', id: this.lib.graphs[0]!.id });
    else this.renderSide();
  }

  private sharedChanged() {
    if (this.where.scope === 'file' && !this.fileTimer) {
      const json = fileGraphJson(this.deps.editor.doc, this.where.id);
      if (json === undefined) {
        this.deps.notify(`Схему «${this.graph.name}» убрали из файла — открыта ваша схема`);
        return this.open({ scope: 'mine', id: this.lib.graphs[0]!.id });
      }
      // A collaborator's edit (or an undo in the document): show what is in the file now
      if (json !== this.written && !this.abort) {
        const g = fileGraph(this.deps.editor.doc, this.where.id);
        if (g) {
          this.graph = g;
          this.written = json;
          this.canvas.replaceGraph(g);
        }
      }
    }
    this.renderSide();
    this.renderBar();
  }

  private saveLib() {
    saveLibrary(this.lib);
  }

  private saveCurrent() {
    this.graph.macros = usedMacros(this.graph.nodes, this.graph.macros);
    if (this.where.scope === 'mine') this.saveLib();
    else {
      clearTimeout(this.fileTimer);
      this.fileTimer = window.setTimeout(() => this.flushFile(), FILE_SAVE_MS);
    }
    this.renderSide();
    this.renderSource();
  }

  private flushFile() {
    if (!this.fileTimer) return;
    clearTimeout(this.fileTimer);
    this.fileTimer = 0;
    if (this.where.scope !== 'file' || !this.boundDoc || JSON.stringify(this.graph) === this.written) return;
    this.written = writeFileGraph(this.boundDoc, this.graph);
  }

  private open(w: Where) {
    if (this.abort) return;
    this.flushFile();
    const doc = this.deps.editor.doc;
    const g = w.scope === 'mine' ? this.lib.graphs.find((x) => x.id === w.id) : fileGraph(doc, w.id);
    if (!g) return;
    this.where = w;
    this.graph = g;
    this.written = w.scope === 'file' ? (fileGraphJson(doc, w.id) ?? '') : '';
    this.canvas.setGraph(g);
    this.renderAll();
  }

  private newGraph() {
    const g: Graph = { id: newId(), name: `Схема ${this.lib.graphs.length + 1}`, nodes: [], edges: [], macros: [] };
    this.lib.graphs.push(g);
    this.saveLib();
    this.open({ scope: 'mine', id: g.id });
  }

  private rename(name: string) {
    const v = name.trim();
    if (!v || v === this.graph.name) return this.renderBar();
    this.graph.name = v;
    this.saveCurrent();
    this.renderBar();
  }

  private copyToMine(g: Graph, name = g.name) {
    const copy: Graph = { ...structuredClone(g), id: newId(), name };
    this.lib.graphs.push(copy);
    for (const m of copy.macros) if (!this.lib.macros.some((x) => x.id === m.id)) this.lib.macros.push(structuredClone(m));
    this.saveLib();
    this.open({ scope: 'mine', id: copy.id });
  }

  private share(g: Graph) {
    const doc = this.deps.editor.doc;
    const exists = fileGraphs(doc).find((x) => x.name === g.name);
    // Sharing the same graph again updates its copy in the file
    const copy: Graph = { ...structuredClone(g), id: exists?.id ?? newId() };
    writeFileGraph(doc, copy);
    this.deps.notify(exists ? `Схема «${g.name}» в файле обновлена` : `Схема «${g.name}» сохранена в файле — её видят все, у кого он открыт`);
    this.renderSide();
  }

  private async savePreset(node: GraphNode, def: NodeDef) {
    const name = await askName(`Пресет ноды «${def.title}»`, node.title ?? def.title);
    if (!name) return;
    this.lib.presets.push({ id: newId(), name, nodeType: node.type, params: structuredClone(node.params) });
    this.saveLib();
    this.renderCustom();
    this.deps.notify(`Пресет «${name}» — в «Моих нодах» и в палитре`);
  }

  private addMacro(m: MacroDef) {
    this.lib.macros = [...this.lib.macros.filter((x) => x.id !== m.id), m];
    this.saveLib();
    this.renderCustom();
  }

  private async importFile(file: File) {
    this.importInput.value = '';
    let data: Partial<Library> & { format?: string };
    try {
      data = JSON.parse(await file.text());
    } catch {
      return this.deps.notify('Файл не читается как JSON', 'error');
    }
    if (data?.format !== FORMAT || !Array.isArray(data.graphs)) return this.deps.notify('Это не файл схем «Улучшений изображений»', 'error');
    const valid = (g: Graph) => g && typeof g.id === 'string' && Array.isArray(g.nodes) && Array.isArray(g.edges);
    let first: string | null = null;
    let graphs = 0;
    for (const g of data.graphs) {
      if (!valid(g)) continue;
      const copy: Graph = { ...g, name: String(g.name || t('Схема')), macros: Array.isArray(g.macros) ? g.macros : [] };
      if (this.lib.graphs.some((x) => x.id === copy.id)) copy.id = newId();
      this.lib.graphs.push(copy);
      first ??= copy.id;
      graphs++;
    }
    const macros = (data.macros ?? []).filter((m) => m && typeof m.id === 'string' && !this.lib.macros.some((x) => x.id === m.id));
    const presets = (data.presets ?? []).filter((p) => p && typeof p.id === 'string' && !this.lib.presets.some((x) => x.id === p.id));
    this.lib.macros.push(...macros);
    this.lib.presets.push(...presets);
    this.saveLib();
    this.deps.notify(`Загружено: ${plural(graphs, ['схема', 'схемы', 'схем'])}, ${plural(macros.length, ['своя нода', 'своих ноды', 'своих нод'])}, ${plural(presets.length, ['пресет', 'пресета', 'пресетов'])}`);
    if (first) this.open({ scope: 'mine', id: first });
    else this.renderAll();
  }

  // ---------- rendering ----------

  private renderAll() {
    this.renderSide();
    this.renderBar();
    this.renderSource();
    this.renderRun();
  }

  private item(name: string, sum: string, on: boolean, open: (() => void) | null, menu: () => MenuEntry[]) {
    const show = (x: number, y: number) => showMenuAt(x, y, menu());
    const btn = h(
      'button',
      { class: `nde-item${on ? ' on' : ''}`, disabled: !!this.abort && !on, onclick: () => open?.(), oncontextmenu: (e: MouseEvent) => (e.preventDefault(), show(e.clientX, e.clientY)) },
      h('span', { class: 'nde-item-name' }, name),
      h('span', { class: 'nde-item-sum' }, sum),
    );
    const more = h('button', { class: 'nde-more', title: 'Ещё', 'aria-label': 'Ещё', onclick: (e: MouseEvent) => (e.stopPropagation(), show(more.getBoundingClientRect().left, more.getBoundingClientRect().bottom)) }, '⋯');
    return h('div', { class: 'nde-item-wrap' }, btn, more);
  }

  private renderSide() {
    const doc = this.deps.editor.doc;
    const isOn = (scope: Where['scope'], id: string) => this.where.scope === scope && this.where.id === id;
    this.mine.replaceChildren(
      ...this.lib.graphs.map((g) =>
        this.item(g.name || t('Без имени'), nodesWord(g.nodes.length), isOn('mine', g.id), () => this.open({ scope: 'mine', id: g.id }), () => [
          { label: 'Переименовать…', run: () => void askName('Название схемы', g.name).then((v) => v && ((g.name = v), this.saveLib(), this.renderAll())) },
          { label: 'Копия', run: () => this.copyToMine(g, `${g.name} (копия)`) },
          { label: 'Поделиться в файле', hint: 'для команды', run: () => this.share(g) },
          { label: 'Скачать JSON', run: () => download(g.name, { format: FORMAT, version: 1, graphs: [g], macros: [], presets: [] }) },
          'sep',
          {
            label: 'Удалить',
            disabled: this.lib.graphs.length < 2 || !!this.abort,
            run: () => {
              this.lib.graphs = this.lib.graphs.filter((x) => x !== g);
              this.saveLib();
              if (isOn('mine', g.id)) this.open({ scope: 'mine', id: this.lib.graphs[0]!.id });
              else this.renderSide();
            },
          },
        ]),
      ),
    );
    const shared = fileGraphs(doc);
    this.inFile.replaceChildren(
      ...(shared.length
        ? shared.map((g) =>
            this.item(g.name || t('Без имени'), nodesWord(g.nodes.length), isOn('file', g.id), () => this.open({ scope: 'file', id: g.id }), () => [
              { label: 'Копию — в мои схемы', run: () => this.copyToMine(g) },
              { label: 'Скачать JSON', run: () => download(g.name, { format: FORMAT, version: 1, graphs: [g], macros: [], presets: [] }) },
              'sep',
              {
                label: 'Убрать из файла',
                disabled: !!this.abort,
                run: () => {
                  if (isOn('file', g.id)) this.open({ scope: 'mine', id: this.lib.graphs[0]!.id });
                  removeFileGraph(doc, g.id);
                },
              },
            ]),
          )
        : [h('div', { class: 'img-note' }, 'Пока пусто. «⋯» у своей схемы → «Поделиться в файле» — и ею смогут пользоваться все, у кого есть этот файл.')]),
    );
    this.renderCustom();
  }

  private renderCustom() {
    const macros = this.lib.macros.map((m) =>
      this.item(m.name, `своя нода · ${nodesWord(m.nodes.length)}`, false, () => this.canvas.addMacro(m), () => [
        { label: 'Добавить на холст', run: () => this.canvas.addMacro(m) },
        {
          label: 'Переименовать…',
          run: () =>
            void askName('Название своей ноды', m.name).then((v) => {
              if (!v) return;
              m.name = v;
              this.saveLib();
              this.renderCustom();
              this.canvas.renameMacro(m.id, v);
            }),
        },
        'sep',
        { label: 'Удалить из «Моих нод»', hint: 'в схемах останется', run: () => ((this.lib.macros = this.lib.macros.filter((x) => x !== m)), this.saveLib(), this.renderCustom()) },
      ]),
    );
    const presets = this.lib.presets.map((p: Preset) =>
      this.item(p.name, `пресет · ${BUILTIN_MAP.get(p.nodeType)?.title ?? p.nodeType}`, false, () => this.canvas.addPreset(p), () => [
        { label: 'Добавить на холст', run: () => this.canvas.addPreset(p) },
        { label: 'Переименовать…', run: () => void askName('Название пресета', p.name).then((v) => v && ((p.name = v), this.saveLib(), this.renderCustom())) },
        'sep',
        { label: 'Удалить', run: () => ((this.lib.presets = this.lib.presets.filter((x) => x !== p)), this.saveLib(), this.renderCustom()) },
      ]),
    );
    this.custom.replaceChildren(
      ...(macros.length || presets.length ? [...macros, ...presets] : [h('div', { class: 'img-note' }, 'Выделите ноды → ПКМ → «Собрать в свою ноду». ПКМ по ноде → «Сохранить как пресет» — её настройки (например, шаблон запроса) станут отдельной нодой.')]),
    );
  }

  private renderBar() {
    this.name.value = this.graph.name;
    this.name.disabled = !!this.abort;
    const file = this.where.scope === 'file';
    this.scope.textContent = file ? 'В этом файле — правки видны всей команде' : 'Моя схема — хранится в этом браузере';
    this.scope.classList.toggle('shared', file);
    this.barActions.replaceChildren(
      file
        ? h('button', { class: 'ups-btn', onclick: () => this.copyToMine(this.graph) }, 'Копию — в мои схемы')
        : h('button', { class: 'ups-btn', title: 'Сохранить копию в этом файле для команды', onclick: () => this.share(this.graph) }, 'Поделиться в файле'),
    );
  }

  private imageSource() {
    return this.graph.nodes.find((n) => BUILTIN_MAP.get(n.type)?.source === 'images') ?? null;
  }

  private renderSource() {
    for (const u of this.thumbs) URL.revokeObjectURL(u);
    this.thumbs = [];
    const sources = this.graph.nodes.filter((n) => BUILTIN_MAP.get(n.type)?.source);
    const src = sources[0];
    if (sources.length > 1) return void this.source.replaceChildren(h('div', { class: 'img-note error' }, 'Источник пакета должен быть один: оставьте одну ноду «Запросы» или «Картинки»'));
    if (!src) return void this.source.replaceChildren(h('div', { class: 'img-note' }, 'Без источника — один прогон. Нода «Запросы» или «Картинки» даст пакет: схема пройдёт для каждого.'));
    if (src.type === 'prompts') {
      const n = String(src.params.lines ?? '').split('\n').filter((l) => l.trim()).length;
      return void this.source.replaceChildren(h('div', { class: n ? 'img-note' : 'img-note warn' }, n ? `${plural(n, ['запрос', 'запроса', 'запросов'])} в ноде «Запросы» — по прогону на каждый` : 'Впишите запросы в ноду «Запросы»: по одному на строку, «имя | запрос» задаёт имя фреймов'));
    }
    const list = this.images.get(src.id) ?? [];
    const sel = this.deps.editor.selection;
    fill(this.source,
      h('div', { class: 'img-note' }, list.length ? `${plural(list.length, ['картинка', 'картинки', 'картинок'])} для ноды «Картинки»` : 'Картинки для ноды «Картинки»: перетащите сюда, вставьте Ctrl+V или выберите'),
      list.length
        ? h(
            'div',
            { class: 'nde-images' },
            ...list.slice(0, 18).map((x) => {
              const url = URL.createObjectURL(x.blob);
              this.thumbs.push(url);
              return h('img', { class: 'nde-image', src: url, alt: x.name, title: x.name });
            }),
          )
        : null,
      h(
        'div',
        { class: 'nde-source-actions' },
        h('button', { class: 'ups-btn', disabled: !!this.abort, onclick: () => this.files.click() }, 'Файлы…'),
        h('button', { class: 'ups-btn', disabled: !!this.abort || !sel.length, onclick: () => void this.addSelection() }, 'Из выделения'),
        h('button', { class: 'ups-btn', disabled: !!this.abort, title: 'Картинки из файлов команды: проект → файл → страница', onclick: () => void this.addFromProjects() }, 'Из проекта…'),
        list.length ? h('button', { class: 'ups-btn', disabled: !!this.abort, onclick: () => (this.images.delete(src.id), this.renderSource()) }, 'Очистить') : null,
      ),
    );
  }

  private renderRun() {
    const s = this.deps.settings();
    const gpu = this.deps.probe();
    fill(this.engines,
      `«Авто»: создание — ${s.geminiKey ? 'Nano Banana' : 'видеокарта (SD-Turbo)'}, увеличение — ${s.magnificKey ? 'Magnific' : 'видеокарта'}. `,
      h('button', { class: 'ups-link', onclick: () => this.deps.openSettings() }, 'Подключения'),
      gpu && !gpu.ok ? h('div', { class: 'ups-need' }, `Видеокарта недоступна: ${gpu.text}`) : null,
    );
    this.runBtn.textContent = this.abort ? 'Остановить' : 'Запустить';
    this.runBtn.classList.toggle('stop', !!this.abort);
  }

  /** Keys changed in “Connections”. */
  refresh() {
    this.renderRun();
  }

  // ---------- images for the “Images” node ----------

  private addFiles(files: File[]) {
    const src = this.imageSource();
    this.files.value = '';
    if (!src) return this.deps.notify('Добавьте в схему ноду «Картинки»', 'error');
    const list = this.images.get(src.id) ?? [];
    for (const f of files) if (f.type.startsWith('image/')) list.push({ name: f.name.replace(/\.[^.]+$/, ''), blob: f });
    this.images.set(src.id, list);
    this.renderSource();
  }

  private async addSelection() {
    const src = this.imageSource();
    if (!src) return;
    const { editor } = this.deps;
    const list = this.images.get(src.id) ?? [];
    const doc = editor.doc;
    for (const id of editor.selection) {
      const hash = topImage(doc.get(id, 'fills'))?.imageHash;
      const bytes = hash ? await editor.store.readImage(hash) : undefined;
      if (!hash || !bytes) continue;
      const name = String(doc.get(id, 'name') || 'image');
      const origin: ImageOrigin = { fileId: this.deps.cloud.openFileId(), fileName: 'Открытый файл', doc, nodeId: id, hash, name, width: Math.round(Number(doc.get(id, 'width') ?? 0)), height: Math.round(Number(doc.get(id, 'height') ?? 0)) };
      list.push({ name: baseName(name), blob: new Blob([bytes as BlobPart]), origin });
    }
    this.images.set(src.id, list);
    if (!list.length) this.deps.notify('В выделении нет слоёв с картинкой', 'error');
    this.renderSource();
  }

  private async addFromProjects() {
    const src = this.imageSource();
    if (!src) return;
    const { editor, server, cloud } = this.deps;
    const picked = await pickImages({ editor, server, cloud }, { multiple: true, title: 'Картинки для схемы', action: 'Добавить' });
    if (!picked?.length) return;
    const list = this.images.get(src.id) ?? [];
    let failed = 0;
    let next = 0;
    this.status.className = 'ups-status';
    const work = async () => {
      while (next < picked.length) {
        const p = picked[next++]!;
        try {
          list.push({ name: baseName(p.origin.name), blob: await p.load(), origin: p.origin });
        } catch {
          failed++;
        }
        this.status.textContent = `Загружаю картинки: ${list.length} из ${picked.length}`;
      }
    };
    await Promise.all([work(), work(), work(), work()]);
    this.status.textContent = '';
    this.images.set(src.id, list);
    if (failed) this.deps.notify(`Не загрузились: ${failed}`, 'error');
    this.renderSource();
  }

  // ---------- run ----------

  private stop() {
    this.abort?.abort();
    this.status.textContent = 'Останавливаю…';
  }

  private paint(r: Row) {
    r.el.className = `nde-qrow ${r.state}`;
    r.el.replaceChildren(
      r.thumb ? h('img', { class: 'nde-thumb', src: r.thumb, alt: '' }) : h('span', { class: 'nde-thumb' }),
      h('span', { class: 'nde-qrow-name' }, r.name),
      h('span', { class: 'nde-qrow-text' }, r.text),
    );
  }

  private async run() {
    this.flushFile();
    const graph = structuredClone(this.graph);
    const fail = (text: string) => {
      this.status.textContent = text;
      this.status.className = 'ups-status error';
    };
    let items;
    try {
      items = batchItems(graph, BUILTIN_MAP, this.images, graph.name);
    } catch (e) {
      return fail((e as Error).message);
    }
    if (!graph.nodes.some((n) => BUILTIN_MAP.get(n.type)?.output)) return fail('В схеме нет вывода — добавьте «На страницу» или «Заменить в документе»');
    if (!items.length) return fail(this.imageSource() ? 'Добавьте картинки для ноды «Картинки»' : 'Впишите запросы в ноду «Запросы»');
    if (graph.nodes.some((n) => n.type === 'replace') && items.some((it) => !it.origin)) return fail('«Заменить в документе» меняет картинки из документа — добавьте их «Из выделения» или «Из проекта…»');

    for (const r of this.rows) if (r.thumb) URL.revokeObjectURL(r.thumb);
    this.rows = items.map((it) => ({ name: it.name, state: 'wait', text: 'Ждёт', el: h('div') }));
    this.rows.forEach((r) => this.paint(r));
    this.queue.replaceChildren(...this.rows.map((r) => r.el));

    const abort = new AbortController();
    this.abort = abort;
    this.lastPage = null;
    this.openBtn.hidden = true;
    this.revertBtn.hidden = true;
    this.writer?.dispose();
    const writer = new ImageWriter(this.deps.editor, this.deps.server, this.deps.cloud);
    this.writer = writer;
    const files = new Set<string>();
    this.status.className = 'ups-status';
    this.canvas.setLocked(true);
    this.renderAll();
    const { editor } = this.deps;
    const services = createServices({ engine: this.deps.engine, settings: this.deps.settings, server: this.deps.server, probe: this.deps.probe });
    const placers = new Map<string, PagePlacer>();
    const used = new Set<string>();
    const started = performance.now();
    let ok = 0;
    let broken: string | null = null;

    for (const [i, it] of items.entries()) {
      const row = this.rows[i]!;
      if (abort.signal.aborted || broken) {
        row.state = 'stopped';
        row.text = 'Не запускалась';
        this.paint(row);
        continue;
      }
      this.status.textContent = `${i + 1} из ${items.length}`;
      this.bar.style.width = `${(i / items.length) * 100}%`;
      row.state = 'run';
      row.text = 'Считаю…';
      this.paint(row);
      this.canvas.clearStates();
      const outs: PageOutput[] = [];
      const reps: ReplaceOutput[] = [];
      try {
        await runItem(graph, BUILTIN_MAP, {
          item: it,
          services,
          signal: abort.signal,
          status: (t) => ((row.text = t), this.paint(row)),
          emit: (o) => outs.push(o),
          replace: (o) => reps.push(o),
          onNode: (id, s) => this.canvas.setState(id, s),
        });
        if (!outs.length && !reps.length) throw new Error('Ни одна нода вывода ничего не получила');
        for (const r of reps) {
          row.text = `Заменяю в «${r.origin.fileName}»…`;
          this.paint(row);
          await writer.replace(r.origin, r.blob, r.width, r.height, r.resize);
          files.add(r.origin.fileName);
        }
        const byPage = new Map<string, PageOutput[]>();
        for (const o of outs) byPage.set(o.page, [...(byPage.get(o.page) ?? []), o]);
        for (const [page, list] of byPage) {
          let placer = placers.get(page);
          if (!placer) placers.set(page, (placer = new PagePlacer(editor, findOrCreatePage(editor, page))));
          await placer.placeRow(list.map((o) => ({ name: o.name, width: o.width, height: o.height, blob: o.blob })));
          used.add(page);
          this.lastPage ??= placer.pageId;
        }
        row.thumb = URL.createObjectURL((outs[0] ?? reps[0])!.blob);
        row.state = 'done';
        row.text = [outs.map(sizeText).join(' + '), reps.length ? `заменено: ${reps.map(sizeText).join(' + ')}` : ''].filter(Boolean).join(' · ');
        ok++;
      } catch (e) {
        const stopped = (e as Error).name === 'AbortError';
        row.state = stopped ? 'stopped' : 'error';
        row.text = stopped ? 'Остановлено' : (e as Error).message;
        // An error in the graph itself will repeat on every item, so stop here
        if (e instanceof GraphError) broken = (e as Error).message;
      }
      this.paint(row);
    }

    this.abort = null;
    this.canvas.setLocked(false);
    this.bar.style.width = '0';
    const seconds = Math.round((performance.now() - started) / 1000);
    const where = [...[...used].map((p) => `«${p}»`), ...[...files].map((f) => `в файле «${f}»`)].join(', ');
    this.status.textContent = broken ?? `Готово: ${ok} из ${items.length} за ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}${where ? ` → ${where}` : ''}`;
    this.status.className = `ups-status${broken ? ' error' : ok ? ' ok' : ''}`;
    this.openBtn.hidden = !used.size;
    this.revertBtn.hidden = !writer.done.length;
    this.revertBtn.textContent = `Вернуть замены (${writer.done.length})`;
    this.renderAll();
    if (ok) this.deps.notify(`Схема «${graph.name}»: ${ok} шт. → ${where}`);
  }

  private async revert() {
    const w = this.writer;
    if (!w || this.abort) return;
    this.revertBtn.disabled = true;
    try {
      const n = await w.revert();
      this.status.textContent = `Вернул прежние картинки: ${n}`;
      this.status.className = 'ups-status ok';
      this.revertBtn.hidden = true;
    } catch (e) {
      this.status.textContent = (e as Error).message;
      this.status.className = 'ups-status error';
    }
    this.revertBtn.disabled = false;
  }
}
