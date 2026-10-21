import { describe, expect, it } from 'vitest';
import { av1Config, decoderCodec, stripTemporalDelimiters, targetSize } from '../src/imaging/video/codecs.ts';
import { bytesSource, readMp4 } from '../src/imaging/video/mp4-read.ts';
import { MemorySink, Mp4Writer, timing, visualEntry } from '../src/imaging/video/mp4-write.ts';

const AVCC = Uint8Array.of(1, 0x64, 0x00, 0x33, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x33, 1, 0, 2, 0x68, 0xee);
const AUDIO_ENTRY = Uint8Array.of(0, 0, 0, 16, ...[...'mp4a'].map((c) => c.charCodeAt(0)), 1, 2, 3, 4, 5, 6, 7, 8);

async function sample() {
  const sink = new MemorySink();
  const matrix = new Uint8Array(36);
  new DataView(matrix.buffer).setInt32(4, 0x10000); // b = 1: 90° rotation
  new DataView(matrix.buffer).setInt32(12, -0x10000);
  new DataView(matrix.buffer).setInt32(32, 0x40000000);
  const writer = new Mp4Writer(sink, [
    { kind: 'video', timescale: 30000, entry: visualEntry('avc1', 3840, 2160, AVCC), width: 3840, height: 2160, matrix },
    { kind: 'audio', timescale: 48000, entry: AUDIO_ENTRY, language: 0x2a0e },
  ]);
  await writer.start();
  // Audio with “priming” (time before zero) and video — interleaved
  await writer.add(1, Uint8Array.of(9, 9), -1024, true, 1024);
  for (let i = 0; i < 4; i++) {
    await writer.add(0, Uint8Array.of(i, i, i), i * 1001, i === 0, 1001);
    await writer.add(1, Uint8Array.of(8, i), i * 1024, true, 1024);
  }
  await writer.finish();
  return new Uint8Array(await sink.blob().arrayBuffer());
}

describe('MP4 for video upscaling', () => {
  it('written data reads back: tracks, samples, edits, rotation', async () => {
    const bytes = await sample();
    const mp4 = await readMp4(bytesSource(bytes));
    expect(mp4.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
    const [video, audio] = mp4.tracks as [NonNullable<(typeof mp4.tracks)[0]>, NonNullable<(typeof mp4.tracks)[0]>];
    expect(video.format).toBe('avc1');
    expect([video.width, video.height]).toEqual([3840, 2160]);
    expect(video.config).toEqual(AVCC);
    expect(video.timescale).toBe(30000);
    expect(video.samples.map((s) => s.cts)).toEqual([0, 1001, 2002, 3003]);
    expect(video.samples.map((s) => s.key)).toEqual([true, false, false, false]);
    expect(video.samples.map((s) => [...bytes.slice(s.offset, s.offset + s.size)])).toEqual([0, 1, 2, 3].map((i) => [i, i, i]));
    expect(new DataView(video.matrix.buffer, video.matrix.byteOffset).getInt32(4)).toBe(0x10000);
    expect(audio.format).toBe('mp4a');
    expect(audio.entry).toEqual(AUDIO_ENTRY);
    expect(audio.language).toBe(0x2a0e);
    expect(audio.editStart).toBe(1024);
    expect(audio.samples).toHaveLength(5);
    expect([...bytes.slice(audio.samples[0]!.offset, audio.samples[0]!.offset + 2)]).toEqual([9, 9]);
    // mdat — with a 64-bit size appended at the end
    const dv = new DataView(bytes.buffer);
    const ftyp = dv.getUint32(0);
    expect(dv.getUint32(ftyp)).toBe(1);
    expect(String.fromCharCode(...bytes.slice(ftyp + 4, ftyp + 8))).toBe('mdat');
    const mdatSize = Number(dv.getBigUint64(ftyp + 8));
    expect(String.fromCharCode(...bytes.slice(ftyp + mdatSize + 4, ftyp + mdatSize + 8))).toBe('moov');
  });

  it('decode order and composition offsets are restored from timestamps (B-frames)', () => {
    // Decode order: I0 P3 B1 B2 — presentation times 0, 3, 1, 2
    const t = timing([0, 3, 1, 2].map((v) => ({ time: v * 10, duration: 10 })));
    expect(t.deltas).toEqual([10, 10, 10, 10]);
    expect(t.offsets).toEqual([10, 30, 0, 0]);
    expect(t.mediaStart).toBe(10);
    expect(t.empty).toBe(0);
    expect(t.shown).toBe(40);
  });

  it('an empty edit if the track starts after zero', () => {
    const t = timing([5, 6].map((v) => ({ time: v * 10, duration: 10 })));
    expect(t.empty).toBe(50);
    expect(t.mediaStart).toBe(0);
    expect(t.shown).toBe(20);
  });

  it('source codec strings', () => {
    expect(decoderCodec({ format: 'avc1', config: AVCC })).toBe('avc1.640033');
    // HEVC Main, level 5.1 (153), compatibility flags 0x60000000, constraints B0
    const hvcC = Uint8Array.of(1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 153);
    expect(decoderCodec({ format: 'hvc1', config: hvcC })).toBe('hvc1.1.6.L153.B0');
    expect(decoderCodec({ format: 'av01', config: Uint8Array.of(0x81, 0x0c, 0x0c, 0) })).toBe('av01.0.12M.08');
    expect(decoderCodec({ format: 'av01', config: Uint8Array.of(0x81, 0x10, 0x4c, 0) })).toBe('av01.0.16M.10');
    expect(decoderCodec({ format: 'vp09', config: Uint8Array.of(1, 0, 0, 0, 0, 40, 0x80) })).toBe('vp09.00.40.08');
    expect(decoderCodec({ format: 'mp4v', config: Uint8Array.of(1) })).toBeNull();
  });

  it('AV1: av1C from the codec string and sequence header, without temporal delimiters', () => {
    const td = [0x12, 0x00];
    const seq = [0x0a, 0x03, 0xaa, 0xbb, 0xcc];
    const frame = [0x32, 0x02, 0x01, 0x02];
    const chunk = Uint8Array.from([...td, ...seq, ...frame]);
    expect([...stripTemporalDelimiters(chunk)]).toEqual([...seq, ...frame]);
    const config = av1Config('av01.0.16M.08', chunk);
    expect([...config]).toEqual([0x81, 0x10, 0x0c, 0, ...seq]);
  });

  it('output size is even, by the long side or by a factor', () => {
    expect(targetSize(1920, 1080, { long: 3840 })).toEqual({ width: 3840, height: 2160 });
    expect(targetSize(1080, 1920, { long: 7680 })).toEqual({ width: 4320, height: 7680 });
    expect(targetSize(1440, 1080, { long: 3840 })).toEqual({ width: 3840, height: 2880 });
    expect(targetSize(853, 480, { factor: 4 })).toEqual({ width: 3412, height: 1920 });
    expect(targetSize(1000, 562, { long: 3840 })).toEqual({ width: 3840, height: 2158 });
  });
});
