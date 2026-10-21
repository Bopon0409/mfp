// Plugin host on the main thread: a Worker with QuickJS, the plugin UI window (iframe),
// applying plugin operations to the editor document.
//
// The UI protocol is Figma-compatible: the UI sends parent.postMessage({ pluginMessage }, '*'),
// and receives messages as event.data.pluginMessage.

import type { Document } from '@mfp/core';
import type { PluginBundle, WidgetMessage } from '../runtime.ts';
import { DocLink } from './doc-link.ts';
import { allowedDomains, uiCsp } from '../network.ts';
import type { FromWorker, PluginRequest, ToWorker, ViewportState } from './protocol.ts';

export interface PluginHostCallbacks {
  doc: Document;
  getPage(): string;
  getSelection(): string[];
  getEditorType?(): 'figma' | 'dev';
  /** Offline (editor setting): network access is denied to the plugin window regardless of the manifest. */
  offline?(): boolean;
  /** Inspect UI occupies the editor's inspector, rather than covering the canvas. */
  getInspectContainer?(): HTMLElement;
  setSelection(ids: string[]): void;
  /** The plugin changed the current page. */
  setPage?(id: string): void;
  /** Editor camera (figma.viewport). */
  getViewport?(): ViewportState;
  setViewport?(v: { center?: { x: number; y: number }; zoom?: number }): void;
  /** Timeline playhead (figma.motion.playheadPosition), seconds; no panel — undefined. */
  getPlayhead?(): number | undefined;
  /** figma.currentUser. */
  currentUser?(): { id: string | null; name: string; photoUrl: string | null; color: string; sessionId: number } | null;
  zoomTo(ids: string[]): void;
  notify(message: string, kind?: 'info' | 'error'): void;
  log(level: string, args: string[]): void;
  /** Load a font for loadFontAsync (true — available). */
  loadFont?(font: { family: string; style: string }): Promise<boolean>;
  /** The plugin has exited. */
  onExit?(state: string, message: string | null, error: string | null): void;
  /** Plugin request: export (bytes or an SVG string), imageBytes, imageFromUrl (hash), flatten (SVG path). */
  request?(method: PluginRequest, args: unknown): Promise<unknown>;
  /** Plugin image (createImage): hash — SHA-1 of the bytes. */
  addImage?(hash: string, bytes: Uint8Array): void;
}

/** Theme CSS variables expected by Figma plugin UIs (part of the --figma-color-* set). */
const THEME_CSS = `
:root {
  --figma-color-bg: #22242a; --figma-color-bg-secondary: #2b2e34; --figma-color-bg-brand: #4d7bfd;
  --figma-color-text: #ffffff; --figma-color-text-secondary: #ffffffb3; --figma-color-text-onbrand: #ffffff;
  --figma-color-border: #3d4046; --figma-color-icon: #ffffff;
}
html, body { background: var(--figma-color-bg); color: var(--figma-color-text); }
`;

export class PluginHost {
  private worker: Worker | null = null;
  private frame: HTMLIFrameElement | null = null;
  private panel: HTMLDivElement | null = null;
  private cb: PluginHostCallbacks;
  private bundle: PluginBundle | null = null;
  private link: DocLink | null = null;
  private sentSelection = '';
  private viewportQueued = false;
  private suggestSeq = 0;
  private suggestWaits = new Map<number, (r: { suggestions?: { name: string; data?: unknown }[]; error?: string; loading?: string }) => void>();
  private onWindowMessage = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const data = e.data as { pluginMessage?: unknown } | null;
    if (data && typeof data === 'object' && 'pluginMessage' in data) {
      this.send({ type: 'uiMessage', message: data.pluginMessage });
    }
  };

  constructor(callbacks: PluginHostCallbacks) {
    this.cb = callbacks;
  }

  get running() {
    return this.worker !== null;
  }

  /** id of the running plugin. */
  get pluginId(): string | null {
    return this.worker ? (this.bundle?.manifest.id ?? null) : null;
  }

  /** Widget: render a node, click, property menu item. */
  widget(msg: WidgetMessage) {
    this.send({ type: 'widget', msg });
  }

  /** Run a plugin: command — menu command (figma.command), parameters — quick action values. */
  run(bundle: PluginBundle, opts: { command?: string; parameters?: Record<string, unknown>; deferRun?: boolean } = {}) {
    const editorType = this.cb.getEditorType?.() ?? 'figma';
    if (editorType === 'dev' && (!bundle.manifest.editorType?.includes('dev') || !bundle.manifest.capabilities?.includes('inspect'))) {
      this.cb.notify('Этот плагин не поддерживает инспектирование в режиме разработчика. Переключитесь в режим дизайна.', 'error');
      return;
    }
    this.stop();
    this.bundle = bundle;
    this.worker = new Worker(new URL('./plugin-worker.ts', import.meta.url), { type: 'module' });
    const worker = this.worker;
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      if (this.worker === worker) this.handle(e.data);
    };
    this.worker.onerror = (e) => {
      this.cb.notify(`Ошибка плагина: ${e.message}`, 'error');
      this.cleanup();
    };
    window.addEventListener('message', this.onWindowMessage);
    // Editor edits after the snapshot go into the plugin copy (the subscription precedes the snapshot).
    this.link = new DocLink(this.cb.doc, (m) => this.send(m));
    const page = this.cb.getPage();
    const selection = this.cb.getSelection();
    this.sentSelection = `${page}|${selection.join(',')}`;
    this.send({
      type: 'start',
      editorType,
      bundle,
      snapshot: this.cb.doc.snapshot(),
      page,
      selection,
      storage: this.loadStorage(),
      viewport: this.cb.getViewport?.(),
      playhead: this.cb.getPlayhead?.() ?? null,
      command: opts.command ?? '',
      parameters: opts.parameters,
      user: this.cb.currentUser?.() ?? null,
      deferRun: opts.deferRun,
    });
  }

  /**
   * Quick action with parameters: the plugin starts immediately and suggests values as the user types
   * (figma.parameters.on('input')); run — once all parameters are entered.
   */
  runWithParameters(bundle: PluginBundle, command: string) {
    this.run(bundle, { command, deferRun: true });
    const worker = this.worker;
    return {
      input: (key: string, query: string, values: Record<string, unknown>, reply: (r: { suggestions?: { name: string; data?: unknown }[]; error?: string; loading?: string }) => void) => {
        if (this.worker !== worker) return;
        const requestId = ++this.suggestSeq;
        this.suggestWaits.clear();
        this.suggestWaits.set(requestId, reply);
        this.send({ type: 'parameterInput', requestId, key, query, parameters: values });
      },
      done: (values: Record<string, unknown>) => {
        this.suggestWaits.clear();
        if (this.worker === worker) this.send({ type: 'run', command, parameters: values });
      },
      cancel: () => {
        this.suggestWaits.clear();
        if (this.worker === worker) this.stop();
      },
    };
  }

  /** Selection or page changed in the editor: notify the plugin (selectionchange, currentpagechange). */
  syncSelection() {
    if (!this.worker) return;
    const page = this.cb.getPage();
    const ids = this.cb.getSelection();
    const key = `${page}|${ids.join(',')}`;
    if (key === this.sentSelection) return;
    this.sentSelection = key;
    this.link?.flush();
    this.send({ type: 'setSelection', ids: [...ids], page });
  }

  private playheadQueued = false;
  /** The timeline playhead moved (figma.motion.playheadPosition): one message per task. */
  syncPlayhead() {
    if (!this.worker || this.playheadQueued || !this.cb.getPlayhead) return;
    this.playheadQueued = true;
    queueMicrotask(() => {
      this.playheadQueued = false;
      if (this.worker) this.send({ type: 'playhead', t: this.cb.getPlayhead?.() ?? null });
    });
  }

  /** The camera changed (figma.viewport): one message per task. */
  syncViewport() {
    if (!this.worker || this.viewportQueued || !this.cb.getViewport) return;
    this.viewportQueued = true;
    queueMicrotask(() => {
      this.viewportQueued = false;
      const v = this.cb.getViewport?.();
      if (v && this.worker) this.send({ type: 'viewport', viewport: v });
    });
  }

  stop() {
    if (!this.worker) return;
    this.send({ type: 'stop' });
    // Let the plugin handle the close event, then terminate the Worker.
    const w = this.worker;
    setTimeout(() => w.terminate(), 200);
    this.cleanup();
  }

  /** For automated tests: send a message to the plugin the way its UI does. */
  postFromUI(message: unknown) {
    this.send({ type: 'uiMessage', message });
  }

  private send(m: ToWorker) {
    // Editor edits made earlier go before this message.
    if (m.type !== 'docOps' && m.type !== 'reset') this.link?.flush();
    this.worker?.postMessage(m);
  }

  private handle(m: FromWorker) {
    switch (m.type) {
      case 'commitUndo':
        this.link?.commitUndo();
        break;
      case 'ops':
        try {
          this.link?.applyPluginOps(m.ops, m.seen);
        } catch (e) {
          // The edits did not match the editor document, so the plugin copy receives a snapshot.
          this.cb.log('warn', [`Правки плагина не применились: ${(e as Error).message}`]);
          if (this.link) this.send(this.link.reset());
        }
        break;
      case 'resync':
        if (this.link) this.send(this.link.reset());
        break;
      case 'selection':
        this.cb.setSelection(m.ids);
        break;
      case 'page':
        this.cb.setPage?.(m.id);
        break;
      case 'setViewport':
        this.cb.setViewport?.({ center: m.center, zoom: m.zoom });
        break;
      case 'request': {
        const id = m.id;
        const run = this.cb.request ? this.cb.request(m.method, m.args) : Promise.reject(new Error('Недоступно в этом окне'));
        run.then(
          (value) => this.send({ type: 'response', id, value }),
          (e) => this.send({ type: 'response', id, error: String((e as Error)?.message ?? e) }),
        );
        break;
      }
      case 'image':
        this.cb.addImage?.(m.hash, m.bytes);
        break;
      case 'openExternal':
        if (/^https?:\/\//i.test(m.url)) window.open(m.url, '_blank', 'noopener');
        break;
      case 'suggestions': {
        const { requestId, type: _t, ...result } = m;
        this.suggestWaits.get(requestId)?.(result);
        break;
      }
      case 'showUI':
        this.showUI(m.html, m.options);
        break;
      case 'postToUI':
        this.frame?.contentWindow?.postMessage({ pluginMessage: m.message }, '*');
        break;
      case 'uiVisible':
        if (this.panel) this.panel.style.display = m.visible ? '' : 'none';
        break;
      case 'uiResize':
        if (this.frame) {
          this.frame.style.width = `${m.width}px`;
          this.frame.style.height = `${m.height}px`;
        }
        break;
      case 'uiClose':
        this.closeUI();
        break;
      case 'notify':
        this.cb.notify(m.message);
        break;
      case 'loadFont': {
        const id = m.id;
        void (this.cb.loadFont?.(m.font) ?? Promise.resolve(true)).then((ok) => this.send({ type: 'fontLoaded', id, ok }));
        break;
      }
      case 'zoomTo':
        this.cb.zoomTo(m.ids);
        break;
      case 'storageSet':
      case 'storageDelete': {
        const s = this.loadStorage();
        if (m.type === 'storageSet') s[m.key] = m.value;
        else delete s[m.key];
        try {
          localStorage.setItem(this.storageKey(), JSON.stringify(s));
        } catch {
          // Storage is unavailable (private mode): clientStorage lives only for the session.
        }
        break;
      }
      case 'log':
        this.cb.log(m.level, m.args);
        break;
      case 'exit':
        if (m.error) this.cb.notify(`Плагин «${this.bundle?.manifest.name}» завершился с ошибкой: ${m.error.split('\n')[0]}`, 'error');
        this.cb.onExit?.(m.state, m.message, m.error);
        if (m.message) this.cb.notify(m.message);
        this.worker?.terminate();
        this.cleanup();
        break;
    }
  }

  private showUI(html: string, options: { width?: number; height?: number; visible?: boolean; title?: string } | null) {
    this.closeUI();
    const panel = document.createElement('div');
    panel.className = 'plugin-panel';
    const title = document.createElement('div');
    title.className = 'plugin-title';
    title.textContent = options?.title ?? this.bundle?.manifest.name ?? 'Плагин';
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = 'Закрыть плагин';
    close.onclick = () => this.stop();
    title.append(close);
    const frame = document.createElement('iframe');
    // No allow-same-origin: the plugin UI has no access to the editor.
    frame.sandbox.add('allow-scripts', 'allow-forms', 'allow-popups', 'allow-modals', 'allow-downloads');
    frame.style.width = `${options?.width ?? 300}px`;
    frame.style.height = `${options?.height ?? 200}px`;
    // Window network access follows manifest.networkAccess (CSP first in head, before any loads); offline — none at all.
    const csp = this.cb.offline?.() ? uiCsp([]) : this.bundle ? uiCsp(allowedDomains(this.bundle.manifest)) : null;
    const meta = csp ? `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">` : '';
    frame.srcdoc = `<!doctype html><html><head>${meta}<meta charset="utf-8"><style>${THEME_CSS}</style></head><body>${html}</body></html>`;
    panel.append(title, frame);
    if (options?.visible === false) panel.style.display = 'none';
    const inspect = this.cb.getEditorType?.() === 'dev' ? this.cb.getInspectContainer?.() : null;
    if (inspect) {
      Object.assign(panel.style, { position: 'absolute', inset: '72px 0 0', width: '100%', height: 'auto', display: options?.visible === false ? 'none' : 'flex', flexDirection: 'column' });
      Object.assign(frame.style, { width: '100%', height: '100%', flex: '1', minHeight: '0' });
      inspect.append(panel);
    } else document.body.append(panel);
    this.panel = panel;
    this.frame = frame;
  }

  private closeUI() {
    this.panel?.remove();
    this.panel = null;
    this.frame = null;
  }

  private cleanup() {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
    }
    window.removeEventListener('message', this.onWindowMessage);
    this.closeUI();
    this.link?.dispose();
    this.link = null;
    this.worker = null;
  }

  private storageKey() {
    return `mfp:plugin-storage:${this.bundle?.manifest.id ?? ''}`;
  }

  private loadStorage(): Record<string, unknown> {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey()) ?? '{}');
    } catch {
      return {};
    }
  }
}
