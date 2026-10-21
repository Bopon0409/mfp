import { expect, it } from 'vitest';
import { scrubPointerDelta, valueScrubber } from '../src/value-scrub.ts';

const normal = { shiftKey: false, altKey: false, ctrlKey: false };
it('ignores stale movementX on the first drag event, including Alt', () => {
  for (const altKey of [false, true]) {
    const delta = scrubPointerDelta({ pointerId: 1, clientX: 900 });
    const scrub = valueScrubber(20);
    const event = { pointerId: 1, clientX: 902, movementX: 600 };
    expect(scrub(delta(event), { ...normal, altKey })).toBe(altKey ? 20.2 : 22);
    expect(delta({ pointerId: 2, clientX: 1200 })).toBe(0);
    expect(delta({ pointerId: 1, clientX: 903 })).toBe(1);
    expect(delta({ pointerId: 1, clientX: 901 })).toBe(-2);
  }
});
it('changes speed and step during one drag without rescaling earlier movement', () => {
  const move = valueScrubber(12.5);
  expect(move(3, normal)).toBe(15.5);
  expect(move(2, { ...normal, shiftKey: true })).toBe(35.5);
  expect(move(2, { ...normal, altKey: true })).toBe(35.7);
  expect(move(2, { ...normal, ctrlKey: true })).toBe(55.7);
  expect(move(-1, normal)).toBe(54.7);
});
it('combines modifiers and accumulates slow movement', () => {
  const move = valueScrubber(0);
  const slowSteps = { ...normal, shiftKey: true, altKey: true };
  expect(move(2, slowSteps)).toBe(0);
  expect(move(8, slowSteps)).toBe(10);
  expect(move(1, { ...normal, shiftKey: true, ctrlKey: true })).toBe(110);
  expect(move(1, { ...normal, altKey: true, ctrlKey: true })).toBe(111);
});
