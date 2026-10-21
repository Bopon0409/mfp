// Codecs for video upscaling: the source codec string for VideoDecoder (from avcC / hvcC / av1C / vpcC),
// choice of output compression (H.264 up to 4K, HEVC and AV1 also for 8K), bitrate, AV1 description for MP4.

import type { Mp4Track } from './mp4-read.ts';

const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const dec2 = (v: number) => String(v).padStart(2, '0');

/** Track codec string for VideoDecoder, or null if the format is not supported. */
export function decoderCodec(track: Pick<Mp4Track, 'format' | 'config'>): string | null {
  const c = track.config;
  if (!c) return null;
  switch (track.format) {
    case 'avc1':
    case 'avc3':
      return `${track.format}.${hex2(c[1]!)}${hex2(c[2]!)}${hex2(c[3]!)}`;
    case 'hvc1':
    case 'hev1': {
      const space = c[1]! >> 6;
      const tier = (c[1]! >> 5) & 1;
      const profile = c[1]! & 31;
      let compat = ((c[2]! << 24) | (c[3]! << 16) | (c[4]! << 8) | c[5]!) >>> 0;
      // Compatibility flags are written in reversed bit order
      let reversed = 0;
      for (let i = 0; i < 32; i++) {
        reversed = ((reversed << 1) | (compat & 1)) >>> 0;
        compat >>>= 1;
      }
      const constraints = [...c.slice(6, 12)];
      while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
      const tail = constraints.map((b) => `.${b.toString(16).toUpperCase()}`).join('');
      return `${track.format}.${['', 'A', 'B', 'C'][space]}${profile}.${reversed.toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${c[12]}${tail}`;
    }
    case 'av01': {
      const profile = c[1]! >> 5;
      const level = c[1]! & 31;
      const tier = c[2]! >> 7;
      const high = (c[2]! >> 6) & 1;
      const twelve = (c[2]! >> 5) & 1;
      return `av01.${profile}.${dec2(level)}${tier ? 'H' : 'M'}.${dec2(high ? (twelve ? 12 : 10) : 8)}`;
    }
    case 'vp09':
      // vpcC is a full box: version and flags, then profile, level, bit depth
      return `vp09.${dec2(c[4]!)}.${dec2(c[5]!)}.${dec2(c[6]! >> 4)}`;
    default:
      return null;
  }
}

/** Stream description for VideoDecoder: required for avcC and hvcC, not needed for AV1 and VP9. */
export const decoderDescription = (track: Pick<Mp4Track, 'format' | 'config'>) =>
  track.config && /^(avc|hvc|hev)/.test(track.format) ? track.config : undefined;

export type OutCodec = 'h264' | 'hevc' | 'av1';

export const CODEC_NAMES: Record<OutCodec, string> = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' };

// Levels in ascending order: 4K 30 fps, 4K 60, 8K 30, 8K 60, 8K 120. Players look at the level,
// so the search starts from the one required by the size and frame rate
const CANDIDATES: Record<OutCodec, string[]> = {
  h264: ['avc1.640033', 'avc1.640034', 'avc1.64003c', 'avc1.64003d', 'avc1.64003e'],
  hevc: ['hvc1.1.6.L150.B0', 'hvc1.1.6.L153.B0', 'hvc1.1.6.L180.B0', 'hvc1.1.6.L183.B0', 'hvc1.1.6.L186.B0'],
  av1: ['av01.0.12M.08', 'av01.0.13M.08', 'av01.0.16M.08', 'av01.0.17M.08', 'av01.0.18M.08'],
};

// Bits per frame pixel: upscaled video is finely detailed, hence the headroom
const BITS_PER_PIXEL: Record<OutCodec, number> = { h264: 0.15, hevc: 0.09, av1: 0.07 };

export const bitrateFor = (codec: OutCodec, width: number, height: number, fps: number) =>
  Math.round(Math.min(400e6, width * height * Math.max(1, Math.min(fps, 120)) * BITS_PER_PIXEL[codec]));

type HardwarePreference = NonNullable<VideoEncoderConfig['hardwareAcceleration']>;

/** Which level to start from: 8K from the third, above 30 fps one step higher. */
export const levelIndex = (width: number, height: number, fps: number) => (width * height > 4096 * 2304 ? 2 : 0) + (fps > 31 ? 1 : 0);

export interface EncoderChoice {
  kind: OutCodec;
  config: VideoEncoderConfig;
  hardware: boolean;
}

const encoderConfig = (kind: OutCodec, codec: string, width: number, height: number, fps: number, hardwareAcceleration: HardwarePreference): VideoEncoderConfig => {
  const config: VideoEncoderConfig & { hevc?: { format: string } } = {
    codec,
    width,
    height,
    bitrate: bitrateFor(kind, width, height, fps),
    framerate: fps,
    latencyMode: 'quality',
    hardwareAcceleration,
  };
  if (kind === 'h264') config.avc = { format: 'avc' };
  if (kind === 'hevc') config.hevc = { format: 'hevc' };
  return config;
};

/**
 * Output compression. “Auto”: up to 4K, H.264 (plays everywhere); above that, whatever the GPU has
 * (HEVC or AV1), otherwise software AV1. Hardware first, then anything.
 */
export async function pickEncoder(width: number, height: number, fps: number, prefer: OutCodec | 'auto'): Promise<EncoderChoice | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const order: OutCodec[] = prefer !== 'auto' ? [prefer] : width * height <= 4096 * 2304 ? ['h264', 'hevc', 'av1'] : ['hevc', 'av1', 'h264'];
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as HardwarePreference[]) {
    for (const kind of order) {
      for (const codec of CANDIDATES[kind].slice(levelIndex(width, height, fps))) {
        const config = encoderConfig(kind, codec, width, height, fps, hardwareAcceleration);
        const s = await VideoEncoder.isConfigSupported(config).catch(() => null);
        if (s?.supported) return { kind, config, hardware: hardwareAcceleration === 'prefer-hardware' };
      }
    }
  }
  return null;
}

// ---------- AV1 in MP4 ----------

const OBU_SEQUENCE_HEADER = 1;
const OBU_TEMPORAL_DELIMITER = 2;

interface Obu {
  type: number;
  start: number;
  end: number;
}

function* obus(data: Uint8Array): Generator<Obu> {
  let o = 0;
  while (o < data.length) {
    const start = o;
    const header = data[o++]!;
    const type = (header >> 3) & 15;
    if (header & 4) o++;
    let size = data.length - o;
    if (header & 2) {
      size = 0;
      for (let i = 0; i < 8; i++) {
        const b = data[o++]!;
        size += (b & 0x7f) * 2 ** (7 * i);
        if (!(b & 0x80)) break;
      }
    }
    o += size;
    if (o > data.length) return;
    yield { type, start, end: o };
  }
}

/** Without frame separators (temporal delimiters): MP4 must not contain them. */
export function stripTemporalDelimiters(data: Uint8Array): Uint8Array {
  const keep = [...obus(data)].filter((u) => u.type !== OBU_TEMPORAL_DELIMITER);
  const size = keep.reduce((s, u) => s + u.end - u.start, 0);
  if (size === data.length) return data;
  const out = new Uint8Array(size);
  let o = 0;
  for (const u of keep) {
    out.set(data.subarray(u.start, u.end), o);
    o += u.end - u.start;
  }
  return out;
}

/** av1C from the codec string and the sequence header of the first keyframe. */
export function av1Config(codec: string, keyFrame: Uint8Array): Uint8Array {
  const m = /^av01\.(\d)\.(\d\d)([MH])\.(\d\d)/.exec(codec);
  const profile = m ? Number(m[1]) : 0;
  const level = m ? Number(m[2]) : 8;
  const tier = m?.[3] === 'H' ? 1 : 0;
  const depth = m ? Number(m[4]) : 8;
  const seq = [...obus(keyFrame)].find((u) => u.type === OBU_SEQUENCE_HEADER);
  const head = Uint8Array.of(
    0x81,
    (profile << 5) | level,
    // tier, high_bitdepth, twelve_bit, monochrome, subsampling x/y (4:2:0), chroma sample position
    (tier << 7) | ((depth > 8 ? 1 : 0) << 6) | ((depth === 12 ? 1 : 0) << 5) | (profile === 1 ? 0 : 0b11 << 2),
    0,
  );
  if (!seq) return head;
  const out = new Uint8Array(4 + seq.end - seq.start);
  out.set(head);
  out.set(keyFrame.subarray(seq.start, seq.end), 4);
  return out;
}

/** Output size: by the long side (4K is 3840, 8K is 7680) or by a factor; always even. */
export function targetSize(width: number, height: number, target: { long: number } | { factor: number }): { width: number; height: number } {
  const k = 'long' in target ? target.long / Math.max(width, height) : target.factor;
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(width * k), height: even(height * k) };
}
