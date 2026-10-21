import { expect, it } from 'vitest';
import { figmaKeyOf } from '../src/figma-keys.ts';
const ev = (v: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...v }) as KeyboardEvent;

it('extra commands use physical keys on Windows and Mac', () => {
  expect(figmaKeyOf(ev({ code: 'BracketRight', key: 'ъ' }), false)).toBe('front');
  expect(figmaKeyOf(ev({ code: 'BracketLeft', key: 'х' }), true)).toBe('back');
  expect(figmaKeyOf(ev({ code: 'KeyG', shiftKey: true }), false)).toBe('layoutGuides');
  expect(figmaKeyOf(ev({ code: 'KeyF', shiftKey: true, altKey: true }), false)).toBe('flatten');
  expect(figmaKeyOf(ev({ code: 'KeyM', ctrlKey: true, metaKey: true }), true)).toBe('mask');
});
it('does not steal modified brackets, plain tools, composition or AltGr', () => {
  expect(figmaKeyOf(ev({ code: 'BracketRight', ctrlKey: true }), false)).toBeNull();
  expect(figmaKeyOf(ev({ code: 'KeyF' }), false)).toBeNull();
  expect(figmaKeyOf(ev({ code: 'KeyM', ctrlKey: true, metaKey: true }), false)).toBeNull();
  expect(figmaKeyOf(ev({ code: 'BracketLeft', isComposing: true }), false)).toBeNull();
  expect(figmaKeyOf(ev({ code: 'BracketLeft', getModifierState: () => true }), false)).toBeNull();
});
