// Annotations (developer mode): notes on layers — Markdown text, category (color), pinned
// properties (their values are shown alongside and change with the layer). Visible in developer
// mode and via “View → Annotations and measurements”. Tool T (in developer mode):
// click a layer — new annotation; click a callout — edit.

import {
  ANNOTATION_COLORS,
  ANNOTATION_PROPERTY_LABELS,
  annotationCategories,
  annotationProperties,
  categoryOf,
  type Annotation,
  type AnnotationCategory,
  type AnnotationPropertyType,
  type Op,
} from '@mfp/core';
import { formatColor, inspectNode, isAutoLayout } from '@mfp/editing';
import type { Canvas, Paint } from 'canvaskit-wasm';
import { closePopover, h, iconBtn, popover } from './dom.ts';
import type { Editor } from './editor.ts';

export interface AnnotationsHooks {
  /** Layer under the point (as in developer mode: the deepest one, an icon as a whole). */
  pick(x: number, y: number): string | null;
  notify(message: string): void;
}

const W = 240;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Annotation Markdown into safe elements (no innerHTML): paragraphs, lists, bold, italic, code, links. */
export function renderMarkdown(md: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const block of md.split(/\n{2,}/)) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
      frag.append(h('ul', {}, ...lines.map((l) => h('li', {}, ...inline(l.replace(/^\s*[-*•]\s+/, ''))))));
      continue;
    }
    const p = h('p');
    lines.forEach((l, i) => {
      if (i) p.append(h('br'));
      p.append(...inline(l));
    });
    frag.append(p);
  }
  return frag;
}

function inline(s: string): Node[] {
  const out: Node[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?:^|(?<=\s))_([^_]+)_|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) out.push(document.createTextNode(s.slice(last, m.index)));
    if (m[1] !== undefined) out.push(h('code', {}, m[1]));
    else if (m[2] !== undefined) out.push(h('strong', {}, m[2]));
    else if (m[3] !== undefined || m[4] !== undefined) out.push(h('em', {}, (m[3] ?? m[4])!));
    else if (m[5] !== undefined) out.push(h('a', { href: m[6], target: '_blank', rel: 'noopener noreferrer' }, m[5]));
    else if (m[7] !== undefined) out.push(h('a', { href: m[7], target: '_blank', rel: 'noopener noreferrer' }, m[7]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(document.createTextNode(s.slice(last)));
  return out;
}

export class Annotations {
  private ed: Editor;
  private hooks: AnnotationsHooks;
  private layer: HTMLElement;
  /** Show outside developer mode too (“View” menu). */
  shown = false;
  /** Page layers with annotations (null — recompute). */
  private cache: string[] | null = null;
  private els = new Map<string, HTMLElement>();
  private paints = new Map<string, Paint>();
  /** Open editor: layer and annotation index. */
  private editing: { id: string; index: number } | null = null;

  constructor(ed: Editor, hooks: AnnotationsHooks, stage: HTMLElement) {
    this.ed = ed;
    this.hooks = hooks;
    this.layer = h('div', { id: 'annotations' });
    stage.append(this.layer);
    ed.overlays.push((canvas) => this.draw(canvas));
    ed.onPage.push(() => {
      this.cache = null;
      closePopover();
    });
    ed.onDocument.push((ops) => this.changed(ops));
  }

  get visible() {
    return this.ed.devMode || this.shown;
  }

  toggle() {
    this.shown = !this.shown;
    this.ed.dirty = true;
    this.hooks.notify(this.shown ? 'Аннотации и измерения видны и в режиме дизайна' : 'Аннотации и измерения — только в режиме разработчика');
  }

  private changed(ops: Op[]) {
    if (!this.cache) return;
    for (const o of ops) {
      if ((o.op === 'set' && 'annotations' in o.props) || (o.op === 'create' && o.props.annotations) || o.op === 'delete' || o.op === 'move') {
        this.cache = null;
        return;
      }
    }
  }

  private annotated(): string[] {
    if (this.cache) return this.cache;
    const doc = this.ed.doc;
    const out: string[] = [];
    for (const id of doc.descendants(this.ed.pageId)) if (doc.get(id, 'annotations')?.length) out.push(id);
    return (this.cache = out);
  }

  // ---------- “Annotation” tool ----------

  down(e: PointerEvent, x: number, y: number): boolean {
    if (this.ed.tool !== 'annotate') return false;
    if (e.button !== 0) return true;
    const id = this.hooks.pick(x, y);
    if (!id) {
      this.hooks.notify('Щёлкните по слою, чтобы добавить к нему аннотацию');
      return true;
    }
    this.add(id);
    return true;
  }

  move(): boolean {
    return this.ed.tool === 'annotate';
  }

  up(): boolean {
    return this.ed.tool === 'annotate';
  }

  /** New annotation on a layer — and edit it right away. */
  add(id: string) {
    const doc = this.ed.doc;
    const list = [...(doc.get(id, 'annotations') ?? [])];
    const cat = annotationCategories(doc)[0];
    list.push({ labelMarkdown: '', ...(cat ? { categoryId: cat.id } : {}) });
    doc.set(id, { annotations: list });
    this.ed.select([id]);
    this.cache = null;
    this.ed.dirty = true;
    // The callout appears on the next frame — then the edit window.
    setTimeout(() => this.edit(id, list.length - 1), 60);
  }

  /** Annotation edit window (at the callout or at the layer). */
  edit(id: string, index: number) {
    const doc = this.ed.doc;
    const ann = doc.get(id, 'annotations')?.[index];
    if (!ann) return;
    const anchor = this.els.get(`${id}#${index}`) ?? this.ed.canvasEl;
    this.editing = { id, index };
    const update = (patch: Partial<Annotation>) => {
      const list = [...(doc.get(id, 'annotations') ?? [])];
      if (!list[index]) return;
      list[index] = clean({ ...list[index]!, ...patch });
      doc.set(id, { annotations: list });
    };
    const remove = () => {
      const list = (doc.get(id, 'annotations') ?? []).filter((_, i) => i !== index);
      doc.set(id, { annotations: list.length ? list : undefined });
      close();
    };
    const { box, close } = popover(anchor, 'ann-pop', {
      width: 300,
      side: 'left',
      onClose: () => {
        this.editing = null;
        // An empty annotation (no text, no properties) is not kept.
        const a = doc.get(id, 'annotations')?.[index];
        if (a && !a.labelMarkdown?.trim() && !a.properties?.length) {
          const list = (doc.get(id, 'annotations') ?? []).filter((_, i) => i !== index);
          doc.set(id, { annotations: list.length ? list : undefined });
        }
      },
    });
    const cats = annotationCategories(doc);
    const catSel = h('select', { class: 'dv-select', 'aria-label': 'Категория' }, h('option', { value: '' }, 'Без категории'), ...cats.map((c) => h('option', { value: c.id, selected: c.id === ann.categoryId }, c.label))) as HTMLSelectElement;
    catSel.addEventListener('change', () => update({ categoryId: catSel.value || undefined }));
    const text = h('textarea', { class: 'cfield ann-text', rows: 4, placeholder: 'Текст: **жирный**, _курсив_, `код`, [ссылка](https://…)', 'aria-label': 'Текст аннотации' }) as HTMLTextAreaElement;
    text.value = ann.labelMarkdown ?? '';
    text.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
    });
    text.addEventListener('input', () => update({ labelMarkdown: text.value }));
    const type = doc.type(id)!;
    const props = annotationProperties(type, isAutoLayout(doc, id));
    const pinned = new Set((ann.properties ?? []).map((p) => p.type));
    const checks = props.map((p) => {
      const cb = h('input', { type: 'checkbox', checked: pinned.has(p) }) as HTMLInputElement;
      cb.addEventListener('change', () => {
        if (cb.checked) pinned.add(p);
        else pinned.delete(p);
        update({ properties: props.filter((x) => pinned.has(x)).map((t) => ({ type: t })) });
      });
      return h('label', { class: 'ann-check' }, cb, h('span', {}, ANNOTATION_PROPERTY_LABELS[p]));
    });
    box.append(
      h('div', { class: 'ann-pop-head' }, h('span', { class: 'ann-pop-title' }, 'Аннотация'), catSel, iconBtn('settings', 'Категории…', (e) => this.categories(e.currentTarget as HTMLElement))),
      text,
      h('div', { class: 'ann-pop-sub' }, 'Свойства рядом с текстом'),
      h('div', { class: 'ann-checks' }, ...checks),
      h('div', { class: 'cacts' }, h('button', { class: 'cbtn danger', onclick: remove }, 'Удалить'), h('button', { class: 'cbtn primary', onclick: () => close() }, 'Готово')),
    );
    setTimeout(() => text.focus());
  }

  /** Annotation categories: name, color, new ones and deleting custom ones. */
  private categories(anchor: HTMLElement) {
    const doc = this.ed.doc;
    const save = (list: AnnotationCategory[]) => doc.set(doc.root, { annotationCategories: list });
    const { box } = popover(anchor, 'ann-cats', { width: 260 });
    const render = () => {
      const list = annotationCategories(doc);
      box.replaceChildren(
        h('div', { class: 'ann-pop-title' }, 'Категории аннотаций'),
        ...list.map((c, i) => {
          const name = h('input', { class: 'cfield', value: c.label, 'aria-label': 'Название категории' }) as HTMLInputElement;
          name.addEventListener('keydown', (e) => e.stopPropagation());
          name.addEventListener('change', () => save(list.map((x, k) => (k === i ? { ...x, label: name.value.trim() || x.label, isPreset: false } : x))));
          const color = h('select', { class: 'dv-select', 'aria-label': 'Цвет' }, ...(Object.keys(ANNOTATION_COLORS) as AnnotationCategory['color'][]).map((k) => h('option', { value: k, selected: k === c.color }, k))) as HTMLSelectElement;
          color.style.color = ANNOTATION_COLORS[c.color];
          color.addEventListener('change', () => {
            save(list.map((x, k) => (k === i ? { ...x, color: color.value as AnnotationCategory['color'] } : x)));
            render();
          });
          const del = iconBtn('trash', 'Удалить категорию', () => {
            save(list.filter((_, k) => k !== i));
            render();
          });
          return h('div', { class: 'ann-cat' }, h('span', { class: 'ann-dot', style: `background:${ANNOTATION_COLORS[c.color]}` }), name, color, del);
        }),
        h(
          'button',
          {
            class: 'cbtn',
            onclick: () => {
              save([...list, { id: doc.newId(), label: 'Новая категория', color: 'yellow', isPreset: false }]);
              render();
            },
          },
          '+ Категория',
        ),
      );
    };
    render();
  }

  // ---------- Callouts on the canvas ----------

  /** Value of a pinned property for the callout. */
  private value(id: string, type: AnnotationPropertyType): string {
    const doc = this.ed.doc;
    const s = inspectNode(doc, id);
    const fill = (fills: typeof s.fills) => {
      const f = fills[0];
      if (!f) return '—';
      return f.kind === 'solid' ? (f.color.token?.name ?? formatColor(f.color)) : f.kind === 'image' ? 'картинка' : 'градиент';
    };
    switch (type) {
      case 'width':
        return String(r2(s.width.value));
      case 'height':
        return String(r2(s.height.value));
      case 'minWidth':
      case 'maxWidth':
      case 'minHeight':
      case 'maxHeight':
        return s.limits[type] ? String(r2(s.limits[type]!.value)) : '—';
      case 'fills':
        return fill(s.text ? s.text.fills : s.fills);
      case 'strokes':
        return s.stroke ? fill(s.stroke.fills) : '—';
      case 'strokeWeight':
        return s.stroke ? ('value' in s.stroke.weight ? String(r2(s.stroke.weight.value)) : 'по сторонам') : '—';
      case 'cornerRadius':
        return s.radius === 'ellipse' ? 'эллипс' : s.radius ? String(r2(s.radius.tl.value)) : '0';
      case 'effects':
        return s.shadows.length ? s.shadows.map((x) => `${x.inset ? 'внутр. ' : ''}тень ${r2(x.x)}, ${r2(x.y)}, ${r2(x.blur)}`).join('; ') : s.blur ? `размытие ${r2(s.blur)}` : '—';
      case 'opacity':
        return `${Math.round(s.opacity.value * 100)}%`;
      case 'textStyleId':
        return s.text?.textStyle ?? '—';
      case 'textAlignHorizontal':
        return s.text ? { left: 'влево', center: 'по центру', right: 'вправо', justify: 'по ширине' }[s.text.align] : '—';
      case 'fontFamily':
        return s.text?.family ?? '—';
      case 'fontStyle':
        return s.text?.style ?? '—';
      case 'fontSize':
        return s.text ? String(r2(s.text.size.value)) : '—';
      case 'fontWeight':
        return s.text ? String(s.text.weight) : '—';
      case 'lineHeight':
        return s.text?.lineHeight ? `${r2(s.text.lineHeight.value)}${s.text.lineHeight.unit === 'PERCENT' ? '%' : ''}` : 'авто';
      case 'letterSpacing':
        return s.text ? String(r2(s.text.letterSpacing.value)) : '—';
      case 'itemSpacing':
        return s.layout ? String(r2(s.layout.gap.value)) : '—';
      case 'padding': {
        const P = s.layout?.padding;
        return P ? [P.top, P.right, P.bottom, P.left].map((v) => r2(v.value)).join(' ') : '—';
      }
      case 'layoutMode':
        return s.layout ? { row: 'в строку', column: 'в столбец', grid: 'сеткой' }[s.layout.direction] : 'нет';
      case 'alignItems':
        return s.layout ? `${s.layout.justify} / ${s.layout.align}` : '—';
      case 'mainComponent':
        return s.component ?? '—';
      default:
        return '—';
    }
  }

  private paint(color: string): Paint {
    let p = this.paints.get(color);
    if (p) return p;
    const ck = this.ed.ck;
    p = new ck.Paint();
    p.setColor(ck.parseColorString(color));
    p.setStyle(ck.PaintStyle.Stroke);
    p.setStrokeWidth(1);
    p.setAntiAlias(true);
    this.paints.set(color, p);
    return p;
  }

  private draw(canvas: Canvas) {
    const ed = this.ed;
    const doc = ed.doc;
    const seen = new Set<string>();
    if (this.visible) {
      const vw = ed.viewW;
      const vh = ed.viewH;
      // Callouts top to bottom; one that overlaps the previous one moves down.
      const items: { key: string; id: string; index: number; box: [number, number, number, number]; ann: Annotation }[] = [];
      for (const id of this.annotated()) {
        if (!doc.has(id) || doc.get(id, 'visible') === false) continue;
        const b = ed.selectionBounds([id]);
        if (!b) continue;
        const [x0, y0] = ed.worldToScreen(b[0], b[1]);
        const [x1, y1] = ed.worldToScreen(b[2], b[3]);
        if (x1 < -W - 40 || x0 > vw + W + 40 || y1 < -200 || y0 > vh + 200) continue;
        (doc.get(id, 'annotations') ?? []).forEach((ann, index) => items.push({ key: `${id}#${index}`, id, index, box: [x0, y0, x1, y1], ann }));
      }
      items.sort((a, b) => a.box[1] - b.box[1]);
      const placed: [number, number, number, number][] = [];
      for (const it of items) {
        let el = this.els.get(it.key);
        if (!el) {
          // Not a button: it contains paragraphs and links. From the keyboard — Enter.
          el = h('div', { class: 'ann', role: 'button', tabIndex: 0 });
          const { id, index } = it;
          el.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('a')) return;
            this.edit(id, index);
          });
          el.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            e.stopPropagation();
            this.edit(id, index);
          });
          this.layer.append(el);
          this.els.set(it.key, el);
        }
        seen.add(it.key);
        this.fill(el, it.id, it.ann);
        const cat = categoryOf(doc, it.ann.categoryId);
        const color = cat ? ANNOTATION_COLORS[cat.color] : '#8a8a8a';
        el.style.setProperty('--ann', color);
        el.classList.toggle('on', this.editing?.id === it.id && this.editing.index === it.index);
        const hgt = el.offsetHeight || 40;
        const right = it.box[2] + 24 + W <= vw - 8;
        let left = right ? it.box[2] + 24 : Math.max(8, it.box[0] - 24 - W);
        let top = Math.max(8, it.box[1]);
        for (const p of placed) if (left < p[2] && left + W > p[0] && top < p[3] + 6 && top + hgt > p[1]) top = p[3] + 6;
        left = Math.round(left);
        top = Math.round(top);
        placed.push([left, top, left + W, top + hgt]);
        el.style.transform = `translate(${left}px, ${top}px)`;
        // Line from the layer to the callout.
        const ax = right ? it.box[2] : it.box[0];
        const ay = Math.min(Math.max(top + 14, it.box[1]), it.box[3]);
        const paint = this.paint(color);
        canvas.drawLine(ax, ay, right ? left : left + W, top + 14, paint);
        canvas.drawCircle(ax, ay, 2.5, paint);
      }
    }
    for (const [k, el] of this.els) {
      if (seen.has(k)) continue;
      el.remove();
      this.els.delete(k);
    }
  }

  /** Callout contents (rebuilt only if changed). */
  private fill(el: HTMLElement, id: string, ann: Annotation) {
    const doc = this.ed.doc;
    const cat = categoryOf(doc, ann.categoryId);
    const props = (ann.properties ?? []).map((p) => [ANNOTATION_PROPERTY_LABELS[p.type], this.value(id, p.type)] as const);
    const sig = JSON.stringify([cat?.label, ann.labelMarkdown, props]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.setAttribute('aria-label', `Аннотация${cat ? ` «${cat.label}»` : ''}: ${ann.labelMarkdown ?? ''}`);
    el.replaceChildren(
      ...(cat ? [h('span', { class: 'ann-cat-chip' }, cat.label)] : []),
      ...(ann.labelMarkdown?.trim() ? [h('div', { class: 'ann-text-view' }, renderMarkdown(ann.labelMarkdown))] : []),
      ...(props.length ? [h('div', { class: 'ann-props' }, ...props.map(([k, v]) => h('div', { class: 'ann-prop' }, h('span', {}, k), h('b', {}, v))))] : []),
    );
  }
}

/** Without empty fields. */
function clean(a: Annotation): Annotation {
  const out: Annotation = {};
  if (a.labelMarkdown !== undefined) out.labelMarkdown = a.labelMarkdown;
  if (a.properties?.length) out.properties = a.properties;
  if (a.categoryId) out.categoryId = a.categoryId;
  return out;
}
