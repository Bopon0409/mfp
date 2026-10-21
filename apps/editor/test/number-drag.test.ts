import { describe, expect, it } from 'vitest';
import { numberInText } from '../src/number-drag.ts';

describe('dragging fields with a unit: number in text', () => {
  it('the unit and surrounding text are kept, a comma is understood', () => {
    expect(numberInText('2%')!.with(14)).toBe('14%');
    expect(numberInText('-0,5px')!.value).toBe(-0.5);
    expect(numberInText('-0,5px')!.with(1.25)).toBe('1.25px');
    expect(numberInText('150%')!.with(152)).toBe('152%');
    expect(numberInText('1,00')!.with(1.1)).toBe('1.1');
  });
  it('no number (“Auto”, “Mixed” in English and Russian, empty) — null', () => {
    // The labels in both interface languages.
    for (const label of ['Auto', 'Mixed', 'Авто', 'Разные']) expect(numberInText(label)).toBeNull();
    expect(numberInText('')).toBeNull();
  });
});
