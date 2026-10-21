// Plugin session in the Worker: document copy, QuickJS, editor events.
// Separate from plugin-worker.ts so it can be tested in Node without a Worker.
//
// The copy is live: editor edits arrive in batches (docOps) in application order, plugin edits
// go to the main thread (ops). Plugin events are asynchronous: selectionchange,
// currentpagechange, documentchange, nodechange (on a page), stylechange.

import { Document, type Op } from '@mfp/core';
import { ChangeTracker, type ChangeOrigin } from '../changes.ts';
import { unionBoxOf, type PluginEnvironment } from '../host-api.ts';
import { PluginRuntime } from '../runtime.ts';
import type { FromWorker, OpsOrigin, PluginRequest, ToWorker, ViewportState } from './protocol.ts';

/** Origin of edits in the document copy: own (plugin) and those received from the editor. */
const EDITOR = 'editor';
const COLLAB = 'collab';
const SILENT = 'silent';
const toLocal = (o: OpsOrigin) => (o === 'REMOTE' ? COLLAB : o === 'LOCAL' ? EDITOR : SILENT);

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Document change events: edits are tracked only if the plugin is subscribed. */
const CHANGE_EVENTS = new Set(['documentchange', 'nodechange', 'stylechange']);

export class WorkerSession {
  runtime: PluginRuntime | null = null;
  private post: (m: FromWorker) => void;
  private env: PluginEnvironment | null = null;
  private ready: Promise<void> = Promise.resolve();
  private page = '';
  private selection: string[] = [];
  private vp: ViewportState = { x: 0, y: 0, zoom: 1, width: 1000, height: 800 };
  /** Editor timeline playhead (figma.motion.playheadPosition); null — no panel. */
  private playhead: number | null = null;
  /** Last applied batch of editor edits. */
  private appliedSeq = 0;
  private fontSeq = 0;
  private fontWaits = new Map<number, (ok: boolean) => void>();
  private listening = new Set<string>();
  private tracker: ChangeTracker | null = null;
  private events = new Set<string>();
  private flushing = false;
  private detach: (() => void)[] = [];
  private requestSeq = 0;
  private requests = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  /** In-flight requests: plugin exit is reported after them (an exact flatten is written back into the document). */
  private pending = new Set<Promise<unknown>>();
  /** Messages are processed strictly in order (plugin startup is asynchronous). */
  private chain: Promise<void> = Promise.resolve();

  constructor(post: (m: FromWorker) => void) {
    this.post = post;
  }

  get doc(): Document | null {
    return this.env?.doc ?? null;
  }

  /** Main thread message: queued after the previous ones. */
  handle(msg: ToWorker): Promise<void> {
    this.chain = this.chain.then(
      () => this.process(msg),
      () => this.process(msg),
    );
    return this.chain;
  }

  private async process(msg: ToWorker) {
    switch (msg.type) {
      case 'start':
        return this.start(msg);
      case 'generate':
        this.runtime?.generate(msg.requestId, msg.nodeId, msg.language);
        return;
      case 'docOps': {
        const doc = this.doc;
        if (!doc) return;
        try {
          doc.apply(msg.ops, toLocal(msg.origin));
          this.appliedSeq = msg.seq;
        } catch (e) {
          this.post({ type: 'log', level: 'warn', args: [`Копия документа плагина разошлась с редактором: ${(e as Error).message}`] });
          this.post({ type: 'resync' });
        }
        return;
      }
      case 'reset': {
        if (!this.env) return;
        this.attach(Document.fromSnapshot(msg.snapshot));
        this.appliedSeq = msg.seq;
        return;
      }
      case 'setSelection': {
        if (msg.page !== this.page) {
          this.page = msg.page;
          this.queue('currentpagechange');
        }
        if (!sameIds(msg.ids, this.selection)) {
          this.selection = msg.ids;
          this.queue('selectionchange');
        }
        return;
      }
      case 'playhead':
        this.playhead = msg.t;
        return;
      case 'viewport':
        this.vp = msg.viewport;
        return;
      case 'uiMessage':
        this.runtime?.postFromUI(msg.message);
        return;
      case 'stop':
        this.runtime?.stop();
        return;
      case 'fontLoaded':
        this.fontWaits.get(msg.id)?.(msg.ok);
        this.fontWaits.delete(msg.id);
        return;
      case 'storageResult':
        return;
      case 'parameterInput':
        this.runtime?.parameterInput(msg.requestId, msg.key, msg.query, msg.parameters);
        return;
      case 'run':
        this.runtime?.run(msg.command, msg.parameters);
        return;
      case 'widget':
        this.runtime?.widget(msg.msg);
        return;
      case 'response': {
        const r = this.requests.get(msg.id);
        this.requests.delete(msg.id);
        if (msg.error !== undefined) r?.reject(new Error(msg.error));
        else r?.resolve(msg.value);
        return;
      }
    }
  }

  /** Request to the editor (rendering, images, network). */
  private request<T>(method: PluginRequest, args: unknown): Promise<T> {
    const id = ++this.requestSeq;
    const p = new Promise<T>((resolve, reject) => {
      this.requests.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.post({ type: 'request', id, method, args });
    });
    this.pending.add(p);
    const done = () => this.pending.delete(p);
    p.then(done, done);
    return p;
  }

  private async start(msg: Extract<ToWorker, { type: 'start' }>) {
    const post = this.post;
    this.page = msg.page;
    this.selection = msg.selection;
    if (msg.viewport) this.vp = msg.viewport;
    this.playhead = msg.playhead ?? null;
    const storage = new Map(Object.entries(msg.storage));
    const env: PluginEnvironment = {
      doc: Document.fromSnapshot(msg.snapshot),
      commitUndo: () => post({ type: 'commitUndo' }),
      getCurrentPage: () => this.page,
      setCurrentPage: (id) => {
        if (id === this.page) return;
        this.page = id;
        // The editor will report the selection of the new page.
        if (this.selection.length) this.queue('selectionchange');
        this.selection = [];
        post({ type: 'page', id });
        this.queue('currentpagechange');
      },
      getSelection: () => this.selection,
      setSelection: (ids) => {
        if (sameIds(ids, this.selection)) return;
        this.selection = ids;
        post({ type: 'selection', ids });
        this.queue('selectionchange');
      },
      notify: (message) => post({ type: 'notify', message }),
      showUI: (html, options) => post({ type: 'showUI', html, options }),
      postToUI: (message) => post({ type: 'postToUI', message }),
      setUIVisible: (visible) => post({ type: 'uiVisible', visible }),
      resizeUI: (width, height) => post({ type: 'uiResize', width, height }),
      closeUI: () => post({ type: 'uiClose' }),
      viewport: {
        center: () => ({ x: this.vp.x, y: this.vp.y }),
        zoom: () => this.vp.zoom,
        bounds: () => {
          const { x, y, zoom, width, height } = this.vp;
          return { x: x - width / 2 / zoom, y: y - height / 2 / zoom, width: width / zoom, height: height / zoom };
        },
        setCenter: (c) => {
          this.vp = { ...this.vp, x: c.x, y: c.y };
          post({ type: 'setViewport', center: { x: c.x, y: c.y } });
        },
        setZoom: (z) => {
          this.vp = { ...this.vp, zoom: z };
          post({ type: 'setViewport', zoom: z });
        },
        scrollAndZoomIntoView: (ids) => {
          // The editor sets the camera (like Shift+2); until it responds, the same estimate is used here.
          const doc = this.doc;
          const live = doc ? ids.filter((id) => doc.has(id)) : [];
          if (doc && live.length) {
            const b = unionBoxOf(doc, live);
            const zoom = Math.min(8, (this.vp.width - 120) / Math.max(1, b.width), (this.vp.height - 120) / Math.max(1, b.height));
            this.vp = { ...this.vp, x: b.x + b.width / 2, y: b.y + b.height / 2, zoom: Math.min(256, Math.max(0.01, zoom)) };
          }
          post({ type: 'zoomTo', ids });
        },
      },
      storage: {
        get: async (k) => storage.get(k),
        set: async (k, v) => {
          storage.set(k, v);
          post({ type: 'storageSet', key: k, value: v });
        },
        delete: async (k) => {
          storage.delete(k);
          post({ type: 'storageDelete', key: k });
        },
        keys: async () => [...storage.keys()],
      },
      log: (level, args) => post({ type: 'log', level, args }),
      currentUser: msg.user ?? null,
      editorType: msg.editorType ?? 'figma',
      mode: msg.editorType === 'dev' ? 'inspect' : 'default',
      loadFont: (font) =>
        new Promise<boolean>((resolve) => {
          const id = ++this.fontSeq;
          this.fontWaits.set(id, resolve);
          post({ type: 'loadFont', id, font });
        }),
      addImage: (hash, bytes) => post({ type: 'image', hash, bytes }),
      suggestions: (requestId, result) => post({ type: 'suggestions', requestId, ...result }),
      openExternal: (url) => post({ type: 'openExternal', url }),
      fonts: () => this.request<{ family: string; style: string }[]>('fonts', null),
      saveVersion: (title, description) => this.request<string>('saveVersion', { title, description }),
      motionPlayhead: () => this.playhead ?? undefined,
      imageBytes: (hash) => this.request<Uint8Array | null>('imageBytes', hash),
      imageFromUrl: (url) => this.request<string>('imageFromUrl', url),
      exportNode: (id, settings) => this.request<Uint8Array | string>('export', { id, settings }),
      flattenGeometry: (ids, origin) => this.request<string | null>('flatten', { ids, origin }),
      listen: (type, on) => {
        if (on) this.listening.add(type);
        else this.listening.delete(type);
        const need = [...this.listening].some((t) => CHANGE_EVENTS.has(t));
        if (need && !this.tracker && this.doc) this.tracker = new ChangeTracker(this.doc);
        if (!need) this.tracker = null;
      },
      ...(msg.codegen
        ? {
            editorType: 'dev' as const,
            mode: 'codegen' as const,
            codegenResult: (requestId: number, results: unknown, error: string | null) => post({ type: 'codegenResult', requestId, results, error }),
            codegenRefresh: () => post({ type: 'codegenRefresh' }),
          }
        : {}),
    };
    this.env = env;
    this.attach(env.doc);
    const starting = PluginRuntime.start(msg.bundle, env, { command: msg.command, parameters: msg.parameters, deferRun: msg.deferRun });
    this.ready = starting.then(
      () => undefined,
      () => undefined,
    );
    const rt = await starting;
    this.runtime = rt;
    const send = () => post({ type: 'exit', state: rt.state, message: rt.closeMessage, error: rt.error });
    // Responses to plugin requests may still change the document — wait for them (at most 10 s).
    const report = () => {
      if (!this.pending.size) return send();
      const limit = new Promise((r) => setTimeout(r, 10_000));
      void Promise.race([Promise.allSettled([...this.pending]), limit]).then(() => setTimeout(send, 0));
    };
    if (rt.state !== 'running') report();
    else rt.onExit = report;
  }

  /** Connect the document copy to the main thread and plugin events. */
  private attach(doc: Document) {
    for (const d of this.detach) d();
    const env = this.env!;
    env.doc = doc;
    if (this.tracker) this.tracker = new ChangeTracker(doc);
    this.detach = [
      // The plugin's own edits go to the main thread.
      doc.onChange((ops: Op[], origin: string) => {
        if (origin === EDITOR || origin === COLLAB || origin === SILENT) return;
        this.post({ type: 'ops', ops, seen: this.appliedSeq });
        // The copy needs no undo history (undo happens in the editor).
        doc.clearHistory();
      }),
      doc.onCommit((op, origin, removed) => {
        if (!this.tracker || origin === SILENT) return;
        const o: ChangeOrigin = origin === COLLAB ? 'REMOTE' : 'LOCAL';
        this.tracker.add(op, o, removed);
        this.schedule();
      }),
    ];
  }

  private queue(event: string) {
    this.events.add(event);
    this.schedule();
  }

  /** Events are sent after the current call, batched (asynchronously). */
  private schedule() {
    if (this.flushing) return;
    this.flushing = true;
    setTimeout(() => this.flush(), 0);
  }

  private flush() {
    this.flushing = false;
    const rt = this.runtime;
    if (!rt || rt.state !== 'running') {
      // The plugin is still starting; events will wait for it.
      if (!rt) this.ready.then(() => this.schedule());
      return;
    }
    const events = [...this.events];
    this.events.clear();
    // Page first, then selection.
    events.sort((a, b) => (a === 'currentpagechange' ? -1 : b === 'currentpagechange' ? 1 : 0));
    for (const e of events) if (this.listening.has(e)) rt.emit(e);
    if (this.tracker && !this.tracker.empty) {
      const { documentChanges, styleChanges, nodeChanges } = this.tracker.take();
      if (documentChanges.length && this.listening.has('documentchange')) rt.emit('documentchange', { documentChanges });
      if (styleChanges.length && this.listening.has('stylechange')) rt.emit('stylechange', { styleChanges });
      if (this.listening.has('nodechange')) for (const [page, list] of nodeChanges) rt.emitNode(page, 'nodechange', { nodeChanges: list });
    }
  }
}
