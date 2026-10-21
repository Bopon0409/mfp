// Highlighting texts outside the length limit on the canvas (own feature; request “max and min character on text
// property”): a text with textMaxLength / textMinLength whose length is out of range gets a red
// dashed frame and the number of “extra” characters. The page's list of such texts is kept as an index
// (recomputed on edits of these properties and the text) so the whole tree isn't walked every frame.

import { textLength } from '@mfp/core';
import type { Editor } from './editor.ts';

export class TextLimits {
  private ed: Editor;
  /** Page texts with a limit; null — rebuild. */
  private limited: Set<string> | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.onPage.push(() => (this.limited = null));
    ed.onDocument.push((ops) => {
      if (!this.limited) return;
      for (const o of ops) {
        if (o.op === 'create' || o.op === 'delete' || o.op === 'move') {
          this.limited = null;
          return;
        }
        if (o.op === 'set' && ('textMaxLength' in o.props || 'textMinLength' in o.props)) {
          const p = ed.doc.props(o.id);
          if (p.textMaxLength || p.textMinLength) this.limited.add(o.id);
          else this.limited.delete(o.id);
        }
      }
    });
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  private collect(): Set<string> {
    const { ed } = this;
    const out = new Set<string>();
    for (const id of ed.doc.descendants(ed.pageId)) {
      if (ed.doc.type(id) !== 'TEXT') continue;
      const p = ed.doc.node(id)!.props;
      if (p.textMaxLength || p.textMinLength) out.add(id);
    }
    return out;
  }

  private draw(canvas: Parameters<Editor['overlays'][number]>[0]) {
    const { ed } = this;
    if (ed.devMode) return;
    const ids = (this.limited ??= this.collect());
    if (!ids.size) return;
    const ck = ed.ck;
    let stroke: InstanceType<typeof ck.Paint> | null = null;
    for (const id of ids) {
      if (!ed.doc.has(id) || !ed.isOnPage(id)) continue;
      const p = ed.doc.props(id);
      const len = textLength(p.characters ?? '');
      const over = p.textMaxLength && len > p.textMaxLength;
      const under = p.textMinLength && len < p.textMinLength;
      if (!over && !under) continue;
      if (!stroke) {
        stroke = new ck.Paint();
        stroke.setAntiAlias(true);
        stroke.setStyle(ck.PaintStyle.Stroke);
        stroke.setStrokeWidth(1.5);
        stroke.setColor(ck.Color(229, 72, 77, 1));
        const dash = ck.PathEffect.MakeDash([5, 3], 0);
        if (dash) stroke.setPathEffect(dash);
      }
      const pts = ed.visualCorners(id).map(([x, y]) => ed.worldToScreen(x, y));
      const b = new ck.PathBuilder();
      pts.forEach(([x, y], i) => (i ? b.lineTo(x, y) : b.moveTo(x, y)));
      b.close();
      const path = b.detachAndDelete();
      canvas.drawPath(path, stroke);
      path.delete();
    }
    stroke?.delete();
  }
}
