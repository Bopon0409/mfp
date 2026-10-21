import { afterEach, expect, it, vi } from 'vitest';
import { draggableWindow } from '../src/draggable-window.ts';
afterEach(() => vi.unstubAllGlobals());
it('drags, clamps, ignores header controls and removes listeners on close', () => {
  const win = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 }); vi.stubGlobal('window', win);
  let control = false, captured = false;
  const head = Object.assign(new EventTarget(), { style: {}, closest: () => control ? {} : null, setPointerCapture: () => captured = true, hasPointerCapture: () => captured, releasePointerCapture: () => captured = false });
  const box = { style: {} as Record<string, string>, isConnected: true, getBoundingClientRect: () => ({ left: 100, top: 100, width: 300, height: 200 }) };
  const close = draggableWindow(box as unknown as HTMLElement, head as unknown as HTMLElement);
  const fire = (type: string, x: number, y: number) => head.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { button: 0, pointerId: 1, clientX: x, clientY: y }));
  control = true; fire('pointerdown', 110, 110); expect(captured).toBe(false);
  control = false; fire('pointerdown', 110, 110); fire('pointermove', 1000, 1000);
  expect(box.style.left).toBe('500px'); expect(box.style.top).toBe('400px');
  fire('pointercancel', 0, 0); expect(captured).toBe(false);
  close(); fire('pointerdown', 0, 0); expect(captured).toBe(false);
});
