// Developer mode in the document (as in the Plugin API): “Ready for development” and “Completed” statuses
// (devStatus), annotations with categories (annotations; categories live on the document) and measurements
// between layer edges (measurements — on the page).

import type { Document } from './document.ts';
import type { AnnotationCategory, AnnotationPropertyType, Matrix, Measurement, MeasurementSide } from './types.ts';

/** Default categories (when the file has none of its own). */
export const PRESET_CATEGORIES: readonly AnnotationCategory[] = Object.freeze([
  { id: 'development', label: 'Разработка', color: 'blue', isPreset: true },
  { id: 'interaction', label: 'Взаимодействие', color: 'violet', isPreset: true },
  { id: 'accessibility', label: 'Доступность', color: 'green', isPreset: true },
  { id: 'content', label: 'Контент', color: 'orange', isPreset: true },
  { id: 'behavior', label: 'Поведение', color: 'teal', isPreset: true },
] as AnnotationCategory[]);

/** Category colors (CSS). */
export const ANNOTATION_COLORS: Record<AnnotationCategory['color'], string> = {
  yellow: '#f5c400',
  orange: '#ff8a00',
  red: '#e5484d',
  pink: '#ee46d3',
  violet: '#9b5de5',
  blue: '#3d7cf5',
  teal: '#1a9fa6',
  green: '#2fb36b',
};

export function annotationCategories(doc: Document): AnnotationCategory[] {
  const own = doc.get(doc.root, 'annotationCategories');
  return own?.length ? [...own] : [...PRESET_CATEGORIES];
}

export function categoryOf(doc: Document, id: string | undefined): AnnotationCategory | null {
  if (!id) return null;
  return annotationCategories(doc).find((c) => c.id === id) ?? null;
}

/** Properties that can be pinned in an annotation for a layer of this type. */
export function annotationProperties(type: string, autoLayout: boolean): AnnotationPropertyType[] {
  const base: AnnotationPropertyType[] = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'opacity', 'effects'];
  if (type === 'TEXT') return [...base, 'fills', 'textStyleId', 'fontFamily', 'fontStyle', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlignHorizontal'];
  const shape: AnnotationPropertyType[] = [...base, 'fills', 'strokes', 'strokeWeight', 'cornerRadius'];
  if (type === 'INSTANCE') shape.push('mainComponent');
  if (autoLayout) shape.push('layoutMode', 'itemSpacing', 'padding', 'alignItems');
  return shape;
}

export const ANNOTATION_PROPERTY_LABELS: Record<AnnotationPropertyType, string> = {
  width: 'Ширина',
  height: 'Высота',
  minWidth: 'Мин. ширина',
  maxWidth: 'Макс. ширина',
  minHeight: 'Мин. высота',
  maxHeight: 'Макс. высота',
  fills: 'Заливка',
  strokes: 'Обводка',
  effects: 'Эффекты',
  strokeWeight: 'Толщина обводки',
  cornerRadius: 'Скругление',
  textStyleId: 'Стиль текста',
  textAlignHorizontal: 'Выравнивание',
  fontFamily: 'Шрифт',
  fontStyle: 'Начертание',
  fontSize: 'Кегль',
  fontWeight: 'Насыщенность',
  lineHeight: 'Интерлиньяж',
  letterSpacing: 'Разрядка',
  itemSpacing: 'Промежуток',
  padding: 'Отступы',
  layoutMode: 'Auto layout',
  alignItems: 'Выравнивание',
  opacity: 'Непрозрачность',
  mainComponent: 'Компонент',
  gridRowGap: 'Промежуток строк',
  gridColumnGap: 'Промежуток колонок',
  gridRowCount: 'Строк',
  gridColumnCount: 'Колонок',
  gridRowAnchorIndex: 'Строка',
  gridColumnAnchorIndex: 'Колонка',
  gridRowSpan: 'Строк занимает',
  gridColumnSpan: 'Колонок занимает',
};

/**
 * Layers with a status on the page: top-level frames and sections and frames inside sections (like
 * the “Ready for development” list in developer mode), top to bottom and left to right.
 */
export function devStatusNodes(doc: Document, page: string): string[] {
  const out: string[] = [];
  const walk = (p: string, depth: number) => {
    for (const id of doc.children(p)) {
      if (doc.get(id, 'devStatus')) out.push(id);
      if (doc.type(id) === 'SECTION' && depth < 4) walk(id, depth + 1);
    }
  };
  walk(page, 0);
  const pos = (id: string) => pageBounds(doc, id) ?? [0, 0, 0, 0];
  return out.sort((a, b) => pos(a)[1] - pos(b)[1] || pos(a)[0] - pos(b)[0]);
}

const I: Matrix = [1, 0, 0, 0, 1, 0];

/** Layer bounds in page coordinates (by corners, with rotation). */
export function pageBounds(doc: Document, id: string): [number, number, number, number] | null {
  if (!doc.has(id)) return null;
  let m = I;
  for (let c: string | null = id; c && doc.type(c) !== 'PAGE'; c = doc.parent(c)) {
    const t = (doc.get(c, 'transform') ?? I) as Matrix;
    m = [t[0] * m[0] + t[1] * m[3], t[0] * m[1] + t[1] * m[4], t[0] * m[2] + t[1] * m[5] + t[2], t[3] * m[0] + t[4] * m[3], t[3] * m[1] + t[4] * m[4], t[3] * m[2] + t[4] * m[5] + t[5]];
  }
  const w = doc.get(id, 'width') ?? 0;
  const h = doc.get(id, 'height') ?? 0;
  const pts = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ].map(([x, y]) => [m[0] * x! + m[1] * y! + m[2], m[3] * x! + m[4] * y! + m[5]] as const);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

const horizontal = (s: MeasurementSide) => s === 'LEFT' || s === 'RIGHT';

/**
 * Measurement on a page: the distance between layer sides and a segment to draw. The sides are
 * on the same axis (left/right or top/bottom); offset: INNER — a fraction along the first layer,
 * OUTER — this many px outside both.
 */
export function measurementGeometry(doc: Document, m: Measurement): { value: number; a: [number, number]; b: [number, number] } | null {
  const A = pageBounds(doc, m.start.node);
  const B = pageBounds(doc, m.end.node);
  if (!A || !B || horizontal(m.start.side) !== horizontal(m.end.side)) return null;
  const edge = (r: [number, number, number, number], s: MeasurementSide) => (s === 'LEFT' ? r[0] : s === 'RIGHT' ? r[2] : s === 'TOP' ? r[1] : r[3]);
  const va = edge(A, m.start.side);
  const vb = edge(B, m.end.side);
  if (horizontal(m.start.side)) {
    const y = m.offset.type === 'INNER' ? A[1] + (A[3] - A[1]) * m.offset.relative : Math.min(A[1], B[1]) - m.offset.fixed;
    return { value: Math.abs(vb - va), a: [va, y], b: [vb, y] };
  }
  const x = m.offset.type === 'INNER' ? A[0] + (A[2] - A[0]) * m.offset.relative : Math.min(A[0], B[0]) - m.offset.fixed;
  return { value: Math.abs(vb - va), a: [x, va], b: [x, vb] };
}

export function measurementsOf(doc: Document, page: string): Measurement[] {
  return (doc.get(page, 'measurements') ?? []).filter((m) => doc.has(m.start.node) && doc.has(m.end.node));
}

export function addMeasurement(doc: Document, page: string, start: Measurement['start'], end: Measurement['end'], opts: { offset?: Measurement['offset']; freeText?: string } = {}): Measurement {
  const m: Measurement = { id: doc.newId(), start, end, offset: opts.offset ?? { type: 'INNER', relative: 0.5 }, freeText: opts.freeText ?? '' };
  doc.set(page, { measurements: [...(doc.get(page, 'measurements') ?? []), m] });
  return m;
}

export function editMeasurement(doc: Document, page: string, id: string, patch: { offset?: Measurement['offset']; freeText?: string }) {
  doc.set(page, { measurements: (doc.get(page, 'measurements') ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)) });
}

export function deleteMeasurement(doc: Document, page: string, id: string) {
  doc.set(page, { measurements: (doc.get(page, 'measurements') ?? []).filter((m) => m.id !== id) });
}

// ---------- Annotation text: HTML from .fig → Markdown ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m)));

/** Annotation label from .fig (paragraphs, links, bold, italic, code, lists) → Markdown. */
export function htmlToMarkdown(html: string): string {
  let s = html.replace(/\r/g, '');
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const t = decode(text.replace(/<[^>]+>/g, ''));
    const u = decode(href);
    return t === u ? u : `[${t}](${u})`;
  });
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '_$2_').replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<li[^>]*>/gi, '- ').replace(/<\/li>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*/gi, '\n\n').replace(/<p[^>]*>/gi, '');
  s = decode(s.replace(/<[^>]+>/g, ''));
  return s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

// ---------- Comparing layer versions ----------

/** Derived data: changes together with the primary data and only clutters the change list. */
// The status is an internal mark (it also holds a link to the compared version itself), also not a design change.
const DERIVED = new Set(['textGlyphs', 'vectorPaths', 'strokePaths', 'centerPaths', 'geometrySize', 'overrides', 'componentRef', 'devStatus']);

export interface NodeDiff {
  /** Present only in the new version / only in the old one. */
  added: string[];
  removed: string[];
  /** Properties changed (property names). */
  changed: { id: string; keys: string[] }[];
}

/** What changed in the subtree of layer root between document versions (by node id). */
export function diffSubtree(before: Document, after: Document, root: string): NodeDiff {
  const ids = (doc: Document) => (doc.has(root) ? new Set([root, ...doc.descendants(root)]) : new Set<string>());
  const a = ids(before);
  const b = ids(after);
  const out: NodeDiff = { added: [], removed: [], changed: [] };
  for (const id of b) if (!a.has(id)) out.added.push(id);
  for (const id of a) if (!b.has(id)) out.removed.push(id);
  for (const id of b) {
    if (!a.has(id)) continue;
    const pa = before.node(id)!.props as Record<string, unknown>;
    const pb = after.node(id)!.props as Record<string, unknown>;
    const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    const diff: string[] = [];
    for (const k of keys) {
      if (DERIVED.has(k)) continue;
      if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) diff.push(k);
    }
    // Child order is also a change (on the parent).
    if (before.parent(id) !== after.parent(id) || before.node(id)!.index !== after.node(id)!.index) diff.push('index');
    if (diff.length) out.changed.push({ id, keys: diff });
  }
  return out;
}
