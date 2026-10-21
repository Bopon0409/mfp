import { describe, expect, it } from 'vitest';
import { effectiveStyle } from '@mfp/core';
import { textKeyOf, textKeyStyle } from '../src/text-keys.ts';

const ev = (o: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent;
const style = (p: object) => effectiveStyle({ fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16, ...p }, {});

describe('text shortcuts', () => {
  it('keys: “<” and “>” by physical key, in the English and Russian layouts', () => {
    // The same physical key types “>” in the English layout and “Ю” in the Russian one.
    for (const key of ['>', 'Ю']) expect(textKeyOf(ev({ code: 'Period', key, ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'size', d: 1 });
    for (const key of ['<', 'Б']) expect(textKeyOf(ev({ code: 'Comma', key, ctrlKey: true, shiftKey: true }))).toEqual({ kind: 'size', d: -1 });
    expect(textKeyOf(ev({ code: 'Comma', ctrlKey: true, altKey: true }))).toEqual({ kind: 'weight', d: -1 });
    expect(textKeyOf(ev({ code: 'Period', altKey: true }))).toEqual({ kind: 'tracking', d: 1 });
    expect(textKeyOf(ev({ code: 'Period', ctrlKey: true }))).toEqual({ kind: 'tracking', d: 1 });
    expect(textKeyOf(ev({ code: 'Comma', metaKey: true }))).toEqual({ kind: 'tracking', d: -1 });
    expect(textKeyOf(ev({ code: 'Comma', altKey: true, shiftKey: true }))).toEqual({ kind: 'leading', d: -1 });
    expect(textKeyOf(ev({ code: 'KeyJ', ctrlKey: true, altKey: true }))).toEqual({ kind: 'align', value: 'JUSTIFIED' });
    expect(textKeyOf(ev({ code: 'KeyT', ctrlKey: true }))).toBeNull();
    expect(textKeyOf(ev({ code: 'Period' }))).toBeNull();
  });

  it('font size and spacing', () => {
    expect(textKeyStyle({ kind: 'size', d: -1 }, style({ fontSize: 1 }))).toEqual({ fontSize: 1 });
    expect(textKeyStyle({ kind: 'tracking', d: -1 }, style({}))).toEqual({ letterSpacing: { unit: 'PERCENT', value: -1 } });
    expect(textKeyStyle({ kind: 'tracking', d: 1 }, style({ letterSpacing: { unit: 'PIXELS', value: 1 } }))).toEqual({ letterSpacing: { unit: 'PIXELS', value: 1.5 } });
    // Line height — always in pixels: “Auto” ≈ 1.2 × font size, percentages — of the font size.
    expect(textKeyStyle({ kind: 'leading', d: 1 }, style({}))).toEqual({ lineHeight: { unit: 'PIXELS', value: 20 } });
    expect(textKeyStyle({ kind: 'leading', d: -1 }, style({ lineHeight: { unit: 'PERCENT', value: 150 } }))).toEqual({ lineHeight: { unit: 'PIXELS', value: 23 } });
  });

  it('weight: by the family\'s styles when known; italic is kept', () => {
    expect(textKeyStyle({ kind: 'weight', d: 1 }, style({}))).toEqual({ fontName: { family: 'Inter', style: 'Medium' } });
    expect(textKeyStyle({ kind: 'weight', d: 1 }, style({}), ['Regular', 'Bold', 'Italic', 'Bold Italic'])).toEqual({ fontName: { family: 'Inter', style: 'Bold' } });
    expect(textKeyStyle({ kind: 'weight', d: -1 }, style({ fontName: { family: 'Inter', style: 'Bold Italic' } }), ['Regular', 'Bold', 'Italic', 'Bold Italic'])).toEqual({ fontName: { family: 'Inter', style: 'Italic' } });
    expect(textKeyStyle({ kind: 'weight', d: 1 }, style({ fontName: { family: 'Inter', style: 'Black' } }))).toEqual({});
  });
});
