// Video upscaling on the user's GPU: the browser decodes frames (WebCodecs), each frame is
// upscaled by Real-ESRGAN (ONNX via WebGPU, tiles with overlapping margins, in strips as for images),
// VideoEncoder compresses the result and it is written as a streaming MP4; audio is copied as is, without re-encoding.

import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { CODEC_NAMES, av1Config, decoderCodec, decoderDescription, pickEncoder, stripTemporalDelimiters } from './codecs.ts';
import { blobSource, readMp4, type Mp4Source, type Mp4Track } from './mp4-read.ts';
import { FileSink, MemorySink, Mp4Writer, visualEntry, type Mp4Sink, type TrackSpec } from './mp4-write.ts';
import type { VideoEvent, VideoInfo, VideoJob, VideoRequest } from './protocol.ts';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;

const MODEL_SCALE = 4;
const PAD = 16;
// Decoded frames in the queue: more is wasted memory (a 4K frame is 33 MB)
const QUEUE = 3;

class Cancelled extends Error {}

const post = (event: VideoEvent, transfer: Transferable[] = []) => postMessage(event, { transfer });

let source: { src: Mp4Source; video: Mp4Track; audio: Mp4Track | null; info: VideoInfo } | null = null;
let cancelled = false;
let busy = false;
const sessions = new Map<string, Promise<ort.InferenceSession>>();

const check = () => {
  if (cancelled) throw new Cancelled();
};

const rotationOf = (m: Uint8Array) => {
  if (m.length < 36) return 0;
  const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const deg = Math.round((Math.atan2(dv.getInt32(4), dv.getInt32(0)) * 180) / Math.PI);
  return (deg + 360) % 360;
};

async function open(file: File) {
  const src = blobSource(file);
  const mp4 = await readMp4(src);
  const video = mp4.tracks.find((t) => t.kind === 'video' && t.samples.length);
  if (!video) throw new Error('В файле нет видеодорожки');
  const codec = decoderCodec(video);
  if (!codec) throw new Error(`Сжатие «${video.format}» не поддерживается — нужны H.264, HEVC, AV1 или VP9`);
  const support = await VideoDecoder.isConfigSupported({ codec, codedWidth: video.width, codedHeight: video.height, description: decoderDescription(video) }).catch(() => null);
  if (!support?.supported) throw new Error(`Браузер не умеет распаковывать ${codec} — попробуйте приложение MFP или другой браузер`);
  const audio = mp4.tracks.find((t) => t.kind === 'audio' && t.samples.length && t.entry.length) ?? null;
  const ticks = video.samples.reduce((s, x) => s + x.duration, 0);
  const seconds = ticks / video.timescale;
  const info: VideoInfo = {
    width: video.width,
    height: video.height,
    fps: seconds > 0 ? video.samples.length / seconds : 30,
    frames: video.samples.length,
    seconds,
    codec,
    audio: audio ? audio.format : null,
    rotation: rotationOf(video.matrix),
  };
  source = { src, video, audio, info };
  post({ type: 'info', info });
}

async function loadModel(url: string): Promise<ort.InferenceSession> {
  let session = sessions.get(url);
  if (!session) {
    session = (async () => {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`Модель не загрузилась: ${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        post({ type: 'stage', text: 'Загружаю модель…', fraction: total ? loaded / total : undefined });
      }
      const bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      post({ type: 'stage', text: 'Готовлю видеокарту…' });
      return ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
    })();
    sessions.set(url, session);
    session.catch(() => sessions.delete(url));
  }
  return session;
}

interface Decoded {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  /** Presentation time from the movie start, in track units. */
  time: number;
  duration: number;
}

/** Frames with presentation time in [from, to): decode from the nearest keyframe, the queue does not build up. */
async function* frames(src: Mp4Source, track: Mp4Track, from: number, to: number, w: number, h: number): AsyncGenerator<Decoded> {
  const samples = track.samples;
  const timeOf = (i: number) => samples[i]!.cts - track.editStart;
  let first = samples.findIndex((_, i) => timeOf(i) >= from);
  if (first < 0) return;
  while (first > 0 && !samples[first]!.key) first--;
  const us = (ticks: number) => Math.round((ticks * 1e6) / track.timescale);
  const byUs = new Map<number, { time: number; duration: number }>();
  const queue: Decoded[] = [];
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const signal = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const wait = () => new Promise<void>((r) => (wake = r));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const meta = byUs.get(frame.timestamp);
      const time = meta?.time ?? Math.round((frame.timestamp * track.timescale) / 1e6);
      if (time >= from && time < to) {
        ctx.drawImage(frame, 0, 0, w, h);
        queue.push({ pixels: ctx.getImageData(0, 0, w, h).data, time, duration: meta?.duration ?? 0 });
      }
      frame.close();
      signal();
    },
    error: (e) => {
      failure = e;
      signal();
    },
  });
  decoder.addEventListener('dequeue', signal);
  const fail = () => {
    if (failure) throw failure instanceof Error ? new Error(`Ошибка распаковки видео: ${failure.message}`) : new Error(String(failure));
  };
  try {
    decoder.configure({ codec: decoderCodec(track)!, codedWidth: track.width, codedHeight: track.height, description: decoderDescription(track) });
    for (let i = first; i < samples.length; i++) {
      const s = samples[i]!;
      // Decode time is not greater than presentation time: no more frames from the range beyond this point
      if (s.dts - track.editStart >= to) break;
      while (queue.length >= QUEUE || decoder.decodeQueueSize > 4) {
        if (queue.length) yield queue.shift()!;
        else await wait();
        check();
        fail();
      }
      const data = await src.read(s.offset, s.size);
      const t = timeOf(i);
      byUs.set(us(t), { time: t, duration: s.duration });
      decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: us(t), duration: us(s.duration), data }));
    }
    const flushed = decoder.flush();
    let done = false;
    void flushed.then(
      () => ((done = true), signal()),
      (e) => ((failure ??= e), signal()),
    );
    while (!done || queue.length) {
      fail();
      if (queue.length) yield queue.shift()!;
      else await wait();
      check();
    }
    fail();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
}

/** Frame at output size: model tiles ×4 in strips, each strip drawn straight into the final canvas. */
class FrameUpscaler {
  readonly out: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly band: ImageData;
  private readonly bandCanvas: OffscreenCanvas;
  private readonly bandCtx: OffscreenCanvasRenderingContext2D;
  private readonly cols: Int32Array;
  private readonly xs: number[];
  private readonly ys: number[];
  private readonly tw: number;
  private readonly th: number;
  private readonly iw: number;
  private readonly ih: number;
  private readonly session: ort.InferenceSession;
  private readonly w: number;
  private readonly h: number;

  constructor(session: ort.InferenceSession, w: number, h: number, tile: number, W: number, H: number) {
    this.session = session;
    this.w = w;
    this.h = h;
    this.tw = Math.min(tile, w);
    this.th = Math.min(tile, h);
    this.iw = this.tw + 2 * PAD;
    this.ih = this.th + 2 * PAD;
    this.xs = positions(w, this.tw);
    this.ys = positions(h, this.th);
    this.cols = new Int32Array(this.iw);
    this.band = new ImageData(w * MODEL_SCALE, this.ih * MODEL_SCALE);
    this.bandCanvas = new OffscreenCanvas(this.band.width, this.band.height);
    this.bandCtx = this.bandCanvas.getContext('2d')!;
    this.out = new OffscreenCanvas(W, H);
    this.ctx = this.out.getContext('2d')!;
    this.ctx.imageSmoothingQuality = 'high';
  }

  get tiles() {
    return this.xs.length * this.ys.length;
  }

  async run(src: Uint8ClampedArray) {
    const { w, h, tw, th, iw, ih, band } = this;
    const bandW = band.width;
    const tileW = iw * MODEL_SCALE;
    const tileH = ih * MODEL_SCALE;
    const cropX = PAD * MODEL_SCALE;
    const keepW = tw * MODEL_SCALE;
    const fy = this.out.height / h;
    for (const y0 of this.ys) {
      for (const x0 of this.xs) {
        check();
        const input = new ort.Tensor('float32', this.tileInput(src, x0 - PAD, y0 - PAD), [1, 3, ih, iw]);
        const result = await this.session.run({ [this.session.inputNames[0]!]: input });
        const output = result[this.session.outputNames[0]!]!;
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
      }
      // The strip includes its margin so smoothing at the seam uses real neighbors; only its own part is drawn
      this.bandCtx.putImageData(band, 0, 0);
      const top = Math.round(y0 * fy);
      const bottom = Math.round((y0 + th) * fy);
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(0, top, this.out.width, bottom - top);
      this.ctx.clip();
      this.ctx.drawImage(this.bandCanvas, 0, (y0 - PAD) * fy, this.out.width, ih * fy);
      this.ctx.restore();
    }
    return this.out;
  }

  private tileInput(src: Uint8ClampedArray, x: number, y: number): Float32Array {
    const { w, h, iw, ih, cols } = this;
    const plane = iw * ih;
    const out = new Float32Array(plane * 3);
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
}

const reflect = (i: number, n: number) => {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * (n - 1) - i;
  return i;
};

const positions = (size: number, tile: number) => {
  const out: number[] = [];
  for (let p = 0; p < size - tile; p += tile) out.push(p);
  out.push(size - tile);
  return out;
};

const bitmapOf = (image: ImageData | OffscreenCanvas, width: number) => {
  const k = Math.min(1, width / image.width);
  return createImageBitmap(image, { resizeWidth: Math.max(1, Math.round(image.width * k)), resizeHeight: Math.max(1, Math.round(image.height * k)), resizeQuality: 'high' });
};

async function prepare(job: VideoJob) {
  if (!source) throw new Error('Видео не открыто');
  const session = await loadModel(job.modelUrl);
  check();
  const { video } = source;
  return { ...source, upscaler: new FrameUpscaler(session, video.width, video.height, job.tile, job.width, job.height) };
}

/** Preview frame: the one nearest to the time, before and after, and how many seconds it took. */
async function probeFrame(job: VideoJob, time: number, previewWidth: number) {
  const { src, video, upscaler } = await prepare(job);
  post({ type: 'stage', text: 'Увеличиваю кадр…' });
  const from = Math.max(0, Math.round(time * video.timescale));
  for await (const f of frames(src, video, from, Infinity, video.width, video.height)) {
    const started = performance.now();
    const out = await upscaler.run(f.pixels);
    const seconds = (performance.now() - started) / 1000;
    const before = await bitmapOf(new ImageData(f.pixels, video.width, video.height), previewWidth);
    const after = await bitmapOf(out, previewWidth);
    post({ type: 'preview', before, after, seconds }, [before, after]);
    return;
  }
  throw new Error('В этом месте видео нет кадров');
}

async function encode(job: VideoJob, handle: FileSystemFileHandle | null, previewWidth: number) {
  const { src, video, audio, info, upscaler } = await prepare(job);
  const started = performance.now();
  const to = job.limit ? Math.round(job.limit * video.timescale) : Infinity;
  const total = video.samples.filter((s) => s.cts - video.editStart >= 0 && s.cts - video.editStart < to).length;

  const choice = await pickEncoder(job.width, job.height, info.fps, job.codec);
  if (!choice) throw new Error(job.codec === 'auto' ? `Браузер не умеет сжимать видео ${job.width}×${job.height}` : `${CODEC_NAMES[job.codec]} ${job.width}×${job.height} здесь недоступен — выберите «Авто»`);
  post({ type: 'encoder', text: `${CODEC_NAMES[choice.kind]} · ${Math.round((choice.config.bitrate ?? 0) / 1e6)} Мбит/с${choice.hardware ? '' : ' · программно'}` });

  const sink: Mp4Sink = handle ? new FileSink(await handle.createWritable()) : new MemorySink();
  const videoSpec: TrackSpec = { kind: 'video', timescale: video.timescale, entry: new Uint8Array(0), width: job.width, height: job.height, matrix: video.matrix };
  const tracks: TrackSpec[] = [videoSpec];
  if (audio) tracks.push({ kind: 'audio', timescale: audio.timescale, entry: audio.entry, language: audio.language });
  const writer = new Mp4Writer(sink, tracks);
  await writer.start();

  // Audio is interleaved with video by time so the file plays from any position
  let ai = 0;
  const audioUntil = async (seconds: number) => {
    if (!audio) return;
    while (ai < audio.samples.length) {
      const s = audio.samples[ai]!;
      const time = s.dts - audio.editStart;
      if (time / audio.timescale > seconds || time >= (to === Infinity ? Infinity : (to / video.timescale) * audio.timescale)) break;
      await writer.add(1, await src.read(s.offset, s.size), time, s.key, s.duration);
      ai++;
    }
  };

  const ticksByUs = new Map<number, { time: number; duration: number }>();
  let description: Uint8Array | null = null;
  let firstKey: Uint8Array | null = null;
  let chain = Promise.resolve();
  let failure: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      let data: Uint8Array = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (choice.kind === 'av1') data = stripTemporalDelimiters(data);
      const d = meta?.decoderConfig?.description;
      if (d && !description) description = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice();
      if (chunk.type === 'key' && !firstKey) firstKey = data;
      const t = ticksByUs.get(chunk.timestamp) ?? { time: Math.round((chunk.timestamp * video.timescale) / 1e6), duration: 0 };
      const key = chunk.type === 'key';
      chain = chain.then(async () => {
        await audioUntil(t.time / video.timescale);
        await writer.add(0, data, t.time, key, t.duration);
      });
      chain.catch((e) => (failure ??= e));
    },
    error: (e) => (failure ??= e),
  });
  encoder.configure(choice.config);
  const fail = () => {
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  };

  const gop = Math.max(1, Math.round(info.fps * 2));
  let done = 0;
  let lastPreview = 0;
  try {
    for await (const f of frames(src, video, 0, to, video.width, video.height)) {
      fail();
      const out = await upscaler.run(f.pixels);
      const us = Math.round((f.time * 1e6) / video.timescale);
      ticksByUs.set(us, { time: f.time, duration: f.duration });
      const frame = new VideoFrame(out, { timestamp: us, duration: Math.round((f.duration * 1e6) / video.timescale) || undefined });
      encoder.encode(frame, { keyFrame: done % gop === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 2) await new Promise((r) => setTimeout(r, 5));
      done++;
      const now = performance.now();
      post({ type: 'progress', done, total, elapsed: (now - started) / 1000, bytes: writer.bytes });
      if (now - lastPreview > 2000) {
        lastPreview = now;
        const before = await bitmapOf(new ImageData(f.pixels, video.width, video.height), previewWidth);
        const after = await bitmapOf(out, previewWidth);
        post({ type: 'preview', before, after, seconds: 0 }, [before, after]);
      }
    }
    post({ type: 'stage', text: 'Дописываю файл…' });
    await encoder.flush();
    await chain;
    fail();
    await audioUntil(Infinity);
    if (!description || (choice.kind === 'av1' && description[0] !== 0x81)) {
      if (choice.kind !== 'av1' || !firstKey) throw new Error('Кодировщик не отдал описание потока');
      description = av1Config(choice.config.codec, firstKey);
    }
    videoSpec.entry = visualEntry(choice.kind === 'h264' ? 'avc1' : choice.kind === 'hevc' ? 'hvc1' : 'av01', job.width, job.height, description);
    await writer.finish();
    const blob = sink instanceof MemorySink ? sink.blob() : null;
    post({ type: 'done', blob, bytes: writer.bytes, frames: done, seconds: (performance.now() - started) / 1000, codec: CODEC_NAMES[choice.kind] });
  } catch (error) {
    if (encoder.state !== 'closed') encoder.close();
    if (sink instanceof FileSink) await sink.abort().catch(() => {});
    throw error;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}

self.onmessage = async (e: MessageEvent<VideoRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    if (busy) cancelled = true;
    return;
  }
  if (busy) return post({ type: 'error', message: 'Уже идёт обработка' });
  busy = true;
  cancelled = false;
  try {
    if (msg.type === 'open') await open(msg.file);
    else if (msg.type === 'frame') await probeFrame(msg.job, msg.time, msg.previewWidth);
    else await encode(msg.job, msg.handle, msg.previewWidth);
  } catch (error) {
    if (error instanceof Cancelled) post({ type: 'cancelled' });
    else post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    busy = false;
  }
};
