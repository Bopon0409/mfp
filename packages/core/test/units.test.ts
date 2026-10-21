import { describe, expect, it } from 'vitest';
import { evaluateNumberInput, formatLength, pxPerUnit } from '@mfp/core';

describe('CSS-like number input', () => {
  it('numbers, comma, arithmetic with parentheses and the ×, ÷, − signs', () => {
    expect(evaluateNumberInput('42')).toEqual({ value: 42, percent: false });
    expect(evaluateNumberInput('12,5')).toEqual({ value: 12.5, percent: false });
    expect(evaluateNumberInput('100/4')?.value).toBe(25);
    expect(evaluateNumberInput('(10 + 6) * 2 - 1')?.value).toBe(31);
    expect(evaluateNumberInput('10 × 3 ÷ 2 − 1')?.value).toBe(14);
    expect(evaluateNumberInput('-8 + 2')?.value).toBe(-6);
  });

  it('units: px as is, rem relative to the root font size', () => {
    expect(evaluateNumberInput('24px')?.value).toBe(24);
    expect(evaluateNumberInput('1.5rem')?.value).toBe(24);
    expect(evaluateNumberInput('1rem + 8', 20)?.value).toBe(28);
  });

  it('percent at the end of an expression; not a number — null', () => {
    expect(evaluateNumberInput('50%')).toEqual({ value: 50, percent: true });
    expect(evaluateNumberInput('100/3%')?.value).toBeCloseTo(33.333, 3);
    for (const bad of ['', 'abc', '2 +', '(1', '1 2', '5%%', '1/0']) expect(evaluateNumberInput(bad)).toBeNull();
  });
});

describe('physical units (MFP-specific)', () => {
  it('mm, cm, inches and pt — at 72 points per inch (1 px = 1 pt), 96 optional', () => {
    expect(evaluateNumberInput('1in')?.value).toBe(72);
    expect(evaluateNumberInput('25.4mm')?.value).toBeCloseTo(72, 9);
    expect(evaluateNumberInput('2,54 см')?.value).toBeCloseTo(72, 9);
    expect(evaluateNumberInput('10pt')?.value).toBe(10);
    expect(evaluateNumberInput('1in', 16, { unit: 'px', dpi: 96 })?.value).toBe(96);
  });

  it('in a millimeter document: a number without a unit is mm, with a unit it is converted; result in px', () => {
    const mm = { unit: 'mm' as const, dpi: 72 };
    expect(evaluateNumberInput('210', 16, mm)?.value).toBeCloseTo(595.28, 2);
    expect(evaluateNumberInput('10mm * 2', 16, mm)?.value).toBeCloseTo(evaluateNumberInput('20mm')!.value, 9);
    expect(evaluateNumberInput('10 + 72px', 16, mm)?.value).toBeCloseTo(10 * (72 / 25.4) + 72, 9);
    expect(evaluateNumberInput('50%', 16, mm)).toEqual({ value: 50, percent: true });
  });

  it('display: px to hundredths, mm to hundredths, inches to thousandths', () => {
    expect(formatLength(595.2756, { unit: 'mm', dpi: 72 })).toBe('210');
    expect(formatLength(100, { unit: 'in', dpi: 96 })).toBe('1.042');
    expect(formatLength(12.345)).toBe('12.35');
    expect(pxPerUnit('cm', 72)).toBeCloseTo(28.3465, 4);
  });
});
