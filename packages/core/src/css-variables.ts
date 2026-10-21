// Variables → CSS custom properties (our own): a block per collection mode,
// references — var(--other), expressions — the mode value, numbers — with the variable's unit (px, rem, %),
// colors — hex or oklch(). The name comes from codeSyntax.WEB (“--bg” or “var(--bg)”), otherwise from the variable name.

import { formatOklch } from './color.ts';
import type { Document } from './document.ts';
import type { RGBA, VariableValue } from './types.ts';
import { collectionVariables, colorHex, isAlias, isColor, isExpression, localCollections, resolveVariable, variableValueIn, variablesIn } from './variables.ts';
import { compositeCss, isComposite } from './composite-variables.ts';

export interface CssVariablesOptions {
  /** Collections in order (all local ones by default). */
  collections?: string[];
  /** Mode selector (by default the first mode is “:root”, the others — `[data-mode="name"]`). */
  selector?: (mode: { name: string; index: number; collection: string; collectionName: string }) => string;
  /** Colors: hex (default) or oklch(). */
  colorFormat?: 'hex' | 'oklch';
  /** First line, a comment. */
  header?: string;
}

/** Property name: codeSyntax.WEB or “Background/Panel 2” → “--background-panel-2”. */
export function cssVariableName(doc: Document, v: string): string {
  const web = doc.get(v, 'codeSyntax')?.WEB?.trim();
  const m = web ? /^(?:var\(\s*)?(--[\w\u0080-￿-]+)\s*\)?$/u.exec(web) : null;
  if (m) return m[1]!;
  const slug = (doc.get(v, 'name') ?? 'var')
    .toLowerCase()
    .replace(/[\s/.]+/g, '-')
    .replace(/[^\p{L}\d_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `--${slug || 'var'}`;
}

const UNITLESS_SCOPES = new Set(['FONT_WEIGHT', 'OPACITY', 'LINE_HEIGHT_MULTIPLIER']);

function cssValue(doc: Document, v: string, val: VariableValue | undefined, colorFormat: 'hex' | 'oklch'): string | null {
  if (val === undefined || isAlias(val) || isExpression(val)) return null;
  if (isColor(val)) {
    const c = val as RGBA;
    return colorFormat === 'oklch' ? formatOklch(c) : colorHex(c).toLowerCase();
  }
  if (typeof val === 'number') {
    const n = +val.toFixed(4);
    const unit = doc.get(v, 'unit');
    if (unit === 'REM') return `${n}rem`;
    if (unit === 'PERCENT') return `${n}%`;
    if (unit === 'MULTIPLIER') return String(n);
    const scopes = doc.get(v, 'scopes') ?? [];
    if (scopes.length && scopes.every((s) => UNITLESS_SCOPES.has(s))) return String(n);
    return n === 0 ? '0' : `${n}px`;
  }
  if (typeof val === 'boolean') return val ? '1' : '0';
  return JSON.stringify(val);
}

/** CSS with all collection modes: “:root { --bg: #1b1d21; … } [data-mode="Light"] { … }”. */
export function cssVariables(doc: Document, opts: CssVariablesOptions = {}): string {
  const colorFormat = opts.colorFormat ?? 'hex';
  const collections = opts.collections ?? localCollections(doc);
  const exported = new Set(collections.flatMap((c) => variablesIn(doc, c)));
  // Extension (brand): all variables of the chain — own values and the parent's values.
  const varsOf = (c: string) => (doc.get(c, 'extendsCollection') ? collectionVariables(doc, c) : variablesIn(doc, c));
  const blocks: string[] = [];
  if (opts.header) blocks.push(`/* ${opts.header.replace(/\*\//g, '* /')} */`);
  for (const c of collections) {
    const collectionName = doc.get(c, 'name') ?? '';
    const modes = doc.get(c, 'modes') ?? [];
    modes.forEach((m, index) => {
      const selector = opts.selector?.({ name: m.name, index, collection: c, collectionName }) ?? (index === 0 ? ':root' : `[data-mode="${m.name.replace(/"/g, '\\"')}"]`);
      const lines: string[] = [];
      for (const v of varsOf(c)) {
        const raw = variableValueIn(doc, v, c, m.modeId);
        const desc0 = doc.get(v, 'description');
        const note = desc0 ? ` /* ${desc0.replace(/\*\//g, '* /').replace(/\s+/g, ' ')} */` : '';
        // Composite: gradient — background, shadows — box-shadow, typography — font (+ “-letter-spacing”).
        if (isComposite(raw)) {
          const name = cssVariableName(doc, v);
          const color = (x: RGBA) => (colorFormat === 'oklch' ? formatOklch(x) : colorHex(x).toLowerCase());
          const parts = compositeCss(raw, color, (id) => resolveVariable(doc, id, null, 0, { [c]: m.modeId }), (id) => (exported.has(id) ? `var(${cssVariableName(doc, id)})` : null));
          lines.push(`  ${name}: ${parts[0]};${note}`);
          if (parts[1]) lines.push(`  ${name}-letter-spacing: ${parts[1]};`);
          continue;
        }
        let value: string | null;
        // A reference to an exported variable becomes var(); to a foreign one (library) — its value.
        if (isAlias(raw) && exported.has(raw.id)) value = `var(${cssVariableName(doc, raw.id)})`;
        else value = cssValue(doc, v, resolveVariable(doc, v, null, 0, { [c]: m.modeId }), colorFormat);
        if (value === null) continue;
        const desc = doc.get(v, 'description');
        lines.push(`  ${cssVariableName(doc, v)}: ${value};${desc ? ` /* ${desc.replace(/\*\//g, '* /').replace(/\s+/g, ' ')} */` : ''}`);
      }
      if (lines.length) blocks.push(`/* ${collectionName} · ${m.name} */\n${selector} {\n${lines.join('\n')}\n}`);
    });
  }
  return `${blocks.join('\n\n')}\n`;
}
