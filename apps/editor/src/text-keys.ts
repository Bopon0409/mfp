// Text formatting shortcuts: alignment Ctrl+Alt+L / T / R / J, font size Ctrl+Shift+< / >,
// weight Ctrl+Alt+< / >, letter spacing Alt+< / >, line height Alt+Shift+< / >.
// “<” and “>” are the comma and period keys (by physical key, so they work in both the English and the Russian layout).
// They work both while editing text (on the selected run) and for whole selected text layers.

import { styleName, styleWeight, type EffectiveTextStyle } from '@mfp/core';
import type { Props, TextStyle } from '@mfp/core';

export type TextKey =
  | { kind: 'align'; value: NonNullable<Props['textAlignHorizontal']> }
  | { kind: 'size' | 'weight' | 'tracking' | 'leading'; d: 1 | -1 };

const ALIGN: Record<string, NonNullable<Props['textAlignHorizontal']>> = { KeyL: 'LEFT', KeyT: 'CENTER', KeyR: 'RIGHT', KeyJ: 'JUSTIFIED' };

/** Which text action the key press means (null — not a text shortcut). */
export function textKeyOf(e: KeyboardEvent): TextKey | null {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.altKey && !e.shiftKey && ALIGN[e.code]) return { kind: 'align', value: ALIGN[e.code]! };
  const d = e.code === 'Period' ? 1 : e.code === 'Comma' ? -1 : 0;
  if (!d) return null;
  if (mod && e.shiftKey && !e.altKey) return { kind: 'size', d };
  if (mod && e.altKey && !e.shiftKey) return { kind: 'weight', d };
  // Generic-layout documentation also lists Ctrl/Cmd + comma/period; keep Alt for existing users.
  if (mod && !e.altKey && !e.shiftKey) return { kind: 'tracking', d };
  if (!mod && e.altKey && e.shiftKey) return { kind: 'leading', d };
  if (!mod && e.altKey && !e.shiftKey) return { kind: 'tracking', d };
  return null;
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/**
 * New run formatting for a font size, weight or spacing step. available — the family's
 * styles, if known (own fonts): weight steps only through them.
 */
export function textKeyStyle(k: Exclude<TextKey, { kind: 'align' }>, s: EffectiveTextStyle, available: string[] = []): TextStyle {
  const size = s.fontSize;
  switch (k.kind) {
    case 'size':
      return { fontSize: Math.max(1, Math.round(size) + k.d) };
    case 'weight': {
      const { weight, italic } = styleWeight(s.fontName.style);
      const own = available.map(styleWeight).filter((w) => w.italic === italic).map((w) => w.weight);
      const list = [...new Set(own.length ? own : WEIGHTS)].sort((a, b) => a - b);
      const next = k.d > 0 ? list.find((w) => w > weight) : [...list].reverse().find((w) => w < weight);
      if (next === undefined) return {};
      const name = available.find((st) => styleWeight(st).weight === next && styleWeight(st).italic === italic) ?? styleName(next, italic, s.fontName.style);
      return { fontName: { family: s.fontName.family, style: name } };
    }
    case 'tracking': {
      const ls = s.letterSpacing ?? { unit: 'PERCENT', value: 0 };
      const step = ls.unit === 'PIXELS' ? 0.5 : 1;
      return { letterSpacing: { unit: ls.unit, value: Math.round((ls.value + k.d * step) * 100) / 100 } };
    }
    case 'leading': {
      // Line height via shortcut — always in pixels (“Auto” and percentages are converted).
      const lh = s.lineHeight ?? { unit: 'AUTO' };
      const px = lh.unit === 'PIXELS' ? lh.value : lh.unit === 'PERCENT' ? (size * lh.value) / 100 : size * 1.2;
      return { lineHeight: { unit: 'PIXELS', value: Math.max(1, Math.round(px) + k.d) } };
    }
  }
}
