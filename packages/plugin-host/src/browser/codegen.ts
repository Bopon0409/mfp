// Codegen plugins (developer mode: capabilities ["codegen"],
// figma.codegen.on("generate")). The plugin lives in its own Worker with a copy of the document: editor
// edits reach the copy, and so does the selection; on a “code for layer in language” request the plugin
// responds with a list of blocks { title, code, language }. There is no UI window in codegen mode.

import type { Document } from '@mfp/core';
import type { PluginBundle } from '../runtime.ts';
import { DocLink } from './doc-link.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

export interface CodegenBlock {
  title: string;
  code: string;
  language: string;
}

export interface CodegenHostOptions {
  /** Editor document (if the file changes, the plugin restarts with the new one). */
  doc(): Document;
  getPage(): string;
  getSelection(): string[];
  notify(message: string, kind?: 'info' | 'error'): void;
  /** The plugin asked to recompute the code (figma.codegen.refresh). */
  onRefresh?(): void;
}

const TIMEOUT = 15_000;

export class CodegenHost {
  readonly bundle: PluginBundle;
  private opts: CodegenHostOptions;
  private worker: Worker | null = null;
  private doc: Document | null = null;
  private link: DocLink | null = null;
  private seq = 0;
  private waits = new Map<number, { resolve(v: CodegenBlock[]): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private error: string | null = null;

  constructor(bundle: PluginBundle, opts: CodegenHostOptions) {
    this.bundle = bundle;
    this.opts = opts;
  }

  /** Plugin languages (from manifest.codegenLanguages; absent — one, named after the plugin). */
  get languages(): { label: string; value: string }[] {
    const list = this.bundle.manifest.codegenLanguages;
    return list?.length ? list : [{ label: this.bundle.manifest.name, value: this.bundle.manifest.id }];
  }

  /** Start (or restart if the document changed). */
  private ensure() {
    const doc = this.opts.doc();
    if (this.worker && this.doc === doc && !this.error) return;
    this.stop();
    this.doc = doc;
    this.error = null;
    const w = new Worker(new URL('./plugin-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
    w.onerror = (e) => this.fail(`Ошибка плагина: ${e.message}`);
    this.worker = w;
    // Editor edits go into the plugin's document copy, in application order.
    this.link = new DocLink(doc, (m) => this.send(m));
    this.send({ type: 'start', bundle: this.bundle, snapshot: doc.snapshot(), page: this.opts.getPage(), selection: this.opts.getSelection(), storage: {}, codegen: true });
  }

  /** Code for a layer in the plugin's language. */
  generate(nodeId: string, language: string): Promise<CodegenBlock[]> {
    this.ensure();
    this.send({ type: 'setSelection', ids: this.opts.getSelection(), page: this.opts.getPage() });
    const requestId = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waits.delete(requestId);
        reject(new Error('Плагин не ответил за 15 с'));
      }, TIMEOUT);
      this.waits.set(requestId, { resolve, reject, timer });
      this.send({ type: 'generate', requestId, nodeId, language });
    });
  }

  stop() {
    this.link?.dispose();
    this.link = null;
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waits.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Плагин остановлен'));
    }
    this.waits.clear();
  }

  private send(m: ToWorker) {
    this.worker?.postMessage(m);
  }

  private fail(message: string) {
    this.error = message;
    for (const w of this.waits.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(message));
    }
    this.waits.clear();
  }

  private handle(m: FromWorker) {
    switch (m.type) {
      case 'codegenResult': {
        const w = this.waits.get(m.requestId);
        if (!w) break;
        this.waits.delete(m.requestId);
        clearTimeout(w.timer);
        if (m.error) w.reject(new Error(m.error));
        else w.resolve(normalize(m.results));
        break;
      }
      case 'codegenRefresh':
        this.opts.onRefresh?.();
        break;
      case 'resync':
        if (this.link) this.send(this.link.reset());
        break;
      case 'notify':
        this.opts.notify(m.message);
        break;
      case 'exit':
        this.fail(m.error ? `Плагин завершился с ошибкой: ${m.error.split('\n')[0]}` : 'Плагин завершился');
        this.worker?.terminate();
        this.worker = null;
        break;
      default:
        // Windows, document edits and the like are not needed in codegen mode.
        break;
    }
  }
}

/** Plugin response: code blocks (anything extra is dropped). */
function normalize(results: unknown): CodegenBlock[] {
  if (!Array.isArray(results)) return [];
  return results
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({ title: String(r.title ?? ''), code: String(r.code ?? ''), language: String(r.language ?? 'PLAINTEXT') }));
}
