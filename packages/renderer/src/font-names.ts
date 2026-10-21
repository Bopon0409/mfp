// Family, style and metrics from a font file (TrueType / OpenType and WOFF), so that text refers
// to the font by the same name as in the system and in .fig files. WOFF2 is Brotli-compressed —
// its tables are not read here (CanvasKit itself provides the name, see FontLibrary.addFile).

import { unzlibSync } from 'fflate';

export interface FontNames {
  family: string;
  style: string;
}

/** Font tables: tag → bytes (decompressed for WOFF); null — not TTF/OTF/WOFF. */
export function fontTables(data: ArrayBuffer | Uint8Array): Map<string, Uint8Array> | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = view.getUint32(0);
  const tables = new Map<string, Uint8Array>();
  const name = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  // 0x00010000 — TrueType, 'OTTO' — OpenType (CFF), 'true' — legacy Apple TrueType.
  if (tag === 0x00010000 || tag === 0x4f54544f || tag === 0x74727565) {
    const n = view.getUint16(4);
    for (let i = 0; i < n; i++) {
      const rec = 12 + i * 16;
      if (rec + 16 > bytes.length) return null;
      const off = view.getUint32(rec + 8);
      const len = view.getUint32(rec + 12);
      if (off + len <= bytes.length) tables.set(name(rec), bytes.subarray(off, off + len));
    }
    return tables;
  }
  // 'wOFF': tables stored separately, zlib-compressed (if compression helped).
  if (tag === 0x774f4646) {
    if (bytes.length < 44) return null;
    const n = view.getUint16(12);
    for (let i = 0; i < n; i++) {
      const rec = 44 + i * 20;
      if (rec + 20 > bytes.length) return null;
      const off = view.getUint32(rec + 4);
      const comp = view.getUint32(rec + 8);
      const orig = view.getUint32(rec + 12);
      if (off + comp > bytes.length) continue;
      const raw = bytes.subarray(off, off + comp);
      try {
        tables.set(name(rec), comp < orig ? unzlibSync(raw) : raw);
      } catch {
        // Corrupted table — skip it.
      }
    }
    return tables;
  }
  return null;
}

/** 'wOF2' — WOFF2. */
export const isWoff2 = (data: ArrayBuffer | Uint8Array) => {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  return b.length >= 4 && b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32;
};

/** null — not TTF/OTF/WOFF (WOFF2 and collections are not parsed) or the file has no names. */
export function fontNames(data: ArrayBuffer | Uint8Array): FontNames | null {
  const t = fontTables(data)?.get('name');
  if (!t || t.length < 6) return null;
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const count = view.getUint16(2);
  const strings = view.getUint16(4);
  // nameID → string; Windows (Unicode) takes precedence over Mac Roman.
  const found = new Map<number, { text: string; rank: number }>();
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > t.length) break;
    const platform = view.getUint16(rec);
    const language = view.getUint16(rec + 4);
    const nameId = view.getUint16(rec + 6);
    if (nameId !== 1 && nameId !== 2 && nameId !== 16 && nameId !== 17) continue;
    const length = view.getUint16(rec + 8);
    const start = strings + view.getUint16(rec + 10);
    if (start + length > t.length) continue;
    let text = '';
    let rank = 0;
    if (platform === 3 || platform === 0) {
      for (let j = 0; j + 1 < length; j += 2) text += String.fromCharCode(view.getUint16(start + j));
      // English name (0x409) — as in the system and in .fig files.
      rank = platform === 3 && language === 0x409 ? 3 : 2;
    } else if (platform === 1) {
      for (let j = 0; j < length; j++) text += String.fromCharCode(t[start + j]!);
      rank = 1;
    } else continue;
    const prev = found.get(nameId);
    if (text && (!prev || rank > prev.rank)) found.set(nameId, { text, rank });
  }
  // Typographic names (16/17) — the full family (“Inter Display”), otherwise the legacy ones (1/2).
  const family = found.get(16)?.text ?? found.get(1)?.text;
  const style = found.get(17)?.text ?? found.get(2)?.text ?? 'Regular';
  return family ? { family, style } : null;
}

/** Variable font axis: tag, limits, default value and slider step. */
export interface FontAxis {
  tag: string;
  min: number;
  max: number;
  default: number;
  step: number;
}

/** Variable font axes (fvar table, excluding hidden ones); null — the font is not variable or is WOFF2. */
export function fontAxes(data: ArrayBuffer | Uint8Array): FontAxis[] | null {
  const t = fontTables(data)?.get('fvar');
  if (!t || t.length < 16) return null;
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const offset = v.getUint16(4);
  const count = v.getUint16(8);
  const size = v.getUint16(10) || 20;
  const fixed = (at: number) => Math.round((v.getInt32(at) / 65536) * 1000) / 1000;
  const out: FontAxis[] = [];
  for (let i = 0; i < count; i++) {
    const at = offset + i * size;
    if (at + 20 > t.length) break;
    // Flag 1 — the axis is hidden from the user (HIDDEN_AXIS).
    if (v.getUint16(at + 16) & 1) continue;
    const tag = String.fromCharCode(t[at]!, t[at + 1]!, t[at + 2]!, t[at + 3]!);
    const min = fixed(at + 4);
    const max = fixed(at + 12);
    out.push({ tag, min, max, default: fixed(at + 8), step: max - min > 20 ? 1 : 0.1 });
  }
  return out.length ? out : null;
}

/** Cap height and x-height as fractions of the font size (head and OS/2 tables); null — no data. */
export function fontMetrics(data: ArrayBuffer | Uint8Array): { capHeight: number; xHeight: number } | null {
  const tables = fontTables(data);
  const head = tables?.get('head');
  const os2 = tables?.get('OS/2');
  if (!head || !os2 || head.length < 20 || os2.length < 90) return null;
  const h = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const o = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
  const upm = h.getUint16(18);
  // sCapHeight and sxHeight exist since version 2 of the OS/2 table.
  if (!upm || o.getUint16(0) < 2) return null;
  const capHeight = o.getInt16(88) / upm;
  const xHeight = o.getInt16(86) / upm;
  return capHeight > 0 ? { capHeight, xHeight } : null;
}

/** Style from the file name (“Inter-SemiBoldItalic.woff2” → “Semi Bold Italic”) when tables can't be read. */
export function styleFromFileName(file: string): string {
  const s = file.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[_\s]+/g, '-');
  const italic = /italic|oblique/.test(s);
  const weights: [RegExp, string][] = [
    [/extra-?light|ultra-?light/, 'Extra Light'],
    [/semi-?bold|demi-?bold/, 'Semi Bold'],
    [/extra-?bold|ultra-?bold/, 'Extra Bold'],
    [/thin|hairline/, 'Thin'],
    [/light/, 'Light'],
    [/medium/, 'Medium'],
    [/black|heavy/, 'Black'],
    [/bold/, 'Bold'],
  ];
  const w = weights.find(([re]) => re.test(s))?.[1];
  if (!w) return italic ? 'Italic' : 'Regular';
  return italic ? `${w} Italic` : w;
}
