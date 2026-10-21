// The “Image enhancements” page (the “Enhancements” section in the left strip): upscaling (Real-ESRGAN
// on the GPU or Magnific), background removal (BiRefNet on the GPU), generation (Nano Banana or
// SD-Turbo on the GPU) and node graphs that export results onto document pages.

import './imaging.css';
import { h, svgEl } from '../dom.ts';
import type { Editor } from '../editor.ts';
import { ICON } from '../icons.ts';
import type { MenuEntry } from '../menu.ts';
import { DOC_MAX_BYTES, imageTarget, insertImage, replaceImage, type ImageTarget } from './document.ts';
import { Cancelled, ImagingEngine, MATTE_MODEL, UPSCALE_MODELS, matteCached, upscaleModelUrl, type UpscaleModel } from './engine.ts';
import { network } from '../network.ts';
import { ASPECT_RATIOS, IMAGE_SIZES, generateImage } from './gemini.ts';
import { loadSettings, openSettings, type ImagingSettings } from './keys.ts';
import { MAGNIFIC_MAX_PIXELS, MAGNIFIC_SCALES, OPTIMIZED_FOR, magnificUpscale, type MagnificMode, type ServerLink } from './magnific.ts';
import { NodesView } from './nodes/view.ts';
import { VideoView } from './video/view.ts';
import { pickImages, type Picked } from './picker.ts';
import { ImageWriter, type Cloud } from './projects.ts';
import type { GpuProbe } from './protocol.ts';
import { t } from '../i18n/index.ts';

export interface ImagingDeps {
  editor: Editor;
  notify: (message: string, kind?: 'info' | 'error') => void;
  server: ServerLink;
  cloud: Cloud;
}

type Tab = 'upscale' | 'matte' | 'generate' | 'nodes' | 'video';
const TABS: [Tab, string][] = [
  ['upscale', 'Увеличение'],
  ['matte', 'Фон'],
  ['generate', 'Генерация'],
  ['nodes', 'Схемы'],
  ['video', 'Видео'],
];

const LOCAL_SCALES = [2, 3, 4];
const MAX_SIDE = 32768;
const MAX_PIXELS = 400e6;
const PREVIEW_MAX = 2048;
const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/bmp,image/gif,image/avif';

const RAIL_ICON =
  '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="6.5" width="13" height="13" rx="2"/><path d="M3.5 16l3.5-3.5 3 3 2-2 4.5 4.5"/><path d="M19 2.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>';

const kName = (w: number, h: number) => {
  const long = Math.max(w, h);
  const off = (k: number) => Math.min(Math.abs(long - 960 * k), Math.abs(long - 1024 * k));
  const k = [1, 2, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32].reduce((best, k) => (off(k) < off(best) ? k : best));
  return off(k) / long < 0.1 ? ` (${k}K)` : '';
};
const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const megabytes = (bytes: number) => (bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)} ГБ` : `${Math.max(1, Math.round(bytes / 2 ** 20))} МБ`);

let openPage: ImagingPage | null = null;
const insidePage = (target: EventTarget | null) =>
  !!openPage && (target === document.body || target === document.documentElement || (target instanceof Node && openPage.root.contains(target)));

// This module loads before main.ts registers its shortcuts, so this interception runs first:
// while the page is open, keys and the clipboard do not reach the document behind it. Dialogs over the page
// (connections) and an open menu handle their own keys; graphs get their keys here.
window.addEventListener(
  'keydown',
  (e) => {
    if (!insidePage(e.target) || document.querySelector('body > .menu')) return;
    if (openPage!.key(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      openPage!.close();
    }
    e.stopImmediatePropagation();
  },
  true,
);
for (const type of ['paste', 'copy', 'cut'] as const) {
  window.addEventListener(
    type,
    (e) => {
      if (!insidePage(e.target)) return;
      e.stopImmediatePropagation();
      if (type === 'paste') openPage!.paste(e as ClipboardEvent);
    },
    true,
  );
}

interface Source {
  blob: Blob;
  bitmap: ImageBitmap;
  name: string;
  target: ImageTarget | null;
  /** Width of the layer image before any enhancements, for recomputing the TILE pattern. */
  targetWidth: number;
}

interface Result {
  blob: Blob;
  width: number;
  height: number;
  op: Tab;
  trimmed: boolean;
}

class ImagingPage {
  readonly root: HTMLElement;
  onToggle: (open: boolean) => void = () => undefined;

  private readonly deps: ImagingDeps;
  private readonly engine = new ImagingEngine();
  private probe: GpuProbe | null = null;
  private available = new Map<string, boolean>();
  /** The background removal model is downloaded into the browser cache (not bundled). */
  private matteReady = false;
  private settings: ImagingSettings = loadSettings();
  private tab: Tab = 'upscale';
  private source: Source | null = null;
  private result: Result | null = null;
  private resultUrl: string | null = null;
  private running: { cancel: () => void } | null = null;
  private firstTile = 0;

  private upEngine: 'local' | 'magnific' = 'local';
  private model: UpscaleModel = UPSCALE_MODELS[0]!;
  private scale = 4;
  private magMode: MagnificMode = 'creative';
  private magScale = 2;
  private magOptimized = 'standard';
  private magPrompt = '';
  private trim = false;
  private genPrompt = '';
  private genAspect = '1:1';
  private genSize = '1K';
  private genUseSource = false;
  private genEngine: 'local' | 'nano' = 'local';
  private genSteps = 2;
  private genSeed = '';
  private sdCached: boolean | null = null;
  private lastSeed: number | null = null;

  private readonly tabsEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly single: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly srcCanvas: HTMLCanvasElement;
  private readonly outCanvas: HTMLCanvasElement;
  private readonly drop: HTMLElement;
  private readonly fromSelection: HTMLButtonElement;
  private readonly fileBar: HTMLElement;
  private readonly options: HTMLElement;
  private readonly sizeInfo: HTMLElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly gpu: HTMLElement;
  private readonly input: HTMLInputElement;
  private nodes: NodesView | null = null;
  private video: VideoView | null = null;
  /** The last replacement in a server file, for “Revert”. */
  private writer: ImageWriter | null = null;

  constructor(deps: ImagingDeps) {
    this.deps = deps;
    this.genEngine = this.settings.geminiKey ? 'nano' : 'local';
    this.input = h('input', { type: 'file', accept: IMAGE_TYPES, hidden: true, onchange: () => this.input.files?.[0] && void this.loadFile(this.input.files[0]) });
    this.fromSelection = h('button', { class: 'ups-btn ups-from-sel', hidden: true, onclick: () => void this.loadSelection() });
    this.srcCanvas = h('canvas', { class: 'ups-src' });
    this.outCanvas = h('canvas', { class: 'ups-out' });
    this.frame = h('div', { class: 'ups-frame', hidden: true, title: 'Удерживайте, чтобы сравнить с исходником' }, this.srcCanvas, this.outCanvas);
    this.drop = h(
      'div',
      { class: 'ups-drop' },
      svgEl('div', { class: 'ups-drop-ic' }, ICON.image),
      h('div', { class: 'ups-drop-title' }, 'Перетащите изображение сюда'),
      h('div', { class: 'ups-drop-sub' }, 'PNG, JPEG, WebP · Ctrl+V — из буфера обмена'),
      h(
        'div',
        { class: 'ups-drop-actions' },
        h('button', { class: 'ups-btn', onclick: () => this.input.click() }, 'Выбрать файл'),
        h('button', { class: 'ups-btn', title: 'Картинка слоя из файлов команды: проект → файл → страница', onclick: () => void this.loadFromProjects() }, 'Из проекта…'),
        this.fromSelection,
      ),
    );
    this.fileBar = h('div', { class: 'ups-filebar', hidden: true });
    this.stage = h('div', { class: 'ups-stage' }, this.drop, this.frame, this.fileBar);

    this.options = h('div', { class: 'ups-options' });
    this.sizeInfo = h('div', { class: 'ups-size' });
    this.runBtn = h('button', { class: 'ups-run', disabled: true, onclick: () => (this.running ? this.running.cancel() : void this.run()) }, 'Запустить');
    this.bar = h('div', { class: 'ups-bar-fill' });
    this.status = h('div', { class: 'ups-status' });
    this.actions = h('div', { class: 'ups-result-actions' });
    this.gpu = h('div', { class: 'ups-gpu' }, 'Проверяю видеокарту…');
    const side = h(
      'aside',
      { class: 'ups-side' },
      this.options,
      h('div', { class: 'ups-section ups-actions' }, this.sizeInfo, this.runBtn, h('div', { class: 'ups-bar' }, this.bar), this.status, this.actions),
      h('div', { class: 'ups-foot' }, this.gpu, h('div', { class: 'ups-private' }, 'Увеличение и удаление фона считаются на этом компьютере. В Nano Banana и Magnific картинка уходит, только если выбрать их, — с вашими ключами.')),
    );
    this.single = h('div', { class: 'ups-body' }, this.stage, side);
    this.body = h('div', { class: 'ups-main' }, this.single);

    this.tabsEl = h('div', { class: 'ups-tabs', role: 'tablist' });
    this.root = h(
      'section',
      { class: 'upscaler', hidden: true, tabIndex: -1, role: 'dialog', 'aria-label': 'Улучшения изображений' },
      h(
        'header',
        { class: 'ups-head' },
        h('h2', { class: 'ups-title' }, 'Улучшения изображений'),
        this.tabsEl,
        h('button', { class: 'ups-btn ups-keys', onclick: () => this.openKeys() }, 'Подключения'),
        svgEl('button', { class: 'ups-close', title: 'Закрыть (Esc)', 'aria-label': 'Закрыть', onclick: () => this.close() }, ICON.close),
      ),
      this.body,
      this.input,
    );
    document.body.append(this.root);

    this.stage.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.stage.classList.add('drag');
    });
    this.stage.addEventListener('dragleave', () => this.stage.classList.remove('drag'));
    this.stage.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.stage.classList.remove('drag');
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (file && !this.running) void this.loadFile(file);
    });
    this.frame.addEventListener('pointerdown', () => this.frame.classList.add('compare'));
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) this.frame.addEventListener(type, () => this.frame.classList.remove('compare'));
    new ResizeObserver(() => this.fit()).observe(this.stage);
    this.setTab('upscale');
  }

  get isOpen() {
    return !this.root.hidden;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.root.hidden = false;
    openPage = this;
    this.root.focus();
    this.onToggle(true);
    if (!this.probe) {
      void this.engine.probe().then((p) => {
        this.probe = p;
        this.gpu.textContent = p.ok ? `Видеокарта: ${p.text} · ${p.f16 ? 'fp16' : 'fp32'}` : p.text;
        this.gpu.classList.toggle('warn', !p.ok);
        void this.checkModels();
      });
    } else void this.checkModels(); // internet access or the model cache may have changed
    const target = imageTarget(this.deps.editor, this.deps.editor.selection);
    this.fromSelection.hidden = !target;
    if (target) this.fromSelection.textContent = `Взять из выделения — ${target.name}`;
  }

  close() {
    if (!this.isOpen) return;
    this.root.hidden = true;
    if (openPage === this) openPage = null;
    this.onToggle(false);
  }

  async openFor(target: ImageTarget, tab: Tab) {
    this.open();
    // A layer from the document: cropping would break replacing its image
    this.trim = false;
    this.setTab(tab);
    if (!this.running) await this.loadTarget(target);
  }

  key(e: KeyboardEvent): boolean {
    return this.tab === 'nodes' && !!this.nodes?.key(e);
  }

  paste(e: ClipboardEvent) {
    if (this.tab === 'nodes') return this.nodes?.paste(e);
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (!file || this.running) return;
    e.preventDefault();
    void this.loadFile(file);
  }

  private openKeys() {
    openSettings(this.deps.server, (s) => {
      this.settings = s;
      if (!s.geminiKey) this.genEngine = 'local';
      this.renderOptions();
      this.update();
      this.nodes?.refresh();
    });
  }

  private setTab(tab: Tab) {
    if (this.running) return;
    this.tab = tab;
    this.tabsEl.replaceChildren(
      ...TABS.map(([id, label]) =>
        h('button', { class: `ups-tab${id === tab ? ' on' : ''}`, role: 'tab', 'aria-selected': String(id === tab), onclick: () => this.setTab(id) }, label),
      ),
    );
    if (tab === 'nodes') {
      this.nodes ??= new NodesView({
        editor: this.deps.editor,
        engine: this.engine,
        probe: () => this.probe,
        settings: () => this.settings,
        server: this.deps.server,
        cloud: this.deps.cloud,
        notify: this.deps.notify,
        openSettings: () => this.openKeys(),
      });
      this.body.replaceChildren(this.nodes.el);
      this.nodes.show();
      return;
    }
    if (tab === 'video') {
      this.video ??= new VideoView({ notify: this.deps.notify });
      this.body.replaceChildren(this.video.el);
      this.video.show();
      return;
    }
    this.body.replaceChildren(this.single);
    if (tab === 'generate' && this.sdCached === null) void this.engine.sdCached().then((c) => ((this.sdCached = c), this.renderOptions()));
    this.renderOptions();
    this.update();
    this.fit();
  }

  private async checkModels() {
    const f16 = !!this.probe?.f16;
    const urls = new Map(UPSCALE_MODELS.map((m) => [m.id, upscaleModelUrl(m.id, f16)] as const));
    // Background removal: the model is downloaded on first run; available if already downloaded or online.
    this.matteReady = await matteCached();
    this.available.set('matte', this.matteReady || network.allowed);
    await Promise.all(
      [...urls].map(async ([id, url]) => {
        try {
          const r = await fetch(url, { method: 'HEAD' });
          this.available.set(id, r.ok && !(r.headers.get('content-type') ?? '').includes('text/html'));
        } catch {
          this.available.set(id, false);
        }
      }),
    );
    if (!this.available.get(this.model.id)) this.model = UPSCALE_MODELS.find((m) => this.available.get(m.id)) ?? this.model;
    this.renderOptions();
    this.update();
  }

  private seg<T extends string | number>(values: T[], current: T, label: (v: T) => string, set: (v: T) => void) {
    return h(
      'div',
      { class: 'ups-seg', style: `grid-template-columns: repeat(${values.length}, 1fr)` },
      ...values.map((v) =>
        h('button', { class: `ups-seg-btn${v === current ? ' on' : ''}`, disabled: !!this.running, onclick: () => (set(v), this.renderOptions(), this.update()) }, label(v)),
      ),
    );
  }

  private section(label: string, ...children: (Node | null)[]) {
    return h('div', { class: 'ups-section' }, h('div', { class: 'ups-label' }, label), ...children.filter((c): c is Node => !!c));
  }

  private needKey(what: string) {
    return h('div', { class: 'ups-need' }, `Нужен ключ ${what}. `, h('button', { class: 'ups-link', onclick: () => this.openKeys() }, 'Подключения'));
  }

  private renderOptions() {
    const f16 = !!this.probe?.f16;
    const s = this.settings;
    const parts: Node[] = [];
    if (this.tab === 'upscale') {
      parts.push(this.section('Где считать', this.seg<'local' | 'magnific'>(['local', 'magnific'], this.upEngine, (v) => (v === 'local' ? 'На видеокарте' : 'Magnific'), (v) => (this.upEngine = v))));
      if (this.upEngine === 'local') {
        parts.push(
          this.section(
            'Модель',
            h(
              'div',
              { class: 'ups-models', role: 'radiogroup' },
              ...UPSCALE_MODELS.map((m) => {
                const ready = this.available.get(m.id) !== false;
                return h(
                  'button',
                  { class: `ups-model${m === this.model ? ' on' : ''}`, role: 'radio', 'aria-checked': String(m === this.model), disabled: !ready || !!this.running, onclick: () => ((this.model = m), this.renderOptions(), this.update()) },
                  h('span', { class: 'ups-model-name' }, m.name, h('span', { class: 'ups-model-size' }, ready ? m.size[f16 ? 'fp16' : 'fp32'] : 'не установлена')),
                  h('span', { class: 'ups-model-hint' }, m.hint),
                );
              }),
            ),
          ),
          this.section('Масштаб', this.seg(LOCAL_SCALES, this.scale, (v) => `×${v}`, (v) => (this.scale = v))),
        );
      } else {
        const prompt = h('input', { class: 'img-input', value: this.magPrompt, placeholder: 'Подсказка (необязательно)', oninput: () => (this.magPrompt = prompt.value) }) as HTMLInputElement;
        parts.push(
          this.section('Режим', this.seg<MagnificMode>(['creative', 'precision'], this.magMode, (v) => (v === 'creative' ? 'Creative' : 'Precision V2'), (v) => (this.magMode = v)), s.magnificKey ? null : this.needKey('Magnific')),
          this.section('Масштаб', this.seg(MAGNIFIC_SCALES, this.magScale, (v) => `×${v}`, (v) => (this.magScale = v))),
        );
        if (this.magMode === 'creative') {
          parts.push(
            this.section(
              'Настройка',
              h('select', { class: 'img-input', onchange: (e: Event) => (this.magOptimized = (e.target as HTMLSelectElement).value) }, ...OPTIMIZED_FOR.map(([v, l]) => h('option', { value: v, selected: v === this.magOptimized }, l))),
              prompt,
            ),
          );
        }
      }
    } else if (this.tab === 'matte') {
      const trim = h('input', { type: 'checkbox', checked: this.trim, disabled: !!this.running, onchange: () => ((this.trim = trim.checked), this.update()) }) as HTMLInputElement;
      parts.push(
        this.section(
          'Удаление фона',
          h('div', { class: 'ups-model-hint' }, `BiRefNet-lite на видеокарте · ${this.matteReady ? `${MATTE_MODEL.size}, скачана` : this.available.get('matte') === false ? `для первой загрузки нужен интернет (${MATTE_MODEL.size})` : `скачается при первом запуске (${MATTE_MODEL.size})`}`),
          h('label', { class: 'img-check' }, trim, 'Обрезать по объекту'),
          h('div', { class: 'img-note' }, 'С обрезкой картинку нельзя вернуть в тот же слой — только вставить новым.'),
        ),
      );
    } else if (this.genEngine === 'local') {
      const prompt = h('textarea', { class: 'img-input', rows: 5, value: this.genPrompt, placeholder: 'Что нарисовать — по-английски, например: red potion bottle, game icon', oninput: () => ((this.genPrompt = prompt.value), this.update()) }) as HTMLTextAreaElement;
      const seed = h('input', { class: 'img-input img-num', type: 'number', min: 0, value: this.genSeed, placeholder: 'случайно', oninput: () => (this.genSeed = seed.value) }) as HTMLInputElement;
      const purge = h('button', { class: 'ups-link', onclick: () => void this.engine.sdPurge().then((c) => ((this.sdCached = c), this.renderOptions())) }, 'удалить из браузера');
      parts.push(
        this.section('Где создавать', this.seg<'local' | 'nano'>(['local', 'nano'], this.genEngine, (v) => (v === 'local' ? 'На видеокарте' : 'Nano Banana'), (v) => (this.genEngine = v))),
        this.section('Запрос', prompt, h('div', { class: 'img-note' }, 'Модель понимает английский. Картинка 512×512 — дальше можно увеличить.')),
        this.section(
          'Настройка',
          h('div', { class: 'img-row' }, h('span', {}, 'Шаги'), this.seg([1, 2, 3, 4], this.genSteps, (v) => String(v), (v) => (this.genSteps = v))),
          h('label', { class: 'img-row' }, h('span', {}, 'Зерно'), seed),
          h('div', { class: 'img-note' }, 'SD-Turbo · ', this.sdCached ? h('span', {}, 'скачана в браузер (2,5 ГБ) · ', purge) : 'скачается при первом запуске (2,5 ГБ, один раз)'),
          this.probe && !this.probe.f16 ? h('div', { class: 'ups-need' }, 'Видеокарта без поддержки fp16 — локальная генерация недоступна') : null,
          h('div', { class: 'img-note' }, 'Powered by Stability AI · Stability AI Community License'),
        ),
      );
    } else {
      const prompt = h('textarea', { class: 'img-input', rows: 5, value: this.genPrompt, placeholder: 'Что нарисовать (или как изменить образец)', oninput: () => ((this.genPrompt = prompt.value), this.update()) }) as HTMLTextAreaElement;
      const useSource = h('input', { type: 'checkbox', checked: this.genUseSource, disabled: !this.source || !!this.running, onchange: () => (this.genUseSource = useSource.checked) }) as HTMLInputElement;
      parts.push(
        this.section('Где создавать', this.seg<'local' | 'nano'>(['local', 'nano'], this.genEngine, (v) => (v === 'local' ? 'На видеокарте' : 'Nano Banana'), (v) => (this.genEngine = v))),
        this.section('Запрос', prompt, h('label', { class: 'img-check' }, useSource, 'Образец — текущая картинка'), s.geminiKey ? null : this.needKey('Google AI')),
        this.section(
          'Формат',
          h('div', { class: 'img-row' },
            h('select', { class: 'img-input', onchange: (e: Event) => (this.genAspect = (e.target as HTMLSelectElement).value) }, ...ASPECT_RATIOS.map((r) => h('option', { value: r, selected: r === this.genAspect }, r))),
            h('select', { class: 'img-input', onchange: (e: Event) => (this.genSize = (e.target as HTMLSelectElement).value) }, ...IMAGE_SIZES.map((r) => h('option', { value: r, selected: r === this.genSize }, r))),
          ),
          h('div', { class: 'img-note' }, `Модель: ${s.geminiModel}`),
        ),
      );
    }
    this.options.replaceChildren(...parts);
  }

  private outputSize() {
    if (!this.source) return null;
    const { width, height } = this.source.bitmap;
    if (this.tab === 'matte') return { width, height, tooBig: width * height > 64e6, note: '' };
    if (this.tab !== 'upscale') return null;
    const k = this.upEngine === 'local' ? this.scale : this.magScale;
    const w = width * k;
    const hgt = height * k;
    const tooBig = this.upEngine === 'local' ? Math.max(w, hgt) > MAX_SIDE || w * hgt > MAX_PIXELS : w * hgt > MAGNIFIC_MAX_PIXELS;
    return { width: w, height: hgt, tooBig, note: tooBig ? (this.upEngine === 'local' ? 'слишком большой результат' : 'больше 25,3 Мп — предел Magnific') : '' };
  }

  private update() {
    const t = this.outputSize();
    this.sizeInfo.textContent = '';
    this.sizeInfo.classList.remove('warn');
    if (t && this.source) {
      const { width, height } = this.source.bitmap;
      this.sizeInfo.textContent = this.tab === 'upscale' ? `${width}×${height} → ${t.width}×${t.height}${kName(t.width, t.height)}` : `${width}×${height}`;
      const docTooBig = this.tab === 'upscale' && !!this.source.target && t.width * t.height * 1.2 > DOC_MAX_BYTES;
      if (t.note || docTooBig) {
        this.sizeInfo.classList.add('warn');
        this.sizeInfo.textContent += ` — ${t.note || 'для документа, скорее всего, больше 64 МБ'}`;
      }
    }
    const s = this.settings;
    let ready = false;
    if (this.tab === 'upscale') ready = !!t && !t.tooBig && (this.upEngine === 'local' ? !!this.probe?.ok && this.available.get(this.model.id) !== false : !!s.magnificKey);
    else if (this.tab === 'matte') ready = !!t && !t.tooBig && !!this.probe?.ok && this.available.get('matte') !== false;
    else if (this.tab === 'generate') ready = !!this.genPrompt.trim() && (this.genEngine === 'local' ? !!this.probe?.ok && !!this.probe.f16 : !!s.geminiKey);
    this.runBtn.disabled = !this.running && !ready;
    this.runBtn.textContent = this.running ? 'Остановить' : this.tab === 'upscale' ? 'Увеличить' : this.tab === 'matte' ? 'Убрать фон' : 'Создать';
    this.runBtn.classList.toggle('stop', !!this.running);
  }

  private async loadFile(file: File) {
    await this.load(file, file.name || t('Из буфера обмена'), null, 0);
  }

  private async loadSelection() {
    const target = imageTarget(this.deps.editor, this.deps.editor.selection);
    if (target && !this.running) await this.loadTarget(target);
  }

  private async loadFromProjects() {
    if (this.running) return;
    const { editor, server, cloud } = this.deps;
    const [p] = (await pickImages({ editor, server, cloud }, { multiple: false, title: 'Картинка из проекта', action: 'Взять' })) ?? [];
    if (p) await this.loadPicked(p);
  }

  private async loadPicked(p: Picked) {
    const o = p.origin;
    this.status.textContent = 'Загружаю картинку…';
    this.status.className = 'ups-status';
    const blob = await p.load().catch((e: Error) => (this.fail(e.message), null));
    if (!blob) return;
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) return this.fail('Не удалось прочитать картинку слоя');
    // Cropping would break the replacement in the same layer
    this.trim = false;
    this.renderOptions();
    await this.load(blob, o.name, { ids: [o.nodeId], hash: o.hash, name: o.name, origin: o }, bitmap.width, bitmap);
  }

  private async loadTarget(target: ImageTarget) {
    const bytes = await this.deps.editor.store.readImage(target.hash);
    if (!bytes) return this.fail('Картинка слоя ещё не загружена — попробуйте через пару секунд');
    const blob = new Blob([bytes as BlobPart]);
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) return this.fail('Не удалось прочитать картинку слоя');
    await this.load(blob, target.name, target, bitmap.width, bitmap);
  }

  private async load(blob: Blob, name: string, target: ImageTarget | null, targetWidth: number, ready?: ImageBitmap) {
    const bitmap = ready ?? (await createImageBitmap(blob).catch(() => null));
    if (!bitmap) return this.fail('Не удалось прочитать изображение');
    this.source?.bitmap.close();
    this.source = { blob, bitmap, name, target, targetWidth };
    this.clearResult();
    const k = Math.min(1, PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
    this.srcCanvas.width = this.outCanvas.width = Math.max(1, Math.round(bitmap.width * k));
    this.srcCanvas.height = this.outCanvas.height = Math.max(1, Math.round(bitmap.height * k));
    const ctx = this.srcCanvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, this.srcCanvas.width, this.srcCanvas.height);
    this.drop.hidden = true;
    this.frame.hidden = false;
    this.fileBar.hidden = false;
    this.fileBar.replaceChildren(
      ...(target ? [h('span', { class: 'ups-badge', title: target.origin ? `Файл «${target.origin.fileName}»` : '' }, target.origin && !target.origin.doc ? `Файл «${target.origin.fileName}»` : target.ids.length > 1 ? `Слои: ${target.ids.length}` : 'Слой')] : []),
      h('span', { class: 'ups-file-name' }, name),
      h('span', { class: 'ups-file-sub' }, `${bitmap.width}×${bitmap.height}${kName(bitmap.width, bitmap.height)}`),
      h('button', { class: 'ups-btn', onclick: () => !this.running && this.input.click() }, 'Заменить'),
    );
    this.status.textContent = '';
    this.status.className = 'ups-status';
    this.fit();
    this.renderOptions();
    this.update();
  }

  private fit() {
    const shown = this.result ?? (this.source ? { width: this.source.bitmap.width, height: this.source.bitmap.height } : null);
    if (!shown) return;
    const box = this.stage.getBoundingClientRect();
    const k = Math.min(Math.max(1, box.width - 48) / shown.width, Math.max(1, box.height - 96) / shown.height);
    this.frame.style.width = `${Math.round(shown.width * k)}px`;
    this.frame.style.height = `${Math.round(shown.height * k)}px`;
  }

  private setProgress(fraction: number) {
    this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10}%`;
  }

  private fail(message: string) {
    this.status.textContent = message;
    this.status.className = 'ups-status error';
  }

  private clearResult() {
    this.outCanvas.getContext('2d')!.clearRect(0, 0, this.outCanvas.width, this.outCanvas.height);
    if (this.resultUrl) URL.revokeObjectURL(this.resultUrl);
    this.resultUrl = null;
    this.result = null;
    this.frame.classList.remove('done');
    this.actions.replaceChildren();
    this.setProgress(0);
  }

  private begin(cancel: () => void) {
    this.clearResult();
    this.running = { cancel };
    this.firstTile = 0;
    this.status.textContent = 'Начинаю…';
    this.status.className = 'ups-status';
    this.renderOptions();
    this.update();
  }

  private end() {
    this.running = null;
    this.renderOptions();
    this.update();
  }

  private async run() {
    const tab = this.tab;
    try {
      let out: { blob: Blob; width: number; height: number; seconds: number };
      const started = performance.now();
      if (tab === 'generate' && this.genEngine === 'local') {
        const seed = this.genSeed.trim() ? Number(this.genSeed) : Math.floor(Math.random() * 2 ** 31);
        const job = this.engine.txt2img(
          { prompt: this.genPrompt, steps: this.genSteps, seed },
          {
            onStage: (text, fraction) => {
              this.status.textContent = text;
              if (fraction !== undefined) this.setProgress(fraction);
            },
            onProgress: (done, total) => this.setProgress(done / total),
          },
        );
        this.begin(() => this.engine.cancel(job.id));
        out = await job.done;
        this.sdCached = true;
        this.lastSeed = seed;
      } else if (tab === 'generate') {
        this.lastSeed = null;
        const abort = new AbortController();
        this.begin(() => abort.abort());
        this.status.textContent = 'Nano Banana рисует…';
        const blob = await generateImage({
          key: this.settings.geminiKey,
          model: this.settings.geminiModel,
          prompt: this.genPrompt,
          references: this.genUseSource && this.source ? [this.source.blob] : [],
          aspectRatio: this.genAspect,
          imageSize: this.genSize,
          signal: abort.signal,
        });
        out = { blob, ...(await this.sizeOf(blob)), seconds: (performance.now() - started) / 1000 };
      } else if (tab === 'upscale' && this.upEngine === 'magnific') {
        const source = this.source!;
        const abort = new AbortController();
        this.begin(() => abort.abort());
        const blob = await magnificUpscale(source.blob, {
          key: this.settings.magnificKey,
          host: this.settings.magnificHost,
          server: this.deps.server,
          mode: this.magMode,
          scale: this.magScale,
          prompt: this.magPrompt,
          optimizedFor: this.magOptimized,
          onStatus: (t) => (this.status.textContent = t),
          signal: abort.signal,
        });
        out = { blob, ...(await this.sizeOf(blob)), seconds: (performance.now() - started) / 1000 };
      } else {
        const source = this.source!;
        const bitmap = await createImageBitmap(source.bitmap);
        const hooks = {
          onStage: (text: string, fraction?: number) => (this.status.textContent = fraction === undefined ? text : `${text} ${Math.round(fraction * 100)}%`),
          onProgress: (done: number, total: number, elapsed: number) => {
            // The first tile includes model loading and shader compilation, so speed is measured after it
            if (done === 1) this.firstTile = elapsed;
            const eta = done > 1 ? ((elapsed - this.firstTile) / (done - 1)) * (total - done) : 0;
            this.setProgress(done / total);
            this.status.textContent = `Тайл ${done} из ${total} · ${time(elapsed)}${eta ? ` · осталось ~${time(eta)}` : ''}`;
          },
          onRows: (top: number, height: number, rows: ImageBitmap) => {
            const ctx = this.outCanvas.getContext('2d')!;
            const y0 = Math.round(top * this.outCanvas.height);
            const y1 = Math.round((top + height) * this.outCanvas.height);
            ctx.drawImage(rows, 0, y0, this.outCanvas.width, Math.max(1, y1 - y0));
            rows.close();
          },
        };
        const job =
          tab === 'matte'
            ? this.engine.matte(bitmap, { trim: this.trim }, hooks)
            : this.engine.upscale(bitmap, { modelUrl: upscaleModelUrl(this.model.id, !!this.probe?.f16), tile: this.model.tile, scale: this.scale, previewWidth: this.outCanvas.width }, hooks);
        this.begin(() => this.engine.cancel(job.id));
        out = await job.done;
      }
      this.end();
      // The background removal model has just been downloaded: the hint says “downloaded”, available offline too.
      if (tab === 'matte' && !this.matteReady) void this.checkModels();
      await this.showResult({ blob: out.blob, width: out.width, height: out.height, op: tab, trimmed: tab === 'matte' && this.trim }, out.seconds);
    } catch (e) {
      this.end();
      const stopped = e instanceof Cancelled || (e as Error).name === 'AbortError';
      if (stopped) {
        this.clearResult();
        this.status.textContent = 'Остановлено';
        this.status.className = 'ups-status';
      } else this.fail((e as Error).message);
    }
  }

  private async sizeOf(blob: Blob) {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }

  private async showResult(result: Result, seconds: number) {
    this.result = result;
    this.frame.classList.add('done');
    this.setProgress(1);
    const bitmap = await createImageBitmap(result.blob);
    // Without a source (generation) or with a different aspect ratio (crop), the frame adapts to the result
    if (!this.source || Math.abs(result.width / result.height - this.source.bitmap.width / this.source.bitmap.height) > 0.01) {
      const k = Math.min(1, PREVIEW_MAX / Math.max(result.width, result.height));
      this.outCanvas.width = Math.max(1, Math.round(result.width * k));
      this.outCanvas.height = Math.max(1, Math.round(result.height * k));
      this.srcCanvas.getContext('2d')!.clearRect(0, 0, this.srcCanvas.width, this.srcCanvas.height);
      this.drop.hidden = true;
      this.frame.hidden = false;
    }
    const ctx = this.outCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.outCanvas.width, this.outCanvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, this.outCanvas.width, this.outCanvas.height);
    bitmap.close();
    this.fit();
    this.status.textContent = `Готово за ${time(seconds)} · ${result.width}×${result.height}${result.op === 'generate' && this.lastSeed !== null ? ` · зерно ${this.lastSeed}` : ''}`;
    this.status.className = 'ups-status ok';
    this.renderActions();
  }

  private renderActions() {
    const r = this.result;
    if (!r) return this.actions.replaceChildren();
    this.resultUrl ??= URL.createObjectURL(r.blob);
    const stem = (this.source?.name || 'image').replace(/\.[^.]+$/, '');
    const suffix = r.op === 'upscale' ? `_x${Math.round(r.width / (this.source?.bitmap.width || r.width))}` : r.op === 'matte' ? '_nobg' : '_gen';
    const target = this.source?.target;
    const canReplace = !!target && (r.op === 'upscale' || (r.op === 'matte' && !r.trimmed));
    const fits = r.blob.size <= DOC_MAX_BYTES;
    const buttons: Node[] = [];
    if (canReplace) {
      buttons.push(
        h('button', {
          class: 'ups-apply',
          disabled: !fits,
          title: !fits ? `${megabytes(r.blob.size)} — больше 64 МБ, сервер такую картинку не примет` : target!.origin && !target!.origin.doc ? `Картинка заменится в файле «${target!.origin.fileName}»; вернуть — кнопкой «Вернуть как было»` : 'Картинка слоя заменится; Ctrl+Z — вернуть',
          onclick: () => void this.replace(),
        }, target!.origin && !target!.origin.doc ? `Заменить в «${target!.origin.fileName}»` : 'Заменить в документе'),
      );
    }
    if (this.writer?.done.length) buttons.push(h('button', { class: 'ups-btn', onclick: () => void this.revertRemote() }, 'Вернуть как было'));
    buttons.push(
      h('button', { class: canReplace ? 'ups-btn' : 'ups-apply', disabled: !fits, onclick: () => void this.insert() }, 'Вставить на страницу'),
      h('button', { class: 'ups-btn', onclick: () => void this.continueWith() }, 'Дальше с результатом'),
      h('a', { class: 'ups-save', href: this.resultUrl, download: `${stem}${suffix}.png` }, `Скачать PNG · ${megabytes(r.blob.size)}`),
    );
    this.actions.replaceChildren(...buttons);
  }

  private async replace() {
    const r = this.result;
    const s = this.source;
    if (!r || !s?.target) return;
    if (s.target.origin) return this.replaceOrigin(s.target, r);
    try {
      await replaceImage(this.deps.editor, s.target, r.blob, r.width, r.width / (s.targetWidth || r.width));
      this.close();
      this.deps.notify(r.op === 'matte' ? 'Фон убран — Ctrl+Z, чтобы вернуть' : `Картинка увеличена до ${r.width}×${r.height} — Ctrl+Z, чтобы вернуть`);
    } catch (e) {
      this.fail((e as Error).message);
    }
  }

  /** A layer from “From project…”: in the open file, via an editor edit; in another file, by updating the file on the server. */
  private async replaceOrigin(target: ImageTarget, r: Result) {
    const o = target.origin!;
    const live = !!o.doc && o.doc === this.deps.editor.doc;
    this.status.textContent = live ? '' : `Сохраняю в файл «${o.fileName}»…`;
    this.status.className = 'ups-status';
    this.writer?.dispose();
    this.writer = new ImageWriter(this.deps.editor, this.deps.server, this.deps.cloud);
    try {
      await this.writer.replace(o, r.blob, r.width, r.height, false);
    } catch (e) {
      return this.fail((e as Error).message);
    }
    target.hash = o.hash;
    const what = r.op === 'matte' ? 'Фон убран' : `Картинка увеличена до ${r.width}×${r.height}`;
    if (live) {
      this.writer = null;
      this.close();
      return this.deps.notify(`${what} — Ctrl+Z, чтобы вернуть`);
    }
    this.status.textContent = `${what}: заменено в файле «${o.fileName}», слой «${o.name}»`;
    this.status.className = 'ups-status ok';
    this.renderActions();
  }

  private async revertRemote() {
    const w = this.writer;
    if (!w) return;
    try {
      await w.revert();
      this.status.textContent = 'Вернул прежнюю картинку';
      this.status.className = 'ups-status ok';
      const t = this.source?.target;
      if (t?.origin) t.hash = t.origin.hash;
    } catch (e) {
      this.fail((e as Error).message);
    }
    this.writer = null;
    this.renderActions();
  }

  private async insert() {
    const r = this.result;
    if (!r) return;
    const name = (this.source?.name || (r.op === 'generate' ? this.genPrompt.slice(0, 40) : t('Картинка'))).replace(/\.[^.]+$/, '') || 'Картинка';
    await insertImage(this.deps.editor, r.blob, r.width, r.height, name);
    this.close();
    this.deps.notify('Картинка на странице — Ctrl+Z, чтобы убрать');
  }

  /** The result becomes the source: e.g. upscale and then remove the background right away. */
  private async continueWith() {
    const r = this.result;
    if (!r) return;
    const s = this.source;
    const keepTarget = s?.target && r.op !== 'generate' && !r.trimmed ? s.target : null;
    await this.load(r.blob, s?.name ?? (this.genPrompt.slice(0, 40) || t('Картинка')), keepTarget, keepTarget ? s!.targetWidth : 0);
  }
}

let installed: { page: ImagingPage; deps: ImagingDeps } | null = null;

/** Context menu items for layers with an image fill. */
export function imagingMenuItems(ids: string[]): MenuEntry[] {
  if (!installed) return [];
  const { page, deps } = installed;
  const target = imageTarget(deps.editor, ids);
  return target
    ? [
        { label: 'Увеличить картинку…', run: () => void page.openFor(target, 'upscale') },
        { label: 'Убрать фон…', run: () => void page.openFor(target, 'matte') },
        'sep',
      ]
    : [];
}

/** The “Enhancements” section in the left strip: opens the page; any other section closes it. */
export function installImaging(rail: HTMLElement, deps: ImagingDeps): void {
  const page = new ImagingPage(deps);
  installed = { page, deps };
  const btn = h('button', { class: 'rail-btn', title: 'Улучшения изображений — увеличение, удаление фона, Nano Banana, Magnific и цепочки', 'aria-label': 'Улучшения' });
  btn.innerHTML = `<span class="rail-ic">${RAIL_ICON}</span><span>Улучшения</span>`;
  btn.addEventListener('click', () => page.toggle());
  page.onToggle = (open) => btn.classList.toggle('on', open);
  rail.insertBefore(btn, rail.querySelector('.rail-bell'));
  rail.addEventListener(
    'click',
    (e) => {
      const target = (e.target as Element).closest('button');
      if (target && target !== btn) page.close();
    },
    true,
  );
}
