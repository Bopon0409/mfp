import { describe, expect, it } from 'vitest';
import { comboOf } from '../src/custom-keys.ts';

const ev = (o: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent;

describe('custom keyboard shortcuts', () => {
  it('shortcut by physical key: Russian layout — the same letters', () => {
    expect(comboOf(ev({ key: 'н', code: 'KeyY', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Y');
    expect(comboOf(ev({ key: '!', code: 'Digit1', shiftKey: true }))).toBe('Shift+1');
    expect(comboOf(ev({ key: 'ArrowUp', code: 'ArrowUp', altKey: true }))).toBe('Alt+↑');
    expect(comboOf(ev({ key: 'k', code: 'KeyK', metaKey: true }))).toBe('Ctrl+K');
  });

  it('a single modifier is not a shortcut', () => {
    expect(comboOf(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
  });
});
