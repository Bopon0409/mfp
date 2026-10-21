import { type Document, spliceRuns, styleAt } from '@mfp/core';

export type FindScope = 'all' | 'text' | 'names';
export interface FindHit { id: string; kind: 'text' | 'name'; source: string; index: number }
export const escapeFind = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Roots include themselves; overlapping selections are visited once, deleted roots ignored. */
export function* findHits(doc: Document, roots: readonly string[], query: string, scope: FindScope = 'all'): Generator<FindHit> {
  if (!query) return;
  const re = new RegExp(escapeFind(query), 'gi');
  const seen = new Set<string>();
  for (const root of roots) {
    if (!doc.has(root)) continue;
    for (const id of [root, ...doc.descendants(root)]) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (doc.type(id) === 'PAGE' || id === doc.root) continue;
      const text = doc.type(id) === 'TEXT' ? doc.get(id, 'characters') ?? '' : null;
      const name = doc.get(id, 'name') ?? '';
      if (scope !== 'names' && text !== null)
        for (const m of text.matchAll(re)) yield { id, kind: 'text', source: text, index: m.index! };
      if (scope !== 'text' && !(scope === 'all' && name === text))
        for (const m of name.matchAll(re)) yield { id, kind: 'name', source: name, index: m.index! };
    }
  }
}

/** A stale result is never applied at a different position. Replacement is literal, including $. */
export function replaceFindHit(doc: Document, hit: FindHit, query: string, replacement: string): boolean {
  if (!query || !doc.has(hit.id)) return false;
  const key = hit.kind === 'text' ? 'characters' : 'name';
  const source = doc.get(hit.id, key) ?? '';
  if (source !== hit.source) return false;
  const match = new RegExp(escapeFind(query), 'iy');
  match.lastIndex = hit.index;
  if (!match.test(source)) return false;
  const next = source.slice(0, hit.index) + replacement + source.slice(hit.index + query.length);
  if (next === source) return false;
  if (hit.kind === 'name') doc.set(hit.id, { name: next });
  else {
    const runs = doc.get(hit.id, 'textRuns');
    doc.set(hit.id, {
      characters: next,
      textRuns: spliceRuns(runs, source.length, hit.index, query.length, replacement.length, styleAt(runs, hit.index)),
      textGlyphs: undefined,
    });
  }
  return true;
}

/** No preview limit: replace each field from the end so original offsets stay valid. One undo. */
export function replaceFindAll(doc: Document, roots: readonly string[], query: string, replacement: string, scope: FindScope = 'all'): number {
  let count = 0;
  doc.transact(() => {
    const fields = new Map<string, FindHit[]>();
    for (const hit of findHits(doc, roots, query, scope)) {
      const key = `${hit.id}|${hit.kind}`;
      const group = fields.get(key) ?? [];
      group.push(hit);
      fields.set(key, group);
    }
    for (const group of fields.values()) for (const hit of group.reverse()) {
      const source = doc.get(hit.id, hit.kind === 'text' ? 'characters' : 'name') ?? '';
      if (replaceFindHit(doc, { ...hit, source }, query, replacement)) count++;
    }
  });
  return count;
}
