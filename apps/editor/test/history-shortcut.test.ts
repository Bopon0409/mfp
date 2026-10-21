import { expect, it } from 'vitest';
import { historyShortcut } from '../src/history-shortcut.ts';
it('routes physical undo/redo keys while leaving text editing and IME alone', () => {
  const event = (extra = {}) => ({ code: 'KeyZ', key: 'я', ctrlKey: true, target: { closest: () => null }, ...extra }) as unknown as KeyboardEvent;
  expect(historyShortcut(event())).toBe('undo');
  expect(historyShortcut(event({ shiftKey: true }))).toBe('redo');
  expect(historyShortcut(event({ code: 'KeyY' }))).toBe('redo');
  expect(historyShortcut(event({ ctrlKey: false, metaKey: true }))).toBe('undo');
  expect(historyShortcut(event({ target: { closest: () => ({}) } }))).toBeNull();
  expect(historyShortcut(event({ isComposing: true }))).toBeNull();
  expect(historyShortcut(event({ altKey: true }))).toBeNull();
});
