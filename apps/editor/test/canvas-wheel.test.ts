import { expect, it, vi } from 'vitest';
import { installCanvasWheel } from '../src/canvas-wheel.ts';

const wheel = (ctrlKey = false, metaKey = false) => Object.assign(new Event('wheel', { cancelable: true, bubbles: true }), { ctrlKey, metaKey });

it('cancels browser zoom and prevents downstream duplicate handlers', () => {
  const root = new EventTarget(), canvas = new EventTarget();
  const handle = vi.fn(), downstream = vi.fn();
  installCanvasWheel(canvas, root, handle);
  root.addEventListener('wheel', downstream);
  for (const e of [wheel(true), wheel(false, true)]) {
    root.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  }
  expect(handle).toHaveBeenCalledTimes(2); expect(downstream).not.toHaveBeenCalled();
});

it('preserves ordinary sidebar scrolling and ordinary canvas wheel', () => {
  const root = new EventTarget(), canvas = new EventTarget(), handle = vi.fn();
  installCanvasWheel(canvas, root, handle);
  const plain = wheel(); root.dispatchEvent(plain);
  expect(plain.defaultPrevented).toBe(false); expect(handle).not.toHaveBeenCalled();
  canvas.dispatchEvent(wheel()); expect(handle).toHaveBeenCalledTimes(1);
});
