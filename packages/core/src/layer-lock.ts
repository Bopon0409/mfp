import type { Document } from './document.ts';

/** Effective editor lock, including ancestors. Does not rewrite children's own flags. */
export function layerLocked(doc: Document, id: string): boolean {
  for (let at: string | null = id; at; at = doc.parent(at)) if (doc.get(at, 'locked') === true) return true;
  return false;
}
