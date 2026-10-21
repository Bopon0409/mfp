// Page-level permissions (our own): a file page can be protected — it can be edited
// by the file owners and the listed people; everyone else with edit access to the file sees it
// view-only (and can comment). Protection is a page property (pageProtection), changed only by
// owners. Checked in the editor (Document.guard: a forbidden edit is rolled back and goes
// nowhere) and on the server (edits to protected pages from others are not accepted).

import type { Document } from './document.ts';
import type { Op } from './types.ts';

export interface PageProtection {
  /** Who else can edit (server people ids), besides the file owners. */
  editors: string[];
}

/** Who is editing: id on the server and whether they own the file. */
export interface PageEditor {
  id: string | null;
  owner: boolean;
}

/** The node's page (a page is its own); none — null. */
export function pageOfNode(doc: Document, id: string): string | null {
  let cur: string | null = id;
  while (cur) {
    const p = doc.parent(cur);
    if (p === doc.root) return doc.type(cur) === 'PAGE' ? cur : null;
    cur = p;
  }
  return null;
}

export const protectionOf = (doc: Document, page: string): PageProtection | null => (doc.get(page, 'pageProtection') as PageProtection | undefined) ?? null;

/** Whether the person can edit the page. */
export function canEditPage(doc: Document, page: string, who: PageEditor): boolean {
  const p = protectionOf(doc, page);
  return !p || who.owner || (!!who.id && p.editors.includes(who.id));
}

/** File pages protected from this person. */
export function lockedPages(doc: Document, who: PageEditor): Set<string> {
  const out = new Set<string>();
  if (who.owner) return out;
  for (const p of doc.children(doc.root)) if (!canEditPage(doc, p, who)) out.add(p);
  return out;
}

/**
 * Pages affected by the operations (ops — applied, inverse — their rollback: it shows
 * where a node moved from and where a deleted one was).
 */
export function pagesTouched(doc: Document, ops: readonly Op[], inverse: readonly Op[]): Set<string> {
  const out = new Set<string>();
  const add = (id: string | undefined) => {
    if (!id || !doc.has(id)) return;
    const p = pageOfNode(doc, id);
    if (p) out.add(p);
  };
  for (const o of [...ops, ...inverse]) {
    if (o.op === 'blob') continue;
    if (o.op === 'create' || o.op === 'move') add(o.parent);
    if (o.op !== 'create') add(o.id);
  }
  return out;
}

/** Document safeguard: an edit of a protected page yields a rejection reason (the page name), otherwise null. */
export function pageGuard(doc: Document, who: () => PageEditor): (ops: readonly Op[], inverse: readonly Op[]) => string | null {
  return (ops, inverse) => {
    const w = who();
    if (w.owner) return null;
    // Only owners change protection (both removing and setting it).
    for (const o of ops) if ((o.op === 'set' && 'pageProtection' in o.props) || (o.op === 'create' && o.type === 'PAGE' && o.props.pageProtection)) return doc.get(o.id, 'name') ?? 'Страница';
    // A deleted protected page — from its rollback (which holds it with its properties).
    for (const o of inverse) {
      if (o.op !== 'create' || o.type !== 'PAGE') continue;
      const p = o.props.pageProtection as PageProtection | undefined;
      if (p && !(w.id && p.editors.includes(w.id))) return o.props.name ?? 'Страница';
    }
    const locked = lockedPages(doc, w);
    if (!locked.size) return null;
    for (const p of pagesTouched(doc, ops, inverse)) if (locked.has(p)) return doc.get(p, 'name') ?? 'Страница';
    return null;
  };
}
