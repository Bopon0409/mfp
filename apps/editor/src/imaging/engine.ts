// A single GPU worker for all tools and chains: jobs run in a queue,
// each with its own progress handlers (stage, tiles, preview strips).

import type { GpuProbe, ImagingEvent, ImagingRequest } from './protocol.ts';
import { network, offlineMessage } from '../network.ts';

export interface UpscaleModel {
  id: string;
  name: string;
  hint: string;
  tile: number;
  size: { fp16: string; fp32: string };
}

export const UPSCALE_MODELS: UpscaleModel[] = [
  { id: 'realesr-general-x4v3', name: 'Быстрая', hint: 'Фото и графика. Лёгкая модель — быстро даже на ноутбуке', tile: 256, size: { fp16: '2 МБ', fp32: '5 МБ' } },
  { id: 'realesr-x4plus', name: 'Качество', hint: 'Больше мелких деталей, в 10–15 раз медленнее', tile: 192, size: { fp16: '32 МБ', fp32: '64 МБ' } },
  { id: 'realesr-x4plus-anime', name: 'Рисунки', hint: 'Иллюстрации, арт и плоские цвета', tile: 192, size: { fp16: '9 МБ', fp32: '17 МБ' } },
];

const modelsBase = () => `${import.meta.env.BASE_URL}upscaler/`;
export const upscaleModelUrl = (id: string, f16: boolean) => `${modelsBase()}${id}.${f16 ? 'fp16' : 'fp32'}.onnx`;
/**
 * BiRefNet-lite (MIT; the weights were trained partly on DIS5K, which has its own terms), graph rewritten for
 * WebGPU (jiabins0303/birefnet-lite-1024-webgpu): fp16 only, with float32 input and output. Not
 * bundled: downloaded once on the first background removal from a pinned source revision and
 * verified by SHA-256; stored in the browser cache.
 */
export const MATTE_MODEL = {
  url: 'https://huggingface.co/jiabins0303/birefnet-lite-1024-webgpu/resolve/1ad01cef0f4101a285c5a3e0bd7f15597d93403f/onnx/model_fp16.onnx',
  sha256: '4059896039dfccb0f15b9080ff06d11d90e499449bb045e797055eb8901cf5f4',
  cache: 'mfp-imaging-matte',
  size: '110 МБ',
};

/** The background removal model is already downloaded (browser cache). */
export async function matteCached(): Promise<boolean> {
  try {
    return !!(await (await caches.open(MATTE_MODEL.cache)).match(MATTE_MODEL.url));
  } catch {
    return false;
  }
}

export interface JobHooks {
  onStage?: (text: string, fraction?: number) => void;
  onProgress?: (done: number, total: number, elapsed: number) => void;
  onRows?: (top: number, height: number, bitmap: ImageBitmap) => void;
}

export interface JobResult {
  blob: Blob;
  width: number;
  height: number;
  seconds: number;
}

export class Cancelled extends Error {
  constructor() {
    super('Остановлено');
  }
}

type Job = { id: number; hooks: JobHooks; resolve: (r: JobResult) => void; reject: (e: Error) => void };

export class ImagingEngine {
  private worker: Worker | null = null;
  private probing: Promise<GpuProbe> | null = null;
  private onProbe: ((p: GpuProbe) => void) | null = null;
  private onSdStatus: ((cached: boolean) => void)[] = [];
  private jobs = new Map<number, Job>();
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private stopped = new Set<number>();

  probe(): Promise<GpuProbe> {
    if (!this.probing) {
      this.probing = new Promise((resolve) => (this.onProbe = resolve));
      this.start();
      this.send({ type: 'probe' });
    }
    return this.probing;
  }

  /** Jobs run in a queue; one cancelled before start is never run. */
  private enqueue(make: (id: number) => { req: ImagingRequest; transfer: Transferable[] }, hooks: JobHooks, gate?: () => Promise<void>): { id: number; done: Promise<JobResult> } {
    const id = ++this.nextId;
    const done = new Promise<JobResult>((resolve, reject) => {
      this.queue = this.queue.then(
        () =>
          new Promise<void>(async (settle) => {
            // Pre-start check (e.g. a model without internet): if it fails, the job does not start.
            if (gate && !this.stopped.has(id)) {
              try {
                await gate();
              } catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
                settle();
                return;
              }
            }
            if (this.stopped.has(id)) {
              this.stopped.delete(id);
              reject(new Cancelled());
              settle();
              return;
            }
            this.jobs.set(id, {
              id,
              hooks,
              resolve: (r) => (resolve(r), settle()),
              reject: (e) => (reject(e), settle()),
            });
            const { req, transfer } = make(id);
            this.send(req, transfer);
          }),
      );
    });
    return { id, done };
  }

  upscale(bitmap: ImageBitmap, opts: { modelUrl: string; tile: number; scale: number; previewWidth: number }, hooks: JobHooks = {}) {
    this.probe();
    return this.enqueue((id) => ({ req: { type: 'upscale', id, bitmap, ...opts }, transfer: [bitmap] }), hooks);
  }

  /** A 512×512 image from text: SD-Turbo on the GPU (the model is downloaded once). */
  txt2img(opts: { prompt: string; steps: number; seed: number }, hooks: JobHooks = {}) {
    this.probe();
    // Without internet the model cannot be downloaded; only an already downloaded one (the worker bypasses the network guard in main).
    return this.enqueue((id) => ({ req: { type: 'txt2img', id, ...opts }, transfer: [] }), hooks, () => this.offlineGate(() => this.sdCached()));
  }

  /** Whether SD-Turbo is in the browser cache. */
  sdCached(): Promise<boolean> {
    this.probe();
    return new Promise((resolve) => {
      this.onSdStatus.push(resolve);
      this.send({ type: 'sd-status' });
    });
  }

  sdPurge(): Promise<boolean> {
    this.probe();
    return new Promise((resolve) => {
      this.onSdStatus.push(resolve);
      this.send({ type: 'sd-purge' });
    });
  }

  matte(bitmap: ImageBitmap, opts: { trim: boolean }, hooks: JobHooks = {}) {
    this.probe();
    // Without internet the model cannot be downloaded; only an already downloaded one (the worker bypasses the network guard in main).
    return this.enqueue((id) => ({ req: { type: 'matte', id, bitmap, modelUrl: MATTE_MODEL.url, cache: MATTE_MODEL.cache, sha256: MATTE_MODEL.sha256, trim: opts.trim }, transfer: [bitmap] }), hooks, () => this.offlineGate(matteCached));
  }

  /** Without internet: only a model that is already downloaded. */
  private async offlineGate(cached: () => Promise<boolean>) {
    if (!network.allowed && !(await cached())) throw new Error(offlineMessage());
  }

  cancel(id: number) {
    if (this.jobs.has(id)) this.send({ type: 'cancel', id });
    else this.stopped.add(id);
  }

  private start() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<ImagingEvent>) => this.onEvent(e.data);
    this.worker.onerror = (e) => {
      const error = new Error(e.message || 'Воркер не запустился');
      this.onProbe?.({ ok: false, text: error.message, f16: false });
      for (const job of this.jobs.values()) job.reject(error);
      this.jobs.clear();
    };
  }

  private send(msg: ImagingRequest, transfer: Transferable[] = []) {
    this.worker?.postMessage(msg, transfer);
  }

  private onEvent(e: ImagingEvent) {
    if (e.type === 'probe') {
      this.onProbe?.(e.probe);
      return;
    }
    if (e.type === 'sd-status') {
      this.onSdStatus.shift()?.(e.cached);
      return;
    }
    const job = this.jobs.get(e.id);
    if (!job) {
      if (e.type === 'rows') e.bitmap.close();
      return;
    }
    if (e.type === 'stage') job.hooks.onStage?.(e.text, e.fraction);
    else if (e.type === 'progress') job.hooks.onProgress?.(e.done, e.total, e.elapsed);
    else if (e.type === 'rows') {
      if (job.hooks.onRows) job.hooks.onRows(e.top, e.height, e.bitmap);
      else e.bitmap.close();
    } else {
      this.jobs.delete(e.id);
      if (e.type === 'done') job.resolve({ blob: e.blob, width: e.width, height: e.height, seconds: e.seconds });
      else if (e.type === 'cancelled') job.reject(new Cancelled());
      else job.reject(new Error(e.message));
    }
  }
}
