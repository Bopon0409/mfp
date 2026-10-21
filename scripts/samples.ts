// Small files of each format for checks (e2e-desktop.ts, corpus.ts): PDF, Sketch, .mfp.

import { strToU8, zipSync } from 'fflate';
import { Document } from '@mfp/core';
import { writeMfp } from '@mfp/io-figma';

const latin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A one-page PDF: a rectangle and a line of text. */
export function samplePdf(): Uint8Array {
  const content = 'BT /F1 24 Tf 72 720 Td (E2E proverka) Tj ET 0.2 0.5 1 rg 72 500 200 120 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin(out);
}

/** Sketch: a page with an artboard and a rectangle. */
export function sampleSketch(): Uint8Array {
  const rect = (x: number, y: number, w: number, h: number) => ({ _class: 'rect', x, y, width: w, height: h });
  const page = {
    _class: 'page',
    name: 'Страница',
    layers: [
      {
        _class: 'artboard',
        do_objectID: 'A1',
        name: 'Экран',
        frame: rect(0, 0, 375, 667),
        layers: [{ _class: 'rectangle', do_objectID: 'R1', name: 'Карточка', frame: rect(20, 20, 200, 100), points: [], style: { fills: [{ _class: 'fill', isEnabled: true, fillType: 0, color: { red: 1, green: 0.5, blue: 0, alpha: 1 } }] } }],
      },
    ],
  };
  return zipSync({
    'document.json': strToU8(JSON.stringify({ _class: 'document', pages: [{ _class: 'MSJSONFileReference', _ref_class: 'MSImmutablePage', _ref: 'pages/P-1' }] })),
    'meta.json': strToU8(JSON.stringify({ version: 136, app: 'com.bohemiancoding.sketch3' })),
    'pages/P-1.json': strToU8(JSON.stringify(page)),
  });
}

/** .mfp: a page, a screen, a rectangle. */
export async function sampleMfp(): Promise<Uint8Array> {
  const doc = new Document({ clientId: 3 });
  const page = doc.create('PAGE', doc.root, { name: 'Страница' });
  const frame = doc.create('FRAME', page, { name: 'Экран', width: 375, height: 667 });
  doc.create('RECTANGLE', frame, { name: 'Карточка', transform: [1, 0, 20, 0, 1, 20], width: 200, height: 100 });
  const { blob } = await writeMfp(doc, null);
  return new Uint8Array(await blob.arrayBuffer());
}
