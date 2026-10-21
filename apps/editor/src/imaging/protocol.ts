// Messages between the “Image enhancements” page and the worker that computes on the GPU.

export interface GpuProbe {
  ok: boolean;
  /** GPU (vendor/architecture) or the reason WebGPU is unavailable. */
  text: string;
  f16: boolean;
}

export type ImagingRequest =
  | { type: 'probe' }
  | { type: 'upscale'; id: number; bitmap: ImageBitmap; modelUrl: string; tile: number; scale: number; previewWidth: number }
  | { type: 'matte'; id: number; bitmap: ImageBitmap; modelUrl: string; cache: string; sha256: string; trim: boolean }
  | { type: 'txt2img'; id: number; prompt: string; steps: number; seed: number }
  | { type: 'sd-status' }
  | { type: 'sd-purge' }
  | { type: 'cancel'; id: number };

export type ImagingEvent =
  | { type: 'probe'; probe: GpuProbe }
  | { type: 'sd-status'; cached: boolean }
  | { type: 'stage'; id: number; text: string; fraction?: number }
  | { type: 'progress'; id: number; done: number; total: number; elapsed: number }
  | { type: 'rows'; id: number; top: number; height: number; bitmap: ImageBitmap }
  | { type: 'done'; id: number; blob: Blob; width: number; height: number; seconds: number }
  | { type: 'cancelled'; id: number }
  | { type: 'error'; id: number; message: string };
