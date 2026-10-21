// Real node services: GPU (worker), Nano Banana, Magnific. “Auto” picks the service by key,
// with no key the GPU. Stopping the graph aborts both the network and the worker job.

import { Cancelled, UPSCALE_MODELS, upscaleModelUrl, type ImagingEngine, type JobResult } from '../engine.ts';
import { generateImage } from '../gemini.ts';
import type { ImagingSettings } from '../keys.ts';
import { magnificUpscale, type ServerLink } from '../magnific.ts';
import type { GpuProbe } from '../protocol.ts';
import { fitInto } from '../resize.ts';
import type { RunContext, Services } from './runner.ts';

export interface ServiceDeps {
  engine: ImagingEngine;
  settings: () => ImagingSettings;
  server: ServerLink;
  probe: () => GpuProbe | null;
}

async function gpu(engine: ImagingEngine, ctx: RunContext, job: { id: number; done: Promise<JobResult> }): Promise<Blob> {
  const stop = () => engine.cancel(job.id);
  ctx.signal.addEventListener('abort', stop, { once: true });
  try {
    return (await job.done).blob;
  } catch (e) {
    if (e instanceof Cancelled) throw new DOMException('Остановлено', 'AbortError');
    throw e;
  } finally {
    ctx.signal.removeEventListener('abort', stop);
  }
}

function needGpu(deps: ServiceDeps, f16 = false) {
  const p = deps.probe();
  if (!p?.ok) throw new Error('Нужна видеокарта с WebGPU — или подключите Nano Banana и Magnific');
  if (f16 && !p.f16) throw new Error('Видеокарта без fp16 — локальная генерация недоступна, подключите Nano Banana');
}

export function createServices(deps: ServiceDeps): Services {
  const { engine } = deps;
  return {
    async generate(o, ctx) {
      const s = deps.settings();
      const where = o.engine === 'auto' ? (s.geminiKey ? 'nano' : 'local') : o.engine;
      if (where === 'nano') {
        if (!s.geminiKey) throw new Error('Нет ключа Google AI: откройте «Подключения»');
        ctx.status('Nano Banana рисует…');
        return generateImage({ key: s.geminiKey, model: s.geminiModel, prompt: o.prompt, references: o.reference ? [o.reference] : [], aspectRatio: o.aspectRatio, imageSize: o.imageSize, signal: ctx.signal });
      }
      needGpu(deps, true);
      ctx.status('SD-Turbo рисует…');
      return gpu(engine, ctx, engine.txt2img({ prompt: o.prompt, steps: o.steps, seed: Math.floor(Math.random() * 2 ** 31) }, { onStage: (t) => ctx.status(t) }));
    },

    async upscale(image, o, ctx) {
      const s = deps.settings();
      const where = o.engine === 'auto' ? (s.magnificKey ? 'magnific' : 'local') : o.engine;
      if (where === 'magnific') {
        if (!s.magnificKey) throw new Error('Нет ключа Magnific: откройте «Подключения»');
        const scale = [2, 4, 8, 16].includes(o.scale) ? o.scale : o.scale <= 2 ? 2 : 4;
        return magnificUpscale(image, { key: s.magnificKey, host: s.magnificHost, server: deps.server, mode: o.mode, scale, onStatus: (t) => ctx.status(t), signal: ctx.signal });
      }
      needGpu(deps);
      const model = UPSCALE_MODELS.find((m) => m.id === o.model) ?? UPSCALE_MODELS[0]!;
      const scale = Math.max(2, Math.min(4, o.scale));
      const bitmap = await createImageBitmap(image);
      ctx.status(`Увеличиваю ×${scale}…`);
      return gpu(engine, ctx, engine.upscale(bitmap, { modelUrl: upscaleModelUrl(model.id, !!deps.probe()?.f16), tile: model.tile, scale, previewWidth: 64 }, { onProgress: (d, t) => ctx.status(`Увеличиваю ×${scale}: ${Math.round((d / t) * 100)}%`) }));
    },

    async removeBackground(image, trim, ctx) {
      needGpu(deps);
      ctx.status('Убираю фон…');
      return gpu(engine, ctx, engine.matte(await createImageBitmap(image), { trim }, { onStage: (t) => ctx.status(t) }));
    },

    fit: (image, width, height, padding) => fitInto(image, width, height, padding),

    async sizeOf(image) {
      const bitmap = await createImageBitmap(image);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    },
  };
}
