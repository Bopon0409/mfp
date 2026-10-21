// Shape builder (Shift+M): selected shapes are cut into intersection
// regions; dragging across regions merges them into one shape, with Alt — removes them. Each gesture
// is an undo step. Esc, Enter or another tool — exit.
//
// Regions are in the common parent's coordinates: each is a connected part of the shapes' intersection
// (Skia PathOps), owners — the shapes covering it. Shapes after a gesture are region groups: each
// original shape gets the regions where it is on top; merged ones become a new shape with the style of
// the top owner of the first touched region.

import type { Canvas, CanvasKit, Paint, Path } from 'canvaskit-wasm';
import { invert, networkFromSvg, networkProps, type Matrix, type NodeType, type Props } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';

/** What can participate (has geometry). */
const SHAPES = new Set<NodeType>(['VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'BOOLEAN_OPERATION', 'TEXT']);

interface Region {
  path: Path;
  /** Shapes (indices in shapes) covering the region, bottom to top. */
  owners: number[];
}

interface Group {
  regions: Set<number>;
  /** Whose style the group's shape has (index in shapes). */
  source: number;
  /** Group node (original shape or a created vector); null — not created yet. */
  node: string | null;
}

/** Path — by its subpaths; connected parts: an outer contour with its holes. */
function components(ck: CanvasKit, path: Path): Path[] {
  const cmds = path.toCmds();
  const contours: number[][] = [];
  let cur: number[] | null = null;
  const args = (verb: number) => (verb === ck.MOVE_VERB || verb === ck.LINE_VERB ? 2 : verb === ck.QUAD_VERB ? 4 : verb === ck.CONIC_VERB ? 5 : verb === ck.CUBIC_VERB ? 6 : 0);
  for (let i = 0; i < cmds.length; ) {
    const verb = cmds[i]!;
    const n = args(verb);
    if (verb === ck.MOVE_VERB) contours.push((cur = []));
    cur?.push(...cmds.subarray(i, i + 1 + n));
    i += 1 + n;
  }
  if (contours.length <= 1) return [path.copy()];
  const paths = contours.map((c) => ck.Path.MakeFromCmds(c)!).filter(Boolean);
  const first = contours.map((c) => [c[1]!, c[2]!] as [number, number]);
  const area = paths.map((p) => {
    const b = p.computeTightBounds();
    return (b[2]! - b[0]!) * (b[3]! - b[1]!);
  });
  // Nesting depth: how many other contours contain the contour's first point.
  const depth = paths.map((_, i) => paths.reduce((d, q, j) => d + (j !== i && q.contains(first[i]![0], first[i]![1]) ? 1 : 0), 0));
  const out: Path[] = [];
  paths.forEach((p, i) => {
    if (depth[i]! % 2) return;
    const b = new ck.PathBuilder();
    b.addPath(p);
    // Holes of this contour: one level deeper and inside it (the smallest such one).
    paths.forEach((q, j) => {
      if (depth[j] !== depth[i]! + 1 || !p.contains(first[j]![0], first[j]![1])) return;
      const host = paths.reduce((best, r, k) => (depth[k] === depth[i] && r.contains(first[j]![0], first[j]![1]) && (best < 0 || area[k]! < area[best]!) ? k : best), -1);
      if (host === i) b.addPath(q);
    });
    b.setFillType(ck.FillType.EvenOdd);
    out.push(b.detachAndDelete());
  });
  for (const p of paths) p.delete();
  return out;
}

function nonEmpty(p: Path | null): boolean {
  if (!p || p.isEmpty()) return false;
  const b = p.computeTightBounds();
  return b[2]! - b[0]! > 0.01 && b[3]! - b[1]! > 0.01;
}

export class ShapeBuilder implements PointerInterceptor {
  private ed: Editor;
  private ck: CanvasKit;
  active = false;
  private parent = '';
  /** Shapes bottom to top: node and style (properties for new shapes). */
  private shapes: { id: string; props: Props }[] = [];
  private regions: Region[] = [];
  private groups: Group[] = [];
  private hover = -1;
  private drag: { touched: number[]; remove: boolean } | null = null;
  /** Our own document edits (others' — undo and the like — exit the mode). */
  private writing = false;
  private paints: { line: Paint; hover: Paint; merge: Paint; remove: Paint };
  private accentV = canvasAccent.version;
  onDone: (() => void) | null = null;

  constructor(ed: Editor) {
    this.ed = ed;
    this.ck = ed.ck;
    const ck = this.ck;
    const paint = (r: number, g: number, b: number, a: number, stroke = false) => {
      const p = new ck.Paint();
      p.setAntiAlias(true);
      p.setColor(ck.Color4f(r, g, b, a));
      if (stroke) {
        p.setStyle(ck.PaintStyle.Stroke);
        p.setStrokeWidth(1);
      }
      return p;
    };
    const { r, g, b } = canvasAccent;
    this.paints = { line: paint(r, g, b, 0.9, true), hover: paint(r, g, b, 0.15), merge: paint(r, g, b, 0.3), remove: paint(0.95, 0.25, 0.2, 0.3) };
    ed.overlays.push((c) => this.draw(c));
    ed.onDocument.push(() => {
      if (this.active && !this.writing) this.stop();
    });
    ed.onPage.push(() => this.stop());
  }

  /** Enter: shapes from the selection (common parent). A string — why it's not possible. */
  start(): string | null {
    const ed = this.ed;
    const doc = ed.doc;
    const ids = ed.selection.filter((id) => SHAPES.has(doc.type(id)!));
    if (ids.length < 1) return 'Выделите фигуры, которые пересекаются';
    const parent = doc.parent(ids[0]!)!;
    if (ids.some((id) => doc.parent(id) !== parent)) return 'Фигуры должны лежать в одном фрейме или группе';
    this.stop();
    // Bottom to top through layers.
    const order = doc.children(parent);
    ids.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const ck = this.ck;
    const paths: Path[] = [];
    this.shapes = [];
    for (const id of ids) {
      const svg = ed.scene.flattenSvg(id);
      const local = svg ? ck.Path.MakeFromSVGString(svg) : null;
      if (!local) continue;
      const t = (doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
      const b = new ck.PathBuilder();
      b.addPath(local, [t[0], t[1], t[2], t[3], t[4], t[5], 0, 0, 1]);
      local.delete();
      paths.push(b.detachAndDelete());
      this.shapes.push({ id, props: doc.props(id) });
    }
    if (!paths.length) return 'У выделения нет формы';
    // Intersection regions: each shape splits the regions found so far into “inside” and “outside”.
    let regions: Region[] = [];
    paths.forEach((s, i) => {
      const next: Region[] = [];
      for (const r of regions) {
        const inter = ck.Path.MakeFromOp(r.path, s, ck.PathOp.Intersect);
        const diff = ck.Path.MakeFromOp(r.path, s, ck.PathOp.Difference);
        if (nonEmpty(inter)) next.push({ path: inter!, owners: [...r.owners, i] });
        else inter?.delete();
        if (nonEmpty(diff)) next.push({ path: diff!, owners: r.owners });
        else diff?.delete();
        r.path.delete();
      }
      let rest: Path | null = s.copy();
      for (let j = 0; j < i && rest; j++) {
        const d: Path | null = ck.Path.MakeFromOp(rest, paths[j]!, ck.PathOp.Difference);
        rest.delete();
        rest = d;
      }
      if (nonEmpty(rest)) next.push({ path: rest!, owners: [i] });
      else rest?.delete();
      regions = next;
    });
    for (const p of paths) p.delete();
    // Connected parts — separate regions.
    this.regions = [];
    for (const r of regions) {
      for (const p of components(ck, r.path)) if (nonEmpty(p)) this.regions.push({ path: p, owners: r.owners });
      r.path.delete();
    }
    // Groups: a region belongs to the topmost covering shape.
    this.groups = this.shapes.map((sh, i) => ({ regions: new Set<number>(), source: i, node: sh.id }));
    this.regions.forEach((r, k) => this.groups[r.owners[r.owners.length - 1]!]!.regions.add(k));
    this.parent = parent;
    this.active = true;
    ed.hideHandles = true;
    ed.dirty = true;
    return null;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    for (const r of this.regions) r.path.delete();
    this.regions = [];
    const nodes = this.groups.map((g) => g.node).filter((id): id is string => !!id && this.ed.doc.has(id));
    this.groups = [];
    this.shapes = [];
    this.hover = -1;
    this.drag = null;
    this.ed.hideHandles = false;
    if (nodes.length) this.ed.select(nodes);
    this.ed.dirty = true;
    this.onDone?.();
  }

  /** Parent coordinates from a world point. */
  private local(wx: number, wy: number): [number, number] {
    const m = this.parent === this.ed.pageId ? ([1, 0, 0, 0, 1, 0] as Matrix) : (this.ed.worldMatrix(this.parent) as Matrix);
    const i = invert(m);
    return [i[0] * wx + i[1] * wy + i[2], i[3] * wx + i[4] * wy + i[5]];
  }

  private regionAt(wx: number, wy: number): number {
    const [x, y] = this.local(wx, wy);
    // On top — regions with more owners don't take priority: regions don't overlap.
    return this.regions.findIndex((r) => r.path.contains(x, y));
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.active) return false;
    const k = this.regionAt(wx, wy);
    this.drag = { touched: k >= 0 ? [k] : [], remove: e.altKey };
    this.ed.dirty = true;
    return true;
  }

  move(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.active) return false;
    const k = this.regionAt(wx, wy);
    this.hover = k;
    if (this.drag && k >= 0 && !this.drag.touched.includes(k)) this.drag.touched.push(k);
    if (this.drag) this.drag.remove ||= e.altKey;
    this.ed.dirty = true;
    return true;
  }

  up(): boolean {
    if (!this.active) return false;
    const d = this.drag;
    this.drag = null;
    if (!d?.touched.length) return true;
    if (d.remove) {
      for (const g of this.groups) for (const k of d.touched) g.regions.delete(k);
    } else {
      const first = this.regions[d.touched[0]!]!;
      for (const g of this.groups) for (const k of d.touched) g.regions.delete(k);
      this.groups.push({ regions: new Set(d.touched), source: first.owners[first.owners.length - 1]!, node: null });
    }
    this.apply();
    this.ed.dirty = true;
    return true;
  }

  /** Shapes by group: the original — as a vector with the same id (empty — removed), new ones — above the source. */
  private apply() {
    const ed = this.ed;
    const doc = ed.doc;
    const ck = this.ck;
    this.writing = true;
    try {
      doc.transact(() => {
        for (const g of this.groups) {
          const parts = [...g.regions].map((k) => this.regions[k]!.path);
          let union: Path | null = null;
          for (const p of parts) {
            if (!union) union = p.copy();
            else {
              const u: Path | null = ck.Path.MakeFromOp(union, p, ck.PathOp.Union);
              union.delete();
              union = u;
            }
          }
          if (!union) {
            if (g.node && doc.has(g.node)) doc.delete(g.node);
            g.node = null;
            continue;
          }
          const data = union.toSVGString();
          const evenOdd = union.getFillType() === ck.FillType.EvenOdd;
          union.delete();
          const net = networkFromSvg(data, evenOdd ? 'EVENODD' : 'NONZERO');
          if (!net) continue;
          const src = this.shapes[g.source]!;
          const style: Props = {
            name: src.props.name,
            fills: src.props.fills,
            strokes: src.props.strokes,
            strokeWeight: src.props.strokeWeight,
            strokeAlign: src.props.strokeAlign,
            effects: src.props.effects,
            opacity: src.props.opacity,
            blendMode: src.props.blendMode,
            transform: [1, 0, 0, 0, 1, 0],
          };
          // The original shape — a vector with the same id (at the same place in layers); new ones — above the source.
          if (g.node && doc.has(g.node) && doc.type(g.node) !== 'VECTOR') {
            const index = doc.children(this.parent).indexOf(g.node);
            doc.delete(g.node);
            doc.createWithId(g.node, 'VECTOR', this.parent, style, index);
          } else if (!g.node || !doc.has(g.node)) {
            const srcNode = this.groups.find((x) => x.source === g.source && x.node && doc.has(x.node))?.node;
            const index = srcNode ? doc.children(this.parent).indexOf(srcNode) + 1 : undefined;
            g.node = doc.create('VECTOR', this.parent, style, index);
          } else doc.set(g.node, { transform: [1, 0, 0, 0, 1, 0] });
          doc.set(g.node!, networkProps(doc, g.node!, net, { shared: true }));
        }
      });
    } finally {
      this.writing = false;
    }
  }

  private draw(canvas: Canvas) {
    if (!this.active) return;
    const ed = this.ed;
    // The theme changed the selection color — repaint.
    if (this.accentV !== canvasAccent.version) {
      this.accentV = canvasAccent.version;
      const { r, g, b } = canvasAccent;
      this.paints.line.setColor(this.ck.Color4f(r, g, b, 0.9));
      this.paints.hover.setColor(this.ck.Color4f(r, g, b, 0.15));
      this.paints.merge.setColor(this.ck.Color4f(r, g, b, 0.3));
    }
    const m = this.parent === ed.pageId ? ([1, 0, 0, 0, 1, 0] as Matrix) : (ed.worldMatrix(this.parent) as Matrix);
    const z = ed.camera.zoom;
    canvas.save();
    // Screen = (world − camera) · zoom; world = parent matrix · point.
    canvas.concat([m[0] * z, m[1] * z, (m[2] - ed.camera.x) * z, m[3] * z, m[4] * z, (m[5] - ed.camera.y) * z, 0, 0, 1]);
    this.paints.line.setStrokeWidth(1 / z);
    const touched = new Set(this.drag?.touched ?? []);
    this.regions.forEach((r, k) => {
      if (touched.has(k)) canvas.drawPath(r.path, this.drag!.remove ? this.paints.remove : this.paints.merge);
      else if (k === this.hover) canvas.drawPath(r.path, this.paints.hover);
      canvas.drawPath(r.path, this.paints.line);
    });
    canvas.restore();
  }
}
