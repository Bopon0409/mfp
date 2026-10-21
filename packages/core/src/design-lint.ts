// Design lint: what is set manually in the design although the design system
// has the same thing, and what is broken.
// - a fill or stroke color matches a color variable (in the layer's mode) or a color style;
// - a corner radius, gap or padding matches a number variable with a suitable scope;
// - low text-to-background contrast (WCAG: 4.5:1, large text — 3:1);
// - a frame detached from a component;
// - a binding to a deleted variable or style.
// Most have a one-click fix (bind, apply a style, replace with an instance).

import { instantiate, propertyDefinitions } from './components.ts';
import type { Document } from './document.ts';
import { applyStyle, localStyles, STYLE_FIELD_NAMES } from './styles.ts';
import type { Paint, Props, RGB, RGBA } from './types.ts';
import { bindVariable, collectionOf, isColor, localVariables, paintWithVariable, resolveVariable, variableAllowed } from './variables.ts';

export type LintKind = 'color' | 'number' | 'contrast' | 'detached' | 'missing' | 'slot' | 'length';

export interface LintIssue {
  id: string;
  kind: LintKind;
  message: string;
  /** Fix (if any): label and action (call inside a transaction). */
  fix?: { label: string; apply(doc: Document): void };
}

const hex = (c: RGB) => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const colorKey = (c: RGB, a = 1) => `${hex(c)}${Math.round(a * 255)}`;

/** Relative luminance (WCAG). */
function luminance(c: RGB): number {
  const ch = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** Contrast of two colors (1–21). */
export function contrastRatio(a: RGB, b: RGB): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** A color over a background, with transparency. */
const over = (fg: RGB, a: number, bg: RGB): RGB => ({ r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) });

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2], a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];

/** Layer bounds on the page (cache for one check). */
class Boxes {
  private world = new Map<string, M>();
  private doc: Document;
  constructor(doc: Document) {
    this.doc = doc;
  }
  matrix(id: string): M {
    let m = this.world.get(id);
    if (!m) {
      const own = (this.doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as M;
      const p = this.doc.parent(id);
      m = p && this.doc.type(p) !== 'PAGE' && this.doc.type(p) !== 'DOCUMENT' ? mul(this.matrix(p), own) : own;
      this.world.set(id, m);
    }
    return m;
  }
  /** Axis-aligned box: [x0, y0, x1, y1]. */
  box(id: string): [number, number, number, number] {
    const m = this.matrix(id);
    const w = this.doc.get(id, 'width') ?? 0;
    const hh = this.doc.get(id, 'height') ?? 0;
    const xs = [0, w, 0, w].map((x, i) => m[0] * x + m[1] * [0, 0, hh, hh][i]! + m[2]);
    const ys = [0, w, 0, w].map((x, i) => m[3] * x + m[4] * [0, 0, hh, hh][i]! + m[5]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
}

/** The layer's topmost visible fill: color; null — not solid (image, gradient); undefined — no fills. */
function topFill(doc: Document, id: string): RGB | null | undefined {
  const fills = (doc.get(id, 'fills') ?? []).filter((f) => f.visible !== false && (f.opacity ?? 1) > 0.01);
  const top = fills[fills.length - 1];
  if (!top) return undefined;
  return top.type === 'SOLID' && (top.opacity ?? 1) >= 0.99 ? top.color : null;
}

/** What is visible at a point inside the subtree (top to bottom): color; null — not solid; undefined — nothing. */
function paintAt(doc: Document, boxes: Boxes, id: string, x: number, y: number): RGB | null | undefined {
  if (doc.get(id, 'visible') === false || (doc.get(id, 'opacity') ?? 1) < 0.5) return undefined;
  const t = doc.type(id);
  if (t === 'TEXT' || t === 'LINE' || t === 'VECTOR' || t === 'STAR' || t === 'POLYGON' || t === 'BOOLEAN_OPERATION') return undefined;
  const [x0, y0, x1, y1] = boxes.box(id);
  const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (!inside && t !== 'GROUP') return undefined;
  const kids = doc.children(id);
  for (let i = kids.length - 1; i >= 0; i--) {
    const r = paintAt(doc, boxes, kids[i]!, x, y);
    if (r !== undefined) return r;
  }
  return inside ? topFill(doc, id) : undefined;
}

/** Background under the layer at its center: layers below (siblings and their descendants), then ancestors; a page — its background. */
function backdrop(doc: Document, boxes: Boxes, id: string): RGB | null {
  const [x0, y0, x1, y1] = boxes.box(id);
  const [x, y] = [(x0 + x1) / 2, (y0 + y1) / 2];
  let cur = id;
  for (let p = doc.parent(id); p; cur = p, p = doc.parent(p)) {
    if (doc.type(p) === 'PAGE') {
      const sibs = doc.children(p);
      for (let j = sibs.indexOf(cur) - 1; j >= 0; j--) {
        const r = paintAt(doc, boxes, sibs[j]!, x, y);
        if (r !== undefined) return r;
      }
      const bg = doc.get(p, 'backgrounds')?.[0];
      return bg?.type === 'SOLID' ? bg.color : { r: 0.96, g: 0.96, b: 0.96 };
    }
    const sibs = doc.children(p);
    for (let j = sibs.indexOf(cur) - 1; j >= 0; j--) {
      const r = paintAt(doc, boxes, sibs[j]!, x, y);
      if (r !== undefined) return r;
    }
    const own = topFill(doc, p);
    if (own !== undefined) return own;
  }
  return null;
}

/** Text length for limits: characters without line breaks (graphemes, as the reader sees them). */
export function textLength(chars: string): number {
  const text = chars.replace(/\n/g, '');
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<unknown> } }).Segmenter;
  if (!Seg) return [...text].length;
  let n = 0;
  for (const _ of new Seg(undefined, { granularity: 'grapheme' }).segment(text)) n++;
  return n;
}

/** Numeric fields checked against variables. */
const NUMBER_FIELDS = ['cornerRadius', 'itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'strokeWeight'] as const;

/** Check a page (or any node). limit — at most this many issues. */
export function lintDesign(doc: Document, root: string, limit = 2000): LintIssue[] {
  const out: LintIssue[] = [];
  const boxes = new Boxes(doc);
  // Variable colors in all modes → variables (candidates; checked in the layer's mode).
  const colorVars = new Map<string, string[]>();
  const numberVars = new Map<number, string[]>();
  for (const v of localVariables(doc)) {
    const coll = collectionOf(doc, v);
    const modes = coll ? (doc.get(coll, 'modes') ?? []).map((m) => m.modeId) : [''];
    for (const m of modes) {
      const val = resolveVariable(doc, v, null, 0, coll ? { [coll]: m } : undefined);
      if (isColor(val)) {
        const k = colorKey(val, val.a ?? 1);
        const list = colorVars.get(k) ?? [];
        if (!list.includes(v)) list.push(v);
        colorVars.set(k, list);
      } else if (typeof val === 'number') {
        const list = numberVars.get(val) ?? [];
        if (!list.includes(v)) list.push(v);
        numberVars.set(val, list);
      }
    }
  }
  // Solid color styles → style.
  const colorStyles = new Map<string, string>();
  for (const s of localStyles(doc, 'PAINT')) {
    const fills = doc.get(s, 'fills') ?? [];
    if (fills.length === 1 && fills[0]!.type === 'SOLID') colorStyles.set(colorKey(fills[0]!.color, fills[0]!.opacity ?? 1), s);
  }
  const name = (id: string) => doc.get(id, 'name') ?? '';
  const push = (i: LintIssue) => out.length < limit && out.push(i);
  const visit = (id: string, inInstance: boolean) => {
    const t = doc.type(id)!;
    const p = doc.node(id)!.props as Props;
    // Inside instances values come from the master: fix the master (except local edits).
    const own = !inInstance || (p.overrides?.length ?? 0) > 0;
    if (own && t !== 'PAGE' && t !== 'COMPONENT_SET') {
      // Paint colors.
      for (const key of ['fills', 'strokes'] as const) {
        const field = key === 'fills' ? 'fillStyleId' : 'strokeStyleId';
        if (p[field] && doc.has(p[field]!)) continue;
        (p[key] ?? []).forEach((paint: Paint, i: number) => {
          if (paint.type !== 'SOLID' || paint.visible === false || paint.boundVariables?.color) return;
          const k = colorKey(paint.color, paint.opacity ?? 1);
          const vars = (colorVars.get(k) ?? []).filter((v) => variableAllowed(doc, v, key, t)).filter((v) => {
            const r = resolveVariable(doc, v, id);
            return isColor(r) && colorKey(r, r.a ?? 1) === k;
          });
          const style = colorStyles.get(k);
          if (vars.length) {
            const v = vars[0]!;
            push({
              id,
              kind: 'color',
              message: `${key === 'fills' ? 'Заливка' : 'Обводка'} ${hex(paint.color)} — как переменная «${name(v)}»`,
              fix: {
                label: 'Привязать',
                apply: (d) => {
                  const list = [...((d.get(id, key) ?? []) as Paint[])];
                  if (!list[i]) return;
                  list[i] = paintWithVariable(d, list[i]!, v, id);
                  d.set(id, { [key]: list } as Props);
                },
              },
            });
          } else if (style) {
            push({ id, kind: 'color', message: `${key === 'fills' ? 'Заливка' : 'Обводка'} ${hex(paint.color)} — как стиль «${name(style)}»`, fix: { label: 'Применить стиль', apply: (d) => applyStyle(d, id, field, style) } });
          }
        });
      }
      // Numbers.
      for (const f of NUMBER_FIELDS) {
        const v = p[f] as number | undefined;
        if (typeof v !== 'number' || v <= 0 || p.boundVariables?.[f]) continue;
        const vars = (numberVars.get(v) ?? []).filter((x) => variableAllowed(doc, x, f, t) && resolveVariable(doc, x, id) === v);
        if (!vars.length) continue;
        const x = vars[0]!;
        push({ id, kind: 'number', message: `${FIELD_LABEL[f]} ${v} — как переменная «${name(x)}»`, fix: { label: 'Привязать', apply: (d) => bindVariable(d, id, f, x) } });
      }
    }
    // Text contrast.
    if (t === 'TEXT' && p.visible !== false) {
      const fill = (doc.get(id, 'fills') ?? []).filter((f) => f.visible !== false).at(-1);
      const bg = backdrop(doc, boxes, id);
      if (fill?.type === 'SOLID' && bg) {
        const fg = over(fill.color, (fill.opacity ?? 1) * (doc.get(id, 'opacity') ?? 1), bg);
        const ratio = contrastRatio(fg, bg);
        const size = doc.get(id, 'fontSize') ?? 12;
        const bold = /bold|black|heavy|semi/i.test(doc.get(id, 'fontName')?.style ?? '');
        const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
        if (ratio < need) push({ id, kind: 'contrast', message: `Контраст ${ratio.toFixed(1)}:1 — нужно не меньше ${need}:1 (${hex(fill.color)} на ${hex(bg)})` });
      }
    }
    // Detached component.
    const from = p.detachedFrom;
    if (from) {
      const alive = doc.has(from) && doc.type(from) === 'COMPONENT';
      push({
        id,
        kind: 'detached',
        message: alive ? `Отсоединён от компонента «${name(from)}»` : 'Отсоединён от компонента (его больше нет)',
        fix: alive ? { label: 'Заменить инстансом', apply: (d) => replaceWithInstance(d, id, from) } : undefined,
      });
    }
    // Text length limit (our own): longer than the maximum or shorter than the minimum.
    if (t === 'TEXT') {
      const len = textLength(p.characters ?? '');
      if (p.textMaxLength && len > p.textMaxLength) push({ id, kind: 'length', message: `Текст ${len} симв. — лимит ${p.textMaxLength} (лишних ${len - p.textMaxLength})` });
      if (p.textMinLength && len < p.textMinLength) push({ id, kind: 'length', message: `Текст ${len} симв. — нужно не меньше ${p.textMinLength}` });
    }
    // Slot in an instance: how many items may be placed.
    const slotKey = p.componentRef ? p.componentPropertyReferences?.slot : undefined;
    if (slotKey) {
      let owner: string | null = null;
      for (let q = doc.parent(id); q; q = doc.parent(q)) if (doc.type(q) === 'INSTANCE') {
        owner = q;
        break;
      }
      const comp = owner ? doc.get(owner, 'componentId') : null;
      const def = comp ? propertyDefinitions(doc, comp)[slotKey] : undefined;
      const n = doc.children(id).length;
      if (def?.minChildren && n < def.minChildren) push({ id, kind: 'slot', message: `В слоте «${name(id)}» ${n}, нужно не меньше ${def.minChildren}` });
      if (def?.maxChildren && n > def.maxChildren) push({ id, kind: 'slot', message: `В слоте «${name(id)}» ${n}, можно не больше ${def.maxChildren}` });
    }
    // Deleted variables and styles.
    for (const [f, a] of Object.entries(p.boundVariables ?? {})) {
      if (!doc.has(a.id)) push({ id, kind: 'missing', message: `Поле «${f}» привязано к удалённой переменной`, fix: { label: 'Отвязать', apply: (d) => bindVariable(d, id, f, null) } });
    }
    for (const f of STYLE_FIELD_NAMES) {
      const s = p[f];
      if (s && !doc.has(s)) push({ id, kind: 'missing', message: 'Стиль удалён', fix: { label: 'Отвязать', apply: (d) => d.set(id, { [f]: '' } as Props) } });
    }
    const nested = inInstance || t === 'INSTANCE';
    for (const c of doc.children(id)) visit(c, nested);
  };
  for (const c of doc.children(root)) visit(c, doc.type(root) === 'INSTANCE');
  return out;
}

const FIELD_LABEL: Record<(typeof NUMBER_FIELDS)[number], string> = {
  cornerRadius: 'Скругление',
  itemSpacing: 'Промежуток',
  counterAxisSpacing: 'Промежуток строк',
  paddingLeft: 'Отступ слева',
  paddingRight: 'Отступ справа',
  paddingTop: 'Отступ сверху',
  paddingBottom: 'Отступ снизу',
  strokeWeight: 'Толщина обводки',
};

/** Replace a detached frame with a component instance (same position and size). */
export function replaceWithInstance(doc: Document, frame: string, component: string): string {
  const parent = doc.parent(frame)!;
  const index = doc.children(parent).indexOf(frame);
  const inst = instantiate(doc, component, parent, doc.get(frame, 'transform') ?? [1, 0, 0, 0, 1, 0], index);
  const own: Props = { name: doc.get(frame, 'name') };
  const w = doc.get(frame, 'width');
  const hh = doc.get(frame, 'height');
  if (w !== doc.get(component, 'width') || hh !== doc.get(component, 'height')) Object.assign(own, { width: w, height: hh });
  for (const k of ['layoutGrow', 'layoutAlign', 'layoutPositioning', 'constraints'] as const) {
    const v = doc.node(frame)!.props[k];
    if (v !== undefined) (own as Record<string, unknown>)[k] = v;
  }
  doc.set(inst, own);
  doc.delete(frame);
  return inst;
}

export const LINT_LABEL: Record<LintKind, string> = {
  color: 'Цвета не из дизайн-системы',
  number: 'Числа не из переменных',
  contrast: 'Слабый контраст текста',
  detached: 'Отсоединённые компоненты',
  missing: 'Удалённые переменные и стили',
  slot: 'Слоты',
  length: 'Длина текста',
};

export type { RGBA };
