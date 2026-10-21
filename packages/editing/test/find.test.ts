import { describe, expect, it } from 'vitest';
import { Document, styleAt } from '@mfp/core';
import { findHits, replaceFindAll, replaceFindHit } from '@mfp/editing';

function fixture() {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, {});
  const frame = doc.create('FRAME', page, { name: 'Card' });
  const text = doc.create('TEXT', frame, { characters: 'cat cat', name: 'cat cat', textRuns: [{ length: 3, style: { fontSize: 24 } }, { length: 4, style: { fontSize: 12 } }] });
  const outside = doc.create('TEXT', page, { characters: 'cat' });
  return { doc, page, frame, text, outside };
}

describe('Scoped find and replace', () => {
  it('includes selected roots, deduplicates overlapping subtrees and keeps siblings untouched', () => {
    const { doc, frame, text, outside } = fixture();
    expect([...findHits(doc, [frame, text, 'missing'], 'CAT', 'text')]).toHaveLength(2);
    expect(replaceFindAll(doc, [frame, text], 'cat', 'dog', 'text')).toBe(2);
    expect(doc.get(outside, 'characters')).toBe('cat');
    expect(doc.get(text, 'characters')).toBe('dog dog');
    doc.undo();
    expect(doc.get(text, 'characters')).toBe('cat cat');
    doc.redo();
    expect(doc.get(text, 'characters')).toBe('dog dog');
  });
  it('replaces one occurrence literally, keeps formatting and rejects stale hits', () => {
    const { doc, text } = fixture();
    const hit = [...findHits(doc, [text], 'cat', 'text')][0]!;
    doc.transact(() => expect(replaceFindHit(doc, hit, 'cat', '$& long')).toBe(true));
    expect(doc.get(text, 'characters')).toBe('$& long cat');
    expect(styleAt(doc.get(text, 'textRuns'), 6).fontSize).toBe(24);
    expect(styleAt(doc.get(text, 'textRuns'), 8).fontSize).toBe(12);
    expect(replaceFindHit(doc, hit, 'cat', 'oops')).toBe(false);
    doc.undo();
    expect(doc.get(text, 'textRuns')).toEqual([{ length: 3, style: { fontSize: 24 } }, { length: 4, style: { fontSize: 12 } }]);
  });
  it('replaces beyond the preview limit and supports deletion and metacharacters', () => {
    const { doc, text } = fixture();
    doc.set(text, { characters: 'a.b '.repeat(2005) });
    expect(replaceFindAll(doc, [text], 'a.b', '', 'text')).toBe(2005);
    expect(doc.get(text, 'characters')).toBe(' '.repeat(2005));
    expect(replaceFindAll(doc, [text], '', 'oops')).toBe(0);
  });
  it('keeps text/name scopes distinct and suppresses duplicate display names', () => {
    const { doc, text } = fixture();
    expect([...findHits(doc, [text], 'cat')]).toHaveLength(2);
    replaceFindAll(doc, [text], 'cat', '$1', 'names');
    expect(doc.get(text, 'name')).toBe('$1 $1');
    expect(doc.get(text, 'characters')).toBe('cat cat');
    expect([...findHits(doc, [], 'cat')]).toEqual([]);
  });
});
