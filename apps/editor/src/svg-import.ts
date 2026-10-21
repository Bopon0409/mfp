// SVG import (dragging a .svg, pasting SVG code) into a frame named after the file.
// Parsing and building layers are shared (@mfp/editing, svg-import.ts); here — DOMParser and Skia
// paths: path syntax (relative commands, arcs, H/V/S/T), exact bounds, union for clip-path,
// path length and a point on it (SVG animations: “line drawing” stroke, motion along a path).

import { importSvgTree, type PathKit } from '@mfp/editing';
import type { Matrix } from '@mfp/core';
import type { CanvasKit, Path } from 'canvaskit-wasm';
import type { Editor } from './editor.ts';

/** CanvasKit paths. */
function skiaPaths(ck: CanvasKit): PathKit<Path> {
  return {
    path(d: string, m: Matrix) {
      const src = ck.Path.MakeFromSVGString(d);
      if (!src) return null;
      const pb = new ck.PathBuilder();
      pb.addPath(src, [m[0], m[1], m[2], m[3], m[4], m[5], 0, 0, 1]);
      src.delete();
      return pb.detachAndDelete();
    },
    bounds(p) {
      const b = p.computeTightBounds();
      return [b[0]!, b[1]!, b[2]!, b[3]!];
    },
    toSvg(p, dx, dy) {
      const pb = new ck.PathBuilder();
      pb.addPath(p, [1, 0, dx, 0, 1, dy, 0, 0, 1]);
      const local = pb.detachAndDelete();
      const data = local.toSVGString();
      local.delete();
      return data;
    },
    union: (a, b) => ck.Path.MakeFromOp(a, b, ck.PathOp.Union),
    dispose: (p) => p.delete(),
    length(p) {
      const it = new ck.ContourMeasureIter(p, false, 1);
      let len = 0;
      for (let c = it.next(); c; c = it.next()) {
        len += c.length();
        c.delete();
      }
      it.delete();
      return len;
    },
    pointAt(d, frac) {
      const p = ck.Path.MakeFromSVGString(d);
      if (!p) return null;
      try {
        const total = this.length!(p);
        if (!(total > 0)) return null;
        let left = Math.max(0, Math.min(1, frac)) * total;
        const it = new ck.ContourMeasureIter(p, false, 1);
        try {
          for (let c = it.next(); c; c = it.next()) {
            const l = c.length();
            if (left <= l + 1e-6) {
              const [x, y, tx, ty] = c.getPosTan(Math.min(l, left));
              c.delete();
              return { x: x!, y: y!, angle: (Math.atan2(ty!, tx!) * 180) / Math.PI };
            }
            left -= l;
            c.delete();
          }
        } finally {
          it.delete();
        }
        return null;
      } finally {
        p.delete();
      }
    },
  };
}

export function importSvg(ed: Editor, text: string, name: string, at: [number, number]): string | null {
  const dom = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = dom.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== 'svg' || dom.querySelector('parsererror')) return null;
  // SMIL and CSS animations — onto the frame's timeline (the browser draws only the first SVG frame into a canvas).
  return importSvgTree(ed.doc, svg, { kit: skiaPaths(ed.ck), parent: ed.pageId, name, at, animate: true });
}
