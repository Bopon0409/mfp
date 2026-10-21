import { expect, it } from 'vitest';
import { devKeyAllowed } from '../src/dev-keys.ts';

function key(code: string, modifiers = '', value = code.startsWith('Key') ? code.slice(3).toLowerCase() : code) {
  return { code, key: value, ctrlKey: modifiers.includes('C'), metaKey: modifiers.includes('M'), altKey: modifiers.includes('A'), shiftKey: modifiers.includes('S') };
}
it('blocks design mutations with either platform modifier, including Russian key values', () => {
  for (const mod of ['C', 'M']) for (const [code, mods] of [
    ['KeyZ', ''], ['KeyZ', 'S'], ['KeyY', ''], ['KeyK', 'A'], ['KeyK', 'S'],
    ['KeyV', ''], ['KeyV', 'A'], ['KeyR', 'S'], ['KeyX', ''], ['KeyD', ''],
    ['KeyG', ''], ['KeyB', ''], ['KeyE', ''], ['KeyL', 'S'], ['BracketRight', ''],
  ]) expect(devKeyAllowed(key(code!, mod + mods, 'я')), `${mod}${mods} ${code}`).toBe(false);
  for (const [code, mods] of [['Delete', ''], ['Backspace', 'S'], ['KeyV', 'S'], ['KeyF', 'AS'], ['KeyA', 'S'], ['BracketLeft', ''], ['Digit5', '']]) {
    expect(devKeyAllowed(key(code!, mods))).toBe(false);
  }
});
it('keeps navigation, copy, export, search, pan and prototype preview available', () => {
  for (const [code, mods] of [
    ['KeyC', 'C'], ['KeyC', 'MS'], ['KeyC', 'CA'], ['KeyE', 'CS'], ['KeyF', 'C'], ['KeyK', 'M'],
    ['KeyA', 'CS'], ['KeyA', 'CA'], ['KeyS', 'C'], ['KeyL', 'C'], ['Space', ''], ['Space', 'S'],
    ['ArrowRight', ''], ['ArrowLeft', 'A'], ['ArrowDown', 'S'], ['ArrowUp', 'C'],
    ['Enter', ''], ['Enter', 'S'], ['Enter', 'CA'], ['Tab', 'S'], ['KeyG', 'S'], ['KeyN', 'S'],
    ['Digit2', 'S'], ['Backslash', 'C'], ['KeyT', ''], ['KeyM', ''],
  ]) expect(devKeyAllowed(key(code!, mods)), `${mods} ${code}`).toBe(true);
});
it('respects outline preference and separates help from removing strokes', () => {
  expect(devKeyAllowed(key('KeyO', 'CS'))).toBe(true);
  expect(devKeyAllowed(key('KeyO', 'CS'), true)).toBe(false);
  expect(devKeyAllowed(key('KeyO', 'S'), true)).toBe(true);
  expect(devKeyAllowed(key('KeyO', 'CA'))).toBe(false);
  expect(devKeyAllowed(key('Slash', 'S', '?'), false, true)).toBe(false);
  expect(devKeyAllowed(key('Slash', 'CS', '?'), false, true)).toBe(true);
  expect(devKeyAllowed(key('Slash', 'S', '?'), false, false)).toBe(true);
});
