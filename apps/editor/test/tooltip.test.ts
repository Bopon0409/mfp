import { describe, expect, it } from 'vitest';
import { splitTip } from '../src/tooltip.ts';

describe('tooltips: name and shortcut', () => {
  it('shortcut from trailing brackets', () => {
    expect(splitTip('Перо (P)')).toEqual({ label: 'Перо', keys: 'P' });
    expect(splitTip('Добавить автораскладку (Shift+A)')).toEqual({ label: 'Добавить автораскладку', keys: 'Shift+A' });
    expect(splitTip('Свернуть интерфейс (Ctrl+Shift+\\)')).toEqual({ label: 'Свернуть интерфейс', keys: 'Ctrl+Shift+\\' });
    expect(splitTip('Закрыть (Esc)')).toEqual({ label: 'Закрыть', keys: 'Esc' });
    expect(splitTip('Библиотеки (Alt+3)')).toEqual({ label: 'Библиотеки', keys: 'Alt+3' });
  });
  it('ordinary brackets stay in the name', () => {
    expect(splitTip('Сглаживание как в iOS (60%)')).toEqual({ label: 'Сглаживание как в iOS (60%)', keys: '' });
    expect(splitTip('Ширина (по содержимому)')).toEqual({ label: 'Ширина (по содержимому)', keys: '' });
    expect(splitTip('Просто подсказка')).toEqual({ label: 'Просто подсказка', keys: '' });
  });
});
