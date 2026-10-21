// Measurements (developer mode): persistent segments between the edges of two layers, showing the distance
// or custom text — visible to everyone who opens the file. Tool M (in developer mode): click near a
// layer edge to start, click near an edge of another (or the same) layer to finish. Click a label to edit.

import { addMeasurement, deleteMeasurement, editMeasurement, measurementGeometry, measurementsOf, type Measurement, type MeasurementSide } from '@mfp/core';
import type { Canvas, Paint } from 'canvaskit-wasm';
import { h, popover } from './dom.ts';
import type { Editor, Rect } from './editor.ts';

export interface MeasurementsHooks {
  pick(x: number, y: number): string | null;
  notify(message: string): void;
  /** Whether they are visible (developer mode or “View → Annotations and measurements”). */
  visible(): boolean;
}

// Own color (developer mode teal), not pink.
const COLOR = { r: 36, g: 193, b: 201 };
const r2 = (v: number) => Math.round(v * 100) / 100;

export class Measurements {
  private ed: Editor;
  private hooks: MeasurementsHooks;
  private root: HTMLElement;
  private labels = new Map<string, HTMLElement>();
  private paints: { line: Paint; edge: Paint; dash: Paint } | null = null;
  /** Measurement in progress and the edge under the pointer. */
  private start: { node: string; side: MeasurementSide } | null = null;
  private hover: { node: string; side: MeasurementSide } | null = null;
  private pointer: [number, number] | null = null;

  constructor(ed: Editor, hooks: MeasurementsHooks, labelsRoot: HTMLElement) {
    this.ed = ed;
    this.hooks = hooks;
    this.root = labelsRoot;
    ed.overlays.push((canvas) => this.draw(canvas));
    ed.onPage.push(() => (this.start = this.hover = null));
  }

  get active() {
    return this.ed.tool === 'measure';
  }

  /** Esc: cancel the measurement in progress. */
  cancel(): boolean {
    if (!this.start) return false;
    this.start = null;
    this.ed.dirty = true;
    return true;
  }

  /** Layer edge near a point: the nearest side (for one in progress — only on the same axis). */
  private edgeAt(x: number, y: number): { node: string; side: MeasurementSide } | null {
    const node = this.hooks.pick(x, y);
    if (!node) return null;
    const b = this.ed.selectionBounds([node]);
    if (!b) return null;
    const d: [MeasurementSide, number][] = [
      ['LEFT', Math.abs(x - b[0])],
      ['RIGHT', Math.abs(x - b[2])],
      ['TOP', Math.abs(y - b[1])],
      ['BOTTOM', Math.abs(y - b[3])],
    ];
    const axis = this.start ? (this.start.side === 'LEFT' || this.start.side === 'RIGHT' ? 'x' : 'y') : null;
    const allowed = d.filter(([s]) => !axis || (axis === 'x') === (s === 'LEFT' || s === 'RIGHT'));
    allowed.sort((a, c) => a[1] - c[1]);
    return { node, side: allowed[0]![0] };
  }

  down(e: PointerEvent, x: number, y: number): boolean {
    if (!this.active) return false;
    if (e.button !== 0) return true;
    const edge = this.edgeAt(x, y);
    if (!edge) return true;
    if (!this.start) {
      this.start = edge;
      this.hooks.notify('Теперь щёлкните у края другого слоя (Esc — отмена)');
    } else {
      const ed = this.ed;
      if (edge.node === this.start.node && edge.side === this.start.side) return true;
      const m = addMeasurement(ed.doc, ed.pageId, this.start, edge);
      this.start = null;
      const g = measurementGeometry(ed.doc, m);
      this.hooks.notify(`Измерение: ${g ? r2(g.value) : ''}`);
    }
    this.ed.dirty = true;
    return true;
  }

  move(_e: PointerEvent, x: number, y: number): boolean {
    if (!this.active) return false;
    this.pointer = [x, y];
    this.hover = this.edgeAt(x, y);
    this.ed.dirty = true;
    return true;
  }

  up(): boolean {
    return this.active;
  }

  private paint() {
    if (this.paints) return this.paints;
    const ck = this.ed.ck;
    const make = (w: number, dash = false) => {
      const p = new ck.Paint();
      p.setColor(ck.Color(COLOR.r, COLOR.g, COLOR.b, 1));
      p.setStyle(ck.PaintStyle.Stroke);
      p.setStrokeWidth(w);
      p.setAntiAlias(true);
      if (dash) p.setPathEffect(ck.PathEffect.MakeDash([3, 3], 0));
      return p;
    };
    this.paints = { line: make(1), edge: make(2), dash: make(1, true) };
    return this.paints;
  }

  /** Layer side on screen (to highlight the edge under the pointer). */
  private edgeLine(e: { node: string; side: MeasurementSide }): [number, number, number, number] | null {
    const b: Rect | null = this.ed.selectionBounds([e.node]);
    if (!b) return null;
    const [x0, y0] = this.ed.worldToScreen(b[0], b[1]);
    const [x1, y1] = this.ed.worldToScreen(b[2], b[3]);
    return e.side === 'LEFT' ? [x0, y0, x0, y1] : e.side === 'RIGHT' ? [x1, y0, x1, y1] : e.side === 'TOP' ? [x0, y0, x1, y0] : [x0, y1, x1, y1];
  }

  private draw(canvas: Canvas) {
    const ed = this.ed;
    const seen = new Set<string>();
    const p = this.paint();
    if (this.hooks.visible()) {
      for (const m of measurementsOf(ed.doc, ed.pageId)) {
        const g = measurementGeometry(ed.doc, m);
        if (!g) continue;
        const [ax, ay] = ed.worldToScreen(g.a[0], g.a[1]);
        const [bx, by] = ed.worldToScreen(g.b[0], g.b[1]);
        const horizontal = Math.abs(by - ay) < Math.abs(bx - ax) || m.start.side === 'LEFT' || m.start.side === 'RIGHT';
        canvas.drawLine(ax, ay, bx, by, p.line);
        // Tick marks at the ends.
        for (const [x, y] of [
          [ax, ay],
          [bx, by],
        ] as const) {
          if (horizontal) canvas.drawLine(x, y - 5, x, y + 5, p.line);
          else canvas.drawLine(x - 5, y, x + 5, y, p.line);
        }
        let el = this.labels.get(m.id);
        if (!el) {
          el = h('button', { class: 'measure-label measurement' });
          const id = m.id;
          el.addEventListener('click', () => this.edit(id));
          this.root.append(el);
          this.labels.set(m.id, el);
        }
        seen.add(m.id);
        const text = m.freeText || String(r2(g.value));
        if (el.textContent !== text) el.textContent = text;
        el.title = m.freeText ? `${r2(g.value)} — щелчок: изменить` : 'Щелчок: свой текст или удалить';
        el.style.transform = `translate(calc(${Math.round((ax + bx) / 2)}px - 50%), calc(${Math.round((ay + by) / 2)}px - 50%))`;
      }
    }
    // Tool: edge under the pointer and the segment in progress.
    if (this.active) {
      for (const e of [this.start, this.hover]) {
        const l = e && this.edgeLine(e);
        if (l) canvas.drawLine(l[0], l[1], l[2], l[3], p.edge);
      }
      if (this.start && this.pointer) {
        const l = this.edgeLine(this.start);
        if (l) {
          const [px, py] = ed.worldToScreen(this.pointer[0], this.pointer[1]);
          const horizontal = this.start.side === 'LEFT' || this.start.side === 'RIGHT';
          canvas.drawLine(l[0], horizontal ? py : l[1], horizontal ? px : l[2], py, p.dash);
        }
      }
    }
    for (const [id, el] of this.labels) {
      if (seen.has(id)) continue;
      el.remove();
      this.labels.delete(id);
    }
  }

  /** Measurement popup: custom text, label side, delete. */
  private edit(id: string) {
    const ed = this.ed;
    const m = measurementsOf(ed.doc, ed.pageId).find((x) => x.id === id);
    const anchor = this.labels.get(id);
    if (!m || !anchor) return;
    const { box, close } = popover(anchor, 'ann-pop', { width: 260 });
    const g = measurementGeometry(ed.doc, m);
    const text = h('input', { class: 'cfield', value: m.freeText, placeholder: g ? String(r2(g.value)) : 'Свой текст', 'aria-label': 'Свой текст' }) as HTMLInputElement;
    text.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close();
    });
    text.addEventListener('input', () => editMeasurement(ed.doc, ed.pageId, id, { freeText: text.value }));
    const offset = h('input', { type: 'range', min: '0', max: '100', value: String(m.offset.type === 'INNER' ? Math.round(m.offset.relative * 100) : 50), 'aria-label': 'Положение вдоль слоя' }) as HTMLInputElement;
    offset.addEventListener('input', () => editMeasurement(ed.doc, ed.pageId, id, { offset: { type: 'INNER', relative: Number(offset.value) / 100 } as Measurement['offset'] }));
    box.append(
      h('div', { class: 'ann-pop-title' }, `Измерение${g ? `: ${r2(g.value)}` : ''}`),
      text,
      h('label', { class: 'ann-pop-sub' }, 'Где линия вдоль слоя', offset),
      h(
        'div',
        { class: 'cacts' },
        h(
          'button',
          {
            class: 'cbtn danger',
            onclick: () => {
              deleteMeasurement(ed.doc, ed.pageId, id);
              close();
            },
          },
          'Удалить',
        ),
        h('button', { class: 'cbtn primary', onclick: () => close() }, 'Готово'),
      ),
    );
    setTimeout(() => text.focus());
  }
}
