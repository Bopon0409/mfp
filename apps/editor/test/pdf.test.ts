import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Lexer, PdfDict, PdfFile, PdfName, PdfRef, PdfStream, PdfString, inflate, parseValue } from '../src/pdf/parser.ts';
import { fontFace, glyphToUnicode, parseCMap } from '../src/pdf/fonts.ts';
import { runPage, type M } from '../src/pdf/content.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A simple PDF: objects in order, a classic cross-reference table. */
function buildPdf(objects: (string | Uint8Array)[], rootNum = 1): Uint8Array {
  const parts: Uint8Array[] = [latin('%PDF-1.7\n')];
  let off = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(off);
    const head = latin(`${i + 1} 0 obj\n`);
    const body = typeof o === 'string' ? latin(o) : o;
    const tail = latin('\nendobj\n');
    parts.push(head, body, tail);
    off += head.length + body.length + tail.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${rootNum} 0 R >>\nstartxref\n${off}\n%%EOF\n`;
  parts.push(latin(xref));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const stream = (dict: string, data: Uint8Array) => {
  const head = latin(`<< ${dict} /Length ${data.length} >>\nstream\n`);
  const tail = latin('\nendstream');
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
};

describe('PDF: lexer and objects', () => {
  it('numbers, names with #xx, strings with escapes and octals, arrays, dictionaries, references', () => {
    const lx = new Lexer(latin('<< /Type /Page /A#20B 12.5 /S (a\\(b\\)\\101\\nc) /H <48656C6C6F> /Arr [1 2 0 R -3 .5] /R 7 0 R >>'));
    const d = parseValue(lx) as PdfDict;
    expect((d.get('Type') as PdfName).v).toBe('Page');
    expect(d.get('A B')).toBe(12.5);
    expect((d.get('S') as PdfString).text()).toBe('a(b)A\nc');
    expect((d.get('H') as PdfString).text()).toBe('Hello');
    const arr = d.get('Arr') as unknown[];
    expect(arr[0]).toBe(1);
    expect(arr[1]).toBeInstanceOf(PdfRef);
    expect(arr.slice(2)).toEqual([-3, 0.5]);
    expect((d.get('R') as PdfRef).num).toBe(7);
  });

  it('Flate with a PNG predictor, ASCII85, ASCIIHex, RunLength — via stream filters', async () => {
    // 3-byte rows with the Up predictor (2): the second row is the difference with the first.
    const rows = Uint8Array.from([2, 10, 20, 30, 2, 1, 1, 1]);
    const flate = new PdfStream(new PdfDict(), new Uint8Array(deflateSync(rows)));
    flate.dict.map.set('Filter', new PdfName('FlateDecode'));
    const parms = new PdfDict();
    parms.map.set('Predictor', 12);
    parms.map.set('Columns', 3);
    flate.dict.map.set('DecodeParms', parms);
    const file = await PdfFile.open(buildPdf(['<< /Type /Catalog >>']));
    expect([...(await file.decode(flate))]).toEqual([10, 20, 30, 11, 21, 31]);
    const a85 = new PdfStream(new PdfDict(), latin('87cURD]i,"Ebo80~>'));
    a85.dict.map.set('Filter', new PdfName('ASCII85Decode'));
    expect(new TextDecoder().decode(await file.decode(a85))).toBe('Hello World!');
    const hex = new PdfStream(new PdfDict(), latin('48 65 6c6C 6f>'));
    hex.dict.map.set('Filter', new PdfName('ASCIIHexDecode'));
    expect(new TextDecoder().decode(await file.decode(hex))).toBe('Hello');
    const rl = new PdfStream(new PdfDict(), Uint8Array.from([2, 65, 66, 67, 254, 90, 128]));
    rl.dict.map.set('Filter', new PdfName('RunLengthDecode'));
    expect(new TextDecoder().decode(await file.decode(rl))).toBe('ABCZZZ');
    expect(new TextDecoder().decode(await inflate(new Uint8Array(deflateSync(enc('ещё')))))).toBe('ещё');
  });

  it('cross-reference stream and object stream; a broken table — scan the file', async () => {
    // Objects 1 (catalog) and 2 (pages) — in object stream 3; the table — stream 4.
    const objs = '<< /Type /Catalog /Pages 2 0 R >> << /Type /Pages /Count 0 /Kids [] >>';
    const header = '1 0 2 34 ';
    const objStm = enc(header + objs);
    const pre = latin('%PDF-1.7\n');
    const s3 = stream(`/Type /ObjStm /N 2 /First ${header.length}`, objStm);
    const o3 = new Uint8Array([...latin('3 0 obj\n'), ...s3, ...latin('\nendobj\n')]);
    const off4 = pre.length + o3.length;
    // Rows: type (1 byte), field 2 (2 bytes), field 3 (1 byte).
    const rows = [
      [0, 0, 0, 0],
      [2, 0, 3, 0],
      [2, 0, 3, 1],
      [1, (pre.length >> 8) & 255, pre.length & 255, 0],
      [1, (off4 >> 8) & 255, off4 & 255, 0],
    ].flat();
    const s4 = stream('/Type /XRef /Size 5 /W [1 2 1] /Root 1 0 R', Uint8Array.from(rows));
    const o4 = new Uint8Array([...latin('4 0 obj\n'), ...s4, ...latin('\nendobj\n')]);
    const bytes = new Uint8Array([...pre, ...o3, ...o4, ...latin(`startxref\n${off4}\n%%EOF\n`)]);
    const f = await PdfFile.open(bytes);
    const cat = await f.dict(f.trailer.get('Root'));
    expect((cat!.get('Type') as PdfName).v).toBe('Catalog');
    expect(((await f.dict(cat!.get('Pages')))!.get('Type') as PdfName).v).toBe('Pages');
    // Broken startxref offset — objects are found by scanning.
    const broken = buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>']);
    const text = new TextDecoder('latin1').decode(broken).replace(/startxref\n\d+/, 'startxref\n999999');
    const g = await PdfFile.open(latin(text));
    expect(((await g.dict(g.trailer.get('Root')))!.get('Type') as PdfName).v).toBe('Catalog');
  });
});

describe('PDF: fonts', () => {
  it('glyph names: Latin, Cyrillic afii, uniXXXX', () => {
    expect(glyphToUnicode('A')).toBe('A');
    expect(glyphToUnicode('quotedblleft')).toBe('“');
    expect(glyphToUnicode('afii10017')).toBe('А');
    expect(glyphToUnicode('afii10023')).toBe('Ё');
    expect(glyphToUnicode('afii10097')).toBe('я');
    expect(glyphToUnicode('afii10071')).toBe('ё');
    expect(glyphToUnicode('uni0436')).toBe('ж');
    expect(glyphToUnicode('a.sc')).toBe('a');
  });

  it('CMap ToUnicode: bfchar, bfrange (with an array), codespace', () => {
    const cm = parseCMap(latin(`begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0003> <0020> <0024> <0041> endbfchar
2 beginbfrange <0010> <0012> <0430> <0020> <0021> [<0044> <0045>] endbfrange`));
    expect(cm.ranges).toEqual([{ lo: 0, hi: 0xffff, len: 2 }]);
    expect(cm.uni.get(3)).toBe(' ');
    expect(cm.uni.get(0x24)).toBe('A');
    expect(cm.uni.get(0x12)).toBe('в');
    expect(cm.uni.get(0x21)).toBe('E');
  });

  it('font name → family and style', () => {
    expect(fontFace('ABCDEF+ArialMT')).toEqual({ family: 'Arimo', style: 'Regular' });
    expect(fontFace('Arial-BoldMT')).toEqual({ family: 'Arimo', style: 'Bold' });
    expect(fontFace('TimesNewRomanPS-BoldItalicMT')).toEqual({ family: 'Tinos', style: 'Bold Italic' });
    expect(fontFace('Helvetica-Oblique')).toEqual({ family: 'Arimo', style: 'Italic' });
    expect(fontFace('OpenSans-SemiBold')).toEqual({ family: 'Open Sans', style: 'Semi Bold' });
    expect(fontFace('Roboto', 300)).toEqual({ family: 'Roboto', style: 'Light' });
    expect(fontFace('Calibri,Bold')).toEqual({ family: 'Carlito', style: 'Bold' });
  });
});

describe('PDF: page', () => {
  it('paths with color and stroke, text as a string, clipping, form with a matrix', async () => {
    const content = `q 0 0 1 rg 10 10 100 50 re f Q
1 0 0 RG 2 w 0 0 m 50 50 l S
q 20 20 60 60 re W n 0 1 0 rg 30 30 10 10 re f Q
BT /F1 12 Tf 100 700 Td (Hello) Tj ( World) Tj ET
q 1 0 0 1 200 0 cm /Fm Do Q`;
    const form = 'q 1 1 0 rg 0 0 10 10 re f Q';
    const pdf = buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm 6 0 R >> >> >>',
      stream('', latin(content)),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584] >>',
      stream('/Type /XObject /Subtype /Form /BBox [0 0 20 20] /Matrix [2 0 0 2 0 0]', latin(form)),
    ]);
    const file = await PdfFile.open(pdf);
    const page = (await file.dict(((await file.array((await file.dict((await file.dict(file.trailer.get('Root')))!.get('Pages')))!.get('Kids'))) ?? [])[0]))!;
    const content0 = await file.decode((await file.resolve(page.get('Contents'))) as PdfStream);
    const base: M = [1, 0, 0, 0, -1, 800];
    const { items } = await runPage(file, content0, await file.dict(page.get('Resources')), base);
    const paths = items.filter((i) => i.kind === 'path');
    // Blue rectangle: y down — from 740 to 790.
    const blue = paths[0]!;
    expect(blue.kind === 'path' && blue.path.box).toEqual([10, 740, 110, 790]);
    expect(blue.kind === 'path' && blue.fill).toEqual({ kind: 'solid', color: { r: 0, g: 0, b: 1, a: 1 } });
    const line = paths[1]!;
    expect(line.kind === 'path' && line.stroke?.width).toBe(2);
    expect(line.kind === 'path' && line.fill).toBeUndefined();
    // Green — with clipping 20…80.
    const green = paths[2]!;
    expect(green.kind === 'path' && green.clip?.path.box).toEqual([20, 720, 80, 780]);
    // Text — a single line, baseline y = 800 − 700.
    const text = items.find((i) => i.kind === 'text');
    expect(text?.kind === 'text' && text.text).toBe('Hello World');
    expect(text?.kind === 'text' && [text.x, text.y, text.size]).toEqual([100, 100, 12]);
    expect(text?.kind === 'text' && text.width).toBeCloseTo(((278 * 0 + 722 + 556 + 222 + 222 + 556 + 278 + 944 + 556 + 333 + 222 + 556) / 1000) * 12, 3);
    // Form: matrix ×2 and offset 200 — yellow 200…220, clipped by the form's box.
    const yellow = paths[3]!;
    expect(yellow.kind === 'path' && yellow.path.box).toEqual([200, 780, 220, 800]);
    expect(yellow.kind === 'path' && yellow.clip?.path.box).toEqual([200, 760, 240, 800]);
  });
});
