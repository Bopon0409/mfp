// Prototype on the canvas (the “Prototype” tab): connections are arrows from a layer with a
// reaction to a screen (overlay, variant, layer to scroll to); flow start badges above screens;
// the selected layer has a “+” handle: dragging it to a screen creates “On click → Navigate to”.

import type { Canvas, Paint as SkPaint, Path } from 'canvaskit-wasm';
import { pageOf, reactionsOf, screenOf, screensOf, type PrototypeAction, type Reaction } from '@mfp/core';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';

type Pt = [number, number];
type Box = [number, number, number, number];

const HANDLE_R = 7;
/** At most this many connections on screen (large files: thousands of reactions). */
const MAX_LINKS = 400;

/** Screen-space tolerance stays usable at any canvas zoom. */
export function hitsPrototypeCurve(point: Pt, start: Pt, end: Pt, dir: number, straight = false): boolean {
  const dx = straight ? 0 : Math.max(40, Math.abs(end[0] - start[0]) * 0.5);
  let previous = start;
  const steps = Math.max(24, Math.min(256, Math.ceil((Math.hypot(end[0] - start[0], end[1] - start[1]) + dx * 2) / 8)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const p: Pt = [u ** 3 * start[0] + 3 * u * u * t * (start[0] + dx * dir) + 3 * u * t * t * (end[0] - dx * dir) + t ** 3 * end[0], u ** 3 * start[1] + 3 * u * u * t * start[1] + 3 * u * t * t * end[1] + t ** 3 * end[1]];
    const vx = p[0] - previous[0], vy = p[1] - previous[1];
    const k = Math.max(0, Math.min(1, ((point[0] - previous[0]) * vx + (point[1] - previous[1]) * vy) / (vx * vx + vy * vy || 1)));
    if (Math.hypot(point[0] - previous[0] - k * vx, point[1] - previous[1] - k * vy) <= 7) return true;
    previous = p;
  }
  return false;
}

interface Link {
  index: number;
  from: string;
  to: string;
  /** Connection of the selected layer (brighter). */
  hot: boolean;
  /** The target is on another page (prototype across the whole file): a short arrow and a label. */
  away?: boolean;
}

export class ProtoCanvas implements PointerInterceptor {
  private ed: Editor;
  /** The “Prototype” tab is open: connections are visible. */
  on = false;
  private paints: { line: SkPaint; dim: SkPaint; fill: SkPaint; dimFill: SkPaint; plus: SkPaint; target: SkPaint } | null = null;
  private accentV = -1;
  private drag: { from: string; at: Pt; target: string | null } | null = null;
  private badges = new Map<string, HTMLElement>();
  /** Labels of connections to other pages (key — “from>to”). */
  private awayLabels = new Map<string, HTMLElement>();
  private root: HTMLElement;
  /** A connection was created (main.ts opens the settings popup). */
  onCreated: ((id: string, index: number) => void) | null = null;

  constructor(ed: Editor, root: HTMLElement) {
    this.ed = ed;
    this.root = root;
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  get active() {
    return this.drag !== null;
  }

  set(on: boolean) {
    this.on = on;
    if (!on) {
      for (const el of this.badges.values()) el.remove();
      this.badges.clear();
      for (const el of this.awayLabels.values()) el.remove();
      this.awayLabels.clear();
    }
    this.ed.dirty = true;
  }

  // ---------- Geometry ----------

  private box(id: string): Box {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [wx, wy] of this.ed.corners(id)) {
      const [x, y] = this.ed.worldToScreen(wx, wy);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1];
  }

  /** Connection exit point on the layer and entry point on the target (on the sides facing each other). */
  private ends(a: Box, b: Box): [Pt, Pt, number] {
    const right = (b[0] + b[2]) / 2 >= (a[0] + a[2]) / 2;
    const start: Pt = [right ? a[2] : a[0], (a[1] + a[3]) / 2];
    const ey = Math.min(b[3] - 4, Math.max(b[1] + 4, b[1] + Math.min(40, (b[3] - b[1]) / 2)));
    const end: Pt = [right ? b[0] : b[2], ey];
    return [start, end, right ? 1 : -1];
  }

  private curve(start: Pt, end: Pt, dir: number): Path {
    const ck = this.ed.ck;
    const dx = Math.max(40, Math.abs(end[0] - start[0]) * 0.5);
    const b = new ck.PathBuilder();
    b.moveTo(start[0], start[1]);
    b.cubicTo(start[0] + dx * dir, start[1], end[0] - dx * dir, end[1], end[0], end[1]);
    return b.detachAndDelete();
  }

  private ensurePaints() {
    // The theme changed the selection color — recreate the brushes.
    if (this.paints && this.accentV !== canvasAccent.version) {
      for (const p of Object.values(this.paints)) p.delete();
      this.paints = null;
    }
    if (this.paints) return this.paints;
    this.accentV = canvasAccent.version;
    const ck = this.ed.ck;
    const stroke = (a: number, w: number) => {
      const p = new ck.Paint();
      p.setAntiAlias(true);
      p.setStyle(ck.PaintStyle.Stroke);
      p.setStrokeWidth(w);
      p.setColor(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, a));
      return p;
    };
    const fill = (r: number, g: number, b: number, a: number) => {
      const p = new ck.Paint();
      p.setAntiAlias(true);
      p.setColor(ck.Color4f(r, g, b, a));
      return p;
    };
    const plus = new ck.Paint();
    plus.setAntiAlias(true);
    plus.setStyle(ck.PaintStyle.Stroke);
    plus.setStrokeWidth(1.5);
    plus.setColor(ck.WHITE);
    const { r, g, b } = canvasAccent;
    this.paints = { line: stroke(1, 2), dim: stroke(0.45, 1.5), fill: fill(r, g, b, 1), dimFill: fill(r, g, b, 0.45), plus, target: stroke(1, 2) };
    return this.paints;
  }

  // ---------- Connections ----------

  /** Where an action leads (including conditional branches). */
  private destinations(actions: PrototypeAction[], out: { to: string; change: boolean }[]) {
    for (const a of actions) {
      if (a.type === 'NODE' && a.destinationId) out.push({ to: a.destinationId, change: a.navigation === 'CHANGE_TO' });
      if (a.type === 'CONDITIONAL') for (const b of a.conditionalBlocks) this.destinations(b.actions, out);
    }
  }

  private links(): Link[] {
    const { ed } = this;
    const doc = ed.doc;
    const sel = ed.selection.filter((id) => doc.has(id));
    const out: Link[] = [];
    // “Change to” on instances (interactive components) — no connections: they are visible in the variant set.
    const inInstance = new Map<string, boolean>();
    const insideInstance = (id: string): boolean => {
      let v = inInstance.get(id);
      if (v === undefined) {
        const p = doc.parent(id);
        v = doc.type(id) === 'INSTANCE' || (!!p && doc.type(p) !== 'PAGE' && insideInstance(p));
        inInstance.set(id, v);
      }
      return v;
    };
    const add = (id: string, reactions: Reaction[], hot: boolean) => {
      reactions.forEach((r, index) => {
        const dest: { to: string; change: boolean }[] = [];
        this.destinations(r.actions, dest);
        for (const { to, change } of dest) {
          if (to === id || !doc.has(to)) continue;
          if (change && insideInstance(id)) continue;
          out.push({ from: id, to, index, hot, ...(ed.isOnPage(to) ? {} : { away: true }) });
        }
      });
    };
    if (sel.length) {
      // Selected layers and everything inside them: their own reactions (for instances — inherited ones too).
      for (const s of sel) {
        add(s, reactionsOf(doc, s), true);
        for (const d of doc.descendants(s)) {
          if (out.length > MAX_LINKS) break;
          const own = doc.get(d, 'reactions');
          if (own?.length) add(d, own, true);
        }
      }
      return out;
    }
    // Nothing selected: all connections on the page (only the layers' own reactions, no inherited ones).
    for (const d of doc.descendants(ed.pageId)) {
      const own = doc.get(d, 'reactions');
      if (own?.length) add(d, own, false);
      if (out.length > MAX_LINKS) break;
    }
    return out;
  }

  // ---------- Rendering ----------

  private draw(canvas: Canvas) {
    if (!this.on) return;
    const { ed } = this;
    const doc = ed.doc;
    const ck = ed.ck;
    const p = this.ensurePaints();
    const W = ed.viewW;
    const H = ed.viewH;
    const visible = (b: Box) => b[2] >= -200 && b[0] <= W + 200 && b[3] >= -200 && b[1] <= H + 200;
    const away = new Set<string>();
    for (const l of this.links()) {
      const a = this.box(l.from);
      if (l.away) {
        // Target on another page: an arrow to the right of the layer and a “Page · Screen” label (click goes there).
        if (!visible(a)) continue;
        // To the right of the new connection handle (the “+” circle 10 px from the edge).
        const start: Pt = [a[2] + 20, (a[1] + a[3]) / 2];
        const end: Pt = [a[2] + 52, start[1]];
        canvas.drawLine(start[0], start[1], end[0], end[1], l.hot ? p.line : p.dim);
        this.arrow(canvas, end, 1, l.hot ? p.fill : p.dimFill);
        if (l.hot) canvas.drawCircle(start[0], start[1], 3.5, p.fill);
        this.awayLabel(l, end);
        away.add(`${l.from}>${l.to}`);
        continue;
      }
      const b = this.box(l.to);
      if (!visible(a) && !visible(b)) continue;
      const [start, end, dir] = this.ends(a, b);
      const path = this.curve(start, end, dir);
      canvas.drawPath(path, l.hot ? p.line : p.dim);
      path.delete();
      this.arrow(canvas, end, dir, l.hot ? p.fill : p.dimFill);
      if (l.hot) canvas.drawCircle(start[0], start[1], 3.5, p.fill);
    }
    // New connection handle on a single selected layer.
    const one = ed.selection.length === 1 && doc.has(ed.selection[0]!) ? ed.selection[0]! : null;
    if (one && ed.isOnPage(one)) {
      const [hx, hy] = this.handlePos(one);
      canvas.drawCircle(hx, hy, HANDLE_R, p.fill);
      canvas.drawLine(hx - 3.5, hy, hx + 3.5, hy, p.plus);
      canvas.drawLine(hx, hy - 3.5, hx, hy + 3.5, p.plus);
    }
    if (this.drag) {
      const a = this.box(this.drag.from);
      const start: Pt = [a[2], (a[1] + a[3]) / 2];
      const [ex, ey] = this.ed.worldToScreen(this.drag.at[0], this.drag.at[1]);
      const dir = ex >= start[0] ? 1 : -1;
      const path = this.curve(start, [ex, ey], dir);
      canvas.drawPath(path, p.line);
      path.delete();
      if (this.drag.target) {
        const t = this.box(this.drag.target);
        canvas.drawRect(ck.LTRBRect(t[0], t[1], t[2], t[3]), p.target);
      }
      canvas.drawCircle(ex, ey, 4, p.fill);
    }
    this.updateBadges();
    for (const [key, el] of this.awayLabels) {
      if (away.has(key)) continue;
      el.remove();
      this.awayLabels.delete(key);
    }
  }

  private arrow(canvas: Canvas, end: Pt, dir: number, paint: SkPaint) {
    const ck = this.ed.ck;
    const b = new ck.PathBuilder();
    b.moveTo(end[0], end[1]);
    b.lineTo(end[0] - 8 * dir, end[1] - 4.5);
    b.lineTo(end[0] - 8 * dir, end[1] + 4.5);
    b.close();
    const path = b.detachAndDelete();
    canvas.drawPath(path, paint);
    path.delete();
  }

  /** The “+” handle: at the middle of the layer's right edge (10 px outside). */
  private handlePos(id: string): Pt {
    const b = this.box(id);
    return [b[2] + 10, (b[1] + b[3]) / 2];
  }

  /** Label of a connection to another page at the end of its arrow; click goes to the target. */
  private awayLabel(l: Link, end: Pt) {
    const { ed } = this;
    const doc = ed.doc;
    const key = `${l.from}>${l.to}`;
    let el = this.awayLabels.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'proto-away';
      el.title = 'Перейти к экрану';
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const to = l.to;
        const page = doc.has(to) ? pageOf(doc, to) : null;
        if (!page) return;
        ed.setPage(page);
        ed.select([to]);
        ed.fitRect(ed.selectionBounds(), 8, true);
      });
      this.root.append(el);
      this.awayLabels.set(key, el);
    }
    const page = pageOf(doc, l.to);
    const text = `${page ? (doc.get(page, 'name') ?? 'Страница') : 'Страница'} · ${doc.get(l.to, 'name') ?? l.to}`;
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('hot', l.hot);
    el.style.transform = `translate(${Math.round(end[0] + 8)}px, ${Math.round(end[1] - 9)}px)`;
  }

  /** Flow start badges above screens (DOM — next to frame labels). */
  private updateBadges() {
    const { ed } = this;
    const doc = ed.doc;
    const flows = (doc.get(ed.pageId, 'flowStartingPoints') ?? []).filter((f) => doc.has(f.nodeId) && ed.isOnPage(f.nodeId));
    const seen = new Set<string>();
    for (const f of flows) {
      const b = this.box(f.nodeId);
      if (b[2] < 0 || b[0] > ed.viewW || b[3] < 0 || b[1] - 40 > ed.viewH) continue;
      seen.add(f.nodeId);
      let el = this.badges.get(f.nodeId);
      if (!el) {
        el = document.createElement('div');
        el.className = 'flow-badge';
        this.root.append(el);
        this.badges.set(f.nodeId, el);
      }
      const text = `▶ ${f.name || 'Поток'}`;
      if (el.textContent !== text) el.textContent = text;
      el.style.transform = `translate(${Math.round(b[0])}px, ${Math.round(b[1] - 40)}px)`;
    }
    for (const [id, el] of this.badges) {
      if (seen.has(id)) continue;
      el.remove();
      this.badges.delete(id);
    }
  }

  // ---------- Pointer ----------

  /** The screen under a world point (topmost). */
  private screenAt(wx: number, wy: number, except: string | null): string | null {
    const { ed } = this;
    const doc = ed.doc;
    const list = screensOf(doc, ed.pageId).filter((s) => doc.type(s) !== 'COMPONENT_SET' && doc.get(s, 'visible') !== false);
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i]!;
      if (s === except) continue;
      const b = ed.selectionBounds([s]);
      if (b && wx >= b[0] && wx <= b[2] && wy >= b[1] && wy <= b[3]) return s;
    }
    return null;
  }

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.on || e.button !== 0) return false;
    const { ed } = this;
    const one = ed.selection.length === 1 && ed.doc.has(ed.selection[0]!) ? ed.selection[0]! : null;
    const [sx, sy] = ed.worldToScreen(wx, wy);
    if (!one || Math.hypot(sx - this.handlePos(one)[0], sy - this.handlePos(one)[1]) > HANDLE_R + 3) {
      for (const link of this.links().reverse()) {
        const a = this.box(link.from);
        const [start, end, dir] = link.away ? [[a[2] + 20, (a[1] + a[3]) / 2], [a[2] + 52, (a[1] + a[3]) / 2], 1] as [Pt, Pt, number] : this.ends(a, this.box(link.to));
        if (hitsPrototypeCurve([sx, sy], start, end, dir, !!link.away)) {
          ed.select([link.from]); this.onCreated?.(link.from, link.index); ed.dirty = true; return true;
        }
      }
      return false;
    }
    const [hx, hy] = this.handlePos(one);
    if (Math.hypot(sx - hx, sy - hy) > HANDLE_R + 3) return false;
    this.drag = { from: one, at: [wx, wy], target: null };
    ed.dirty = true;
    return true;
  }

  move(_e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.drag) return false;
    this.drag.at = [wx, wy];
    this.drag.target = this.screenAt(wx, wy, screenOf(this.ed.doc, this.drag.from));
    this.ed.dirty = true;
    return true;
  }

  up(): boolean {
    const d = this.drag;
    if (!d) return false;
    this.drag = null;
    this.ed.dirty = true;
    if (!d.target) return true;
    const doc = this.ed.doc;
    const list = doc.type(d.from) === 'INSTANCE' ? reactionsOf(doc, d.from) : (doc.get(d.from, 'reactions') ?? []);
    const r: Reaction = { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: d.target, navigation: 'NAVIGATE', transition: null }] };
    // There is already an on-click — the new connection replaces its target.
    const at = list.findIndex((x) => x.trigger?.type === 'ON_CLICK');
    const next = at >= 0 ? list.map((x, i) => (i === at ? { ...x, actions: [{ ...(x.actions[0]?.type === 'NODE' ? x.actions[0] : r.actions[0]!), destinationId: d.target, navigation: 'NAVIGATE' as const }, ...x.actions.slice(1)] } : x)) : [...list, r];
    doc.transact(() => doc.set(d.from, { reactions: next as Reaction[] }));
    this.onCreated?.(d.from, at >= 0 ? at : next.length - 1);
    return true;
  }
}
