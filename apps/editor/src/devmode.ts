// Developer mode (Shift+D): the file is view-only. A click selects the deepest
// layer (an icon — an instance made of vectors — as a whole), Shift — add; editing and drawing tools
// are unavailable. On the right — inspect (inspect-panel.ts), on the canvas — distances on hover (measure.ts)
// and auto layout padding and gaps of the selected frame.

import type { Canvas, Paint } from 'canvaskit-wasm';
import type { Editor, Rect } from './editor.ts';

const VECTORISH = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE', 'ELLIPSE', 'RECTANGLE']);

export class DevMode {
  private ed: Editor;
  private root: HTMLElement;
  private labels: HTMLElement[] = [];
  private fill: Paint | null = null;
  /** Turned on or off (panels, toolbar). */
  onChange: (() => void)[] = [];
  /** Whether a layer can be selected (with focus on a frame — only inside it). */
  allow: ((id: string) => boolean) | null = null;

  constructor(ed: Editor, labelsRoot: HTMLElement) {
    this.ed = ed;
    this.root = labelsRoot;
    ed.overlays.push((canvas) => this.draw(canvas));
  }

  get active() {
    return this.ed.devMode;
  }

  set(on: boolean) {
    if (this.ed.devMode === on) return;
    this.ed.devMode = on;
    this.ed.hover = null;
    this.ed.dirty = true;
    for (const cb of this.onChange) cb();
  }

  /**
   * Layer under the point for inspect: the deepest one. Inside an icon (an instance containing only
   * vectors and shapes) — the instance itself: the developer needs the icon, not its outline.
   */
  pickAt(x: number, y: number): string | null {
    const ed = this.ed;
    const path = ed.scene
      .hitPath(x, y, 3 / ed.camera.zoom)
      .map((n) => ed.scene.id(n))
      .filter((id): id is string => !!id && (!this.allow || this.allow(id)));
    const deepest = path[path.length - 1];
    if (!deepest) return null;
    if (VECTORISH.has(ed.doc.type(deepest) ?? '')) {
      for (let i = path.length - 2; i >= 0; i--) {
        const id = path[i]!;
        if (ed.doc.type(id) === 'INSTANCE' && this.iconLike(id)) return id;
      }
    }
    return deepest;
  }

  /** The instance is an icon: only vectors, shapes and their groups inside. */
  private iconLike(id: string): boolean {
    const doc = this.ed.doc;
    let n = 0;
    for (const d of doc.descendants(id)) {
      const t = doc.type(d)!;
      if (t === 'TEXT' || t === 'INSTANCE' || ++n > 200) return false;
      if (!VECTORISH.has(t) && t !== 'GROUP' && t !== 'FRAME') return false;
    }
    return n > 0;
  }

  // ---------- Pointer on the canvas ----------

  down(e: PointerEvent, x: number, y: number): boolean {
    if (!this.active || this.ed.tool !== 'select') return false;
    if (e.button !== 0) return true;
    const ed = this.ed;
    const t = this.pickAt(x, y);
    if (!t) ed.select([]);
    else if (e.shiftKey) ed.select(ed.selection.includes(t) ? ed.selection.filter((s) => s !== t) : [...ed.selection, t]);
    else ed.select([t]);
    ed.canvasEl.style.cursor = '';
    return true;
  }

  move(_e: PointerEvent, x: number, y: number): boolean {
    if (!this.active || this.ed.tool !== 'select') return false;
    const t = this.pickAt(x, y);
    if (t !== this.ed.hover) {
      this.ed.hover = t;
      this.ed.dirty = true;
    }
    return true;
  }

  up(): boolean {
    return this.active && this.ed.tool === 'select';
  }

  dblclick(): boolean {
    return this.active;
  }

  // ---------- Auto layout padding and gaps ----------

  private paint(): Paint {
    if (this.fill) return this.fill;
    const ck = this.ed.ck;
    this.fill = new ck.Paint();
    this.fill.setColor(ck.Color(242, 80, 155, 0.22));
    this.fill.setAntiAlias(true);
    return this.fill;
  }

  /** Padding and gap areas of the selected auto layout frame (page coordinates). */
  private spacing(): { rect: Rect; label: string }[] {
    const ed = this.ed;
    const doc = ed.doc;
    if (!this.active || ed.selection.length !== 1) return [];
    const id = ed.selection[0]!;
    const mode = doc.get(id, 'layoutMode');
    if (mode !== 'HORIZONTAL' && mode !== 'VERTICAL') return [];
    const t = doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0];
    if (Math.abs(t[1]) > 1e-6 || Math.abs(t[3]) > 1e-6) return [];
    const b = ed.selectionBounds([id]);
    if (!b) return [];
    const [x0, y0, x1, y1] = b;
    const pt = doc.get(id, 'paddingTop') ?? 0;
    const pr = doc.get(id, 'paddingRight') ?? 0;
    const pb = doc.get(id, 'paddingBottom') ?? 0;
    const pl = doc.get(id, 'paddingLeft') ?? 0;
    const out: { rect: Rect; label: string }[] = [];
    const add = (rect: Rect, v: number) => rect[2] - rect[0] > 0.01 && rect[3] - rect[1] > 0.01 && out.push({ rect, label: String(Math.round(v * 100) / 100) });
    add([x0, y0, x1, y0 + pt], pt);
    add([x0, y1 - pb, x1, y1], pb);
    add([x0, y0 + pt, x0 + pl, y1 - pb], pl);
    add([x1 - pr, y0 + pt, x1, y1 - pb], pr);
    const kids = doc
      .children(id)
      .filter((c) => doc.get(c, 'visible') !== false && doc.get(c, 'layoutPositioning') !== 'ABSOLUTE')
      .map((c) => ed.selectionBounds([c]))
      .filter((r): r is Rect => !!r)
      .sort((a, c) => (mode === 'HORIZONTAL' ? a[0] - c[0] : a[1] - c[1]));
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i]!;
      const c = kids[i + 1]!;
      if (mode === 'HORIZONTAL') add([a[2], y0 + pt, c[0], y1 - pb], c[0] - a[2]);
      else add([x0 + pl, a[3], x1 - pr, c[1]], c[1] - a[3]);
    }
    return out;
  }

  private draw(canvas: Canvas) {
    const ed = this.ed;
    const areas = this.spacing();
    const paint = this.paint();
    const shown: { x: number; y: number; label: string }[] = [];
    for (const a of areas) {
      const [sx0, sy0] = ed.worldToScreen(a.rect[0], a.rect[1]);
      const [sx1, sy1] = ed.worldToScreen(a.rect[2], a.rect[3]);
      canvas.drawRect(ed.ck.LTRBRect(sx0, sy0, sx1, sy1), paint);
      // Label — if the area on screen is not tiny.
      if (Math.max(sx1 - sx0, sy1 - sy0) >= 14) shown.push({ x: (sx0 + sx1) / 2, y: (sy0 + sy1) / 2, label: a.label });
    }
    while (this.labels.length < shown.length) {
      const el = document.createElement('div');
      el.className = 'measure-label spacing';
      this.root.append(el);
      this.labels.push(el);
    }
    this.labels.forEach((el, i) => {
      const s = shown[i];
      if (!s) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      if (el.textContent !== s.label) el.textContent = s.label;
      el.style.transform = `translate(calc(${Math.round(s.x)}px - 50%), calc(${Math.round(s.y)}px - 50%))`;
    });
  }
}
