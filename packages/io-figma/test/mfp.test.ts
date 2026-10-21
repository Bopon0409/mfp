import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { MemorySource, ZipWriter, crc32, imageHashes, readMfp, readZipDirectory, readZipEntry, writeMfp } from '../src/index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const toSource = async (blob: Blob) => new MemorySource(new Uint8Array(await blob.arrayBuffer()));

describe('ZIP writer', () => {
  it('CRC32 matches the reference', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
  });

  for (const forceZip64 of [false, true]) {
    it(`записи читаются обратно${forceZip64 ? ' (ZIP64)' : ''}`, async () => {
      const zip = new ZipWriter({ forceZip64 });
      const big = bytes('Привет, MFP! '.repeat(1000));
      zip.add('a.txt', bytes('hello'));
      zip.add('dir/сжатый.json', big, true);
      zip.add('empty', new Uint8Array(0));
      const src = await toSource(zip.finish());
      const entries = await readZipDirectory(src);
      expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/сжатый.json', 'empty']);
      expect(entries[1]!.method).toBe(8);
      expect(entries[1]!.compressedSize).toBeLessThan(big.length);
      expect(new TextDecoder().decode(await readZipEntry(src, entries[0]!))).toBe('hello');
      expect(await readZipEntry(src, entries[1]!)).toEqual(big);
      expect((await readZipEntry(src, entries[2]!)).length).toBe(0);
    });
  }
});

describe('.mfp format', () => {
  it('persists archived pattern motifs and their embedded images', async () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const source = doc.create('RECTANGLE', page, { width: 10, height: 10, fills: [{ type: 'IMAGE', imageHash: 'motif', scaleMode: 'FILL' }] });
    doc.create('RECTANGLE', page, { fills: [{ type: 'PATTERN', sourceNodeId: source, tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' }] });
    doc.delete(source);
    const { blob } = await writeMfp(doc, { readImage: async () => bytes('motif-image') });
    const loaded = await readMfp(await toSource(blob));
    expect(loaded.doc.snapshot()).toEqual(doc.snapshot());
    expect(loaded.doc.patternSourceNode(source)).toBeDefined();
    expect(new TextDecoder().decode(await loaded.images!.readImage('motif'))).toBe('motif-image');
  });
  function sample() {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root, { name: 'Страница' });
    doc.create('RECTANGLE', page, { name: 'Фото', fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: 'aa11' }] });
    doc.create('ELLIPSE', page, { strokes: [{ type: 'IMAGE', scaleMode: 'TILE', imageHash: 'bb22' }] });
    doc.create('TEXT', page, { characters: 'Текст' });
    return doc;
  }

  it('collects hashes of all document images', () => {
    expect([...imageHashes(sample())].sort()).toEqual(['aa11', 'bb22']);
  });

  it('saves a document with images and opens it back', async () => {
    const doc = sample();
    const images = new Map([['aa11', bytes('PNG-1')]]);
    const { blob, missing } = await writeMfp(doc, { readImage: async (h) => images.get(h) });
    expect(missing).toEqual(['bb22']);
    const opened = await readMfp(await toSource(blob));
    expect(JSON.stringify(opened.doc.snapshot())).toBe(JSON.stringify(doc.snapshot()));
    expect(new TextDecoder().decode(await opened.images!.readImage('aa11'))).toBe('PNG-1');
    expect(await opened.images!.readImage('bb22')).toBeUndefined();
  });

  it('opens an old .mfp v1 (JSON)', async () => {
    const doc = sample();
    const v1 = bytes(JSON.stringify({ format: 'mfp', version: 1, document: doc.snapshot() }));
    const opened = await readMfp(new MemorySource(v1));
    expect(JSON.stringify(opened.doc.snapshot())).toBe(JSON.stringify(doc.snapshot()));
    expect(opened.images).toBeNull();
  });

  it('a shader effect keeps its code, parameters and paused animation in .mfp', async () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const effects = [{ type: 'SHADER' as const, code: 'uniform shader content;\nuniform float amount;\nhalf4 main(float2 p) { return content.eval(p) * amount; }', params: { amount: [0.75] }, preset: 'custom', animate: false, visible: true }];
    const id = doc.create('RECTANGLE', page, { effects });
    const { blob, missing } = await writeMfp(doc, null);
    expect(missing).toEqual([]);
    const opened = await readMfp(await toSource(blob));
    expect(opened.doc.get(id, 'effects')).toEqual(effects);
  });
});

it('embeds images used only in styled text and vector-path fills', async () => {
 const doc=new Document({clientId:1}); const page=doc.create('PAGE',doc.root);
 doc.create('TEXT',page,{characters:'A',textRuns:[{length:1,style:{fills:[{type:'IMAGE',imageHash:'text-only',scaleMode:'FILL'}]}}]});
 doc.create('VECTOR',page,{vectorPaths:[{data:'M0 0L10 0L10 10Z',windingRule:'NONZERO',fills:[{type:'IMAGE',imageHash:'path-only',scaleMode:'FILL'}]}]});
 expect([...imageHashes(doc)].sort()).toEqual(['path-only','text-only']);
 const {blob,missing}=await writeMfp(doc,{readImage:async h=>bytes(h)});
 expect(missing).toEqual([]);
 const loaded=await readMfp(await toSource(blob));
 expect(new TextDecoder().decode(await loaded.images!.readImage('text-only'))).toBe('text-only');
 expect(new TextDecoder().decode(await loaded.images!.readImage('path-only'))).toBe('path-only');
});
