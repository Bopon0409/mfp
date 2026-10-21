// The “Video” tab in “Image enhancements”: MP4/MOV up to 4K or 8K on the user's GPU.
// Preview frame (before/after and a time estimate), a trial of the first 10 seconds, output written straight to disk.

import '../imaging.css';
import './video.css';
import { h, svgEl } from '../../dom.ts';
import { ICON } from '../../icons.ts';
import { UPSCALE_MODELS, upscaleModelUrl, type UpscaleModel } from '../engine.ts';
import { CODEC_NAMES, bitrateFor, targetSize, type OutCodec } from './codecs.ts';
import type { VideoEvent, VideoInfo, VideoJob, VideoRequest } from './protocol.ts';

type Target = '4k' | '8k' | 'x2' | 'x4';
const TARGETS: [Target, string][] = [
  ['4k', '4K'],
  ['8k', '8K'],
  ['x2', '×2'],
  ['x4', '×4'],
];
const CODECS: (OutCodec | 'auto')[] = ['auto', 'h264', 'hevc', 'av1'];
const PROBE_SECONDS = 10;

export interface VideoViewDeps {
  notify: (message: string, kind?: 'info' | 'error') => void;
}

const duration = (s: number) => {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.max(1, Math.round(s))} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
};
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const megabytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2).replace('.', ',')} ГБ` : `${Math.max(1, Math.round(b / 1e6))} МБ`);
const kName = (w: number, h: number) => (Math.max(w, h) >= 7680 ? ' (8K)' : Math.max(w, h) >= 3840 ? ' (4K)' : '');

export class VideoView {
  readonly el: HTMLElement;
  private readonly deps: VideoViewDeps;
  private worker: Worker | null = null;
  private f16 = false;
  private gpuOk: boolean | null = null;
  private available = new Map<string, boolean>();
  private file: File | null = null;
  private info: VideoInfo | null = null;
  private target: Target = '4k';
  private model: UpscaleModel = UPSCALE_MODELS[0]!;
  private codec: OutCodec | 'auto' = 'auto';
  private probeOnly = false;
  private time = 0;
  private perFrame: number | null = null;
  private running: 'open' | 'frame' | 'encode' | null = null;
  private started = 0;
  private resultUrl: string | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  private readonly stage: HTMLElement;
  private readonly drop: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly srcCanvas: HTMLCanvasElement;
  private readonly outCanvas: HTMLCanvasElement;
  private readonly player: HTMLVideoElement;
  private readonly fileBar: HTMLElement;
  private readonly options: HTMLElement;
  private readonly sizeInfo: HTMLElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly gpu: HTMLElement;
  private readonly input: HTMLInputElement;

  constructor(deps: VideoViewDeps) {
    this.deps = deps;
    this.input = h('input', { type: 'file', accept: 'video/mp4,video/quicktime,.mp4,.m4v,.mov', hidden: true, onchange: () => this.input.files?.[0] && this.openFile(this.input.files[0]) });
    this.drop = h(
      'div',
      { class: 'ups-drop' },
      svgEl('div', { class: 'ups-drop-ic' }, ICON.play),
      h('div', { class: 'ups-drop-title' }, 'Перетащите видео сюда'),
      h('div', { class: 'ups-drop-sub' }, 'MP4 или MOV · H.264, HEVC, AV1, VP9 · звук сохранится'),
      h('div', { class: 'ups-drop-actions' }, h('button', { class: 'ups-btn', onclick: () => this.input.click() }, 'Выбрать видео')),
    );
    this.srcCanvas = h('canvas', { class: 'ups-src' });
    this.outCanvas = h('canvas', { class: 'ups-out' });
    this.frame = h('div', { class: 'ups-frame', hidden: true, title: 'Удерживайте, чтобы сравнить с исходником' }, this.srcCanvas, this.outCanvas);
    this.player = h('video', { class: 'vid-player', controls: true, hidden: true });
    this.fileBar = h('div', { class: 'ups-filebar', hidden: true });
    this.stage = h('div', { class: 'ups-stage' }, this.drop, this.frame, this.player, this.fileBar);

    this.options = h('div', { class: 'ups-options' });
    this.sizeInfo = h('div', { class: 'ups-size' });
    this.runBtn = h('button', { class: 'ups-run', disabled: true, onclick: () => (this.running ? this.cancel() : void this.encode()) }, 'Увеличить видео');
    this.bar = h('div', { class: 'ups-bar-fill' });
    this.status = h('div', { class: 'ups-status' });
    this.actions = h('div', { class: 'ups-result-actions' });
    this.gpu = h('div', { class: 'ups-gpu' }, 'Проверяю видеокарту…');
    const side = h(
      'aside',
      { class: 'ups-side' },
      this.options,
      h('div', { class: 'ups-section ups-actions' }, this.sizeInfo, this.runBtn, h('div', { class: 'ups-bar' }, this.bar), this.status, this.actions),
      h('div', { class: 'ups-foot' }, this.gpu, h('div', { class: 'ups-private' }, 'Видео обрабатывается на этом компьютере и никуда не отправляется. Минута видео 1080p до 4K — около часа и больше, в зависимости от видеокарты.')),
    );
    this.el = h('div', { class: 'ups-body vid-body' }, this.stage, side, this.input);

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
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('video/') || /\.(mp4|m4v|mov)$/i.test(f.name));
      if (file && !this.running) this.openFile(file);
    });
    this.frame.addEventListener('pointerdown', () => this.frame.classList.add('compare'));
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) this.frame.addEventListener(type, () => this.frame.classList.remove('compare'));
    new ResizeObserver(() => this.fit()).observe(this.stage);
    window.addEventListener('beforeunload', (e) => {
      if (this.running === 'encode') e.preventDefault();
    });
    void this.checkGpu();
    this.render();
  }

  show() {
    this.render();
    this.fit();
  }

  private async checkGpu() {
    const missing = typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined';
    const adapter = missing ? null : await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    this.gpuOk = !!adapter;
    this.f16 = !!adapter?.features.has('shader-f16');
    if (missing) this.gpu.textContent = 'Браузер без WebCodecs — нужен свежий Chrome, Edge или приложение MFP';
    else if (!adapter) this.gpu.textContent = 'Нет WebGPU — нужен свежий Chrome, Edge или приложение MFP';
    else {
      const { vendor, architecture, description } = adapter.info;
      this.gpu.textContent = `Видеокарта: ${description || [vendor, architecture].filter(Boolean).join(' ') || 'есть'}`;
    }
    this.gpu.classList.toggle('warn', !adapter);
    await Promise.all(
      UPSCALE_MODELS.map(async (m) => {
        try {
          const r = await fetch(upscaleModelUrl(m.id, this.f16), { method: 'HEAD' });
          this.available.set(m.id, r.ok && !(r.headers.get('content-type') ?? '').includes('text/html'));
        } catch {
          this.available.set(m.id, false);
        }
      }),
    );
    if (!this.available.get(this.model.id)) this.model = UPSCALE_MODELS.find((m) => this.available.get(m.id)) ?? this.model;
    this.render();
  }

  private send(msg: VideoRequest, transfer: Transferable[] = []) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<VideoEvent>) => this.onEvent(e.data);
      this.worker.onerror = (e) => this.onEvent({ type: 'error', message: e.message || 'Обработчик видео не запустился' });
    }
    this.worker.postMessage(msg, transfer);
  }

  private openFile(file: File) {
    this.file = file;
    this.info = null;
    this.perFrame = null;
    this.time = 0;
    this.clearResult();
    this.frame.hidden = true;
    this.running = 'open';
    this.setStatus('Читаю видео…');
    this.send({ type: 'open', file });
    this.render();
  }

  private outSize() {
    if (!this.info) return null;
    const { width, height } = this.info;
    return targetSize(width, height, this.target === '4k' ? { long: 3840 } : this.target === '8k' ? { long: 7680 } : { factor: this.target === 'x2' ? 2 : 4 });
  }

  private job(): VideoJob | null {
    const size = this.outSize();
    if (!size) return null;
    return {
      modelUrl: upscaleModelUrl(this.model.id, this.f16),
      tile: Math.round(this.model.tile * 1.5),
      width: size.width,
      height: size.height,
      codec: this.codec,
      limit: this.probeOnly ? PROBE_SECONDS : null,
    };
  }

  private seg<T extends string>(values: [T, string][], current: T, set: (v: T) => void) {
    return h(
      'div',
      { class: 'ups-seg', style: `grid-template-columns: repeat(${values.length}, 1fr)` },
      ...values.map(([v, label]) => h('button', { class: `ups-seg-btn${v === current ? ' on' : ''}`, disabled: !!this.running, onclick: () => (set(v), this.render()) }, label)),
    );
  }

  private section(label: string, ...children: (Node | null | false)[]) {
    return h('div', { class: 'ups-section' }, h('div', { class: 'ups-label' }, label), ...children.filter((c): c is Node => !!c));
  }

  private render() {
    const info = this.info;
    const size = this.outSize();
    const busy = !!this.running;
    const parts: Node[] = [];
    parts.push(
      this.section(
        'Размер',
        this.seg(TARGETS, this.target, (v) => ((this.target = v), (this.perFrame = null))),
        info && size && Math.max(size.width, size.height) > Math.max(info.width, info.height) * 4
          ? h('div', { class: 'img-note warn' }, 'Больше ×4 от исходника — модель увеличит в 4 раза, остальное — простым растяжением')
          : null,
      ),
    );
    const f16 = this.f16;
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
              { class: `ups-model${m === this.model ? ' on' : ''}`, role: 'radio', 'aria-checked': String(m === this.model), disabled: !ready || busy, onclick: () => ((this.model = m), (this.perFrame = null), this.render()) },
              h('span', { class: 'ups-model-name' }, m.name, h('span', { class: 'ups-model-size' }, ready ? m.size[f16 ? 'fp16' : 'fp32'] : 'не установлена')),
              h('span', { class: 'ups-model-hint' }, m.hint),
            );
          }),
        ),
      ),
    );
    parts.push(
      this.section(
        'Сжатие',
        this.seg(
          CODECS.map((c) => [c, c === 'auto' ? 'Авто' : CODEC_NAMES[c]] as [OutCodec | 'auto', string]),
          this.codec,
          (v) => (this.codec = v),
        ),
        h(
          'div',
          { class: 'img-note' },
          size && size.width * size.height > 4096 * 2304
            ? '8K в H.264 не бывает: «Авто» выберет HEVC или AV1. Для просмотра в Windows может понадобиться расширение HEVC или AV1.'
            : '«Авто» — H.264: открывается везде. HEVC и AV1 — файл меньше при том же качестве.',
        ),
      ),
    );
    if (info) {
      const range = h('input', {
        class: 'vid-range',
        type: 'range',
        min: '0',
        max: String(Math.max(0, info.seconds - 1 / info.fps)),
        step: String(1 / Math.max(1, Math.round(info.fps))),
        value: String(this.time),
        disabled: busy,
        oninput: () => {
          this.time = Number(range.value);
          timeLabel.textContent = clock(this.time);
        },
      });
      const timeLabel = h('span', { class: 'vid-time' }, clock(this.time));
      parts.push(
        this.section(
          'Пробный кадр',
          h('div', { class: 'vid-row' }, range, timeLabel),
          h('button', { class: 'ups-btn', disabled: busy || !this.ready(), onclick: () => this.probeFrame() }, 'Увеличить этот кадр'),
          h('div', { class: 'img-note' }, this.perFrame ? `Кадр — ${this.perFrame.toFixed(1).replace('.', ',')} с. Удерживайте картинку, чтобы сравнить.` : 'Покажет до/после и сколько займёт всё видео.'),
        ),
      );
      const check = h('input', { type: 'checkbox', checked: this.probeOnly, disabled: busy, onchange: () => ((this.probeOnly = check.checked), this.render()) });
      parts.push(this.section('Проба', h('label', { class: 'img-check' }, check, `Только первые ${PROBE_SECONDS} секунд`)));
    }
    this.options.replaceChildren(...parts);

    this.sizeInfo.textContent = '';
    if (info && size) {
      const seconds = this.probeOnly ? Math.min(PROBE_SECONDS, info.seconds) : info.seconds;
      const frames = Math.round(seconds * info.fps);
      const kind: OutCodec = this.codec !== 'auto' ? this.codec : size.width * size.height <= 4096 * 2304 ? 'h264' : 'hevc';
      const bytes = (bitrateFor(kind, size.width, size.height, info.fps) * seconds) / 8;
      const eta = this.perFrame ? ` · ≈ ${duration(this.perFrame * frames)}` : '';
      this.sizeInfo.textContent = `${info.width}×${info.height} → ${size.width}×${size.height}${kName(size.width, size.height)} · ${frames} кадров · файл ≈ ${megabytes(bytes)}${eta}`;
    }
    this.runBtn.disabled = !this.running && !this.ready();
    this.runBtn.textContent = this.running && this.running !== 'open' ? 'Остановить' : this.probeOnly ? `Увеличить ${PROBE_SECONDS} секунд` : 'Увеличить видео';
    this.runBtn.classList.toggle('stop', !!this.running && this.running !== 'open');

    this.drop.hidden = !!this.file;
    this.fileBar.hidden = !this.file;
    if (this.file) {
      const sub = info
        ? `${info.width}×${info.height} · ${Math.round(info.fps * 100) / 100} к/с · ${clock(info.seconds)} · ${info.codec.split('.')[0]}${info.audio ? ' · звук' : ''}${info.rotation ? ` · поворот ${info.rotation}°` : ''}`
        : 'читаю…';
      this.fileBar.replaceChildren(
        h('span', { class: 'ups-file-name' }, this.file.name),
        h('span', { class: 'ups-file-sub' }, sub),
        h('button', { class: 'ups-btn', disabled: busy, onclick: () => this.input.click() }, 'Другое видео'),
      );
    }
  }

  private ready() {
    return !!this.info && !!this.gpuOk && this.available.get(this.model.id) !== false;
  }

  private setStatus(text: string, kind: '' | 'ok' | 'error' = '') {
    this.status.textContent = text;
    this.status.className = `ups-status${kind ? ` ${kind}` : ''}`;
  }

  private setProgress(fraction: number) {
    this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10}%`;
  }

  private clearResult() {
    if (this.resultUrl) URL.revokeObjectURL(this.resultUrl);
    this.resultUrl = null;
    this.player.hidden = true;
    this.player.removeAttribute('src');
    this.actions.replaceChildren();
    this.setProgress(0);
  }

  private probeFrame() {
    const job = this.job();
    if (!job) return;
    this.begin('frame');
    this.setStatus('Готовлю…');
    this.send({ type: 'frame', job, time: this.time, previewWidth: this.previewWidth(2) });
  }

  private previewWidth(k: number) {
    return Math.min(3840, Math.round(this.stage.clientWidth * devicePixelRatio * k) || 1920);
  }

  private async encode() {
    const job = this.job();
    if (!job || !this.file) return;
    const base = this.file.name.replace(/\.[^.]+$/, '');
    const name = `${base}-${job.width}x${job.height}${job.limit ? '-проба' : ''}.mp4`;
    let handle: FileSystemFileHandle | null = null;
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (picker) {
      try {
        handle = await picker({ suggestedName: name, types: [{ description: 'Видео MP4', accept: { 'video/mp4': ['.mp4'] } }] });
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
        handle = null;
      }
    }
    this.begin('encode');
    this.setStatus('Готовлю…');
    this.saveName = name;
    this.handle = handle;
    this.wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    this.send({ type: 'encode', job, handle, previewWidth: this.previewWidth(1) });
  }

  private saveName = '';
  private handle: FileSystemFileHandle | null = null;

  private begin(kind: 'frame' | 'encode') {
    this.clearResult();
    this.running = kind;
    this.started = performance.now();
    this.render();
  }

  private end() {
    this.running = null;
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.render();
  }

  private cancel() {
    this.worker?.postMessage({ type: 'cancel' } satisfies VideoRequest);
    this.setStatus('Останавливаю…');
  }

  private onEvent(e: VideoEvent) {
    switch (e.type) {
      case 'info':
        this.info = e.info;
        this.time = Math.min(e.info.seconds / 2, Math.max(0, e.info.seconds - 1 / e.info.fps));
        this.running = null;
        this.setStatus('');
        // Preview frame right away: shows what the result will look like and how long it will take
        this.render();
        if (this.ready()) this.probeFrame();
        break;
      case 'stage':
        this.setStatus(e.text);
        if (e.fraction !== undefined) this.setProgress(e.fraction);
        break;
      case 'encoder':
        this.encoderText = e.text;
        break;
      case 'progress': {
        const rate = e.elapsed / e.done;
        this.perFrame = rate;
        this.setProgress(e.done / e.total);
        this.setStatus(`Кадр ${e.done} из ${e.total} · ${rate.toFixed(rate < 1 ? 2 : 1).replace('.', ',')} с/кадр · осталось ≈ ${duration(rate * (e.total - e.done))} · ${megabytes(e.bytes)}${this.encoderText ? ` · ${this.encoderText}` : ''}`);
        break;
      }
      case 'preview':
        this.showPreview(e.before, e.after);
        if (this.running === 'frame') {
          this.perFrame = e.seconds;
          this.end();
          this.setStatus(`Кадр увеличен за ${e.seconds.toFixed(1).replace('.', ',')} с (первый — дольше: видеокарта прогревается)`, 'ok');
        }
        break;
      case 'done':
        this.end();
        this.setProgress(1);
        this.setStatus(`Готово: ${e.frames} кадров за ${duration(e.seconds)} · ${e.codec} · ${megabytes(e.bytes)}`, 'ok');
        void this.showResult(e.blob);
        break;
      case 'cancelled':
        this.end();
        this.setProgress(0);
        this.setStatus('Остановлено');
        break;
      case 'error':
        this.end();
        this.setStatus(e.message, 'error');
        if (!this.info) {
          this.file = null;
          this.render();
        }
        break;
    }
  }

  private encoderText = '';

  private showPreview(before: ImageBitmap, after: ImageBitmap) {
    for (const [canvas, bitmap] of [
      [this.srcCanvas, before],
      [this.outCanvas, after],
    ] as const) {
      canvas.width = after.width;
      canvas.height = after.height;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, after.width, after.height);
      bitmap.close();
    }
    this.player.hidden = true;
    this.frame.hidden = false;
    this.frame.classList.add('done');
    this.fit();
  }

  private async showResult(blob: Blob | null) {
    const file = blob ?? (await this.handle?.getFile().catch(() => null));
    if (!file) return;
    this.resultUrl = URL.createObjectURL(file);
    this.player.src = this.resultUrl;
    this.player.hidden = false;
    this.frame.hidden = true;
    const buttons: Node[] = [];
    if (blob) buttons.push(h('a', { class: 'ups-save', href: this.resultUrl, download: this.saveName }, 'Скачать MP4'));
    else buttons.push(h('div', { class: 'img-note ok' }, `Сохранено: ${this.handle?.name ?? this.saveName}`));
    buttons.push(h('button', { class: 'ups-btn', onclick: () => ((this.player.hidden = true), (this.frame.hidden = false), this.fit()) }, 'Показать кадр до/после'));
    this.actions.replaceChildren(...buttons);
    if (blob) this.deps.notify('Видео готово — нажмите «Скачать MP4»');
  }

  private fit() {
    const w = this.outCanvas.width;
    const hgt = this.outCanvas.height;
    if (!w || !hgt || this.frame.hidden) return;
    const box = this.stage.getBoundingClientRect();
    const k = Math.min(Math.max(1, box.width - 48) / w, Math.max(1, box.height - 96) / hgt);
    this.frame.style.width = `${Math.round(w * k)}px`;
    this.frame.style.height = `${Math.round(hgt * k)}px`;
  }
}
