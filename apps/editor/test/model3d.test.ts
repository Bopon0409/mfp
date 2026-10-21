import { describe, expect, it } from 'vitest';
import { isModelBytes } from '../src/model3d.ts';

const text = (s: string) => new TextEncoder().encode(s);

describe('3D model files', () => {
  it('GLB by header, glTF — JSON with asset.version 2; nothing else', () => {
    expect(isModelBytes(Uint8Array.of(0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0))).toBe(true);
    expect(isModelBytes(text('  {"asset":{"version":"2.0"},"scenes":[]}'))).toBe(true);
    expect(isModelBytes(text('{"asset":{"version":"1.0"}}'))).toBe(false);
    expect(isModelBytes(text('{"v":"5.7.4","layers":[]}'))).toBe(false);
    expect(isModelBytes(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBe(false);
  });
});
