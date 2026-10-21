// Image enhancements on the user's GPU (ONNX via WebGPU):
// Real-ESRGAN upscale: tiles with overlapping margins, in strips into a streaming PNG and the preview;
// BiRefNet background removal: a 1024×1024 mask stretched to the image size, into the alpha channel;
// SD-Turbo text-to-image: the model (≈2.4 GB) from Hugging Face once, then from the browser cache.

import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { ClipTokenizer } from './clip-tokenizer.ts';
import type { UnetEvent, UnetRequest } from './sd-unet-worker.ts';
import { PngStream } from './png.ts';
import type { GpuProbe, ImagingEvent, ImagingRequest } from './protocol.ts';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;

const MODEL_SCALE = 4;
// Margin around a tile: the model sees the neighbors, and tile seams are invisible
const PAD = 16;

class Cancelled extends Error {}

const post = (event: ImagingEvent, transfer: Transferable[] = []) => postMessage(event, { transfer });

const sessions = new Map<string, Promise<ort.InferenceSession>>();
let cancelledId = -1;

async function probe(): Promise<GpuProbe> {
  if (!navigator.gpu) return { ok: false, text: 'Браузер без WebGPU — нужен свежий Chrome, Edge или приложение MFP', f16: false };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { ok: false, text: 'WebGPU есть, но видеокарта недоступна', f16: false };
  const { vendor, architecture, description } = adapter.info;
  const name = description || [vendor, architecture].filter(Boolean).join(' ') || 'видеокарта';
  return { ok: true, text: name, f16: adapter.features.has('shader-f16') };
}

/** The whole file, with download progress reported to the job stage. */
async function download(id: number, url: string, text: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Модель не загрузилась: ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    // Stopped during download: abort it rather than fetch a hundred megabytes for nothing.
    if (cancelledId === id) {
      await reader.cancel().catch(() => {});
      throw new Cancelled();
    }
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    post({ type: 'stage', id, text, fraction: total ? loaded / total : undefined });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}

/**
 * Model: bundled (url next to the editor) or, if cached is set, downloaded once from the
 * source into the browser cache and verified by SHA-256 (not bundled).
 */
async function loadModel(id: number, url: string, cached?: { cache: string; sha256: string }): Promise<ort.InferenceSession> {
  let session = sessions.get(url);
  if (!session) {
    session = (async () => {
      let bytes: Uint8Array<ArrayBuffer>;
      if (cached) {
        const cache = await caches.open(cached.cache);
        const hit = await cache.match(url);
        if (hit) bytes = new Uint8Array(await hit.arrayBuffer());
        else {
          bytes = await download(id, url, 'Скачиваю модель (один раз)…');
          const sum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
          if (sum !== cached.sha256) throw new Error('Скачанная модель повреждена или подменена — попробуйте ещё раз');
          await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
        }
      } else bytes = await download(id, url, 'Загружаю модель…');
      post({ type: 'stage', id, text: 'Готовлю видеокарту…' });
      try {
        return await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
      } catch (e) {
        // A corrupted cache entry must not break every subsequent run: download again.
        if (cached) await caches.open(cached.cache).then((c) => c.delete(url)).catch(() => {});
        throw e;
      }
    })();
    sessions.set(url, session);
    session.catch(() => sessions.delete(url));
  }
  return session;
}

const reflect = (i: number, n: number) => {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * (n - 1) - i;
  return i;
};

// Tile positions: the last one is pinned to the edge, so all tiles are the same size and the model is not rebuilt
const positions = (size: number, tile: number) => {
  const out: number[] = [];
  for (let p = 0; p < size - tile; p += tile) out.push(p);
  out.push(size - tile);
  return out;
};

function readPixels(bitmap: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

function tileInput(src: Uint8ClampedArray, w: number, h: number, x: number, y: number, iw: number, ih: number): Float32Array {
  const plane = iw * ih;
  const out = new Float32Array(plane * 3);
  const cols = new Int32Array(iw);
  for (let i = 0; i < iw; i++) cols[i] = reflect(x + i, w);
  for (let r = 0; r < ih; r++) {
    const row = reflect(y + r, h) * w;
    const base = r * iw;
    for (let i = 0; i < iw; i++) {
      const s = (row + cols[i]!) * 4;
      out[base + i] = src[s]! / 255;
      out[plane + base + i] = src[s + 1]! / 255;
      out[2 * plane + base + i] = src[s + 2]! / 255;
    }
  }
  return out;
}

async function upscale(msg: Extract<ImagingRequest, { type: 'upscale' }>) {
  const { id, bitmap, scale } = msg;
  const started = performance.now();
  const check = () => {
    if (cancelledId === id) throw new Cancelled();
  };
  const w = bitmap.width;
  const h = bitmap.height;
  const src = readPixels(bitmap);

  let hasAlpha = false;
  for (let i = 3; i < src.length; i += 4) {
    if (src[i] !== 255) {
      hasAlpha = true;
      break;
    }
  }
  const alphaSource = hasAlpha ? new OffscreenCanvas(w, h) : null;
  if (alphaSource) {
    const gray = new ImageData(w, h);
    for (let i = 0; i < src.length; i += 4) {
      gray.data[i] = gray.data[i + 1] = gray.data[i + 2] = src[i + 3]!;
      gray.data[i + 3] = 255;
    }
    alphaSource.getContext('2d')!.putImageData(gray, 0, 0);
  }
  bitmap.close();

  const session = await loadModel(id, msg.modelUrl);
  check();
  post({ type: 'stage', id, text: 'Увеличиваю…' });

  const tw = Math.min(msg.tile, w);
  const th = Math.min(msg.tile, h);
  const iw = tw + 2 * PAD;
  const ih = th + 2 * PAD;
  const xs = positions(w, tw);
  const ys = positions(h, th);
  const total = xs.length * ys.length;

  const ow = w * scale;
  const oh = h * scale;
  const channels = hasAlpha ? 4 : 3;
  const png = new PngStream(ow, oh, channels);

  // A strip of tiles at model scale together with margins above and below: when downscaling to ×2/×3
  // the strip edges are smoothed using real neighboring pixels, and there are no seams between strips
  const bandW = w * MODEL_SCALE;
  const bandH = ih * MODEL_SCALE;
  const band = new ImageData(bandW, bandH);
  const bandCanvas = new OffscreenCanvas(bandW, bandH);
  const bandCtx = bandCanvas.getContext('2d', { willReadFrequently: true })!;
  const scaledCanvas = scale === MODEL_SCALE ? null : new OffscreenCanvas(ow, ih * scale);
  const scaledCtx = scaledCanvas?.getContext('2d', { willReadFrequently: true }) ?? null;
  if (scaledCtx) scaledCtx.imageSmoothingQuality = 'high';
  const alphaCanvas = alphaSource ? new OffscreenCanvas(bandW, bandH) : null;
  const alphaCtx = alphaCanvas?.getContext('2d', { willReadFrequently: true }) ?? null;
  if (alphaCtx) alphaCtx.imageSmoothingQuality = 'high';

  const tileW = iw * MODEL_SCALE;
  const tileH = ih * MODEL_SCALE;
  const cropX = PAD * MODEL_SCALE;
  const keepW = tw * MODEL_SCALE;
  const previewScale = Math.min(1, msg.previewWidth / ow);

  let done = 0;
  let emitted = 0;
  try {
    for (const y0 of ys) {
      for (const x0 of xs) {
        check();
        const input = new ort.Tensor('float32', tileInput(src, w, h, x0 - PAD, y0 - PAD, iw, ih), [1, 3, ih, iw]);
        const result = await session.run({ [session.inputNames[0]!]: input });
        const output = result[session.outputNames[0]!]!;
        const data = output.data as Float32Array;
        const plane = tileW * tileH;
        const px = band.data;
        for (let r = 0; r < tileH; r++) {
          const from = r * tileW + cropX;
          let to = (r * bandW + x0 * MODEL_SCALE) * 4;
          for (let i = 0; i < keepW; i++, to += 4) {
            px[to] = data[from + i]! * 255;
            px[to + 1] = data[plane + from + i]! * 255;
            px[to + 2] = data[2 * plane + from + i]! * 255;
            px[to + 3] = 255;
          }
        }
        input.dispose();
        output.dispose();
        done++;
        post({ type: 'progress', id, done, total, elapsed: (performance.now() - started) / 1000 });
      }

      if (alphaSource && alphaCtx) {
        const sy = Math.max(0, y0 - PAD);
        const sh = Math.min(h, y0 + th + PAD) - sy;
        alphaCtx.clearRect(0, 0, bandW, bandH);
        alphaCtx.drawImage(alphaSource, 0, sy, w, sh, 0, (sy - (y0 - PAD)) * MODEL_SCALE, bandW, sh * MODEL_SCALE);
        const a = alphaCtx.getImageData(0, 0, bandW, bandH).data;
        for (let i = 3; i < a.length; i += 4) band.data[i] = a[i - 3]!;
      }

      let rows = band;
      if (scaledCtx && scaledCanvas) {
        bandCtx.putImageData(band, 0, 0);
        scaledCtx.clearRect(0, 0, ow, ih * scale);
        scaledCtx.drawImage(bandCanvas, 0, 0, ow, ih * scale);
        rows = scaledCtx.getImageData(0, 0, ow, ih * scale);
      }

      // Rows of this strip not yet in the file: the last strip overlaps the previous one
      const bandTop = (y0 - PAD) * scale;
      const start = Math.max(emitted, y0 * scale);
      const end = (y0 + th) * scale;
      const count = end - start;
      if (count > 0) {
        const packed = new Uint8Array(count * ow * channels);
        const rgba = rows.data;
        let k = 0;
        for (let r = start - bandTop; r < end - bandTop; r++) {
          let s = r * ow * 4;
          for (let i = 0; i < ow; i++, s += 4) {
            packed[k++] = rgba[s]!;
            packed[k++] = rgba[s + 1]!;
            packed[k++] = rgba[s + 2]!;
            if (channels === 4) packed[k++] = rgba[s + 3]!;
          }
        }
        await png.writeRows(packed, count);
        const preview = await createImageBitmap(rows, 0, start - bandTop, ow, count, {
          resizeWidth: Math.max(1, Math.round(ow * previewScale)),
          resizeHeight: Math.max(1, Math.round(count * previewScale)),
          resizeQuality: 'high',
        });
        post({ type: 'rows', id, top: start / oh, height: count / oh, bitmap: preview }, [preview]);
        emitted = end;
      }
    }
    check();
    post({ type: 'stage', id, text: 'Собираю PNG…' });
    const blob = await png.finish();
    post({ type: 'done', id, blob, width: ow, height: oh, seconds: (performance.now() - started) / 1000 });
  } catch (error) {
    png.abort();
    throw error;
  }
}

const MATTE = 1024;
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;
// More transparent than this counts as background: used to find object edges for trimming
const TRIM_ALPHA = 8;

async function matte(msg: Extract<ImagingRequest, { type: 'matte' }>) {
  const { id, bitmap } = msg;
  const started = performance.now();
  const w = bitmap.width;
  const h = bitmap.height;
  const session = await loadModel(id, msg.modelUrl, { cache: msg.cache, sha256: msg.sha256 });
  if (cancelledId === id) throw new Cancelled();
  post({ type: 'stage', id, text: 'Убираю фон…' });

  const small = new OffscreenCanvas(MATTE, MATTE);
  const smallCtx = small.getContext('2d', { willReadFrequently: true })!;
  smallCtx.imageSmoothingQuality = 'high';
  smallCtx.drawImage(bitmap, 0, 0, MATTE, MATTE);
  const px = smallCtx.getImageData(0, 0, MATTE, MATTE).data;
  const plane = MATTE * MATTE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (px[i * 4 + c]! / 255 - MEAN[c]!) / STD[c]!;
  }
  const tensor = new ort.Tensor('float32', input, [1, 3, MATTE, MATTE]);
  const result = await session.run({ [session.inputNames[0]!]: tensor });
  const output = result[session.outputNames[0]!]!;
  const logits = output.data as Float32Array;
  const mask = new ImageData(MATTE, MATTE);
  for (let i = 0; i < plane; i++) {
    const a = 255 / (1 + Math.exp(-logits[i]!));
    mask.data[i * 4] = mask.data[i * 4 + 1] = mask.data[i * 4 + 2] = a;
    mask.data[i * 4 + 3] = 255;
  }
  tensor.dispose();
  output.dispose();
  if (cancelledId === id) throw new Cancelled();

  const maskSmall = new OffscreenCanvas(MATTE, MATTE);
  maskSmall.getContext('2d')!.putImageData(mask, 0, 0);
  const maskFull = new OffscreenCanvas(w, h);
  const maskCtx = maskFull.getContext('2d', { willReadFrequently: true })!;
  maskCtx.imageSmoothingQuality = 'high';
  maskCtx.drawImage(maskSmall, 0, 0, w, h);
  const alpha = maskCtx.getImageData(0, 0, w, h).data;

  const full = new OffscreenCanvas(w, h);
  const fullCtx = full.getContext('2d', { willReadFrequently: true })!;
  fullCtx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = fullCtx.getImageData(0, 0, w, h);
  const rgba = image.data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = Math.round((rgba[i + 3]! * alpha[i]!) / 255);
      rgba[i + 3] = a;
      if (a > TRIM_ALPHA) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('Объект не найден — вся картинка распознана как фон');

  let out = full;
  if (msg.trim) {
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    out = new OffscreenCanvas(cw, ch);
    out.getContext('2d')!.putImageData(image, -x0, -y0, x0, y0, cw, ch);
  } else {
    fullCtx.putImageData(image, 0, 0);
  }
  post({ type: 'stage', id, text: 'Собираю PNG…' });
  const blob = await out.convertToBlob({ type: 'image/png' });
  post({ type: 'done', id, blob, width: out.width, height: out.height, seconds: (performance.now() - started) / 1000 });
}

// SD-Turbo (Stability AI Community License): an ONNX Runtime Web build, version pinned
const SD_BASE = 'https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/ace89b7d2cd849f9a73914cdbb8a3ea60c853dd1/';
const SD_CACHE = 'mfp-imaging-sd-turbo';
const SD_FILES = { vocab: 'tokenizer/vocab.json', merges: 'tokenizer/merges.txt', text: 'text_encoder/model.onnx', unet: 'unet/model.onnx', vae: 'vae_decoder/model.onnx' } as const;
const SD_LATENT = 64;
const VAE_SCALE = 0.18215;

/** Model file: from Cache Storage; if absent, download it with progress and put it there. */
async function sdFile(name: keyof typeof SD_FILES, onBytes?: (loaded: number) => void): Promise<Uint8Array> {
  const url = SD_BASE + SD_FILES[name];
  const cache = await caches.open(SD_CACHE);
  const hit = await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Модель не скачалась: ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    try {
      onBytes?.(loaded);
    } catch (e) {
      // Stopped: abort the download.
      await reader.cancel().catch(() => {});
      throw e;
    }
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  return bytes;
}

async function sdCached(): Promise<boolean> {
  const cache = await caches.open(SD_CACHE);
  const hits = await Promise.all(Object.values(SD_FILES).map((f) => cache.match(SD_BASE + f)));
  return hits.every(Boolean);
}

interface SdModel {
  tokenizer: ClipTokenizer;
  text: ort.InferenceSession;
  unet: (sample: Float32Array, timestep: number, hidden: Float32Array) => Promise<Float32Array>;
  vae: ort.InferenceSession;
}

/** UNet in a nested worker (its own WebAssembly memory); replies are matched by request number. */
async function startUnet(bytes: Uint8Array): Promise<SdModel['unet']> {
  const worker = new Worker(new URL('./sd-unet-worker.ts', import.meta.url), { type: 'module' });
  const waiting = new Map<number, { resolve: (eps: Float32Array) => void; reject: (e: Error) => void }>();
  let onLoad: { resolve: () => void; reject: (e: Error) => void } | null = null;
  worker.onmessage = (e: MessageEvent<UnetEvent>) => {
    const m = e.data;
    if (m.type === 'loaded') onLoad?.resolve();
    else if (m.type === 'eps') waiting.get(m.id)?.resolve(m.eps), waiting.delete(m.id);
    else if (m.id < 0) onLoad?.reject(new Error(m.message));
    else waiting.get(m.id)?.reject(new Error(m.message)), waiting.delete(m.id);
  };
  worker.onerror = (e) => onLoad?.reject(new Error(e.message || 'Воркер UNet не запустился'));
  await new Promise<void>((resolve, reject) => {
    onLoad = { resolve, reject };
    worker.postMessage({ type: 'load', bytes, latent: SD_LATENT } satisfies UnetRequest, [bytes.buffer]);
  });
  let next = 0;
  return (sample, timestep, hidden) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ type: 'run', id, sample, timestep, hidden, latent: SD_LATENT } satisfies UnetRequest, [sample.buffer]);
    });
}
let sdModel: Promise<SdModel> | null = null;

// As in the ONNX Runtime example for SD-Turbo: no extra copies of the model bytes, and fixed dimensions
const sdOptions = (dims: Record<string, number>): ort.InferenceSession.SessionOptions => ({
  executionProviders: ['webgpu'],
  enableMemPattern: false,
  enableCpuMemArena: false,
  freeDimensionOverrides: dims,
  extra: { session: { disable_prepacking: '1', use_device_allocator_for_initializers: '1', use_ort_model_bytes_directly: '1', use_ort_model_bytes_for_initializers: '1' } },
});

function loadSd(id: number): Promise<SdModel> {
  sdModel ??= (async () => {
    // Approximate file sizes, for the overall download percentage
    const parts: Record<keyof typeof SD_FILES, number> = { vocab: 1.06e6, merges: 0.52e6, text: 6.8e8, unet: 1.73e9, vae: 9.9e7 };
    const all = Object.values(parts).reduce((a, b) => a + b, 0);
    const done: Partial<Record<keyof typeof SD_FILES, number>> = {};
    const report = (name: keyof typeof SD_FILES) => (loaded: number) => {
      if (cancelledId === id) throw new Cancelled();
      done[name] = loaded;
      const sum = Object.values(done).reduce((a, b) => a + b, 0);
      post({ type: 'stage', id, text: `Скачиваю SD-Turbo (один раз) · ${(sum / 2 ** 30).toFixed(2)} из ${(all / 2 ** 30).toFixed(1)} ГБ`, fraction: Math.min(1, sum / all) });
    };
    const vocab = JSON.parse(new TextDecoder().decode(await sdFile('vocab', report('vocab')))) as Record<string, number>;
    const merges = new TextDecoder().decode(await sdFile('merges', report('merges')));
    const tokenizer = new ClipTokenizer(vocab, merges);
    const textBytes = await sdFile('text', report('text'));
    post({ type: 'stage', id, text: 'Готовлю текстовый энкодер…' });
    const text = await ort.InferenceSession.create(textBytes, sdOptions({ batch_size: 1 }));
    const unetBytes = await sdFile('unet', report('unet'));
    post({ type: 'stage', id, text: 'Готовлю UNet…' });
    const unet = await startUnet(unetBytes);
    const vaeBytes = await sdFile('vae', report('vae'));
    post({ type: 'stage', id, text: 'Готовлю VAE…' });
    const vae = await ort.InferenceSession.create(vaeBytes, sdOptions({ batch_size: 1, num_channels_latent: 4, height_latent: SD_LATENT, width_latent: SD_LATENT }));
    return { tokenizer, text, unet, vae };
  })();
  sdModel.catch(() => (sdModel = null));
  return sdModel;
}

/** “trailing” steps out of 1000 training steps and their σ (scaled_linear, β 0.00085…0.012), as in the model's scheduler_config. */
function sdSchedule(steps: number): { timesteps: number[]; sigmas: number[] } {
  const acp: number[] = [];
  let prod = 1;
  for (let i = 0; i < 1000; i++) {
    const beta = (Math.sqrt(0.00085) + ((Math.sqrt(0.012) - Math.sqrt(0.00085)) * i) / 999) ** 2;
    prod *= 1 - beta;
    acp.push(prod);
  }
  const timesteps = Array.from({ length: steps }, (_, i) => Math.round(1000 - (i * 1000) / steps) - 1);
  return { timesteps, sigmas: timesteps.map((t) => Math.sqrt((1 - acp[t]!) / acp[t]!)) };
}

/** Seeded normal noise: mulberry32 + Box–Muller. */
function gaussian(seed: number): () => number {
  let a = seed >>> 0 || 1;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const r = Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-12)));
    const th = 2 * Math.PI * uniform();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

async function txt2img(msg: Extract<ImagingRequest, { type: 'txt2img' }>) {
  const { id } = msg;
  const started = performance.now();
  const sd = await loadSd(id);
  if (cancelledId === id) throw new Cancelled();
  post({ type: 'stage', id, text: 'Рисую…' });

  const ids = new ort.Tensor('int32', sd.tokenizer.encode(msg.prompt), [1, 77]);
  const encoded = await sd.text.run({ [sd.text.inputNames[0]!]: ids });
  const hidden = encoded[sd.text.outputNames[0]!]!.data as Float32Array;

  const steps = Math.max(1, Math.min(4, Math.round(msg.steps)));
  const { timesteps, sigmas } = sdSchedule(steps);
  const randn = gaussian(msg.seed);
  const size = 4 * SD_LATENT * SD_LATENT;
  let latents = new Float32Array(size);
  for (let i = 0; i < size; i++) latents[i] = randn() * sigmas[0]!;
  for (let s = 0; s < steps; s++) {
    if (cancelledId === id) throw new Cancelled();
    const sigma = sigmas[s]!;
    const k = 1 / Math.sqrt(sigma * sigma + 1);
    const scaled = new Float32Array(size);
    for (let i = 0; i < size; i++) scaled[i] = latents[i]! * k;
    const eps = await sd.unet(scaled, timesteps[s]!, hidden.slice());
    // Euler (prediction_type epsilon): x0 = x − σ·ε; next step x = x0 + σ'·ε
    const next = sigmas[s + 1] ?? 0;
    const step = new Float32Array(size);
    for (let i = 0; i < size; i++) step[i] = latents[i]! + (next - sigma) * eps[i]!;
    latents = step;
    post({ type: 'progress', id, done: s + 1, total: steps, elapsed: (performance.now() - started) / 1000 });
  }
  for (let i = 0; i < size; i++) latents[i] = latents[i]! / VAE_SCALE;
  const decoded = await sd.vae.run({ [sd.vae.inputNames[0]!]: new ort.Tensor('float32', latents, [1, 4, SD_LATENT, SD_LATENT]) });
  const rgb = decoded[sd.vae.outputNames[0]!]!.data as Float32Array;
  const side = SD_LATENT * 8;
  const plane = side * side;
  const image = new ImageData(side, side);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) image.data[i * 4 + c] = (rgb[c * plane + i]! / 2 + 0.5) * 255;
    image.data[i * 4 + 3] = 255;
  }
  const canvas = new OffscreenCanvas(side, side);
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  post({ type: 'done', id, blob, width: side, height: side, seconds: (performance.now() - started) / 1000 });
}

self.onmessage = async (e: MessageEvent<ImagingRequest>) => {
  const msg = e.data;
  if (msg.type === 'probe') {
    post({ type: 'probe', probe: await probe() });
  } else if (msg.type === 'sd-status') {
    post({ type: 'sd-status', cached: await sdCached().catch(() => false) });
  } else if (msg.type === 'sd-purge') {
    sdModel = null;
    await caches.delete(SD_CACHE).catch(() => false);
    post({ type: 'sd-status', cached: false });
  } else if (msg.type === 'cancel') {
    cancelledId = msg.id;
  } else {
    try {
      if (msg.type === 'upscale') await upscale(msg);
      else if (msg.type === 'matte') await matte(msg);
      else await txt2img(msg);
    } catch (error) {
      if (error instanceof Cancelled) post({ type: 'cancelled', id: msg.id });
      else post({ type: 'error', id: msg.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
};
