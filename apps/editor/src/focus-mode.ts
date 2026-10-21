// Isolation mode (our own; as in Illustrator): everything except the isolated layers
// is dimmed with the page background color, and click and marquee selection work only inside them — as
// if it were a separate page. Exit — the bar above the canvas, Esc with an empty selection, or switching
// pages. The document doesn't change.

import type { Editor } from './editor.ts';

export class FocusMode {
  private ed: Editor;
  private ids: string[] = [];
  private badge: HTMLButtonElement;

  constructor(ed: Editor, stage: HTMLElement) {
    this.ed = ed;
    this.badge = document.createElement('button');
    this.badge.className = 'vision-badge focus-badge';
    this.badge.hidden = true;
    this.badge.title = 'Выйти из изоляции (Esc)';
    this.badge.addEventListener('click', () => this.exit());
    stage.append(this.badge);
    ed.onPage.push(() => this.exit());
    // Esc with an empty selection — exit (the first Esc clears the selection, as usual).
    addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !this.active || ed.selection.length) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        this.exit();
      },
      true,
    );
    ed.overlays.unshift((canvas) => this.draw(canvas));
  }

  get active() {
    return this.ids.length > 0;
  }

  enter(ids: string[]) {
    this.ids = ids.filter((id) => this.ed.doc.has(id));
    this.ed.isolation = [...this.ids];
    this.ed.select([]);
    this.badge.hidden = !this.ids.length;
    this.badge.textContent = `◎ Изоляция: ${this.ids.length === 1 ? this.ed.doc.get(this.ids[0]!, 'name') || 'слой' : `${this.ids.length} слоёв`} ✕`;
    this.ed.dirty = true;
  }

  exit() {
    if (!this.ids.length) return;
    this.ids = [];
    this.ed.isolation = [];
    this.badge.hidden = true;
    this.ed.dirty = true;
  }

  private draw(canvas: Parameters<Editor['overlays'][number]>[0]) {
    const { ed } = this;
    this.ids = this.ids.filter((id) => ed.doc.has(id));
    if (!this.ids.length) {
      if (ed.isolation.length) ed.isolation = [];
      this.badge.hidden = true;
      return;
    }
    const ck = ed.ck;
    const b = new ck.PathBuilder();
    b.addRect(ck.XYWHRect(-10, -10, ed.viewW + 20, ed.viewH + 20));
    for (const id of this.ids) {
      const pts = ed.visualCorners(id).map(([x, y]) => ed.worldToScreen(x, y));
      pts.forEach(([x, y], i) => (i ? b.lineTo(x, y) : b.moveTo(x, y)));
      b.close();
    }
    const path = b.detachAndDelete();
    path.setFillType(ck.FillType.EvenOdd);
    const bg = ed.doc.get(ed.pageId, 'backgrounds')?.[0];
    const c = bg?.type === 'SOLID' ? bg.color : { r: 0.96, g: 0.96, b: 0.96 };
    const p = new ck.Paint();
    p.setAntiAlias(true);
    p.setColor(ck.Color4f(c.r, c.g, c.b, 0.86));
    canvas.drawPath(path, p);
    p.delete();
    path.delete();
  }
}
