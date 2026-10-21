import { describe, expect, it } from 'vitest';
import { allFolders, cleanFolder, dissolvedFolder, pageTree, renamedFolder } from '../src/page-folders.ts';

const pages = [
  { id: 'cover', folder: '' },
  { id: 'login', folder: 'Продукт/Онбординг' },
  { id: 'home', folder: 'Продукт' },
  { id: 'signup', folder: 'Продукт / Онбординг ' },
  { id: 'old', folder: 'Архив' },
  { id: 'settings', folder: 'Продукт/Настройки' },
];

describe('nested page folders (MFP-specific)', () => {
  it('tree: a folder in place of its first page, subfolders inside, row depth', () => {
    const rows = pageTree(pages, new Set());
    expect(rows.map((r) => (r.kind === 'page' ? `${'  '.repeat(r.depth)}${r.id}` : `${'  '.repeat(r.depth)}[${r.path}]`))).toEqual([
      'cover',
      '[Продукт]',
      '  [Продукт/Онбординг]',
      '    login',
      '    signup',
      '  home',
      '  [Продукт/Настройки]',
      '    settings',
      '[Архив]',
      '  old',
    ]);
    const product = rows.find((r) => r.kind === 'folder' && r.path === 'Продукт');
    expect(product && product.kind === 'folder' && product.pages).toEqual(['login', 'home', 'signup', 'settings']);
  });

  it('a collapsed folder hides the whole subtree', () => {
    const rows = pageTree(pages, new Set(['Продукт/Онбординг']));
    expect(rows.filter((r) => r.kind === 'page').map((r) => r.kind === 'page' && r.id)).toEqual(['cover', 'home', 'settings', 'old']);
  });

  it('renaming and nesting change the path of the whole subtree, dissolving moves it one level up', () => {
    expect(renamedFolder('Продукт/Онбординг', 'Продукт', 'Приложение')).toBe('Приложение/Онбординг');
    expect(renamedFolder('Продуктовый', 'Продукт', 'X')).toBe('Продуктовый');
    expect(renamedFolder('Архив', 'Архив', 'Продукт/Архив')).toBe('Продукт/Архив');
    expect(dissolvedFolder('Продукт/Онбординг', 'Продукт/Онбординг')).toBe('Продукт');
    expect(dissolvedFolder('Продукт/Онбординг/Шаг 1', 'Продукт')).toBe('Онбординг/Шаг 1');
    expect(dissolvedFolder('Архив', 'Архив')).toBe('');
  });

  it('paths are cleaned up; the menu knows intermediate folders too', () => {
    expect(cleanFolder(' a // b / ')).toBe('a/b');
    expect(allFolders(['a/b/c', 'd', ''])).toEqual(['a', 'a/b', 'a/b/c', 'd']);
  });
});
