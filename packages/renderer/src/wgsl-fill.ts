/// <reference types="@webgpu/types" />
import type { CanvasKit, Image } from 'canvaskit-wasm';
import type { WgslFill } from '@mfp/core';

/** Output is straight RGBA, matching the authored Figma module. */
export function wgslUniforms(fill: WgslFill, params: Record<string, number[]>, width: number, height: number, time: number): Float32Array {
  const out = new Float32Array(8 + fill.uniforms.length * 4);
  out.set([time, width, height, 0, width, height, 0, 0]);
  fill.uniforms.forEach((p, i) => {
    const values = params[p.name] ?? p.value;
    for (let k = 0; k < (p.kind === 'color' ? 4 : 1); k++) {
      const v = values[k] ?? p.value[k] ?? 0;
      out[8 + i * 4 + k] = Number.isFinite(v) ? v : p.value[k] ?? 0;
    }
  });
  return out;
}

let gpuDevice: Promise<GPUDevice> | undefined;
async function device(): Promise<GPUDevice> {
  if (!gpuDevice) gpuDevice = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('Шейдер Figma требует WebGPU. Проверьте поддержку GPU в браузере или WebView2.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU: совместимый адаптер не найден');
    const d = await adapter.requestDevice();
    void d.lost.then(() => { gpuDevice = undefined; });
    return d;
  })();
  return gpuDevice;
}

interface Entry { image?: Image; revision: number; time?: number; pending?: Promise<void>; error?: string; disposed?: boolean }
export const WGSL_FRAME = 'shader:wgsl-frame';

/** Single-pass fills only: fixed quad, one vec4 uniform buffer, vs_main/fs_main. */
export class WgslFillCache {
  private entries = new Map<string, Entry>();
  private pipelines = new Map<string, Promise<{ device: GPUDevice; pipeline: GPURenderPipeline }>>();
  private disposed = false;
  private revision = 0;
  private ck: CanvasKit;
  private changed: () => void;
  private failed: (message: string) => void;
  constructor(ck: CanvasKit, changed: () => void, failed: (message: string) => void) { this.ck = ck; this.changed = changed; this.failed = failed; }

  get(fill: WgslFill, params: Record<string, number[]>, width: number, height: number, time: number): Entry {
    // Keep logical dimensions in uniforms even when limiting raster allocation.
    const scale = Math.min(1, 2048 / Math.max(width, height), Math.sqrt(2 ** 20 / Math.max(1, width * height)));
    const w = Math.max(1, Math.ceil(width * scale)), h = Math.max(1, Math.ceil(height * scale));
    const key = JSON.stringify([fill, params, width, height]);
    let e = this.entries.get(key);
    if (!e) {
      e = { revision: 0 };
      this.entries.set(key, e);
      if (this.entries.size > 32) {
        const [oldKey, old] = this.entries.entries().next().value!;
        old.disposed = true; old.image?.delete(); this.entries.delete(oldKey);
      }
    }
    const tick = Math.floor(time * 30) / 30;
    if (!e.pending && !e.error && e.time !== tick && !this.disposed) {
      const entry = e;
      entry.pending = this.draw(fill, params, width, height, w, h, tick).then((image) => {
        if (entry.disposed || this.disposed) { image.delete(); return; }
        entry.image?.delete(); entry.image = image; entry.revision = ++this.revision; entry.time = tick;
        this.changed();
      }).catch((error: unknown) => {
        entry.error = error instanceof Error ? error.message : String(error);
        if (!entry.disposed && !this.disposed) this.failed(entry.error);
      }).finally(() => { entry.pending = undefined; });
    }
    return e;
  }

  async ready() {
    await Promise.all([...this.entries.values()].map((e) => e.pending));
    const error = [...this.entries.values()].find((e) => e.error)?.error;
    if (error) throw new Error(error);
  }

  dispose() {
    this.disposed = true;
    for (const e of this.entries.values()) { e.disposed = true; e.image?.delete(); }
    this.entries.clear(); this.pipelines.clear();
  }

  private async pipeline(source: string) {
    let pending = this.pipelines.get(source);
    if (!pending) {
      pending = (async () => {
        const d = await device();
        const module = d.createShaderModule({ code: source });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((m) => m.type === 'error');
        if (errors.length) throw new Error(`WGSL: ${errors.map((m) => m.message).join('\n')}`);
        const pipeline = await d.createRenderPipelineAsync({
          layout: 'auto', vertex: { module, entryPoint: 'vs_main', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, format: 'float32x2', offset: 0 }, { shaderLocation: 1, format: 'float32x2', offset: 8 }] }] },
          fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' },
        });
        return { device: d, pipeline };
      })();
      this.pipelines.set(source, pending);
    }
    return pending;
  }

  private async draw(fill: WgslFill, params: Record<string, number[]>, width: number, height: number, w: number, h: number, time: number): Promise<Image> {
    const { device: d, pipeline } = await this.pipeline(fill.source);
    if (this.disposed) throw new Error('Renderer disposed');
    const data = wgslUniforms(fill, params, width, height, time);
    const uniform = d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const quad = d.createBuffer({ size: 96, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    new Float32Array(quad.getMappedRange()).set([-1,-1,0,1, 1,-1,1,1, -1,1,0,0, -1,1,0,0, 1,-1,1,1, 1,1,1,0]);
    quad.unmap();
    const texture = d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const pitch = Math.ceil(w * 4 / 256) * 256;
    const readback = d.createBuffer({ size: pitch * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      d.queue.writeBuffer(uniform, 0, data.buffer);
      const bindings = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
      const encoder = d.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] });
      pass.setPipeline(pipeline); pass.setBindGroup(0, bindings); pass.setVertexBuffer(0, quad); pass.draw(6); pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: pitch, rowsPerImage: h }, [w, h]);
      d.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(readback.getMappedRange());
      const pixels = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) pixels.set(mapped.subarray(y * pitch, y * pitch + w * 4), y * w * 4);
      const image = this.ck.MakeImage({ width: w, height: h, colorType: this.ck.ColorType.RGBA_8888, alphaType: this.ck.AlphaType.Unpremul, colorSpace: this.ck.ColorSpace.SRGB }, pixels, w * 4);
      if (!image) throw new Error('Не удалось создать изображение WGSL');
      return image;
    } finally { readback.destroy(); texture.destroy(); quad.destroy(); uniform.destroy(); }
  }
}
