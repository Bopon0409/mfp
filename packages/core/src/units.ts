// Number input as in CSS: arithmetic and units in number fields (“100/3”, “1.5rem + 8”, “50%”).
//
// Numbers use a dot or a comma; a number can have a unit: px (as is), rem (× the document root font
// size). Operations: + − × ÷ (* and / too), parentheses, unary minus. Percent is a % sign at the
// end of the whole expression: the value stays a number of percent, and the field decides what it
// means (for W and H — a fraction of the parent's inner area). Anything else is not a number (null):
// the field restores the previous value.
//
// Physical units (MFP extension): mm, cm, in, pt.
// Conversion uses the document resolution: 72 points per inch (default; 1 px = 1 pt, as in MFP's
// PDF export) or 96 (as in CSS). A document can show lengths in a chosen unit: then a number
// without a unit in a length field is in that unit, others are converted to it, the result is in pixels.

/** Length unit for display and input. */
export type LengthUnit = 'px' | 'mm' | 'cm' | 'in' | 'pt';

/** Document units (the documentUnits property of the root). */
export interface DocumentUnits {
  unit: LengthUnit;
  /** Pixels per inch: 72 — print (1 px = 1 pt), 96 — CSS. */
  dpi: number;
}

export const DEFAULT_DPI = 72;

/** How many pixels in one unit. */
export function pxPerUnit(unit: LengthUnit, dpi = DEFAULT_DPI): number {
  switch (unit) {
    case 'in':
      return dpi;
    case 'cm':
      return dpi / 2.54;
    case 'mm':
      return dpi / 25.4;
    case 'pt':
      return dpi / 72;
    default:
      return 1;
  }
}

/** Unit label in the UI. */
export const UNIT_LABEL: Record<LengthUnit, string> = { px: 'px', mm: 'мм', cm: 'см', in: 'дюйм', pt: 'pt' };

/** Length in pixels — in document units, rounded (mm and pt — to hundredths, cm and inches — to thousandths). */
export function formatLength(px: number, units?: DocumentUnits): string {
  if (!units || units.unit === 'px') return String(Math.round(px * 100) / 100);
  const v = px / pxPerUnit(units.unit, units.dpi);
  const k = units.unit === 'cm' || units.unit === 'in' ? 1000 : 100;
  return String(Math.round(v * k) / k);
}

/** Default document root font size (1 rem), px. */
export const ROOT_FONT_SIZE = 16;

export interface NumberInput {
  value: number;
  /** A % sign at the end: value is in percent. */
  percent: boolean;
}

type Token = { kind: 'num'; value: number } | { kind: 'op'; op: string };

/** units — numbers with a unit are converted to the document unit (without one — px), rem too. */
function tokenize(text: string, rem: number, units?: DocumentUnits): Token[] | null {
  const base = units ? pxPerUnit(units.unit, units.dpi) : 1;
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === ' ') {
      i++;
      continue;
    }
    if ('+-*/()×÷−'.includes(c)) {
      out.push({ kind: 'op', op: c === '×' ? '*' : c === '÷' ? '/' : c === '−' ? '-' : c });
      i++;
      continue;
    }
    const m = /^(\d+(?:[.,]\d*)?|[.,]\d+)\s*(px|rem|mm|cm|in|pt|мм|см)?/i.exec(text.slice(i));
    if (!m) return null;
    const v = Number(m[1]!.replace(',', '.'));
    const u = m[2]?.toLowerCase();
    const px = u === 'rem' ? v * rem : u === 'px' ? v : u ? v * pxPerUnit(u === 'мм' ? 'mm' : u === 'см' ? 'cm' : (u as LengthUnit), units?.dpi) : null;
    out.push({ kind: 'num', value: px === null ? v : px / base });
    i += m[0].length;
  }
  return out;
}

/**
 * Parse field input; null — not a number. rem — the document root font size. units — a length
 * field in a document with physical units: the result is in pixels (percent — as is).
 */
export function evaluateNumberInput(text: string, rem = ROOT_FONT_SIZE, units?: DocumentUnits): NumberInput | null {
  let t = text.trim();
  if (!t) return null;
  const percent = t.endsWith('%');
  if (percent) t = t.slice(0, -1).trim();
  const tokens = tokenize(t, rem, units);
  if (!tokens?.length) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (op: string) => {
    const k = peek();
    return k?.kind === 'op' && k.op === op;
  };
  // expression := term (+|- term)*; term := factor (*|/ factor)*;
  // factor := -factor | number | ( expression )
  const factor = (): number => {
    if (isOp('-')) {
      pos++;
      return -factor();
    }
    if (isOp('+')) {
      pos++;
      return factor();
    }
    if (isOp('(')) {
      pos++;
      const v = expr();
      if (!isOp(')')) throw new Error('скобка');
      pos++;
      return v;
    }
    const k = peek();
    if (k?.kind !== 'num') throw new Error('число');
    pos++;
    return k.value;
  };
  const term = (): number => {
    let v = factor();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[pos++] as { op: string }).op;
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { op: string }).op;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  try {
    const value = expr();
    if (pos !== tokens.length || !Number.isFinite(value)) return null;
    return { value: units && !percent ? value * pxPerUnit(units.unit, units.dpi) : value, percent };
  } catch {
    return null;
  }
}
