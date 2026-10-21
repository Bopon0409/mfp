// The plugin sandbox as shipped: without comments (tools/strip-comments.ts). The vitest project
// “plugin-host-built” runs all plugin tests with the processed sandbox (MFP_SHIM_BUILT).
import { describe, expect, it } from 'vitest';
import { compactCode } from '../../../tools/strip-comments.ts';
import { FIGMA_SHIM } from '../src/index.ts';

const comments = (code: string) => code.split('\n').filter((l) => /^\s*\/\//.test(l)).length;

describe('plugin sandbox in the build', () => {
  it('without comments and duplicated code', () => {
    const built = process.env.MFP_SHIM_BUILT ? FIGMA_SHIM : compactCode(FIGMA_SHIM);
    expect(comments(built)).toBe(0);
    expect(built).not.toMatch(/как в Figma|API виджетов Figma/);
    expect(built).toContain('globalThis.__mfp_call');
    expect(() => new Function(built)).not.toThrow();
    if (!process.env.MFP_SHIM_BUILT) expect(comments(FIGMA_SHIM)).toBeGreaterThan(10);
  });
});
