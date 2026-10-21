import { describe, expect, it } from 'vitest';
import { Document, addMode, alias, createCollection, createVariable, cssVariableName, cssVariables, extendCollection, setVariableOverride, setVariableValue } from '@mfp/core';

describe('variables in CSS', () => {
  it('modes as blocks, references as var(), units, names from codeSyntax or the name', () => {
    const doc = new Document({ clientId: 1 });
    doc.create('PAGE', doc.root, { name: 'Страница' });
    const ids = doc.transact(() => {
      const base = createCollection(doc, 'Палитра');
      const gray = createVariable(doc, 'Gray/900', base, 'COLOR', { r: 0.1, g: 0.1, b: 0.12, a: 1 });
      const white = createVariable(doc, 'Gray/0', base, 'COLOR', { r: 1, g: 1, b: 1, a: 1 });
      const theme = createCollection(doc, 'Тема');
      const dark = doc.get(theme, 'modes')![0]!.modeId;
      doc.set(theme, { modes: [{ modeId: dark, name: 'Тёмная' }] });
      const light = addMode(doc, theme, 'Светлая');
      const bg = createVariable(doc, 'Фон/Панель', theme, 'COLOR', alias(gray));
      setVariableValue(doc, bg, light, alias(white));
      doc.set(bg, { codeSyntax: { WEB: 'var(--panel)' } });
      const gap = createVariable(doc, 'Отступ/M', theme, 'FLOAT', 0.75);
      doc.set(gap, { unit: 'REM' });
      const radius = createVariable(doc, 'Радиус', theme, 'FLOAT', { type: 'EXPRESSION', expression: '4 * 2' });
      setVariableValue(doc, radius, light, 6);
      const weight = createVariable(doc, 'Вес', theme, 'FLOAT', 600);
      doc.set(weight, { scopes: ['FONT_WEIGHT'] });
      return { gray, bg, theme, dark, light };
    });
    expect(cssVariableName(doc, ids.gray)).toBe('--gray-900');
    expect(cssVariableName(doc, ids.bg)).toBe('--panel');
    const css = cssVariables(doc, { selector: ({ index, collectionName }) => (collectionName === 'Тема' && index === 1 ? '[data-theme="light"]' : ':root') });
    expect(css).toContain(':root {\n  --gray-900: #1a1a1f;\n  --gray-0: #ffffff;\n}');
    expect(css).toContain('  --panel: var(--gray-900);');
    expect(css).toContain('[data-theme="light"] {\n  --panel: var(--gray-0);');
    expect(css).toContain('  --отступ-m: 0.75rem;');
    expect(css).toContain('  --радиус: 8px;');
    expect(css).toContain('  --радиус: 6px;');
    expect(css).toContain('  --вес: 600;');
    const ok = cssVariables(doc, { colorFormat: 'oklch' });
    expect(ok).toMatch(/--gray-0: oklch\(100% 0 0\);/);
    expect(ok).toContain('[data-mode="Светлая"] {');
  });
});

describe('variables in CSS: extensions (brands)', () => {
  it('a brand mode block has all chain variables: own values and the parent\'s', () => {
    const doc = new Document({ clientId: 1 });
    doc.create('PAGE', doc.root, { name: 'Страница' });
    doc.transact(() => {
      const base = createCollection(doc, 'Тема');
      const accent = createVariable(doc, 'Акцент', base, 'COLOR', { r: 0, g: 0, b: 1, a: 1 });
      createVariable(doc, 'Фон', base, 'COLOR', { r: 1, g: 1, b: 1, a: 1 });
      const ext = extendCollection(doc, base, 'Бренд Б');
      setVariableOverride(doc, ext, accent, doc.get(ext, 'modes')![0]!.modeId, { r: 0, g: 0.6, b: 0.2, a: 1 });
    });
    const css = cssVariables(doc, { selector: ({ collectionName }) => (collectionName === 'Бренд Б' ? '[data-brand="b"]' : ':root') });
    expect(css).toContain(':root {\n  --акцент: #0000ff;\n  --фон: #ffffff;\n}');
    expect(css).toContain('[data-brand="b"] {\n  --акцент: #009933;\n  --фон: #ffffff;\n}');
  });
});
