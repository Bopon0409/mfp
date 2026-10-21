// PDF fonts for importing as text: codes → Unicode (ToUnicode, WinAnsi, MacRoman, Standard
// encodings, /Differences with glyph names, Identity-H and embedded CMaps), glyph widths (/Widths,
// /W), font name → family and style (the “ABCDEF+” subset prefix removed; Helvetica, Arial, Times,
// Courier, Calibri, Cambria — the metric-compatible free Arimo, Tinos, Cousine, Carlito, Caladea).

import { PdfDict, PdfName, PdfStream, PdfString, latin1, type PdfFile, type PdfObj } from './parser.ts';

/** Glyph name → Unicode: the core of the Adobe Glyph List (Latin, symbols, Cyrillic afii). */
const GLYPHS: Record<string, string> = (() => {
  const g: Record<string, string> = {};
  const ascii = 'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at'.split(' ');
  ascii.forEach((n, i) => (g[n] = String.fromCharCode(0x20 + i)));
  for (let i = 0; i < 26; i++) {
    g[String.fromCharCode(65 + i)] = String.fromCharCode(65 + i);
    g[String.fromCharCode(97 + i)] = String.fromCharCode(97 + i);
  }
  Object.assign(g, {
    bracketleft: '[',
    backslash: '\\',
    bracketright: ']',
    asciicircum: '^',
    underscore: '_',
    grave: '`',
    braceleft: '{',
    bar: '|',
    braceright: '}',
    asciitilde: '~',
    quoteleft: '‘',
    quoteright: '’',
    quotedblleft: '“',
    quotedblright: '”',
    quotesinglbase: '‚',
    quotedblbase: '„',
    guillemotleft: '«',
    guillemotright: '»',
    guilsinglleft: '‹',
    guilsinglright: '›',
    endash: '–',
    emdash: '—',
    bullet: '•',
    ellipsis: '…',
    dagger: '†',
    daggerdbl: '‡',
    perthousand: '‰',
    trademark: '™',
    Euro: '€',
    florin: 'ƒ',
    circumflex: 'ˆ',
    tilde: '˜',
    fi: 'fi',
    fl: 'fl',
    ff: 'ff',
    ffi: 'ffi',
    ffl: 'ffl',
    dotlessi: 'ı',
    Lslash: 'Ł',
    lslash: 'ł',
    OE: 'Œ',
    oe: 'œ',
    Scaron: 'Š',
    scaron: 'š',
    Zcaron: 'Ž',
    zcaron: 'ž',
    Ydieresis: 'Ÿ',
    fraction: '⁄',
    minus: '−',
    ogonek: '˛',
    caron: 'ˇ',
    ring: '˚',
    hungarumlaut: '˝',
    breve: '˘',
    dotaccent: '˙',
    nbspace: ' ',
    nonbreakingspace: ' ',
    sfthyphen: '­',
    afii61352: '№',
    numero: '№',
  });
  // Latin-1: names in order U+00A1…U+00FF.
  const latin =
    'exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis'.split(' ');
  latin.forEach((n, i) => {
    if (!(n in g) || n === 'hyphen') g[n === 'hyphen' ? 'sfthyphen' : n] = String.fromCharCode(0xa1 + i);
  });
  g.hyphen = '-';
  g.guillemotleft = '«';
  // Cyrillic (afii): А…Е, Ё, Ж…Я; а…е, ё, ж…я; then Ukrainian and Serbian letters.
  for (let i = 0; i < 6; i++) g[`afii${10017 + i}`] = String.fromCharCode(0x410 + i);
  g.afii10023 = 'Ё';
  for (let i = 0; i < 26; i++) g[`afii${10024 + i}`] = String.fromCharCode(0x416 + i);
  for (let i = 0; i < 6; i++) g[`afii${10065 + i}`] = String.fromCharCode(0x430 + i);
  g.afii10071 = 'ё';
  for (let i = 0; i < 26; i++) g[`afii${10072 + i}`] = String.fromCharCode(0x436 + i);
  Object.assign(g, {
    afii10050: 'Ґ',
    afii10051: 'Ђ',
    afii10052: 'Ѓ',
    afii10053: 'Є',
    afii10054: 'Ѕ',
    afii10055: 'І',
    afii10056: 'Ї',
    afii10057: 'Ј',
    afii10058: 'Љ',
    afii10059: 'Њ',
    afii10060: 'Ћ',
    afii10061: 'Ќ',
    afii10062: 'Ў',
    afii10145: 'Џ',
    afii10098: 'ґ',
    afii10099: 'ђ',
    afii10100: 'ѓ',
    afii10101: 'є',
    afii10102: 'ѕ',
    afii10103: 'і',
    afii10104: 'ї',
    afii10105: 'ј',
    afii10106: 'љ',
    afii10107: 'њ',
    afii10108: 'ћ',
    afii10109: 'ќ',
    afii10110: 'ў',
    afii10193: 'џ',
  });
  return g;
})();

/** Glyph name → string: from the list, uniXXXX, uXXXX, “a.sc” (a variant maps like its base). */
export function glyphToUnicode(name: string): string | undefined {
  const direct = GLYPHS[name];
  if (direct !== undefined) return direct;
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (m) {
    let s = '';
    for (let i = 0; i + 4 <= m[1]!.length; i += 4) s += String.fromCharCode(parseInt(m[1]!.slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1]!, 16));
  const dot = name.indexOf('.');
  if (dot > 0) return glyphToUnicode(name.slice(0, dot));
  const und = name.indexOf('_');
  if (und > 0) {
    const parts = name.split('_').map(glyphToUnicode);
    if (parts.every((p) => p !== undefined)) return parts.join('');
  }
  return undefined;
}

// ---------- Simple font encodings ----------

const decodeWith = (label: string) => {
  try {
    const d = new TextDecoder(label);
    return Array.from({ length: 256 }, (_, i) => d.decode(Uint8Array.of(i)));
  } catch {
    return Array.from({ length: 256 }, (_, i) => String.fromCharCode(i));
  }
};

let winAnsi: string[] | null = null;
let macRoman: string[] | null = null;

/** Adobe StandardEncoding: ASCII except quotes, plus its own symbols above 0xA0. */
function standard(): string[] {
  const t = Array.from({ length: 256 }, (_, i) => (i >= 0x20 && i < 0x7f ? String.fromCharCode(i) : ''));
  t[0x27] = '’';
  t[0x60] = '‘';
  const hi: [number, string][] = [
    [0xa1, 'exclamdown'],
    [0xa2, 'cent'],
    [0xa3, 'sterling'],
    [0xa4, 'fraction'],
    [0xa5, 'yen'],
    [0xa6, 'florin'],
    [0xa7, 'section'],
    [0xa8, 'currency'],
    [0xa9, 'quotesingle'],
    [0xaa, 'quotedblleft'],
    [0xab, 'guillemotleft'],
    [0xac, 'guilsinglleft'],
    [0xad, 'guilsinglright'],
    [0xae, 'fi'],
    [0xaf, 'fl'],
    [0xb1, 'endash'],
    [0xb2, 'dagger'],
    [0xb3, 'daggerdbl'],
    [0xb4, 'periodcentered'],
    [0xb6, 'paragraph'],
    [0xb7, 'bullet'],
    [0xb8, 'quotesinglbase'],
    [0xb9, 'quotedblbase'],
    [0xba, 'quotedblright'],
    [0xbb, 'guillemotright'],
    [0xbc, 'ellipsis'],
    [0xbd, 'perthousand'],
    [0xbf, 'questiondown'],
    [0xc1, 'grave'],
    [0xc2, 'acute'],
    [0xc3, 'circumflex'],
    [0xc4, 'tilde'],
    [0xc5, 'macron'],
    [0xc6, 'breve'],
    [0xc7, 'dotaccent'],
    [0xc8, 'dieresis'],
    [0xca, 'ring'],
    [0xcb, 'cedilla'],
    [0xcd, 'hungarumlaut'],
    [0xce, 'ogonek'],
    [0xcf, 'caron'],
    [0xd0, 'emdash'],
    [0xe1, 'AE'],
    [0xe3, 'ordfeminine'],
    [0xe8, 'Lslash'],
    [0xe9, 'Oslash'],
    [0xea, 'OE'],
    [0xeb, 'ordmasculine'],
    [0xf1, 'ae'],
    [0xf5, 'dotlessi'],
    [0xf8, 'lslash'],
    [0xf9, 'oslash'],
    [0xfa, 'oe'],
    [0xfb, 'germandbls'],
  ];
  for (const [c, n] of hi) t[c] = GLYPHS[n] ?? '';
  return t;
}

function baseEncoding(name: string | undefined): string[] {
  if (name === 'MacRomanEncoding') return (macRoman ??= decodeWith('macintosh'));
  if (name === 'StandardEncoding') return standard();
  return (winAnsi ??= decodeWith('windows-1252'));
}

// ---------- CMap ----------

interface CMap {
  /** Code (bytes as a number) → Unicode. */
  uni: Map<number, string>;
  /** Code lengths (codespace): by the first byte — how many bytes are in the code. */
  lengths: number[];
}

/** Parse a CMap (ToUnicode or CID encodings): codespacerange, bfchar, bfrange, cidchar, cidrange. */
export function parseCMap(data: Uint8Array): { uni: Map<number, string>; cid: Map<number, number>; ranges: { lo: number; hi: number; len: number }[] } {
  const s = latin1(data);
  const uni = new Map<number, string>();
  const cid = new Map<number, number>();
  const ranges: { lo: number; hi: number; len: number }[] = [];
  const hex = (h: string) => parseInt(h || '0', 16);
  const utf16 = (h: string) => {
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (h.length % 4 === 2) out += String.fromCharCode(parseInt(h.slice(-2), 16));
    return out;
  };
  for (const block of s.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) ranges.push({ lo: hex(m[1]!), hi: hex(m[2]!), len: m[1]!.length / 2 });
  }
  for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) uni.set(hex(m[1]!), utf16(m[2]!));
  }
  for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = hex(m[1]!);
      const hi = Math.min(hex(m[2]!), lo + 65535);
      if (m[4] !== undefined) {
        // The last UTF-16 word increments with the code.
        const base = m[4];
        const head = base.slice(0, -4);
        const last = hex(base.slice(-4));
        for (let c = lo; c <= hi; c++) uni.set(c, utf16(head + (last + c - lo).toString(16).padStart(4, '0')));
      } else {
        const list = [...(m[5] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]!));
        list.forEach((u, i) => uni.set(lo + i, u));
      }
    }
  }
  for (const block of s.matchAll(/begincidchar([\s\S]*?)endcidchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*(\d+)/g)) cid.set(hex(m[1]!), Number(m[2]));
  }
  for (const block of s.matchAll(/begincidrange([\s\S]*?)endcidrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\d+)/g)) {
      const lo = hex(m[1]!);
      const hi = Math.min(hex(m[2]!), lo + 65535);
      for (let c = lo; c <= hi; c++) cid.set(c, Number(m[3]) + c - lo);
    }
  }
  return { uni, cid, ranges };
}

// ---------- Font ----------

export interface PdfFont {
  /** Family and style for a text layer. */
  family: string;
  style: string;
  /** String codes → characters with width (in thousandths of font size) and a space flag (for Tw). */
  decode(bytes: Uint8Array): { text: string; width: number; space: boolean }[];
  /** Cap height above the baseline (fraction of font size). */
  ascent: number;
  /** Type3: glyph matrix (widths are in its units). */
  vertical: boolean;
}

/** Known fonts → metric-compatible free ones. */
const SUBSTITUTE: [RegExp, string][] = [
  [/^(helvetica|arial|arialmt|liberationsans|nimbussans)/i, 'Arimo'],
  [/^(times|timesnewroman|liberationserif|nimbusroman)/i, 'Tinos'],
  [/^(courier|couriernew|liberationmono|nimbusmono)/i, 'Cousine'],
  [/^calibri/i, 'Carlito'],
  [/^cambria/i, 'Caladea'],
];

const WEIGHTS: [RegExp, string, number][] = [
  [/extra-?light|ultra-?light/i, 'Extra Light', 200],
  [/semi-?bold|demi-?bold/i, 'Semi Bold', 600],
  [/extra-?bold|ultra-?bold/i, 'Extra Bold', 800],
  [/thin|hairline/i, 'Thin', 100],
  [/light/i, 'Light', 300],
  [/medium/i, 'Medium', 500],
  [/black|heavy/i, 'Black', 900],
  [/bold/i, 'Bold', 700],
];

/** PDF font name → family and style (weight and italic also from the descriptor). */
export function fontFace(baseFont: string, weight?: number, italicFlag?: boolean): { family: string; style: string } {
  let name = baseFont.replace(/^[A-Z]{6}\+/, '');
  // «Arial,Bold», «Arial-BoldMT», «TimesNewRomanPS-ItalicMT».
  const [fam, ...rest] = name.split(/[-,]/);
  const styleText = rest.join(' ');
  name = fam!.replace(/(PSMT|MT|PS|Std|LT|Pro)$/i, '');
  let w = WEIGHTS.find(([re]) => re.test(styleText));
  // Weight in the family name itself (“HelveticaBold”).
  if (!w) {
    const atEnd = (re: RegExp) => new RegExp(`(${re.source})$`, 'i');
    const inName = WEIGHTS.find(([re]) => atEnd(re).test(name));
    const stripped = inName ? name.replace(atEnd(inName[0]), '') : '';
    if (inName && stripped) {
      name = stripped;
      w = inName;
    }
  }
  const italic = /italic|oblique|kursiv/i.test(styleText) || /(italic|oblique)$/i.test(name) || italicFlag === true;
  name = name.replace(/(italic|oblique)$/i, '');
  let family = SUBSTITUTE.find(([re]) => re.test(name))?.[1];
  if (!family) {
    // «TimesNewRoman» → «Times New Roman»; «OpenSans» → «Open Sans».
    family = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim() || 'Inter';
  }
  let weightName = w?.[1];
  if (!weightName && weight && weight !== 400) weightName = WEIGHTS.find(([, , v]) => v === Math.round(weight / 100) * 100)?.[1];
  const style = weightName ? (italic ? `${weightName} Italic` : weightName) : italic ? 'Italic' : 'Regular';
  return { family, style };
}

/** Font from the /Font dictionary (page resources). */
export async function loadFont(file: PdfFile, dict: PdfDict): Promise<PdfFont> {
  const subtype = (dict.get('Subtype') as PdfName | undefined)?.v ?? 'Type1';
  const baseFont = ((await file.resolve(dict.get('BaseFont'))) as PdfName | undefined)?.v ?? 'Helvetica';
  const composite = subtype === 'Type0';
  const descFont = composite ? await file.dict(((await file.array(dict.get('DescendantFonts'))) ?? [])[0]) : null;
  const descriptor = await file.dict((descFont ?? dict).get('FontDescriptor'));
  const flags = await file.num(descriptor?.get('Flags'), 0);
  const weight = await file.num(descriptor?.get('FontWeight'), 0);
  const italicAngle = await file.num(descriptor?.get('ItalicAngle'), 0);
  const ascentRaw = await file.num(descriptor?.get('Ascent'), 0);
  const face = fontFace(baseFont, weight || undefined, (flags & 64) !== 0 || italicAngle < -3);
  const ascent = ascentRaw > 0 && ascentRaw < 2000 ? ascentRaw / 1000 : 0.8;
  // ToUnicode is the main source of character info.
  const tu = await file.resolve(dict.get('ToUnicode'));
  const toUni = tu instanceof PdfStream ? parseCMap(await file.decode(tu)) : null;

  if (composite) {
    const enc = await file.resolve(dict.get('Encoding'));
    const encName = enc instanceof PdfName ? enc.v : '';
    const vertical = /-V$/.test(encName);
    let cmap: ReturnType<typeof parseCMap> | null = null;
    if (enc instanceof PdfStream) cmap = parseCMap(await file.decode(enc));
    // CID widths: /DW and /W [c [w1 w2 …] c1 c2 w …].
    const dw = await file.num(descFont?.get('DW'), 1000);
    const widths = new Map<number, number>();
    const W = (await file.array(descFont?.get('W'))) ?? [];
    for (let i = 0; i < W.length; ) {
      const first = (await file.resolve(W[i])) as number;
      const next = await file.resolve(W[i + 1]);
      if (Array.isArray(next)) {
        for (let k = 0; k < next.length; k++) widths.set(first + k, (await file.num(next[k], dw)) || dw);
        i += 2;
      } else {
        const last = next as number;
        const w = await file.num(W[i + 2], dw);
        for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, w);
        i += 3;
      }
    }
    const ranges = cmap?.ranges.length ? cmap.ranges : (toUni?.ranges.length ? toUni.ranges : [{ lo: 0, hi: 0xffff, len: 2 }]);
    const codeLen = (b: Uint8Array, i: number) => {
      for (const r of ranges) {
        if (r.len > b.length - i) continue;
        let v = 0;
        for (let k = 0; k < r.len; k++) v = v * 256 + b[i + k]!;
        if (v >= r.lo && v <= r.hi) return r.len;
      }
      return Math.min(2, b.length - i);
    };
    return {
      ...face,
      ascent,
      vertical,
      decode(bytes) {
        const out: { text: string; width: number; space: boolean }[] = [];
        for (let i = 0; i < bytes.length; ) {
          const len = Math.max(1, codeLen(bytes, i));
          let code = 0;
          for (let k = 0; k < len; k++) code = code * 256 + (bytes[i + k] ?? 0);
          i += len;
          const cid = cmap?.cid.get(code) ?? code;
          const text = toUni?.uni.get(code) ?? '';
          out.push({ text, width: widths.get(cid) ?? dw, space: len === 1 && code === 32 });
        }
        return out;
      },
    };
  }

  // Simple font: encoding (a name or a dictionary with /Differences), /Widths with /FirstChar.
  const encObj = await file.resolve(dict.get('Encoding'));
  const symbolic = (flags & 4) !== 0 && !(flags & 32);
  let table = symbolic && !encObj ? Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)) : baseEncoding(encObj instanceof PdfName ? encObj.v : undefined);
  if (encObj instanceof PdfDict) {
    const base = encObj.get('BaseEncoding');
    table = [...baseEncoding(base instanceof PdfName ? base.v : undefined)];
    const diffs = (await file.array(encObj.get('Differences'))) ?? [];
    let code = 0;
    for (const d of diffs) {
      const v = await file.resolve(d);
      if (typeof v === 'number') code = v;
      else if (v instanceof PdfName) {
        const u = glyphToUnicode(v.v);
        if (u !== undefined) table[code] = u;
        code++;
      }
    }
  } else table = [...table];
  // Symbol TrueType font codes (0xF020…) are Private Use: strip them.
  const firstChar = await file.num(dict.get('FirstChar'), 0);
  const widthsArr = (await file.array(dict.get('Widths'))) ?? [];
  const widths: number[] = [];
  for (const w of widthsArr) widths.push(await file.num(w, 0));
  const missing = await file.num(descriptor?.get('MissingWidth'), 0);
  // Type3: widths in font matrix units.
  let scale = 1;
  if (subtype === 'Type3') {
    const fm = (await file.array(dict.get('FontMatrix'))) ?? [0.001];
    scale = ((fm[0] as number) ?? 0.001) * 1000;
  }
  return {
    ...face,
    ascent,
    vertical: false,
    decode(bytes) {
      const out: { text: string; width: number; space: boolean }[] = [];
      for (const code of bytes) {
        const text = toUni?.uni.get(code) ?? table[code] ?? '';
        const w = widths[code - firstChar];
        out.push({ text, width: (w !== undefined && w > 0 ? w : missing || 500) * scale, space: code === 32 });
      }
      return out;
    },
  };
}

/** PDF string as bytes (the font has its own codes). */
export const stringBytes = (o: PdfObj) => (o instanceof PdfString ? o.bytes : new Uint8Array());
