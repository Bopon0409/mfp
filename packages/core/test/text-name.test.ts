import { expect, it } from 'vitest';
import { Document, nameFromText, textAutoRename } from '../src/index.ts';

it('renames text with content, preserves a manual name and can opt back in', () => {
  const doc=new Document({clientId:1}); const page=doc.create('PAGE',doc.root); const id=doc.create('TEXT',page);
  doc.set(id,{characters:'First title'});
  expect(doc.get(id,'name')).toBe('First title'); expect(doc.get(id,'autoRename')).toBe(true);
  doc.set(id,{name:'Heading'}); expect(doc.get(id,'autoRename')).toBe(false);
  doc.set(id,{characters:'Second title'}); expect(doc.get(id,'name')).toBe('Heading');
  doc.set(id,{autoRename:true}); expect(doc.get(id,'name')).toBe('Second title');
  doc.set(id,{characters:'Third'}); expect(doc.get(id,'name')).toBe('Third');
});

it('undoes text and automatic name together and replicates the exact operations', () => {
  const doc=new Document({clientId:1}); const page=doc.create('PAGE',doc.root); const id=doc.create('TEXT',page);
  const other=Document.fromSnapshot(doc.snapshot(),2); const before=doc.snapshot(); const depth=doc.undoDepth;
  doc.onChange(ops=>other.apply(ops,'loro'));
  doc.set(id,{characters:'Hello'});
  expect(doc.undoDepth).toBe(depth+1); expect(other.snapshot()).toEqual(doc.snapshot());
  doc.undo(); expect(doc.snapshot()).toEqual(before); expect(other.snapshot()).toEqual(before);
  doc.redo(); expect(doc.get(id,'name')).toBe('Hello'); expect(other.snapshot()).toEqual(doc.snapshot());
});

it('keeps legacy custom names, explicit opt-out and existing short-name convention', () => {
  expect(textAutoRename({name:'Hero',characters:'Hello'})).toBe(false);
  expect(textAutoRename({name:'Hello',characters:'Hello'})).toBe(true);
  expect(textAutoRename({name:'Hello',characters:'Hello',autoRename:false})).toBe(false);
  expect(nameFromText('  First line\nSecond line')).toBe('First line');
  expect(nameFromText('')).toBe('Text');
});
