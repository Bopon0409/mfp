// Rulers and guides.
// - Shift+R — show or hide the rulers at the top and left: ticks in page coordinates,
//   selection bounds highlighted.
// - A guide is dragged from a ruler onto the canvas; dragging moves it; back onto the ruler —
//   delete (or select with a click and press Delete). Layers snap to guides (snap.ts).
// Guides are stored on the page (guides property).

import type { Canvas, Paint } from 'canvaskit-wasm';
import { formatLength, pxPerUnit, type Guide as PageGuide } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';

const SIZE = 20;
/** Hit tolerance for a guide, screen pixels. */
const HIT = 4;

export class Rulers implements PointerInterceptor {
  private ed: Editor;
  private top: HTMLCanvasElement;
  private left: HTMLCanvasElement;
  private corner: HTMLElement;
  private paints: { guide: Paint; active: Paint } | null = null;
  private accentV = -1;
  visible = false;
  /** Guide being dragged: index in the page list (−1 — new, not yet on the canvas). */
  private drag: { axis: 'X' | 'Y'; index: number; offset: number; overRuler: boolean } | null = null;
  /** Selected guide (Delete removes it). */
  selected: number | null = null;
  private hover: number | null = null;
  onChange: (() => void) | null = null;

  constructor(ed: Editor, stage: HTMLElement) {
    this.ed = ed;
    this.top = document.createElement('canvas');
    this.top.className = 'ruler ruler-top';
    this.left = document.createElement('canvas');
    this.left.className = 'ruler ruler-left';
    this.corner = document.createElement('div');
    this.corner.className = 'ruler-corner';
    stage.append(this.top, this.left, this.corner);
    try {
      this.visible = localStorage.getItem('mfp-rulers') === '1';
    } catch {
      // No storage — rulers are hidden.
    }
    this.apply();
    for (const [el, axis] of [
      [this.top, 'Y'],
      [this.left, 'X'],
    ] as const) {
      // The top ruler yields a horizontal guide (Y axis), the left one — a vertical guide.
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer already released — drag without capture.
        }
        this.drag = { axis, index: -1, offset: 0, overRuler: true };
        this.selected = null;
        const move = (ev: PointerEvent) => this.dragTo(ev);
        const up = (ev: PointerEvent) => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          this.dragTo(ev);
          this.finish();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      });
    }
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  get active(): boolean {
    return this.drag !== null;
  }

  toggle() {
    this.visible = !this.visible;
    try {
      localStorage.setItem('mfp-rulers', this.visible ? '1' : '0');
    } catch {
      // Not remembered — no big deal.
    }
    this.apply();
    this.onChange?.();
  }

  private apply() {
    for (const el of [this.top, this.left, this.corner]) el.style.display = this.visible ? '' : 'none';
    this.ed.dirty = true;
  }

  private guides(): PageGuide[] {
    return (this.ed.doc.get(this.ed.pageId, 'guides') ?? []) as PageGuide[];
  }

  /** Guide under a screen point. */
  private hit(sx: number, sy: number): number {
    const gs = this.guides();
    for (let i = gs.length - 1; i >= 0; i--) {
      const g = gs[i]!;
      const [gx, gy] = this.ed.worldToScreen(g.axis === 'X' ? g.offset : 0, g.axis === 'Y' ? g.offset : 0);
      if (g.axis === 'X' ? Math.abs(sx - gx) <= HIT : Math.abs(sy - gy) <= HIT) return i;
    }
    return -1;
  }

  /** Pointer position while dragging a guide (over a ruler — delete on release). */
  private dragTo(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const r = this.ed.canvasEl.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const [wx, wy] = this.ed.screenToWorld(sx, sy);
    d.offset = Math.round(d.axis === 'X' ? wx : wy);
    d.overRuler = this.visible && (d.axis === 'X' ? sx < SIZE : sy < SIZE);
    if (d.axis === 'X' ? sx < 0 : sy < 0) d.overRuler = true;
    this.ed.dirty = true;
  }

  /** Guide released: on the canvas — save (new or moved), on the ruler — delete. */
  private finish() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const doc = this.ed.doc;
    const gs = [...this.guides()];
    if (d.overRuler) {
      if (d.index >= 0) {
        gs.splice(d.index, 1);
        doc.set(this.ed.pageId, { guides: gs });
      }
      this.selected = null;
    } else if (d.index >= 0) {
      gs[d.index] = { axis: d.axis, offset: d.offset };
      doc.set(this.ed.pageId, { guides: gs });
      this.selected = d.index;
    } else {
      gs.push({ axis: d.axis, offset: d.offset });
      doc.set(this.ed.pageId, { guides: gs });
      this.selected = gs.length - 1;
    }
    this.ed.dirty = true;
  }

  /** Delete the selected guide (Delete). */
  deleteSelected(): boolean {
    if (this.selected === null) return false;
    const gs = [...this.guides()];
    if (!gs[this.selected]) return false;
    gs.splice(this.selected, 1);
    this.ed.doc.set(this.ed.pageId, { guides: gs });
    this.selected = null;
    return true;
  }

  // ---------- Pointer interception on the canvas (guides can be grabbed and moved) ----------

  down(e: PointerEvent): boolean {
    if (e.button !== 0 || this.ed.tool !== 'select') return false;
    const r = this.ed.canvasEl.getBoundingClientRect();
    const i = this.hit(e.clientX - r.left, e.clientY - r.top);
    if (i < 0) {
      this.selected = null;
      return false;
    }
    const g = this.guides()[i]!;
    this.drag = { axis: g.axis, index: i, offset: g.offset, overRuler: false };
    this.selected = i;
    this.ed.select([]);
    return true;
  }

  move(e: PointerEvent): boolean {
    if (this.drag) {
      this.dragTo(e);
      return true;
    }
    if (this.ed.tool !== 'select' || e.buttons) return false;
    const r = this.ed.canvasEl.getBoundingClientRect();
    const i = this.hit(e.clientX - r.left, e.clientY - r.top);
    if (i !== (this.hover ?? -1)) {
      this.hover = i < 0 ? null : i;
      this.ed.dirty = true;
    }
    if (i < 0) return false;
    this.ed.canvasEl.style.cursor = this.guides()[i]!.axis === 'X' ? 'col-resize' : 'row-resize';
    return true;
  }

  up(e: PointerEvent): boolean {
    if (!this.drag) return false;
    this.dragTo(e);
    this.finish();
    return true;
  }

  // ---------- Drawing ----------

  private paint() {
    if (this.paints && this.accentV !== canvasAccent.version) {
      for (const p of Object.values(this.paints)) p.delete();
      this.paints = null;
    }
    if (this.paints) return this.paints;
    this.accentV = canvasAccent.version;
    const ck = this.ed.ck;
    const make = (r: number, g: number, b: number) => {
      const p = new ck.Paint();
      p.setColor(ck.Color(r, g, b, 1));
      p.setStyle(ck.PaintStyle.Stroke);
      p.setStrokeWidth(1);
      return p;
    };
    this.paints = { guide: make(242, 72, 90), active: make(Math.round(canvasAccent.r * 255), Math.round(canvasAccent.g * 255), Math.round(canvasAccent.b * 255)) };
    return this.paints;
  }

  private draw(canvas: Canvas) {
    const ed = this.ed;
    const p = this.paint();
    const W = ed.viewW;
    const H = ed.viewH;
    const gs = this.guides();
    const line = (axis: 'X' | 'Y', offset: number, paint: Paint) => {
      const [x, y] = ed.worldToScreen(offset, offset);
      if (axis === 'X') canvas.drawLine(Math.round(x) + 0.5, 0, Math.round(x) + 0.5, H, paint);
      else canvas.drawLine(0, Math.round(y) + 0.5, W, Math.round(y) + 0.5, paint);
    };
    gs.forEach((g, i) => {
      if (this.drag && this.drag.index === i) return;
      line(g.axis, g.offset, i === this.selected || i === this.hover ? p.active : p.guide);
    });
    if (this.drag && !this.drag.overRuler) line(this.drag.axis, this.drag.offset, p.active);
    if (this.visible) this.drawRulers();
  }

  /** Ruler ticks: the label step is a “round” number so labels are at least 50 px apart. */
  private drawRulers() {
    const ed = this.ed;
    const dpr = devicePixelRatio || 1;
    // Document units (mm, cm, inches, pt): ticks and labels use them; k — pixels per unit.
    const units = ed.doc.get(ed.doc.root, 'documentUnits');
    const k = units && units.unit !== 'px' ? pxPerUnit(units.unit, units.dpi) : 1;
    const z = ed.camera.zoom * k;
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000].filter((v) => k !== 1 || v >= 1);
    const step = steps.find((s) => s * z >= 50) ?? steps[steps.length - 1]!;
    const minor = step / (step * z >= 100 ? 10 : 5);
    const sel = ed.selectionBounds();
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--panel').trim() || '#22242a';
    const fg = css.getPropertyValue('--muted').trim() || '#8c8c8c';
    const accent = css.getPropertyValue('--accent').trim() || '#4d7bfd';
    for (const [el, horizontal] of [
      [this.top, true],
      [this.left, false],
    ] as const) {
      const len = horizontal ? ed.viewW : ed.viewH;
      const w = horizontal ? len : SIZE;
      const h = horizontal ? SIZE : len;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
      }
      const c = el.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      const origin = (horizontal ? ed.camera.x : ed.camera.y) / k;
      const toScreen = (v: number) => (v - origin) * z;
      // Selection — a band and numbers at the edges.
      if (sel) {
        const a = toScreen((horizontal ? sel[0] : sel[1]) / k);
        const b = toScreen((horizontal ? sel[2] : sel[3]) / k);
        c.fillStyle = `${accent}40`;
        if (horizontal) c.fillRect(a, 0, b - a, SIZE);
        else c.fillRect(0, a, SIZE, b - a);
      }
      c.strokeStyle = fg;
      c.fillStyle = fg;
      c.lineWidth = 1;
      c.font = '9px Inter, system-ui, sans-serif';
      c.textBaseline = 'top';
      const first = Math.floor(origin / minor) * minor;
      const last = origin + len / z;
      c.beginPath();
      for (let v = first; v <= last; v += minor) {
        const s = Math.round(toScreen(v)) + 0.5;
        const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
        const t = major ? 8 : 4;
        if (horizontal) {
          c.moveTo(s, SIZE);
          c.lineTo(s, SIZE - t);
        } else {
          c.moveTo(SIZE, s);
          c.lineTo(SIZE - t, s);
        }
      }
      c.stroke();
      for (let v = Math.floor(origin / step) * step; v <= last; v += step) {
        const s = toScreen(v);
        const label = String(k === 1 ? Math.round(v) : Math.round(v * 1000) / 1000);
        if (horizontal) c.fillText(label, s + 3, 2);
        else {
          c.save();
          c.translate(2, s - 3);
          c.rotate(-Math.PI / 2);
          c.fillText(label, 0, 0);
          c.restore();
        }
      }
      if (sel) {
        c.fillStyle = accent;
        c.font = '600 9px Inter, system-ui, sans-serif';
        for (const v of horizontal ? [sel[0], sel[2]] : [sel[1], sel[3]]) {
          const s = toScreen(v / k);
          const label = formatLength(v, units);
          const tw = c.measureText(label).width;
          if (horizontal) {
            c.fillStyle = bg;
            c.fillRect(s - tw / 2 - 2, 1, tw + 4, 11);
            c.fillStyle = accent;
            c.fillText(label, s - tw / 2, 2);
          } else {
            c.save();
            c.translate(2, s + tw / 2);
            c.rotate(-Math.PI / 2);
            c.fillStyle = bg;
            c.fillRect(-2, -1, tw + 4, 11);
            c.fillStyle = accent;
            c.fillText(label, 0, 0);
            c.restore();
          }
        }
      }
      // Guides — marks on the ruler.
      c.fillStyle = 'rgb(242,72,90)';
      for (const g of this.guides()) {
        if ((g.axis === 'X') !== horizontal) continue;
        const s = toScreen(g.offset / k);
        if (horizontal) c.fillRect(Math.round(s) - 1, SIZE - 6, 2, 6);
        else c.fillRect(SIZE - 6, Math.round(s) - 1, 6, 2);
      }
    }
  }
}
