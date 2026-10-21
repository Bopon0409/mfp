import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { defaultTextProps, setDefaultText } from '../src/default-text.ts';

describe('default style of new texts in a file (MFP-specific)', () => {
  it('taken from a text, survives editing the sample, resets; a deleted style — without a link', () => {
    const doc = new Document({ clientId: 1 });
    const page = doc.create('PAGE', doc.root);
    const style = doc.create('STYLE', doc.root, { name: 'Body' });
    const t = doc.create('TEXT', page, { characters: 'Привет', fontName: { family: 'Manrope', style: 'Bold' }, fontSize: 18, fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 } }], textStyleId: style, width: 50 });
    expect(defaultTextProps(doc)).toEqual({});
    setDefaultText(doc, t);
    doc.set(t, { fontSize: 40 });
    expect(defaultTextProps(doc)).toMatchObject({ fontName: { family: 'Manrope', style: 'Bold' }, fontSize: 18, fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 } }], textStyleId: style });
    doc.delete(style);
    expect(defaultTextProps(doc).textStyleId).toBeUndefined();
    setDefaultText(doc, null);
    expect(defaultTextProps(doc)).toEqual({});
  });
});
