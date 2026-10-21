// mfp plugin check: manifest, APIs in code, command runs (including parameters and codegen).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPlugin, formatReport, scanApi } from '../src/plugin-check.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function pluginDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mfp-plugin-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('mfp plugin check', () => {
  it('finds Figma API calls in code', () => {
    const used = scanApi('figma.createRectangle(); figma.ui.postMessage(1); node.vectorNetwork; n.exportAsync(); figma.createRectangle()');
    expect(Object.fromEntries(used)).toEqual({ 'figma.createRectangle': 2, 'figma.ui.postMessage': 1, 'node.vectorNetwork': 1, 'node.exportAsync': 1 });
  });

  it('catalog plugins and examples work', async () => {
    for (const dir of ['apps/editor/public/catalog/rename-layers', 'apps/editor/public/catalog/lorem', 'packages/plugin-host/fixtures/codegen-sample']) {
      const r = await checkPlugin(join(ROOT, dir));
      expect(r.verdict, formatReport(r)).toBe('works');
    }
    // Quick action with parameters: values come from the plugin's suggestions.
    const rename = await checkPlugin(join(ROOT, 'apps/editor/public/catalog/rename-layers'));
    expect(rename.runs[0]).toMatchObject({ state: 'closed', message: 'Layers renamed: 1', changes: 1 });
  });

  it('TypeScript without a build, unknown APIs, an error at launch', async () => {
    const dir = pluginDir({
      'manifest.json': JSON.stringify({ name: 'TS', id: 'ts', api: '1.0.0', main: 'dist/code.js', menu: [{ name: 'Go', command: 'go' }] }),
      'code.ts': `const size: number = 10;
        const n = figma.createRectangle();
        n.resize(size, size);
        if (figma.command === 'go') { const s = figma.createSticky(); s.text.characters = 'x'; }
        figma.closePlugin();`,
    });
    const r = await checkPlugin(dir);
    expect(r.warnings).toContain('dist/code.js нет — взят исходник code.ts');
    expect(r.apis.missing).toEqual([{ name: 'figma.createSticky', count: 1 }]);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.state).toBe('error');
    expect(r.verdict).toBe('fails');
    expect(formatReport(r)).toContain('Итог: не работает');
  });

  it('missing manifest or code — a clear error', async () => {
    expect((await checkPlugin(pluginDir({}))).errors).toEqual(['нет manifest.json']);
    const r = await checkPlugin(pluginDir({ 'manifest.json': JSON.stringify({ name: 'X', id: 'x', api: '1.0.0', main: 'code.js' }) }));
    expect(r.errors).toEqual(['нет файла code.js (плагин не собран?)']);
  });
});
