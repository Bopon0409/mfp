import { describe, expect, it } from 'vitest';
import { applyTextCase, textLayoutOf } from '../src/text.ts';

describe('text layout parameters', () => {
  it('defaults — Inter, auto spacing, no case transform or decorations', () => {
    const t = textLayoutOf({ characters: 'abc' });
    expect(t).toMatchObject({ family: 'Inter', style: 'Regular', fontSize: 12, align: 'LEFT', alignV: 'TOP', autoWidth: true, letterSpacing: 0, textCase: 'ORIGINAL', decoration: 'NONE' });
    expect(t.lineHeight).toBeUndefined();
  });

  it('spacings are converted to a font-size multiplier and pixels', () => {
    const px = textLayoutOf({ fontSize: 20, lineHeight: { unit: 'PIXELS', value: 30 }, letterSpacing: { unit: 'PERCENT', value: 10 } });
    expect(px.lineHeight).toBeCloseTo(1.5);
    expect(px.letterSpacing).toBeCloseTo(2);
    const pct = textLayoutOf({ fontSize: 20, lineHeight: { unit: 'PERCENT', value: 120 }, letterSpacing: { unit: 'PIXELS', value: -0.5 } });
    expect(pct.lineHeight).toBeCloseTo(1.2);
    expect(pct.letterSpacing).toBe(-0.5);
    expect(textLayoutOf({ textAutoResize: 'HEIGHT' }).autoWidth).toBe(false);
  });

  it('case transform works for Cyrillic too', () => {
    expect(applyTextCase('Привет, мир', 'UPPER')).toBe('ПРИВЕТ, МИР');
    expect(applyTextCase('Привет, Мир', 'LOWER')).toBe('привет, мир');
    expect(applyTextCase('дизайн без «тормозов» и-так-далее', 'TITLE')).toBe('Дизайн Без «Тормозов» И-Так-Далее');
    expect(applyTextCase('как есть', 'ORIGINAL')).toBe('как есть');
  });
});
