import type { Editor, Rect } from './editor.ts';
import { layerLocked } from '@mfp/core';

/** Keyboard cursor lives in document coordinates, so zooming never moves its target. */
export class KeyboardSelection {
  point: [number, number] | null = null;
  anchor: [number, number] | null = null;
  private ed: Editor;
  private pick: (x: number, y: number) => string | null;
  constructor(ed: Editor, pick: (x: number, y: number) => string | null) {
    this.ed = ed;
    this.pick = pick;
    ed.overlays.push((canvas) => {
      if (!this.point) return;
      const [x, y] = ed.worldToScreen(...this.point);
      const p = new ed.ck.Paint();
      p.setAntiAlias(true);
      p.setColor(ed.ck.Color4f(0.86, 0.08, 0.5, 1));
      p.setStrokeWidth(2);
      p.setStyle(ed.ck.PaintStyle.Stroke);
      if (this.anchor) {
        const [ax, ay] = ed.worldToScreen(...this.anchor);
        canvas.drawRect(ed.ck.LTRBRect(Math.min(x, ax), Math.min(y, ay), Math.max(x, ax), Math.max(y, ay)), p);
      }
      canvas.drawCircle(x, y, 5, p);
      canvas.drawLine(x - 12, y, x + 12, y, p);
      canvas.drawLine(x, y - 12, x, y + 12, p);
      p.delete();
    });
    ed.onPage.push(() => this.stop());
    ed.onDocumentSet.push(() => this.stop());
    ed.canvasEl.addEventListener('pointerdown', () => this.stop(), { capture: true });
  }
  start() {
    const r = this.ed.viewportRect();
    this.point = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
    this.anchor = null;
    this.ed.canvasEl.focus();
    this.ed.dirty = true;
    this.ed.notify?.('Выделение с клавиатуры: стрелки — курсор, Ctrl/Cmd+стрелки — рамка, Enter — выбрать, Esc — выйти');
  }
  stop() {
    if (!this.point) return;
    this.point = this.anchor = null;
    this.ed.dirty = true;
  }
  key(e: KeyboardEvent): boolean {
    if (!this.point) return false;
    if (e.key === 'Escape') { this.stop(); return true; }
    if (e.key === 'Enter') {
      if (this.anchor) this.selectBox();
      else {
        const id = this.pick(...this.point);
        this.ed.select(id ? [id] : []);
      }
      return true;
    }
    const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (!delta || e.altKey) return false;
    if (e.ctrlKey || e.metaKey) this.anchor ??= [...this.point];
    else this.anchor = null;
    const step = (e.shiftKey ? 100 : 10) / this.ed.camera.zoom;
    this.point = [this.point[0] + delta[0] * step, this.point[1] + delta[1] * step];
    const v = this.ed.viewportRect();
    const pad = 24 / this.ed.camera.zoom;
    const dx = this.point[0] < v[0] + pad ? this.point[0] - v[0] - pad : Math.max(0, this.point[0] - v[2] + pad);
    const dy = this.point[1] < v[1] + pad ? this.point[1] - v[1] - pad : Math.max(0, this.point[1] - v[3] + pad);
    if (dx || dy) this.ed.setCamera({ ...this.ed.camera, x: this.ed.camera.x + dx, y: this.ed.camera.y + dy });
    if (this.anchor) this.selectBox();
    this.ed.dirty = true;
    return true;
  }
  private selectBox() {
    const ed = this.ed;
    const [x, y] = this.point!, [ax, ay] = this.anchor!;
    const r: Rect = [Math.min(x, ax), Math.min(y, ay), Math.max(x, ax), Math.max(y, ay)];
    ed.select(ed.doc.children(ed.pageId).filter((id) => {
      if (ed.doc.get(id, 'visible') === false || layerLocked(ed.doc, id)) return false;
      const b = ed.selectionBounds([id]);
      return b && b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1];
    }));
  }
}

export function keyboardSelectionShortcut(e: KeyboardEvent, mac: boolean): boolean {
  return e.code === 'Space' && !e.shiftKey && !e.metaKey && !e.isComposing && !e.getModifierState?.('AltGraph') &&
    (mac ? e.altKey && !e.ctrlKey : e.ctrlKey && !e.altKey);
}

export function regionShortcut(e: KeyboardEvent, mac: boolean): boolean {
  return e.key === 'F6' && !e.metaKey && !e.altKey && !e.isComposing && (!e.ctrlKey || !mac);
}
