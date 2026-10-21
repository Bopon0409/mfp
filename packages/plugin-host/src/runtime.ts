// Plugin runtime: QuickJS (wasm) + the `figma` shim + the host API.
//
// The plugin runs in a separate interpreter without access to the DOM, the network and
// host globals. Limits:
// time per sandbox entry (protection against infinite loops) and memory.

import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import { HostApi, type PluginEnvironment } from './host-api.ts';
import type { PluginManifest } from './manifest.ts';
import { FIGMA_SHIM } from './shim.ts';
import { allowedDomains } from './network.ts';

/** A single QuickJS variant, release sync: the quickjs-emscripten package would pull all four into the bundle. */
let quickjs: Promise<QuickJSWASMModule> | null = null;
const getQuickJS = () => (quickjs ??= newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-wasmfile-release-sync')));

export interface PluginBundle {
  manifest: PluginManifest;
  /** Contents of the manifest.main file. */
  code: string;
  /** Contents of the manifest.ui file (available to the plugin as __html__). */
  html?: string;
  /** manifest.ui as an object (several windows): key → HTML (available to the plugin as __uiFiles__). */
  uiFiles?: Record<string, string>;
}

export interface RuntimeOptions {
  /** Maximum time of one sandbox entry, ms. */
  timeLimitMs?: number;
  /** Interpreter memory limit, bytes. */
  memoryLimit?: number;
  /** Timer scheduler (can be replaced in tests). */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Menu command (figma.command). */
  command?: string;
  /** Quick action parameter values (run event). */
  parameters?: Record<string, unknown>;
  /** run comes later (via run()): the user enters parameters first. */
  deferRun?: boolean;
}

export type PluginState = 'running' | 'closed' | 'error';

/** For a widget: render a node, a handler event (element path) or a property menu item. */
export type WidgetMessage =
  | { action: 'render'; nodeId: string }
  | { action: 'event'; nodeId: string; path: string; kind: string; event?: unknown }
  | { action: 'menu'; nodeId: string; propertyName: string; propertyValue?: unknown };

export class PluginRuntime {
  private vm: QuickJSContext;
  private dispatchFn: QuickJSHandle;
  private api: HostApi;
  private timers = new Map<number, unknown>();
  /** Bytes: host → sandbox (by id, taken once) and sandbox → host. */
  private outBlobs = new Map<number, Uint8Array>();
  private inBlobs = new Map<number, Uint8Array>();
  private blobSeq = 0;
  private opts: Required<Omit<RuntimeOptions, 'command' | 'parameters' | 'deferRun'>>;
  state: PluginState = 'running';
  closeMessage: string | null = null;
  error: string | null = null;
  readonly manifest: PluginManifest;
  /** Called when the plugin exits (closePlugin or an error). */
  onExit: ((state: PluginState) => void) | null = null;

  private constructor(vm: QuickJSContext, bundle: PluginBundle, env: PluginEnvironment, opts: RuntimeOptions) {
    this.vm = vm;
    this.manifest = bundle.manifest;
    this.opts = {
      timeLimitMs: opts.timeLimitMs ?? 5000,
      memoryLimit: opts.memoryLimit ?? 256 * 1024 * 1024,
      schedule: opts.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
      cancel: opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
    this.api = new HostApi(env, bundle.manifest.id, opts.command ?? '', allowedDomains(bundle.manifest), {
      onClose: (message) => this.exit('closed', message),
      setTimer: (id, ms) => {
        this.timers.set(
          id,
          this.opts.schedule(() => {
            this.timers.delete(id);
            this.dispatch('timer', { id });
          }, ms),
        );
      },
      clearTimer: (id) => {
        const h = this.timers.get(id);
        if (h !== undefined) this.opts.cancel(h);
        this.timers.delete(id);
      },
      settle: (id, value, error) => this.dispatch('settle', { id, value, error }),
      blob: (bytes) => {
        const id = ++this.blobSeq;
        this.outBlobs.set(id, bytes);
        return { $blob: id };
      },
      takeBlob: (id) => {
        const bytes = this.inBlobs.get(id);
        this.inBlobs.delete(id);
        return bytes;
      },
    });

    vm.runtime.setMemoryLimit(this.opts.memoryLimit);
    vm.runtime.setMaxStackSize(1024 * 1024);

    const bridge = vm.newFunction('__mfp_call', (methodH, argsH) => {
      const method = vm.getString(methodH);
      const args = JSON.parse(vm.getString(argsH)) as unknown[];
      try {
        const result = this.api.call(method, args);
        return result === undefined ? vm.undefined : vm.newString(JSON.stringify(result));
      } catch (e) {
        return vm.newString(JSON.stringify({ $error: (e as Error).message }));
      }
    });
    vm.setProp(vm.global, '__mfp_call', bridge);
    bridge.dispose();
    // Bytes are passed as an ArrayBuffer (memory copy), not as a JSON array of numbers.
    const take = vm.newFunction('__mfp_take', (idH) => {
      const id = vm.getNumber(idH);
      const bytes = this.outBlobs.get(id);
      this.outBlobs.delete(id);
      if (!bytes) return vm.undefined;
      return vm.newArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    });
    vm.setProp(vm.global, '__mfp_take', take);
    take.dispose();
    const put = vm.newFunction('__mfp_put', (bufH) => {
      const view = vm.getArrayBuffer(bufH);
      const copy = new Uint8Array(view.value);
      view.dispose();
      const id = ++this.blobSeq;
      this.inBlobs.set(id, copy);
      return vm.newNumber(id);
    });
    vm.setProp(vm.global, '__mfp_put', put);
    put.dispose();

    this.evalOrThrow(FIGMA_SHIM, 'mfp-shim.js');
    this.dispatchFn = vm.getProp(vm.global, '__mfp_dispatch');
    const html = vm.newString(bundle.html ?? '');
    vm.setProp(vm.global, '__html__', html);
    html.dispose();
    if (bundle.uiFiles) {
      const files = vm.newObject();
      for (const [k, v] of Object.entries(bundle.uiFiles)) {
        const h = vm.newString(v);
        vm.setProp(files, k, h);
        h.dispose();
      }
      vm.setProp(vm.global, '__uiFiles__', files);
      files.dispose();
    }
  }

  /** Creates the runtime and runs the plugin code. */
  static async start(bundle: PluginBundle, env: PluginEnvironment, opts: RuntimeOptions = {}): Promise<PluginRuntime> {
    const QuickJS = await getQuickJS();
    const vm = QuickJS.newContext();
    const rt = new PluginRuntime(vm, bundle, env, opts);
    rt.guard(() => rt.evalOrThrow(bundle.code, bundle.manifest.main));
    // After the plugin code: the run event (command and quick action parameters).
    if (env.mode !== 'codegen' && !opts.deferRun) rt.run(opts.command ?? '', opts.parameters);
    return rt;
  }

  /** Message from the plugin UI (parent.postMessage({ pluginMessage }, '*')). */
  postFromUI(message: unknown, origin = 'null') {
    this.dispatch('uiMessage', { message, origin });
  }

  /** Codegen: call the figma.codegen generate handler for a node (the response goes via env.codegenResult). */
  generate(requestId: number, nodeId: string, language: string) {
    this.dispatch('codegen', { requestId, nodeId, language });
  }

  /** run event: command and quick action parameters. */
  run(command: string, parameters?: Record<string, unknown>) {
    this.emit('run', { command, ...(parameters ? { parameters } : {}) });
  }

  /** Quick action parameter input: the plugin responds with suggestions (figma.parameters.on('input')). */
  parameterInput(requestId: number, key: string, query: string, parameters: Record<string, unknown>) {
    this.dispatch('parameterInput', { requestId, key, query, parameters });
  }

  /** Editor event: selectionchange, currentpagechange, close… */
  emit(type: string, ...args: unknown[]) {
    this.dispatch('event', { type, args });
  }

  /** Widget: render a node, a handler event (element path) or the property menu. */
  widget(msg: WidgetMessage) {
    if (msg.action === 'render') this.dispatch('widgetRender', { nodeId: msg.nodeId });
    else if (msg.action === 'event') this.dispatch('widgetEvent', { nodeId: msg.nodeId, path: msg.path, kind: msg.kind, event: msg.event ?? null });
    else this.dispatch('widgetMenu', { nodeId: msg.nodeId, propertyName: msg.propertyName, propertyValue: msg.propertyValue ?? null });
  }

  /** Node event (nodechange for a page). */
  emitNode(id: string, type: string, ...args: unknown[]) {
    this.dispatch('nodeEvent', { id, type, args });
  }

  /** Force-stop the plugin (the user closed the window). */
  stop() {
    if (this.state !== 'running') return;
    this.emit('close');
    this.exit('closed', null);
  }

  private dispatch(kind: string, data: unknown) {
    if (this.state !== 'running') return;
    const vm = this.vm;
    this.guard(() => {
      const k = vm.newString(kind);
      const d = vm.newString(JSON.stringify(data ?? null));
      const res = vm.callFunction(this.dispatchFn, vm.undefined, k, d);
      k.dispose();
      d.dispose();
      if (res.error) {
        const err = vm.dump(res.error);
        res.error.dispose();
        throw new Error(formatError(err));
      }
      res.value.dispose();
    });
  }

  /** Run a sandbox entry with a time limit, then drain promises. */
  private guard(fn: () => void) {
    if (this.state !== 'running') return;
    const vm = this.vm;
    try {
      vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.opts.timeLimitMs));
      fn();
      // Plugin microtasks (promises).
      for (let i = 0; i < 1000; i++) {
        if (this.state !== 'running') break;
        const r = vm.runtime.executePendingJobs();
        if (r.error) {
          const err = vm.dump(r.error);
          r.error.dispose();
          throw new Error(formatError(err));
        }
        if (r.value === 0) break;
      }
    } catch (e) {
      this.error = (e as Error).message;
      this.exit('error', null);
    } finally {
      if (this.state === 'running') vm.runtime.removeInterruptHandler();
    }
  }

  private evalOrThrow(code: string, filename: string) {
    const res = this.vm.evalCode(code, filename);
    if (res.error) {
      const err = this.vm.dump(res.error);
      res.error.dispose();
      throw new Error(formatError(err));
    }
    res.value.dispose();
  }

  private exit(state: PluginState, message: string | null) {
    if (this.state !== 'running') return;
    this.state = state;
    this.closeMessage = message;
    for (const h of this.timers.values()) this.opts.cancel(h);
    this.timers.clear();
    this.onExit?.(state);
    // Free the interpreter after leaving the current call.
    queueMicrotask(() => {
      this.dispatchFn.dispose();
      this.vm.dispose();
    });
  }
}

function formatError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string; stack?: string };
    return `${e.name ?? 'Error'}: ${e.message ?? JSON.stringify(err)}${e.stack ? `\n${e.stack}` : ''}`;
  }
  return String(err);
}


