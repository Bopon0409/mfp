import { beforeAll, expect, it } from 'vitest';
import { Document, type ShaderPaint } from '@mfp/core';
import { registerFigmaShader, resolveFigmaShader, readMfp, writeMfp, MemorySource } from '../src/index.ts';
import { GLOW } from './fixtures/glow.ts';
import { toFigPaint } from '@mfp/renderer';

const source = (): ShaderPaint => ({ type: 'SHADER', code: '', opacity: 0.4, figma: {
  reference: { assetRef: { key: 'original', version: 'edb22f7683d1fb52fcb5a703303c2cbc711ae338' } },
  definition: {
    customToolArtifactRef: { customToolId: 'c8995ed5-fcc8-49d5-9046-21471d3aebe4', customToolVersion: 'edb22f7683d1fb52fcb5a703303c2cbc711ae338' },
    componentPropDefs: [
      { id: { sessionID: 1, localID: 1 }, name: 'spreadWidth', varValue: { value: { floatValue: 28 } } },
      { id: { sessionID: 1, localID: 2 }, name: 'dotColor', varValue: { value: { colorValue: { r: 1, g: 0.6, b: 0.2, a: 1 } } } },
    ],
  },
  assignments: [{ defID: { sessionID: 1, localID: 1 }, varValue: { value: { floatValue: 100 } } }, { defID: { sessionID: 1, localID: 2 }, varValue: { value: { colorValue: { r: 1, g: 0.035, b: 0.035, a: 0.5 } } } }],
} });

beforeAll(() => registerFigmaShader('c8995ed5-fcc8-49d5-9046-21471d3aebe4', 'edb22f7683d1fb52fcb5a703303c2cbc711ae338', GLOW));

it('resolves the supplied version and preserves assigned controls, opacity and custom overrides', () => {
  const old = source();
  const resolved = resolveFigmaShader({ ...old, params: { brightness: [2.5] } });
  expect(resolved.wgsl?.uniforms).toHaveLength(26);
  expect(resolved.params).toEqual({ spreadWidth: [100], dotColor: [1, 0.035, 0.035, 0.5], brightness: [2.5] });
  expect(resolved.opacity).toBe(0.4);
  expect(old.wgsl).toBeUndefined();
  // Already saved unresolved .mfp paints also resolve in the render adapter.
  expect(toFigPaint(old)?.shader?.wgsl?.source).toContain('fn hash4');
  expect(resolveFigmaShader(resolved)).toBe(resolved);
});

it('does not substitute another version or overwrite user-authored SkSL', () => {
  const other = source();
  (other.figma!.definition as { customToolArtifactRef: { customToolVersion: string } }).customToolArtifactRef.customToolVersion = 'new-version';
  expect(resolveFigmaShader(other)).toBe(other);
  const edited = { ...source(), code: 'half4 main(float2 p) { return half4(1); }' };
  expect(resolveFigmaShader(edited)).toBe(edited);
});

it('packs WGSL source and controls into a portable .mfp file', async () => {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root);
  const fill = resolveFigmaShader(source());
  const node = doc.create('RECTANGLE', page, { width: 560, height: 140, fills: [fill] });
  const { blob } = await writeMfp(doc, null);
  const loaded = await readMfp(new MemorySource(new Uint8Array(await blob.arrayBuffer())));
  expect(loaded.doc.get(node, 'fills')).toEqual([fill]);
});
