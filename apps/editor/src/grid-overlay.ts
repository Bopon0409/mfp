// Auto layout grid cells on the canvas: dashed tracks of the selected grid frame
// (or the frame that contains the selected layer).

import type { Canvas, Paint } from 'canvaskit-wasm';
import type { Matrix } from '@mfp/core';
import { gridLayout } from '@mfp/editing';
import type { Editor } from './editor.ts';
import { canvasAccent } from './appearance.ts';

export class GridOverlay {
  private ed: Editor;
  private paint: Paint | null = null;
  private accentV = -1;

  constructor(ed: Editor) {
    this.ed = ed;
    ed.underlays.push((canvas) => this.draw(canvas));
  }

  private draw(canvas: Canvas) {
    const ed = this.ed;
    const doc = ed.doc;
    if (ed.tool !== 'select') return;
    const frames = new Set<string>();
    for (const id of ed.selection) {
      if (!doc.has(id)) continue;
      if (doc.get(id, 'layoutMode') === 'GRID') frames.add(id);
      const p = doc.parent(id);
      if (p && doc.get(p, 'layoutMode') === 'GRID') frames.add(p);
    }
    if (!frames.size) return;
    const ck = ed.ck;
    if (this.paint && this.accentV !== canvasAccent.version) {
      this.paint.delete();
      this.paint = null;
    }
    if (!this.paint) {
      this.accentV = canvasAccent.version;
      this.paint = new ck.Paint();
      this.paint.setStyle(ck.PaintStyle.Stroke);
      this.paint.setStrokeWidth(1);
      this.paint.setAntiAlias(true);
      this.paint.setColor(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 0.7));
      this.paint.setPathEffect(ck.PathEffect.MakeDash([4, 3], 0));
    }
    for (const id of frames) {
      const res = gridLayout(doc, id);
      if (!res || !res.columns.length || !res.rows.length) continue;
      const m = ed.worldMatrix(id) as Matrix;
      const pt = (x: number, y: number) => ed.worldToScreen(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
      for (const [y0, y1] of res.rows)
        for (const [x0, x1] of res.columns) {
          const pb = new ck.PathBuilder();
          const pts = [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
          pts.forEach(([x, y], i) => (i ? pb.lineTo(x, y) : pb.moveTo(x, y)));
          pb.close();
          const path = pb.detachAndDelete();
          canvas.drawPath(path, this.paint);
          path.delete();
        }
    }
  }
}
