import { afterEach, expect, it, vi } from 'vitest';
import { startFrameLoop } from '../src/frame-loop.ts';
afterEach(() => vi.unstubAllGlobals());

it('keeps updating loading state after a failed render and can stop cleanly', () => {
  let next: (() => void) | undefined;
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { next = fn; return 1; });
  const cancel = vi.fn(); vi.stubGlobal('cancelAnimationFrame', cancel);
  let building = true, inert = false, calls = 0;
  const error = new Error('render failure');
  const report = vi.fn();
  const stop = startFrameLoop(() => {
    inert = building;
    if (++calls === 1) throw error;
  }, report);
  expect(report).toHaveBeenCalledWith(error);
  expect(inert).toBe(true);
  building = false;
  next!();
  expect(inert).toBe(false);
  expect(calls).toBe(2);
  stop(); next!();
  expect(calls).toBe(2);
  expect(cancel).toHaveBeenCalled();
});
