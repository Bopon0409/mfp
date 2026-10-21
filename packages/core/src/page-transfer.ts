// Moving a page to another file: the page with all its content and
// everything it needs to work — main components from other pages (and from libraries), styles,
// variables with collections (and the ones they reference), the page's comments. References
// are remapped to new ids; same-named styles and variables of the target file are used as is.
// Prototype connections to layers on other pages are removed (they do not exist in the new file). Bytes of images,
// video and sounds are listed by hash in the report (the caller copies them).

import { commentPages, threadPage } from './comments.ts';
import { blobRefs, type Document } from './document.ts';
import { mediaHashes } from './media.ts';
import { patternReferences } from './patterns.ts';
import { resourcesPage } from './styles.ts';
import { STYLE_FIELD_NAMES } from './styles.ts';
import type { NodeType, Props, Reaction } from './types.ts';
import { addMode, boundVariableIds, collectionOf, valueRefs, variablesIn } from './variables.ts';

export interface PageTransferReport {
  /** New page in the target file. */
  page: string;
  /** Hashes of images, video and sounds (bytes come from the source storage). */
  images: Set<string>;
  /** Main components copied from other pages and from libraries. */
  components: number;
  styles: number;
  variables: number;
  /** Styles, variables and components the target already had. */
  reused: number;
  comments: number;
  /** Prototype connections to layers outside the page — removed. */
  droppedLinks: number;
}

/** Fields where a string is not a reference (names, texts, keys): not remapped. */
const PLAIN = new Set(['name', 'characters', 'description', 'key', 'library', 'codeSyntax', 'textGlyphs', 'devResources', 'annotations']);

/** Remap references (values and object keys — node and mode ids) using the table. */
function remapDeep(v: unknown, map: Map<string, string>): unknown {
  if (typeof v === 'string') return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => remapDeep(x, map));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[map.get(k) ?? k] = remapDeep(x, map);
    return out;
  }
  return v;
}

function remapProps(props: Record<string, unknown>, map: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = PLAIN.has(k) ? v : remapDeep(v, map);
  const glyphs = props.textGlyphs as Props['textGlyphs'];
  if (glyphs) out.textGlyphs = { ...glyphs, runs: remapDeep(glyphs.runs, map) };
  return out;
}

/** Hashes of images, video and sounds in properties. */
function mediaOf(props: Props, out: Set<string>) {
  for (const hash of mediaHashes(props)) out.add(hash);
}

/** Top-level main component (for a variant — its set). */
function masterRoot(doc: Document, id: string): string {
  const p = doc.parent(id);
  return p && doc.type(p) === 'COMPONENT_SET' ? p : id;
}

const inside = (doc: Document, id: string, root: string) => {
  for (let c: string | null = id; c; c = doc.parent(c)) if (c === root) return true;
  return false;
};

/**
 * Copies of the page's main components on other pages of the file: moving would leave them without
 * a main component. The number of such copies (0 — the page can be moved).
 */
export function instancesElsewhere(doc: Document, page: string): number {
  const masters = new Set<string>();
  for (const id of doc.descendants(page)) if (doc.type(id) === 'COMPONENT') masters.add(id);
  if (!masters.size) return 0;
  let n = 0;
  for (const p of doc.children(doc.root)) {
    if (p === page) continue;
    for (const id of doc.descendants(p)) if (doc.type(id) === 'INSTANCE' && masters.has(doc.get(id, 'componentId') ?? '')) n++;
  }
  return n;
}

/**
 * Copy page page of document source into target (call inside a target transaction).
 * sourceName — the source file name (page “Components — <name>” for main components from other pages);
 * componentsTitle — that page title in the interface language (the editor passes a translated one).
 */
export function transferPage(source: Document, page: string, target: Document, opts: { sourceName: string; componentsTitle?: string }): PageTransferReport {
  const report: PageTransferReport = { page: '', images: new Set(), components: 0, styles: 0, variables: 0, reused: 0, comments: 0, droppedLinks: 0 };
  const map = new Map<string, string>();

  // 1. Dependencies: main components outside the page, styles, variables and collections (along the chain).
  const masters = new Set<string>();
  const styles = new Set<string>();
  const vars = new Set<string>();
  const collections = new Set<string>();
  const motifs = new Set<string>();
  const motifAliases = new Map<string, string>();
  const queue: string[] = [page];
  const seen = new Set<string>();
  const visitProps = (id: string) => {
    const p = source.node(id)?.props;
    if (!p) return;
    for (const ref of patternReferences(p)) {
      const actual = source.patternSourceNode(ref);
      if (!actual) continue;
      motifAliases.set(ref, actual);
      if (!inside(source, actual, page) && !motifs.has(actual)) {
        motifs.add(actual);
        queue.push(actual);
      }
    }
    const cid = p.componentId;
    if (cid && source.has(cid) && !inside(source, cid, page)) {
      const root = masterRoot(source, cid);
      if (!masters.has(root)) {
        masters.add(root);
        queue.push(root);
      }
    }
    for (const f of STYLE_FIELD_NAMES) {
      const s = p[f];
      if (s && source.has(s) && !styles.has(s)) { styles.add(s); queue.push(s); }
    }
    for (const r of p.textRuns ?? []) for (const s of [r.style.textStyleId, r.style.fillStyleId]) if (s && source.has(s) && !styles.has(s)) { styles.add(s); queue.push(s); }
    for (const v of boundVariableIds(p)) if (source.has(v)) vars.add(v);
    for (const c of Object.keys(p.explicitVariableModes ?? {})) if (source.has(c)) collections.add(c);
  };
  while (queue.length) {
    const root = queue.pop()!;
    if (seen.has(root)) continue;
    seen.add(root);
    visitProps(root);
    for (const id of source.descendants(root)) visitProps(id);
  }
  // Styles with their variables; variables by reference (and inside composites), along the chain.
  for (const s of styles) for (const v of boundVariableIds(source.node(s)!.props)) if (source.has(v)) vars.add(v);
  for (const v of [...vars]) {
    const stack = [v];
    while (stack.length) {
      const x = stack.pop()!;
      for (const val of Object.values(source.get(x, 'valuesByMode') ?? {}))
        for (const r of valueRefs(val)) {
          if (source.has(r) && !vars.has(r)) {
            vars.add(r);
            stack.push(r);
          }
        }
    }
  }
  for (const v of vars) {
    const c = collectionOf(source, v);
    if (c) collections.add(c);
  }

  // 2. Collections and variables: the target's same-named ones are used (modes matched by name), otherwise a copy.
  const res = resourcesPage(target)!;
  const tKey = new Map<string, string>();
  for (const id of target.descendants(res)) {
    const k = target.get(id, 'key');
    if (k) tKey.set(k, id);
  }
  const byName = (parent: string, type: NodeType, name: string) => target.children(parent).find((id) => target.type(id) === type && target.get(id, 'name') === name);
  const newVars: [string, string][] = [];
  for (const c of collections) {
    const k = source.get(c, 'key');
    const name = source.get(c, 'name') ?? '';
    const same = (k && tKey.get(k)) || byName(res, 'VARIABLE_COLLECTION', name);
    if (same && target.type(same) === 'VARIABLE_COLLECTION') {
      map.set(c, same);
      report.reused++;
      // Modes by name; add the missing ones.
      for (const m of source.get(c, 'modes') ?? []) {
        const tm = (target.get(same, 'modes') ?? []).find((x) => x.name === m.name)?.modeId ?? addMode(target, same, m.name);
        if (tm !== m.modeId) map.set(m.modeId, tm);
      }
    } else {
      const props = { ...(source.node(c)!.props as Record<string, unknown>) };
      map.set(c, target.create('VARIABLE_COLLECTION', res, props as Props));
    }
    for (const v of variablesIn(source, c)) {
      if (!vars.has(v)) continue;
      const tc = map.get(c)!;
      const existing = byName(tc, 'VARIABLE', source.get(v, 'name') ?? '');
      if (existing) {
        map.set(v, existing);
        report.reused++;
      } else {
        const id = target.create('VARIABLE', tc, { ...(source.node(v)!.props as Record<string, unknown>) } as Props);
        map.set(v, id);
        newVars.push([v, id]);
        report.variables++;
      }
    }
  }

  // 3. Styles: by key or by name and kind — the target's; otherwise a copy on the internal page.
  const newStyles: [string, string][] = [];
  for (const s of styles) {
    const k = source.get(s, 'key');
    const type = source.get(s, 'styleType');
    const same = (k && tKey.get(k)) || target.children(res).find((id) => target.type(id) === 'STYLE' && target.get(id, 'styleType') === type && target.get(id, 'name') === source.get(s, 'name'));
    if (same) {
      map.set(s, same);
      report.reused++;
    } else {
      const id = target.create('STYLE', res, { ...(source.node(s)!.props as Record<string, unknown>) } as Props);
      map.set(s, id);
      newStyles.push([s, id]);
      report.styles++;
    }
  }

  // 4. Nodes: the page and main components outside it — as copies (new ids), references later.
  const copied: [string, string][] = [];
  const copyTree = (from: string, parent: string, index?: number): string => {
    const props = source.node(from)!.props;
    mediaOf(props, report.images);
    const copyProps = { ...props };
    delete copyProps.preservedPatternSource;
    const id = target.create(source.type(from)!, parent, copyProps, index);
    map.set(from, id);
    copied.push([from, id]);
    for (const c of source.children(from)) copyTree(c, id);
    return id;
  };
  // The new page goes after the last user page.
  const afterUserPages = () => {
    let last = -1;
    target.children(target.root).forEach((p, i) => {
      if (!target.get(p, 'internal')) last = i;
    });
    return last + 1;
  };
  report.page = copyTree(page, target.root, afterUserPages());
  if (masters.size) {
    let compPage: string | null = null;
    for (const m of masters) {
      const k = source.get(m, 'key');
      const same = k ? tKey.get(k) : undefined;
      if (same && target.type(same) === source.type(m)) {
        map.set(m, same);
        // Set variants by key or name (copies inside reference them).
        for (const v of source.children(m)) {
          const tv = target.children(same).find((x) => (source.get(v, 'key') && target.get(x, 'key') === source.get(v, 'key')) || target.get(x, 'name') === source.get(v, 'name'));
          if (tv) map.set(v, tv);
        }
        report.reused++;
        continue;
      }
      // A library asset goes to the internal page (stays a library asset); a local one — to the components page.
      const fromLibrary = !!source.get(m, 'library') || !!source.get(source.parent(m) ?? '', 'internal');
      let parent = res;
      if (!fromLibrary) {
        const title = opts.componentsTitle ?? `Components — ${opts.sourceName}`;
        compPage ??= target.children(target.root).find((p) => target.get(p, 'name') === title && !target.get(p, 'internal')) ?? target.create('PAGE', target.root, { name: title }, afterUserPages());
        parent = compPage;
      }
      copyTree(m, parent);
      report.components++;
    }
  }

  // Motifs outside the transferred page remain hidden; shared and nested sources copy once.
  let motifPage: string | undefined;
  for (const motif of motifs) {
    if (map.has(motif)) continue;
    let covered = false;
    for (let parent = source.parent(motif); parent; parent = source.parent(parent)) if (motifs.has(parent)) { covered = true; break; }
    if (covered) continue;
    motifPage ??= target.children(target.root).find((id) => target.get(id, 'patternArchive')) ?? target.create('PAGE', target.root, { name: 'Источники узоров', internal: true, patternArchive: true });
    copyTree(motif, motifPage);
  }
  for (const [alias, actual] of motifAliases) if (map.has(actual)) map.set(alias, map.get(actual)!);

  // 5. The page's comments (this device's file — COMMENT nodes).
  const threads = commentPages(source).flatMap((p) => source.children(p)).filter((t) => source.type(t) === 'COMMENT' && threadPage(source, t) === page);
  if (threads.length) {
    let cp = commentPages(target)[0];
    cp ??= target.create('PAGE', target.root, { name: 'Комментарии', internal: true, commentsPage: true, backgrounds: [] });
    for (const t of threads) copyTree(t, cp);
    report.comments = threads.length;
  }

  // 6. References of the copies point to new ids; connections to things that do not exist are removed. Live — only
  // new nodes (in a copy of the file the same ids could point to something else).
  const fresh = new Set([...map.values()]);
  const fix = (from: string, to: string) => {
    const original = source.node(from)!.props;
    // Paths and glyphs use content-addressed blobs; moving IDs alone loses their geometry.
    for (const hash of blobRefs(original)) {
      const data = source.blob(hash);
      if (data !== undefined) target.putBlob(data);
    }
    mediaOf(original, report.images);
    const props = remapProps(original as Record<string, unknown>, map);
    if (original.preservedPatternSource) props.preservedPatternSource = undefined;
    if (props.reactions) {
      const reactions = (props.reactions as Reaction[])
        .map((r) => {
          const actions = (r.actions ?? []).filter((a) => {
            const dest = (a as { destinationId?: string | null }).destinationId;
            const ok = !dest || fresh.has(dest);
            if (!ok) report.droppedLinks++;
            return ok;
          });
          return { ...r, actions };
        })
        .filter((r) => r.actions.length);
      props.reactions = reactions.length ? reactions : undefined;
    }
    const cur = target.node(to)!.props as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) if (JSON.stringify(v) !== JSON.stringify(cur[k])) patch[k] = v;
    if (Object.keys(patch).length) target.set(to, patch as Props);
  };
  for (const [from, to] of [...copied, ...newStyles, ...newVars]) fix(from, to);
  // Flow starting points of the page — only onto copied nodes.
  const flows = target.get(report.page, 'flowStartingPoints');
  if (flows?.length) {
    const kept = flows.filter((f) => fresh.has(f.nodeId));
    if (kept.length !== flows.length) target.set(report.page, { flowStartingPoints: kept });
  }
  return report;
}
