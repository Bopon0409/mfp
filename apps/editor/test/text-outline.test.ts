import { describe, expect, it } from 'vitest';
import { utf8Index } from '../src/text-outline.ts';

describe('text outlines: glyph offsets', () => {
  it('UTF-8 bytes from layout → string indices (Cyrillic, dashes, emoji)', () => {
    const text = 'Тк — a👍b';
    const index = utf8Index(text);
    // Т(0–1) к(2–3) space(4) —(5–7) space(8) a(9) 👍(10–13) b(14)
    expect([0, 2, 4, 5, 8, 9, 10, 14].map(index)).toEqual([0, 1, 2, 3, 4, 5, 6, 8]);
    expect(text[index(5)]).toBe('—');
    expect(text.codePointAt(index(10))).toBe(0x1f44d);
    // End of the line and beyond it — the line length.
    expect(index(15)).toBe(text.length);
    expect(index(99)).toBe(text.length);
  });
});
