// UI translation: exact strings, templates, user names in “…”, labels assembled in code.
import { beforeAll, describe, expect, it } from 'vitest';

let i18n: typeof import('../src/i18n/index.ts');

beforeAll(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'mfp.lang' ? 'en' : null), setItem() {}, removeItem() {} };
  i18n = await import('../src/i18n/index.ts');
  i18n.useDictionary({
    exact: { Слои: 'Layers', Прямоугольник: 'Rectangle', Фрейм: 'Frame', 'Без названия': 'Untitled', Страницы: 'Pages' },
    patterns: { 'Файл «{0}» сохранён': 'File “{0}” saved', 'Выделено слоёв: {0}': 'Layers selected: {0}', '{0} МБ': '{0} MB', 'Страница {0}': 'Page {0}' },
  });
});

describe('interface translation', () => {
  it('exact strings and whitespace at the edges', () => {
    expect(i18n.lang).toBe('en');
    expect(i18n.tr('Слои')).toBe('Layers');
    expect(i18n.tr('\n  Слои  ')).toBe('\n  Layers  ');
    expect(i18n.tr('Hello')).toBe('Hello');
    expect(i18n.tr('Нет такой строки')).toBe('Нет такой строки');
  });

  it('templates: substitutions are translated, names in “…” are not', () => {
    expect(i18n.tr('Выделено слоёв: 3')).toBe('Layers selected: 3');
    expect(i18n.tr('Файл «Фрейм» сохранён')).toBe('File “Фрейм” saved');
  });

  it('a short template does not match a Russian phrase', () => {
    expect(i18n.tr('12 МБ')).toBe('12 MB');
    expect(i18n.tr('Очень много МБ')).toBe('Очень много МБ');
  });

  it('composed labels: keyboard shortcut and parts joined by a separator', () => {
    expect(i18n.tr('Прямоугольник (R)')).toBe('Rectangle (R)');
    expect(i18n.tr('Фрейм · Прямоугольник')).toBe('Frame · Rectangle');
    expect(i18n.tr('Фрейм · «Фрейм»')).toBe('Frame · «Фрейм»');
  });

  it('a long string with no match — fast', () => {
    const long = 'Текст '.repeat(20_000);
    const t0 = performance.now();
    expect(i18n.tr(long)).toBe(long);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('t(): labels from code with substitutions', () => {
    expect(i18n.t('Без названия')).toBe('Untitled');
    expect(i18n.t('Страница {0}', 2)).toBe('Page 2');
    expect(i18n.t('Неизвестно {0}', 5)).toBe('Неизвестно 5');
  });
});
