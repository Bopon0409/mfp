// SD-Turbo UNet in a separate worker: each ONNX Runtime instance has its own WebAssembly memory (up to 4 GB),
// and the UNet (1.73 GB, twice that while parsing) does not fit into one together with the text encoder.

import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;

export type UnetRequest =
  | { type: 'load'; bytes: Uint8Array; latent: number }
  | { type: 'run'; id: number; sample: Float32Array; timestep: number; hidden: Float32Array; latent: number };

export type UnetEvent = { type: 'loaded' } | { type: 'eps'; id: number; eps: Float32Array } | { type: 'error'; id: number; message: string };

let session: ort.InferenceSession | null = null;

self.onmessage = async (e: MessageEvent<UnetRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      session = await ort.InferenceSession.create(msg.bytes, {
        executionProviders: ['webgpu'],
        // The graph optimizer folds constants into fp32 copies of the weights, and then the UNet does not fit into 4 GB
        graphOptimizationLevel: 'disabled',
        enableMemPattern: false,
        enableCpuMemArena: false,
        freeDimensionOverrides: { batch_size: 1, num_channels: 4, height: msg.latent, width: msg.latent, sequence_length: 77, steps: 1 },
        extra: { session: { disable_prepacking: '1', use_device_allocator_for_initializers: '1', use_ort_model_bytes_directly: '1', use_ort_model_bytes_for_initializers: '1' } },
      });
      postMessage({ type: 'loaded' } satisfies UnetEvent);
      return;
    }
    if (!session) throw new Error('UNet не загружен');
    const out = await session.run({
      sample: new ort.Tensor('float32', msg.sample, [1, 4, msg.latent, msg.latent]),
      timestep: new ort.Tensor('int64', BigInt64Array.from([BigInt(msg.timestep)]), [1]),
      encoder_hidden_states: new ort.Tensor('float32', msg.hidden, [1, 77, msg.hidden.length / 77]),
    });
    const eps = (out[session.outputNames[0]!]!.data as Float32Array).slice();
    postMessage({ type: 'eps', id: msg.id, eps } satisfies UnetEvent, { transfer: [eps.buffer] });
  } catch (error) {
    postMessage({ type: 'error', id: msg.type === 'run' ? msg.id : -1, message: error instanceof Error ? error.message : String(error) } satisfies UnetEvent);
  }
};
