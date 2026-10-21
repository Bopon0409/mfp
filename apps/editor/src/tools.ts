// Pointer handling: selection, moving, resizing, selection box,
// creating shapes by dragging, panning. Selection rules.

import { invert, multiply, type Matrix, type NodeType, type Props, acceptsChildren } from '@mfp/core';
import type { Editor, Rect, Tool } from './editor.ts';
import { layerLocked } from '@mfp/core';
import { installCanvasWheel } from './canvas-wheel.ts';
import { SNAP_PX, RESIZE_SNAP_PX, Snapper, type Guide } from './snap.ts';
import { applyConstraints, canFill, canHug, gridLayout, isAutoLayout, scaleTree, setSizing, sizingProps, snapshotProps, type Axis } from '@mfp/editing';
import type { PointerInterceptor } from './vector.ts';
import { defaultShapeProps, defaultTextProps } from './default-text.ts';
import { arrangement, gapHandles, reorderHandles, reorderPlan, type Arrangement } from './smart.ts';

/** Where the dragged layer can be dropped. */
const DROP_TARGETS = new Set(['FRAME', 'COMPONENT', 'SECTION']);
/** Containers that go into another frame only if they fit inside it entirely. */
const FRAME_LIKE = new Set(['FRAME', 'COMPONENT', 'SECTION', 'INSTANCE']);

type Mode =
  | { kind: 'idle' }
  | { kind: 'intercept' }
  | { kind: 'pan'; sx: number; sy: number; cam: { x: number; y: number; zoom: number } }
  | {
      kind: 'move';
      start: [number, number];
      origins: Map<string, Matrix>;
      moved: boolean;
      snap?: Snapper;
      bounds?: Rect;
      /** Layers temporarily taken out of the auto layout flow during a drag. */
      lifted?: string[];
      /** Where they will drop: parent and position (for auto layout). */
      target?: string;
      index?: number;
      /** Into a grid: the cell under the pointer; where the drag started from (the cell in its grid before the start). */
      cell?: { row: number; column: number };
      gridFrom?: Map<string, { row: number; column: number }>;
      /** Pressed a widget element with a handler: without a drag — a click into the widget. */
      widgetClick?: { widget: string; path: string; node: string } | null;
    }
  | { kind: 'resize'; id: string; handle: number; start: [number, number]; transform: Matrix; w: number; h: number; snap?: Snapper; snapshot?: Map<string, Props> }
  | {
      kind: 'marquee';
      start: [number, number];
      base: string[];
      /** Layers the selection box picks from, with their bounds (computed once). */
      candidates?: { id: string; b: Rect }[];
      /** A click without a drag selects this frame (the box started on its empty area). */
      clickSelects?: string;
    }
  | { kind: 'zoom'; start: [number, number]; sx: number; sy: number; out: boolean }
  | { kind: 'rotate'; id: string; center: [number, number]; a0: number; world: Matrix; parentWorld: Matrix }
  | { kind: 'resizeMany'; handle: number; box: Rect; items: ManyItem[]; snap?: Snapper; snapshot: Map<string, Props> }
  | { kind: 'scale'; handle: number; box: Rect; items: ManyItem[]; snapshot: Map<string, Props> }
  | { kind: 'gap'; arr: Arrangement; start: [number, number]; origins: Map<string, Matrix> }
  | { kind: 'reorder'; arr: Arrangement; index: number; start: [number, number]; origins: Map<string, Matrix>; moved: boolean }
  | { kind: 'rotateMany'; center: [number, number]; a0: number; items: ManyItem[] }
  | { kind: 'create'; id: string; anchor: [number, number]; parent: string; parentInv: Matrix; moved: boolean; snap: Snapper }
  | { kind: 'line'; id: string; anchor: [number, number]; parentInv: Matrix; moved: boolean; snap: Snapper };

/** A layer in the shared box of several selected: original world matrix and size. */
interface ManyItem {
  id: string;
  world: Matrix;
  parentWorld: Matrix;
  w: number;
  h: number;
}

/** Handle's fraction of width and height (0 nw, 1 n, 2 ne, 3 e, 4 se, 5 s, 6 sw, 7 w). */
const HANDLE_X = [0, 0.5, 1, 1, 1, 0.5, 0, 0];
const HANDLE_Y = [0, 0, 0, 0.5, 1, 1, 1, 0.5];

/** Top-level frames as artboards: empty space inside — a selection box over the children. */
const ARTBOARDS = new Set(['FRAME', 'COMPONENT', 'SECTION']);
/** Containers: a selection box with Ctrl takes their deepest layers. */
const GROUPS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'SECTION', 'BOOLEAN_OPERATION']);

/** Containers inside which new shapes are created. */
const CONTAINERS = new Set<NodeType>(['FRAME', 'SECTION', 'COMPONENT', 'INSTANCE']);
const KEYBOARD_CREATE = new Set<Tool>(['frame', 'section', 'slice', 'rect', 'ellipse', 'polygon', 'star', 'text']);
const HIT_HANDLE = 7;
/** Hit tolerance for lines, screen pixels. */
const HIT_LINE = 4;
/** Rotation cursor: a curved arrow. */
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M5 14a7 7 0 0 1 12-6l2-2v6h-6l2-2a4.5 4.5 0 0 0-7.6 4" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>')}") 12 12, crosshair`;

export class Tools {
  private ed: Editor;
  private mode: Mode = { kind: 'idle' };
  spaceHeld = false;
  /** Z held — magnifier: click zooms in (with Alt — out), a box — zoom to the area. */
  zoomHeld = false;
  /** Called when the tool switched by itself (e.g. after creating a shape). */
  onToolChange: (() => void) | null = null;
  /** Start text editing (wired up by main.ts). */
  onEditText: ((id: string, isNew: boolean, at?: [number, number]) => void) | null = null;
  /** The “Text” tool on a vector or shape path: text on a path (true — created). */
  onTextOnPath: ((wx: number, wy: number) => boolean) | null = null;
  /** Start editing a vector path (wired up by main.ts). */
  onEditVector: ((id: string) => void) | null = null;
  /** Pointer interception: pen and path editing (see vector.ts). */
  interceptor: PointerInterceptor | null = null;
  /** Copies of layers in place for Alt-drag (wired up by main.ts). */
  duplicateForDrag: ((ids: string[]) => string[]) | null = null;
  /** The alignment key object changed (the panel redraws “Position”). */
  onKeyObject: (() => void) | null = null;
  /** Right click: show the context menu (window screen coordinates and the canvas point). */
  onContextMenu: ((clientX: number, clientY: number, at: [number, number]) => void) | null = null;
  /** Click on a widget element with a handler (the element's path in the widget tree). */
  onWidgetClick: ((widget: string, path: string, node: string) => void) | null = null;

  private creationCursor = false;

  constructor(ed: Editor) {
    this.ed = ed;
    const c = ed.canvasEl;
    c.addEventListener('pointerdown', (e) => { this.creationCursor = false; this.down(e); });
    c.addEventListener('pointermove', (e) => { if (this.creationCursor) { this.creationCursor = false; ed.dirty = true; } this.move(e); });
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e));
    c.addEventListener('dblclick', (e) => this.dblclick(e));
    installCanvasWheel(c, window, (e) => this.wheel(e));
    c.addEventListener('contextmenu', (e) => this.contextMenu(e));
    ed.overlays.push((canvas) => {
      if (!this.creationCursor || !KEYBOARD_CREATE.has(ed.tool) || ed.devMode) return;
      const x = ed.viewW / 2, y = ed.viewH / 2;
      const p = new ed.ck.Paint();
      p.setAntiAlias(true);
      p.setColor(ed.ck.Color4f(0.2, 0.4, 1, 1));
      p.setStrokeWidth(2);
      canvas.drawLine(x - 12, y, x + 12, y, p);
      canvas.drawLine(x, y - 12, x, y + 12, p);
      p.delete();
    });
  }

  prepareKeyboardCreation() {
    this.creationCursor = KEYBOARD_CREATE.has(this.ed.tool);
    if (this.creationCursor) {
      this.ed.canvasEl.focus();
      this.ed.notify?.('Enter — поставить объект в центре холста, стрелки — прокрутить, Esc — отменить');
    }
  }

  creationKey(e: KeyboardEvent): boolean {
    const ed = this.ed;
    if (!KEYBOARD_CREATE.has(ed.tool) || ed.devMode || this.mode.kind !== 'idle' || e.ctrlKey || e.metaKey || e.altKey) return false;
    const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key];
    if (delta) {
      this.creationCursor = true;
      const step = (e.shiftKey ? 400 : 80) / ed.camera.zoom;
      ed.setCamera({ ...ed.camera, x: ed.camera.x + delta[0] * step, y: ed.camera.y + delta[1] * step });
      return true;
    }
    if (e.shiftKey || !['Enter', 'Escape'].includes(e.key)) return false;
    this.creationCursor = false;
    if (e.key === 'Escape') {
      ed.tool = 'select'; ed.dirty = true; this.onToolChange?.(); return true;
    }
    if (e.repeat) return true;
    this.beginCreate(...ed.screenToWorld(ed.viewW / 2, ed.viewH / 2), false, true);
    // beginCreate updates mode; use a method to avoid TypeScript's stale narrowing.
    this.completeKeyboardCreation();
    return true;
  }

  private completeKeyboardCreation() {
    const m = this.mode;
    this.mode = { kind: 'idle' };
    if (m.kind !== 'create') return;
    this.ed.endLive();
    this.finishCreate(m);
  }

  /** Right click: the layer under the pointer becomes selected (if it wasn't), then the menu. */
  private contextMenu(e: MouseEvent) {
    e.preventDefault();
    const ed = this.ed;
    if (this.interceptor?.active || this.mode.kind !== 'idle') return;
    const [sx, sy] = this.local(e);
    const at = ed.screenToWorld(sx, sy);
    if (ed.tool === 'select') {
      const t = this.pick(at[0], at[1], e.ctrlKey || e.metaKey);
      if (!t) ed.select([]);
      else if (!ed.selection.includes(t)) ed.select([t]);
    }
    this.onContextMenu?.(e.clientX, e.clientY, at);
  }

  private local(e: PointerEvent | MouseEvent): [number, number] {
    const r = this.ed.canvasEl.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Node pick by click: top level; inside a top-level frame — its direct child; Ctrl — the deepest. */
  pick(wx: number, wy: number, deep: boolean): string | null {
    const ed = this.ed;
    let path = ed.scene
      .hitPath(wx, wy, HIT_LINE / ed.camera.zoom)
      .map((n) => ed.scene.id(n)!)
      .filter((id) => !layerLocked(ed.doc, id));
    // Isolation: only inside the isolated layer (it acts as the page); outside — nothing.
    if (ed.isolation?.length) {
      const k = path.findIndex((id) => ed.isolation.includes(id));
      if (k < 0) return null;
      path = path.length > k + 1 ? path.slice(k + 1) : [path[k]!];
    }
    if (!path.length) return null;
    // A widget — as a whole: don't go inside.
    const widget = path.find((id) => ed.doc.get(id, 'widget'));
    if (widget) return widget;
    if (deep) return path[path.length - 1]!;
    // An already selected node or its ancestor on the path — keep working with it.
    for (const id of path) if (ed.selection.includes(id)) return id;
    const top = path[0]!;
    if (CONTAINERS.has(ed.doc.type(top)!) && path.length > 1 && ed.doc.type(top) !== 'INSTANCE') return path[1]!;
    return top;
  }

  /** Widget element with a click handler under the point: the widget and the element path. */
  widgetHit(wx: number, wy: number): { widget: string; path: string; node: string } | null {
    const ed = this.ed;
    const path = ed.scene.hitPath(wx, wy, HIT_LINE / ed.camera.zoom).map((n) => ed.scene.id(n)!);
    const wi = path.findIndex((id) => ed.doc.get(id, 'widget'));
    if (wi < 0) return null;
    for (let i = path.length - 1; i > wi; i--) {
      const h = ed.doc.get(path[i]!, 'widgetHandler');
      if (h) return { widget: path[wi]!, path: h, node: path[i]! };
    }
    return null;
  }

  /** Visible and unlocked layers with their page bounds (for the selection box). */
  private boxes(ids: readonly string[]): { id: string; b: Rect }[] {
    const doc = this.ed.doc;
    const out: { id: string; b: Rect }[] = [];
    for (const id of ids) {
      if (doc.get(id, 'visible') === false || layerLocked(doc, id)) continue;
      const b = this.ed.selectionBounds([id]);
      if (b) out.push({ id, b });
    }
    return out;
  }

  /** The deepest visible page layers on screen and nearby (for the Ctrl selection box). */
  private deepCandidates(): { id: string; b: Rect }[] {
    const ed = this.ed;
    const doc = ed.doc;
    const v = ed.viewportRect();
    const out: { id: string; b: Rect }[] = [];
    const walk = (p: string) => {
      for (const id of doc.children(p)) {
        if (doc.get(id, 'visible') === false || layerLocked(doc, id)) continue;
        const b = ed.selectionBounds([id]);
        if (!b || b[0] > v[2] || b[2] < v[0] || b[1] > v[3] || b[3] < v[1]) continue;
        if (GROUPS.has(doc.type(id) ?? '') && doc.children(id).length) walk(id);
        else out.push({ id, b });
      }
    };
    walk(ed.pageId);
    return out;
  }

  /** Empty area of a top-level frame acts as an artboard (not for a widget: it's a single object, its buttons are pressed directly). */
  private isArtboardBackground(id: string): boolean {
    const doc = this.ed.doc;
    return doc.parent(id) === this.ed.pageId && ARTBOARDS.has(doc.type(id) ?? '') && doc.children(id).length > 0 && !doc.get(id, 'widget');
  }

  /** Start dragging the selection (e.g. by the frame label on the canvas). */
  beginMove(e: PointerEvent) {
    const ed = this.ed;
    if (!ed.selection.length) return;
    try {
      ed.canvasEl.setPointerCapture(e.pointerId);
    } catch {
      // Without capture — events still come through the window.
    }
    const [sx, sy] = this.local(e);
    const [wx, wy] = ed.screenToWorld(sx, sy);
    ed.doc.beginGroup();
    const origins = new Map<string, Matrix>();
    for (const id of ed.selection) origins.set(id, [...(ed.doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0])] as Matrix);
    this.mode = { kind: 'move', start: [wx, wy], origins, moved: false };
  }

  /** Smart selection reorder dot under a screen point: row and layer index. */
  private reorderAt(sx: number, sy: number): { arr: Arrangement; index: number } | null {
    const arr = arrangement(this.ed);
    if (!arr) return null;
    const i = reorderHandles(this.ed, arr).findIndex((p) => !!p && Math.hypot(p.x - sx, p.y - sy) <= 7);
    return i >= 0 ? { arr, index: i } : null;
  }

  /** Layer offset by (dx, dy) in page coordinates from the original position. */
  private shiftFrom(id: string, origin: Matrix, dx: number, dy: number) {
    const ed = this.ed;
    const parent = ed.doc.parent(id)!;
    const inv = invert((parent === ed.pageId ? [1, 0, 0, 0, 1, 0] : ed.worldMatrix(parent)) as Matrix);
    ed.doc.set(id, { transform: [origin[0], origin[1], origin[2] + inv[0] * dx + inv[1] * dy, origin[3], origin[4], origin[5] + inv[3] * dx + inv[4] * dy] });
  }

  /** Smart selection gap handle under a screen point (within 6 px). */
  private gapAt(sx: number, sy: number): Arrangement | null {
    const arr = arrangement(this.ed);
    if (!arr) return null;
    return gapHandles(this.ed, arr).some((p) => Math.abs(p.x - sx) <= 6 && Math.abs(p.y - sy) <= 10) ? arr : null;
  }

  /** Rotation zone: just outside a corner handle. */
  private rotateZoneAt(sx: number, sy: number): boolean {
    if (this.ed.selection.some(id => this.ed.doc.type(id) === 'SECTION' && this.ed.doc.get(id, 'sectionRotationEnabled') !== true)) return false;
    const hs = this.ed.handlePositions();
    if (!this.ed.selection.length || hs.length !== 8) return false;
    const c = [hs[0]!, hs[2]!, hs[4]!, hs[6]!];
    const cx = (c[0]![0] + c[2]![0]) / 2;
    const cy = (c[0]![1] + c[2]![1]) / 2;
    return c.some(([x, y]) => {
      if (Number.isNaN(x)) return false;
      const d = Math.hypot(sx - x, sy - y);
      // Outside the corner: farther from the center than the corner itself.
      return d > HIT_HANDLE && d < HIT_HANDLE + 14 && Math.hypot(sx - cx, sy - cy) > Math.hypot(x - cx, y - cy);
    });
  }

  private handleAt(sx: number, sy: number): number {
    const hs = this.ed.handlePositions();
    for (let i = 0; i < hs.length; i++) if (Math.abs(hs[i]![0] - sx) <= HIT_HANDLE && Math.abs(hs[i]![1] - sy) <= HIT_HANDLE) return i;
    return -1;
  }

  private down(e: PointerEvent) {
    const ed = this.ed;
    ed.canvasEl.focus();
    ed.canvasEl.setPointerCapture(e.pointerId);
    const [sx, sy] = this.local(e);
    let [wx, wy] = ed.screenToWorld(sx, sy);
    if (e.button === 1 || this.spaceHeld || ed.tool === 'hand') {
      this.mode = { kind: 'pan', sx, sy, cam: { ...ed.camera } };
      return;
    }
    if (e.button !== 0) return;
    if (ed.selection.some(id => layerLocked(ed.doc, id))) ed.select(ed.selection.filter(id => !layerLocked(ed.doc, id)));
    if (this.zoomHeld) {
      this.mode = { kind: 'zoom', start: [wx, wy], sx, sy, out: e.altKey };
      return;
    }
    if (this.interceptor?.down(e, wx, wy)) {
      this.mode = { kind: 'intercept' };
      return;
    }

    if (ed.tool === 'scale') {
      // Scale (K): box handles scale layers entirely — with strokes, text and contents.
      const h = this.handleAt(sx, sy);
      if (h >= 0 && ed.selection.length) {
        const ids = ed.selection.filter((id) => ed.doc.has(id));
        const items: ManyItem[] = ids.map((id) => {
          const parent = ed.doc.parent(id)!;
          return {
            id,
            world: ed.worldMatrix(id) as Matrix,
            parentWorld: (parent === ed.pageId ? [1, 0, 0, 0, 1, 0] : ed.worldMatrix(parent)) as Matrix,
            w: ed.doc.get(id, 'width') ?? 0,
            h: ed.doc.get(id, 'height') ?? 0,
          };
        });
        ed.doc.beginGroup();
        ed.beginLive(ids, 'direct');
        this.mode = { kind: 'scale', handle: h, box: ed.selectionBounds(ids)!, items, snapshot: snapshotProps(ed.doc, ids) };
        return;
      }
    }
    if (ed.tool === 'select') {
      // Smart selection: the dot at the center of a row layer — reorder it.
      const re = this.reorderAt(sx, sy);
      if (re) {
        const origins = new Map<string, Matrix>();
        for (const it of re.arr.items) origins.set(it.id, [...(ed.doc.get(it.id, 'transform') ?? [1, 0, 0, 0, 1, 0])] as Matrix);
        ed.doc.beginGroup();
        ed.beginLive(re.arr.items.map((i) => i.id), 'direct');
        this.mode = { kind: 'reorder', arr: re.arr, index: re.index, start: [wx, wy], origins, moved: false };
        return;
      }
      // Smart selection: a row gap handle — change all gaps at once.
      const arr = this.gapAt(sx, sy);
      if (arr) {
        const origins = new Map<string, Matrix>();
        for (const it of arr.items) origins.set(it.id, [...(ed.doc.get(it.id, 'transform') ?? [1, 0, 0, 0, 1, 0])] as Matrix);
        ed.doc.beginGroup();
        ed.beginLive(arr.items.map((i) => i.id), 'direct');
        this.mode = { kind: 'gap', arr, start: [wx, wy], origins };
        return;
      }
    }
    if (ed.tool === 'select' || ed.tool === 'scale') {
      // Several layers: rotation around the center of the shared box, resize — with its handles.
      if (ed.selection.length > 1 && (this.handleAt(sx, sy) >= 0 || this.rotateZoneAt(sx, sy))) {
        const h = this.handleAt(sx, sy);
        const ids = ed.selection.filter((id) => ed.doc.has(id));
        const items: ManyItem[] = ids.map((id) => {
          const parent = ed.doc.parent(id)!;
          return {
            id,
            world: ed.worldMatrix(id) as Matrix,
            parentWorld: (parent === ed.pageId ? [1, 0, 0, 0, 1, 0] : ed.worldMatrix(parent)) as Matrix,
            w: ed.doc.get(id, 'width') ?? 0,
            h: ed.doc.get(id, 'height') ?? 0,
          };
        });
        const box = ed.selectionBounds(ids)!;
        ed.doc.beginGroup();
        ed.beginLive(ids, 'direct');
        if (h >= 0) this.mode = { kind: 'resizeMany', handle: h, box, items, snap: Snapper.forNodes(ed, ids), snapshot: snapshotProps(ed.doc, ids) };
        else {
          const center = ed.rotationPivot(ids) ?? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
          ed.rotating = true;
          this.mode = { kind: 'rotateMany', center, a0: Math.atan2(wy - center[1], wx - center[0]), items };
        }
        return;
      }
      // Rotation — outside a corner handle.
      if (this.handleAt(sx, sy) < 0 && this.rotateZoneAt(sx, sy)) {
        const id = ed.selection[0]!;
        const world = ed.worldMatrix(id) as Matrix;
        // Around the pivot point (box center by default).
        const center = ed.rotationPivot([id])!;
        ed.rotating = true;
        const parent = ed.doc.parent(id)!;
        ed.doc.beginGroup();
        ed.beginLive([id], 'direct');
        this.mode = {
          kind: 'rotate',
          id,
          center,
          a0: Math.atan2(wy - center[1], wx - center[0]),
          world,
          parentWorld: (parent === ed.pageId ? [1, 0, 0, 0, 1, 0] : ed.worldMatrix(parent)) as Matrix,
        };
        return;
      }
      // Resize handles (only for a single selected node).
      const h = this.handleAt(sx, sy);
      if (h >= 0 && ed.selection.length === 1) {
        const id = ed.selection[0]!;
        ed.doc.beginGroup();
        ed.beginLive([id], 'direct');
        // Handle snapping — only for unrotated and unflipped nodes (the box matches the bounds).
        const wm = ed.worldMatrix(id);
        const axisAligned = Math.abs(wm[1]) < 1e-6 && Math.abs(wm[3]) < 1e-6 && wm[0] > 0 && wm[4] > 0;
        this.mode = {
          kind: 'resize',
          id,
          handle: h,
          start: [wx, wy],
          transform: [...(ed.doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0])] as Matrix,
          w: ed.doc.get(id, 'width') ?? 0,
          h: ed.doc.get(id, 'height') ?? 0,
          snap: axisAligned ? Snapper.forResize(ed, [id]) : undefined,
          // Children are placed by constraints from the original state (no error accumulation).
          snapshot: ed.doc.children(id).length ? snapshotProps(ed.doc, [id]) : undefined,
        };
        return;
      }
      const target = this.pick(wx, wy, e.ctrlKey || e.metaKey);
      // Empty area of an unselected top-level frame: a selection
      // box over its children, click — select the frame. The frame is moved by its label or when selected.
      if (target && !e.shiftKey && !(e.ctrlKey || e.metaKey) && !ed.selection.includes(target) && this.isArtboardBackground(target)) {
        this.mode = { kind: 'marquee', start: [wx, wy], base: [], candidates: this.boxes(ed.doc.children(target)), clickSelects: target };
        ed.marquee = [wx, wy, wx, wy];
        return;
      }
      if (target) {
        if (e.shiftKey) {
          ed.select(ed.selection.includes(target) ? ed.selection.filter((s) => s !== target) : [...ed.selection, target]);
          if (!ed.selection.includes(target)) return;
        } else if (!ed.selection.includes(target)) ed.select([target]);
        ed.doc.beginGroup();
        const origins = new Map<string, Matrix>();
        for (const id of ed.selection) origins.set(id, [...(ed.doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0])] as Matrix);
        this.mode = { kind: 'move', start: [wx, wy], origins, moved: false, widgetClick: e.shiftKey ? null : this.widgetHit(wx, wy) };
        return;
      }
      const base = e.shiftKey ? [...ed.selection] : [];
      if (!e.shiftKey) ed.select([]);
      // Ctrl — the box picks the deepest layers, otherwise — the page's top level.
      const deep = e.ctrlKey || e.metaKey;
      // Isolation: the box picks children of the isolated layers.
      const isolated = (ed.isolation ?? []).filter((id) => ed.doc.has(id));
      this.mode = { kind: 'marquee', start: [wx, wy], base, candidates: deep ? this.deepCandidates() : isolated.length ? this.boxes(isolated.flatMap((id) => (ed.doc.children(id).length ? ed.doc.children(id) : [id]))) : undefined };
      ed.marquee = [wx, wy, wx, wy];
      return;
    }

    this.beginCreate(wx, wy, !(e.ctrlKey || e.metaKey));
  }

  /** Shared by pointer insertion and keyboard placement. */
  private beginCreate(wx: number, wy: number, snapToObjects: boolean, keyboard = false) {
    const ed = this.ed;
    // Creating a shape: inside the deepest container under the pointer.
    const TOOL_TYPES: Partial<Record<string, NodeType>> = { frame: 'FRAME', section: 'SECTION', slice: 'SLICE', ellipse: 'ELLIPSE', text: 'TEXT', line: 'LINE', arrow: 'LINE', polygon: 'POLYGON', star: 'STAR' };
    const type: NodeType = TOOL_TYPES[ed.tool] ?? 'RECTANGLE';
    // Text by clicking a path — text on a path.
    if (!keyboard && type === 'TEXT' && this.onTextOnPath?.(wx, wy)) return;
    let parent = ed.pageId;
    const path = ed.scene.hitPath(wx, wy).map((n) => ed.scene.id(n)!);
    for (const id of path) {
      const t = ed.doc.type(id)!;
      if (keyboard && (layerLocked(ed.doc, id) || t === 'INSTANCE')) break;
      if (type === 'SECTION' ? t === 'SECTION' : CONTAINERS.has(t) && t !== 'INSTANCE') parent = id;
    }
    const parentInv = invert(parent === ed.pageId ? [1, 0, 0, 0, 1, 0] : (ed.worldMatrix(parent) as Matrix));
    // The new shape's corner also snaps to neighbors' edges and centers.
    const snap = keyboard ? new Snapper([]) : Snapper.forCreate(ed, parent);
    if (snapToObjects) {
      const s = snap.snapPoint(wx, wy, SNAP_PX / ed.camera.zoom);
      ed.guides = s.guides;
      [wx, wy] = [wx + s.dx, wy + s.dy];
    }
    const [lx, ly] = apply(parentInv, wx, wy);
    const x = ed.snapPx(lx);
    const y = ed.snapPx(ly);
    ed.doc.beginGroup();
    const count = ed.doc.children(parent).filter((c) => ed.doc.type(c) === type).length + 1;
    // A new layer goes right above the selected one in the same container (own feature, per setting; request “insert new
    // shapes relative to selected layer”); otherwise — on top of everything.
    const above = ed.insertAboveSelection && ed.selection.length === 1 && ed.doc.parent(ed.selection[0]!) === parent ? ed.doc.children(parent).indexOf(ed.selection[0]!) + 1 : undefined;
    const names: Record<string, string> = { FRAME: 'Frame', SECTION: 'Section', SLICE: 'Slice', RECTANGLE: 'Rectangle', ELLIPSE: 'Ellipse', LINE: 'Line', POLYGON: 'Polygon', STAR: 'Star' };
    if (type === 'LINE') {
      // Line: a segment from the press point; length — node width, direction — rotation.
      // Arrow (Shift+L) — the same line with an arrowhead at the end.
      const arrow = ed.tool === 'arrow';
      const id = ed.doc.create('LINE', parent, {
        name: arrow ? `Arrow ${count}` : `Line ${count}`,
        transform: [1, 0, x, 0, 1, y],
        width: 0,
        height: 0,
        strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
        ...(arrow ? { strokeEndCap: 'ARROW_LINES' as const } : {}),
      }, above);
      ed.select([id]);
      ed.beginLive([id], 'direct');
      this.mode = { kind: 'line', id, anchor: [x, y], parentInv, moved: false, snap };
      return;
    }
    const id = ed.doc.create(
      type,
      parent,
      type === 'TEXT'
        ? {
            // The text's name then follows its content (see text-edit.ts).
            name: 'Text',
            characters: '',
            fontSize: 24,
            fontName: { family: 'Inter', style: 'Regular' },
            // While dragging the box — fixed size; the mode is chosen on release.
            textAutoResize: 'NONE',
            transform: [1, 0, x, 0, 1, y],
            width: 1,
            height: 1,
            fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
            // File defaults for new texts (if set): font, size, color, style.
            ...defaultTextProps(ed.doc),
          }
        : {
            name: `${names[type]} ${count}`,
            transform: [1, 0, x, 0, 1, y],
            width: 1,
            height: 1,
            fills: type === 'FRAME' || type === 'SECTION' ? [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] : [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }],
            ...(type === 'SECTION' ? { strokes: [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8 } }], strokeWeight: 1, strokeAlign: 'INSIDE' } : {}),
            // File defaults for new shapes (if set).
            ...defaultShapeProps(ed.doc, type),
          },
      above,
    );
    ed.select([id]);
    ed.beginLive([id], 'direct');
    this.mode = { kind: 'create', id, anchor: [x, y], parent, parentInv, moved: false, snap };
  }

  private move(e: PointerEvent) {
    const ed = this.ed;
    const [sx, sy] = this.local(e);
    const [wx, wy] = ed.screenToWorld(sx, sy);
    const m = this.mode;
    if (m.kind !== 'pan' && this.interceptor?.move(e, wx, wy)) return;
    switch (m.kind) {
      case 'idle': {
        if (ed.tool !== 'select' && ed.tool !== 'scale') return;
        const gapArr = ed.tool === 'select' ? this.gapAt(sx, sy) : null;
        if (gapArr) {
          ed.canvasEl.style.cursor = gapArr.axis === 'x' ? 'ew-resize' : 'ns-resize';
          return;
        }
        const h = this.handleAt(sx, sy);
        ed.canvasEl.style.cursor =
          h >= 0 && ed.selection.length >= 1
            ? h % 4 === 0
              ? 'nwse-resize'
              : h % 4 === 2
                ? 'nesw-resize'
                : h % 4 === 1
                  ? 'ns-resize'
                  : 'ew-resize'
            : this.rotateZoneAt(sx, sy)
              ? ROTATE_CURSOR
              : this.reorderAt(sx, sy)
                ? 'grab'
                : '';
        const hover = this.pick(wx, wy, e.ctrlKey || e.metaKey);
        if (hover !== ed.hover) {
          ed.hover = hover;
          ed.dirty = true;
        }
        return;
      }
      case 'pan':
        ed.setCamera({ ...m.cam, x: m.cam.x - (sx - m.sx) / m.cam.zoom, y: m.cam.y - (sy - m.sy) / m.cam.zoom });
        return;
      case 'rotate': {
        let a = Math.atan2(wy - m.center[1], wx - m.center[0]) - m.a0;
        // Shift — 15° steps by the resulting angle.
        if (e.shiftKey) {
          const base = Math.atan2(m.world[3], m.world[0]);
          const step = Math.PI / 12;
          a = Math.round((base + a) / step) * step - base;
        }
        const c = Math.cos(a);
        const s = Math.sin(a);
        const [cx, cy] = m.center;
        // Rotation in the world around the center: W' = T(c) · R · T(-c) · W; into parent coordinates.
        const rot: Matrix = [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy];
        const local = multiply(invert(m.parentWorld), multiply(rot, m.world));
        ed.doc.set(m.id, { transform: local });
        return;
      }
      case 'move': {
        let dx = wx - m.start[0];
        let dy = wy - m.start[1];
        if (!m.moved && Math.hypot(dx * ed.camera.zoom, dy * ed.camera.zoom) < 3) return;
        if (!m.moved) {
          let ids = [...m.origins.keys()];
          // Alt at drag start — drag copies, originals stay in place.
          if (e.altKey && this.duplicateForDrag) {
            const copies = ed.doc.transact(() => this.duplicateForDrag!(ids));
            m.origins = new Map(copies.map((id) => [id, [...(ed.doc.get(id, 'transform') ?? [1, 0, 0, 0, 1, 0])] as Matrix]));
            ids = copies;
            ed.select(copies);
          }
          // Auto layout children leave the flow during a drag — neighbors close up.
          m.lifted = ids.filter((id) => isAutoLayout(ed.doc, ed.doc.parent(id)!) && ed.doc.get(id, 'layoutPositioning') !== 'ABSOLUTE');
          if (m.lifted.length) {
            ed.glideLayout();
            ed.doc.transact(() => {
              // Grid: all children are explicitly in their cells (the dragged one leaves a hole, neighbors stay).
              m.gridFrom = new Map();
              for (const parent of new Set(m.lifted!.map((id) => ed.doc.parent(id)!))) {
                if (ed.doc.get(parent, 'layoutMode') !== 'GRID') continue;
                const res = gridLayout(ed.doc, parent);
                ed.doc.children(parent).forEach((k, i) => {
                  const c = res?.cells[i];
                  if (!c) return;
                  ed.doc.set(k, { gridRowAnchorIndex: c.row, gridColumnAnchorIndex: c.column });
                  if (m.lifted!.includes(k)) m.gridFrom!.set(k, c);
                });
              }
              m.lifted!.forEach((id) => ed.doc.set(id, { layoutPositioning: 'ABSOLUTE' }));
            });
          }
          ed.beginLive(ids, 'translate');
          m.snap = Snapper.forNodes(ed, ids);
          m.bounds = ed.selectionBounds(ids) ?? undefined;
        }
        m.moved = true;
        // Snapping (Ctrl — without it).
        ed.guides = [];
        ed.spacings = [];
        if (m.snap && m.bounds && !(e.ctrlKey || e.metaKey)) {
          const b = m.bounds;
          const s = m.snap.snapRect([b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy], SNAP_PX / ed.camera.zoom);
          dx += s.dx;
          dy += s.dy;
          ed.guides = s.guides;
          ed.spacings = s.spacings ?? [];
        }
        ed.doc.transact(() => {
          for (const [id, t] of m.origins) {
            // Offset in parent coordinates (the parent may be rotated).
            const parent = ed.doc.parent(id)!;
            const pw = parent === ed.pageId ? ([1, 0, 0, 0, 1, 0] as Matrix) : (ed.worldMatrix(parent) as Matrix);
            const inv = invert(pw);
            const ldx = inv[0] * dx + inv[1] * dy;
            const ldy = inv[3] * dx + inv[4] * dy;
            ed.doc.set(id, { transform: [t[0], t[1], ed.snapPx(t[2] + ldx), t[3], t[4], ed.snapPx(t[5] + ldy)] });
          }
        });
        this.updateDrop(m, wx, wy, dx, dy);
        return;
      }
      case 'resizeMany': {
        ed.guides = [];
        let [x, y] = [wx, wy];
        if (e.ctrlKey || e.metaKey) m.snap?.releaseResize();
        if (m.snap && !(e.ctrlKey || e.metaKey)) {
          const s = m.snap.snapResizePoint(wx, wy, RESIZE_SNAP_PX / ed.camera.zoom, HANDLE_X[m.handle] !== 0.5, HANDLE_Y[m.handle] !== 0.5);
          [x, y] = [wx + s.dx, wy + s.dy];
          ed.guides = s.guides;
        }
        this.resizeMany(m, x, y, e.shiftKey, e.altKey, e.ctrlKey || e.metaKey);
        return;
      }
      case 'gap': {
        // New gap for all: the first layer stays, the rest follow one after another.
        const a = m.arr.axis === 'x' ? 0 : 1;
        const delta = a === 0 ? wx - m.start[0] : wy - m.start[1];
        const gap = Math.max(0, ed.snapPx(m.arr.gap + delta));
        let pos = m.arr.items[0]!.b[a]!;
        ed.doc.transact(() => {
          for (const it of m.arr.items) {
            const d = pos - it.b[a]!;
            pos += it.b[a + 2]! - it.b[a]! + gap;
            const t = m.origins.get(it.id)!;
            const parent = ed.doc.parent(it.id)!;
            const pw = (parent === ed.pageId ? [1, 0, 0, 0, 1, 0] : ed.worldMatrix(parent)) as Matrix;
            const inv = invert(pw);
            const [dx, dy] = a === 0 ? [d, 0] : [0, d];
            ed.doc.set(it.id, { transform: [t[0], t[1], t[2] + inv[0] * dx + inv[1] * dy, t[3], t[4], t[5] + inv[3] * dx + inv[4] * dy] });
          }
        });
        // Gap marks.
        const label = String(gap);
        ed.spacings = [];
        let p = m.arr.items[0]!.b[a + 2]!;
        for (let i = 1; i < m.arr.items.length; i++) {
          const prev = m.arr.items[i - 1]!.b;
          const cur = m.arr.items[i]!.b;
          const mid = a === 0 ? (Math.max(prev[1], cur[1]) + Math.min(prev[3], cur[3])) / 2 : (Math.max(prev[0], cur[0]) + Math.min(prev[2], cur[2])) / 2;
          ed.spacings.push(a === 0 ? { a: [p, mid], b: [p + gap, mid], label } : { a: [mid, p], b: [mid, p + gap], label });
          p += gap + (cur[a + 2]! - cur[a]!);
        }
        ed.dirty = true;
        return;
      }
      case 'reorder': {
        // The dragged one follows the pointer along the row, the rest go to their places in the new order.
        const a = m.arr.axis === 'x' ? 0 : 1;
        const delta = a === 0 ? wx - m.start[0] : wy - m.start[1];
        if (!m.moved && Math.abs(delta) * ed.camera.zoom < 3) return;
        m.moved = true;
        const me = m.arr.items[m.index]!.b;
        const plan = reorderPlan(m.arr, m.index, (me[a]! + me[a + 2]!) / 2 + delta);
        ed.doc.transact(() => {
          m.arr.items.forEach((it, i) => {
            const d = i === m.index ? delta : plan.starts[i]! - it.b[a]!;
            this.shiftFrom(it.id, m.origins.get(it.id)!, a === 0 ? d : 0, a === 0 ? 0 : d);
          });
        });
        return;
      }
      case 'scale': {
        // Uniform scale from the opposite side (Alt — from the center).
        const [x0, y0, x1, y1] = m.box;
        const hx = HANDLE_X[m.handle]!;
        const hy = HANDLE_Y[m.handle]!;
        const ax = e.altKey ? (x0 + x1) / 2 : hx === 0 ? x1 : hx === 1 ? x0 : (x0 + x1) / 2;
        const ay = e.altKey ? (y0 + y1) / 2 : hy === 0 ? y1 : hy === 1 ? y0 : (y0 + y1) / 2;
        const W = Math.max(1e-6, x1 - x0);
        const H = Math.max(1e-6, y1 - y0);
        const k = e.altKey ? 2 : 1;
        const sxF = hx === 0.5 ? 0 : (Math.abs(wx - ax) * k) / W;
        const syF = hy === 0.5 ? 0 : (Math.abs(wy - ay) * k) / H;
        const s = Math.max(0.01, Math.round(Math.max(sxF, syF) * 1000) / 1000);
        ed.doc.transact(() => {
          for (const it of m.items) {
            scaleTree(ed.doc, it.id, s, (id) => m.snapshot.get(id) ?? ed.doc.props(id));
            const w = it.world;
            const world: Matrix = [w[0], w[1], ax + (w[2] - ax) * s, w[3], w[4], ay + (w[5] - ay) * s];
            ed.doc.set(it.id, { transform: multiply(invert(it.parentWorld), world) });
          }
        });
        return;
      }
      case 'rotateMany': {
        let a = Math.atan2(wy - m.center[1], wx - m.center[0]) - m.a0;
        // Shift — 15° steps.
        if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        const c = Math.cos(a);
        const s = Math.sin(a);
        const [cx, cy] = m.center;
        const rot: Matrix = [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy];
        ed.doc.transact(() => {
          for (const it of m.items) ed.doc.set(it.id, { transform: multiply(invert(it.parentWorld), multiply(rot, it.world)) });
        });
        return;
      }
      case 'resize': {
        ed.guides = [];
        let [x, y] = [wx, wy];
        if (e.ctrlKey || e.metaKey) m.snap?.releaseResize();
        if (m.snap && !(e.ctrlKey || e.metaKey)) {
          const s = m.snap.snapResizePoint(wx, wy, RESIZE_SNAP_PX / ed.camera.zoom, HANDLE_X[m.handle] !== 0.5, HANDLE_Y[m.handle] !== 0.5);
          [x, y] = [wx + s.dx, wy + s.dy];
          ed.guides = s.guides;
        }
        // Layer's aspect ratio lock — proportions are kept even without Shift (Shift then releases them).
        const locked = ed.doc.get(m.id, 'constrainProportions') === true;
        this.resizeTo(m, x, y, locked ? !e.shiftKey : e.shiftKey, e.altKey, e.ctrlKey || e.metaKey);
        return;
      }
      case 'zoom':
        if (Math.hypot(sx - m.sx, sy - m.sy) > 4) {
          ed.marquee = [m.start[0], m.start[1], wx, wy];
          ed.dirty = true;
        }
        return;
      case 'marquee': {
        ed.marquee = [m.start[0], m.start[1], wx, wy];
        const r: Rect = [Math.min(m.start[0], wx), Math.min(m.start[1], wy), Math.max(m.start[0], wx), Math.max(m.start[1], wy)];
        m.candidates ??= this.boxes(ed.doc.children(ed.pageId));
        const hit = m.candidates.filter(({ b }) => b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1]).map((c) => c.id);
        ed.select([...new Set([...m.base, ...hit])]);
        ed.dirty = true;
        return;
      }
      case 'line': {
        ed.guides = [];
        let [px, py] = [wx, wy];
        if (!(e.ctrlKey || e.metaKey)) {
          const s = m.snap.snapPoint(wx, wy, SNAP_PX / ed.camera.zoom);
          [px, py] = [wx + s.dx, wy + s.dy];
          ed.guides = s.guides;
        }
        const [lx, ly] = apply(m.parentInv, px, py);
        let dx = lx - m.anchor[0];
        let dy = ly - m.anchor[1];
        let len = Math.hypot(dx, dy);
        let angle = Math.atan2(dy, dx);
        // Shift — 45° steps.
        if (e.shiftKey) angle = (Math.round(angle / (Math.PI / 4)) * Math.PI) / 4;
        len = ed.snapPx(len);
        m.moved = m.moved || len > 1;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        [dx, dy] = [c, s];
        ed.doc.set(m.id, { transform: [dx, -dy, m.anchor[0], dy, dx, m.anchor[1]], width: Math.max(0, len) });
        return;
      }
      case 'create': {
        ed.guides = [];
        let [px, py] = [wx, wy];
        if (!(e.ctrlKey || e.metaKey)) {
          const s = m.snap.snapPoint(wx, wy, SNAP_PX / ed.camera.zoom);
          [px, py] = [wx + s.dx, wy + s.dy];
          ed.guides = s.guides;
        }
        const [lx, ly] = apply(m.parentInv, px, py);
        let w = ed.snapPx(lx) - m.anchor[0];
        let h = ed.snapPx(ly) - m.anchor[1];
        if (e.shiftKey) {
          const s = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * s;
          h = Math.sign(h || 1) * s;
        }
        m.moved = m.moved || Math.abs(w) > 1 || Math.abs(h) > 1;
        // Alt — from the center (the press point is the shape's middle).
        if (e.altKey) {
          ed.doc.set(m.id, { transform: [1, 0, m.anchor[0] - Math.abs(w), 0, 1, m.anchor[1] - Math.abs(h)], width: Math.max(1, Math.abs(w) * 2), height: Math.max(1, Math.abs(h) * 2) });
          return;
        }
        const x = w < 0 ? m.anchor[0] + w : m.anchor[0];
        const y = h < 0 ? m.anchor[1] + h : m.anchor[1];
        ed.doc.set(m.id, { transform: [1, 0, x, 0, 1, y], width: Math.max(1, Math.abs(w)), height: Math.max(1, Math.abs(h)) });
        return;
      }
    }
  }

  /**
   * Drag target: the deepest frame under the pointer (except the dragged ones themselves).
   * A frame goes into another frame only if it fits inside it entirely.
   * In an auto layout frame — the insertion point by pointer position along the main axis.
   */
  private updateDrop(m: Extract<Mode, { kind: 'move' }>, wx: number, wy: number, dx: number, dy: number) {
    const ed = this.ed;
    const doc = ed.doc;
    // A group's bounds follow its children. Crossing its old bounds must not
    // change membership; explicit moves in the layer tree still can.
    const ids = [...m.origins.keys()].filter(id => doc.type(doc.parent(id)!) !== 'GROUP');
    if (!ids.length) {
      m.target = undefined;
      m.index = undefined;
      m.cell = undefined;
      ed.drop = null;
      ed.dirty = true;
      return;
    }
    const moving = new Set(m.origins.keys());
    const b = m.bounds;
    const moved: Rect | null = b ? [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy] : null;
    const framesMoving = ids.some((id) => FRAME_LIKE.has(doc.type(id)!));
    let target = ed.pageId;
    for (const n of ed.scene.hitPath(wx, wy, 0, moving)) {
      const id = ed.scene.id(n)!;
      // Into an instance — only into slots.
      if (!DROP_TARGETS.has(doc.type(id)!) || layerLocked(doc, id) || !acceptsChildren(doc, id)) continue;
      if (framesMoving && moved) {
        const tb = ed.selectionBounds([id]);
        if (!tb || moved[0] < tb[0] || moved[1] < tb[1] || moved[2] > tb[2] || moved[3] > tb[3]) continue;
      }
      target = id;
    }
    m.target = target;
    m.index = undefined;
    m.cell = undefined;
    // Grid: the cell under the pointer (nearest track on each axis) — highlight it.
    if (target !== ed.pageId && doc.get(target, 'layoutMode') === 'GRID') {
      const res = gridLayout(doc, target);
      let cell: [number, number][] | undefined;
      if (res?.columns.length && res.rows.length) {
        const tw = ed.worldMatrix(target) as Matrix;
        const [lx, ly] = apply(invert(tw), wx, wy);
        const nearest = (tracks: [number, number][], v: number) => {
          let best = 0;
          let bd = Infinity;
          tracks.forEach(([a, z], i) => {
            const d = v < a ? a - v : v > z ? v - z : 0;
            if (d < bd) {
              bd = d;
              best = i;
            }
          });
          return best;
        };
        const column = nearest(res.columns, lx);
        const row = nearest(res.rows, ly);
        m.cell = { row, column };
        const [x0, x1] = res.columns[column]!;
        const [y0, y1] = res.rows[row]!;
        cell = [apply(tw, x0, y0), apply(tw, x1, y0), apply(tw, x1, y1), apply(tw, x0, y1)];
      }
      ed.guides = [];
      ed.drop = { target, line: null, cell };
      ed.dirty = true;
      return;
    }
    let line: Guide | null = null;
    if (target !== ed.pageId && isAutoLayout(doc, target)) {
      const horizontal = doc.get(target, 'layoutMode') === 'HORIZONTAL';
      const tw = ed.worldMatrix(target) as Matrix;
      const [lx, ly] = apply(invert(tw), wx, wy);
      const flow = doc.children(target).filter((k) => !moving.has(k) && doc.get(k, 'visible') !== false && doc.get(k, 'layoutPositioning') !== 'ABSOLUTE');
      const box = (k: string) => {
        const t = (doc.get(k, 'transform') ?? [1, 0, 0, 0, 1, 0]) as Matrix;
        return { x: t[2], y: t[5], w: doc.get(k, 'width') ?? 0, h: doc.get(k, 'height') ?? 0 };
      };
      let i = flow.findIndex((k) => {
        const kb = box(k);
        return horizontal ? lx < kb.x + kb.w / 2 : ly < kb.y + kb.h / 2;
      });
      if (i < 0) i = flow.length;
      // Position in the full children list (without the dragged ones — they are removed before insertion).
      const rest = doc.children(target).filter((k) => !moving.has(k));
      m.index = i < flow.length ? rest.indexOf(flow[i]!) : rest.length;
      // Pointer: between neighbors, across the main axis, over the content area.
      const W = doc.get(target, 'width') ?? 0;
      const H = doc.get(target, 'height') ?? 0;
      const gap = doc.get(target, 'itemSpacing') ?? 0;
      const prev = flow[i - 1] ? box(flow[i - 1]!) : null;
      const next = flow[i] ? box(flow[i]!) : null;
      if (horizontal) {
        const x = next ? next.x - Math.max(0, gap) / 2 : prev ? prev.x + prev.w + Math.max(0, gap) / 2 : doc.get(target, 'paddingLeft') ?? 0;
        line = [...apply(tw, x, doc.get(target, 'paddingTop') ?? 0), ...apply(tw, x, H - (doc.get(target, 'paddingBottom') ?? 0))] as Guide;
      } else {
        const y = next ? next.y - Math.max(0, gap) / 2 : prev ? prev.y + prev.h + Math.max(0, gap) / 2 : doc.get(target, 'paddingTop') ?? 0;
        line = [...apply(tw, doc.get(target, 'paddingLeft') ?? 0, y), ...apply(tw, W - (doc.get(target, 'paddingRight') ?? 0), y)] as Guide;
      }
      ed.guides = [];
    }
    ed.drop = { target, line };
    ed.dirty = true;
  }

  /** Dragged layers released: return them to the flow and put them into the target (in the same undo group). */
  private drop(m: Extract<Mode, { kind: 'move' }>) {
    const ed = this.ed;
    const doc = ed.doc;
    const ids = [...m.origins.keys()].filter((id) => doc.has(id) && doc.type(doc.parent(id)!) !== 'GROUP');
    if (!ids.length) return;
    const target = m.target ?? doc.parent(ids[0]!)!;
    const targetAL = target !== ed.pageId && isAutoLayout(doc, target);
    const reparent = ids.some((id) => doc.parent(id) !== target) || targetAL;
    // Grid: children's cells — before the move (who is in the target cell; pin the rest).
    const grid = m.cell && doc.get(target, 'layoutMode') === 'GRID' ? gridLayout(doc, target) : null;
    const before = grid ? new Map(doc.children(target).map((k, i) => [k, grid.cells[i] ?? null])) : null;
    // The dragged layer's previous cell — if dragged within the same grid.
    const from = grid && doc.parent(ids[0]!) === target ? (m.gridFrom?.get(ids[0]!) ?? null) : null;
    doc.transact(() => {
      for (const id of m.lifted ?? []) if (doc.has(id)) doc.set(id, { layoutPositioning: 'AUTO' });
      if (!reparent) return;
      const tw = (target === ed.pageId ? [1, 0, 0, 0, 1, 0] : ed.worldMatrix(target)) as Matrix;
      const worlds = new Map(ids.map((id) => [id, ed.worldMatrix(id) as Matrix]));
      // First move all to the end of the target — then insertion indices are computed on the list without them.
      if (m.index !== undefined) for (const id of ids) doc.move(id, target);
      ids.forEach((id, i) => {
        doc.move(id, target, m.index === undefined ? undefined : m.index + i);
        // The on-screen position is kept (in auto layout the layout sets it anyway).
        doc.set(id, { transform: multiply(invert(tw), worlds.get(id)!) });
      });
      if (m.cell && before) {
        const cell = m.cell;
        const first = ids[0]!;
        // Other children are explicitly in their cells (otherwise auto placement would move them).
        for (const [k, c] of before) if (c && !ids.includes(k)) doc.set(k, { gridRowAnchorIndex: c.row, gridColumnAnchorIndex: c.column });
        // Cell occupied — that layer goes to the dragged one's previous place (or in order, if the dragged one wasn't from here).
        const other = [...before].find(([k, c]) => !ids.includes(k) && c && c.row === cell.row && c.column === cell.column)?.[0];
        if (other) doc.set(other, from ? { gridRowAnchorIndex: from.row, gridColumnAnchorIndex: from.column } : { gridRowAnchorIndex: -1, gridColumnAnchorIndex: -1 });
        doc.set(first, { gridRowAnchorIndex: cell.row, gridColumnAnchorIndex: cell.column });
        for (const id of ids.slice(1)) doc.set(id, { gridRowAnchorIndex: -1, gridColumnAnchorIndex: -1 });
      }
    });
  }

  /** Resizing by a handle in the node's own coordinates (rotation is accounted for). */
  private resizeTo(m: Extract<Mode, { kind: 'resize' }>, wx: number, wy: number, keepRatio: boolean, fromCenter: boolean, ignoreConstraints = false) {
    const ed = this.ed;
    const parent = ed.doc.parent(m.id)!;
    const pw = (parent === ed.pageId ? [1, 0, 0, 0, 1, 0] : ed.worldMatrix(parent)) as Matrix;
    const world = multiply(pw, m.transform);
    const [px, py] = apply(invert(world), wx, wy);
    const hx = HANDLE_X[m.handle]!;
    const hy = HANDLE_Y[m.handle]!;
    let x0 = 0;
    let y0 = 0;
    let x1 = m.w;
    let y1 = m.h;
    if (hx === 0) x0 = px;
    if (hx === 1) x1 = px;
    if (hy === 0) y0 = py;
    if (hy === 1) y1 = py;
    if (fromCenter) {
      if (hx !== 0.5) [x0, x1] = hx === 0 ? [px, m.w - px] : [m.w - px, px];
      if (hy !== 0.5) [y0, y1] = hy === 0 ? [py, m.h - py] : [m.h - py, py];
    }
    if (keepRatio && m.w > 0 && m.h > 0) {
      const ratio = m.w / m.h;
      let w = Math.abs(x1 - x0);
      let h = Math.abs(y1 - y0);
      if (hx === 0.5) w = h * ratio;
      else if (hy === 0.5) h = w / ratio;
      else if (w / h > ratio) h = w / ratio;
      else w = h * ratio;
      if (hx === 0) x0 = x1 - w;
      else if (hx === 1) x1 = x0 + w;
      else [x0, x1] = [(m.w - w) / 2, (m.w + w) / 2];
      if (hy === 0) y0 = y1 - h;
      else if (hy === 1) y1 = y0 + h;
      else [y0, y1] = [(m.h - h) / 2, (m.h + h) / 2];
    }
    const nx = Math.min(x0, x1);
    const ny = Math.min(y0, y1);
    const w = Math.max(ed.pixelSnap ? 1 : 0.01, ed.snapPx(Math.abs(x1 - x0)));
    const h = Math.max(ed.pixelSnap ? 1 : 0.01, ed.snapPx(Math.abs(y1 - y0)));
    // New top-left corner in parent coordinates: T · (nx, ny).
    const t = m.transform;
    const ox = t[0] * nx + t[1] * ny + t[2];
    const oy = t[3] * nx + t[4] * ny + t[5];
    // A line has no height: only its length is dragged.
    const props: Props = { transform: [t[0], t[1], ed.snapPx(ox), t[3], t[4], ed.snapPx(oy)], width: w, height: ed.doc.type(m.id) === 'LINE' ? 0 : h };
    // The dragged axis becomes fixed: “hug contents” and “fill” are removed.
    // Text isn't scaled in this case: horizontally — fixed width,
    // vertically or by a corner — fixed size.
    // Dragged to the edge of an auto layout parent — “fill” along this axis.
    const edge = keepRatio ? {} : this.fillAtEdge(m.id, parent, hx !== 0.5 ? w : null, hy !== 0.5 ? h : null);
    if (hx !== 0.5 || keepRatio) Object.assign(props, sizingProps(ed.doc, m.id, 'width', edge.width ? 'FILL' : 'FIXED'));
    if (hy !== 0.5 || keepRatio) Object.assign(props, sizingProps(ed.doc, m.id, 'height', edge.height ? 'FILL' : 'FIXED'));
    ed.doc.set(m.id, props);
    // Children follow their constraints, from the snapshot taken before the drag (Ctrl — they stay in place).
    if (m.snapshot) {
      const to: [number, number] = ignoreConstraints ? [m.w, m.h] : [w, props.height ?? h];
      ed.doc.transact(() => applyConstraints(ed.doc, m.id, [m.w, m.h], to, (id) => m.snapshot!.get(id) ?? ed.doc.props(id)));
    }
  }

  /**
   * An auto layout child dragged to the parent's edge: along the main axis — to the space left after
   * neighbors and gaps, across — to the parent's size minus padding (tolerance — 6 px on screen).
   * A parent that hugs contents along this axis can't have “fill” children — then no.
   */
  private fillAtEdge(id: string, parent: string, w: number | null, h: number | null): { width?: boolean; height?: boolean } {
    const doc = this.ed.doc;
    if (!isAutoLayout(doc, parent) || doc.get(parent, 'layoutMode') === 'GRID' || doc.get(id, 'layoutPositioning') === 'ABSOLUTE') return {};
    const p = doc.props(parent);
    const horizontal = p.layoutMode === 'HORIZONTAL';
    const tol = 6 / this.ed.camera.zoom;
    const innerW = (p.width ?? 0) - (p.paddingLeft ?? 0) - (p.paddingRight ?? 0);
    const innerH = (p.height ?? 0) - (p.paddingTop ?? 0) - (p.paddingBottom ?? 0);
    const flow = doc.children(parent).filter((k) => k !== id && doc.get(k, 'visible') !== false && doc.get(k, 'layoutPositioning') !== 'ABSOLUTE');
    const auto = p.primaryAxisAlignItems === 'SPACE_BETWEEN' || p.primaryAxisAlignItems === 'SPACE_AROUND' || p.primaryAxisAlignItems === 'SPACE_EVENLY';
    const gap = auto ? 0 : (p.itemSpacing ?? 0);
    const others = flow.reduce((a, k) => a + (doc.get(k, horizontal ? 'width' : 'height') ?? 0), 0) + gap * flow.length;
    // With wrapping, the main axis is split into rows — “to the edge” can't be determined there.
    const main = p.layoutWrap === 'WRAP' || p.primaryAxisSizingMode === 'AUTO' ? null : (horizontal ? innerW : innerH) - others;
    const cross = p.counterAxisSizingMode === 'AUTO' ? null : horizontal ? innerH : innerW;
    const reach = (v: number | null, limit: number | null) => v !== null && limit !== null && limit > 0 && v >= limit - tol;
    return { width: reach(w, horizontal ? main : cross), height: reach(h, horizontal ? cross : main) };
  }

  /**
   * Resizing several layers with a shared box: each layer is scaled
   * together with the box — position and size; text changes its box, not the font size. Rotated layers
   * keep their angle: their center follows the box and the sides stretch along their own axes.
   * Groups are only moved for now (scaling children along with constraints — stage 2).
   */
  private resizeMany(m: Extract<Mode, { kind: 'resizeMany' }>, wx: number, wy: number, keepRatio: boolean, fromCenter: boolean, ignoreConstraints = false) {
    const ed = this.ed;
    const doc = ed.doc;
    const [x0, y0, x1, y1] = m.box;
    const W = Math.max(1e-6, x1 - x0);
    const H = Math.max(1e-6, y1 - y0);
    const hx = HANDLE_X[m.handle]!;
    const hy = HANDLE_Y[m.handle]!;
    let [nx0, ny0, nx1, ny1] = [x0, y0, x1, y1];
    if (hx === 0) nx0 = Math.min(wx, x1 - 1);
    if (hx === 1) nx1 = Math.max(wx, x0 + 1);
    if (hy === 0) ny0 = Math.min(wy, y1 - 1);
    if (hy === 1) ny1 = Math.max(wy, y0 + 1);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    if (fromCenter) {
      if (hx === 0) nx1 = cx + (cx - nx0);
      if (hx === 1) nx0 = cx - (nx1 - cx);
      if (hy === 0) ny1 = cy + (cy - ny0);
      if (hy === 1) ny0 = cy - (ny1 - cy);
    }
    if (keepRatio) {
      let w = nx1 - nx0;
      let h = ny1 - ny0;
      const ratio = W / H;
      if (hx === 0.5) w = h * ratio;
      else if (hy === 0.5) h = w / ratio;
      else if (w / h > ratio) h = w / ratio;
      else w = h * ratio;
      if (hx === 0) nx0 = nx1 - w;
      else if (hx === 1) nx1 = nx0 + w;
      else [nx0, nx1] = [cx - w / 2, cx + w / 2];
      if (hy === 0) ny0 = ny1 - h;
      else if (hy === 1) ny1 = ny0 + h;
      else [ny0, ny1] = [cy - h / 2, cy + h / 2];
    }
    const sx = (nx1 - nx0) / W;
    const sy = (ny1 - ny0) / H;
    const mapX = (x: number) => nx0 + (x - x0) * sx;
    const mapY = (y: number) => ny0 + (y - y0) * sy;
    doc.transact(() => {
      for (const it of m.items) {
        const t = doc.type(it.id);
        const wm = it.world;
        const props: Props = {};
        const fixedGroup = t === 'GROUP' || t === 'BOOLEAN_OPERATION';
        const axisAligned = Math.abs(wm[1]) < 1e-6 && Math.abs(wm[3]) < 1e-6;
        let world: Matrix;
        if (axisAligned && !fixedGroup) {
          // Layer edges map to edges with the same scale — adjacent layers stay edge to edge.
          const ax = wm[2];
          const bx = wm[2] + wm[0] * it.w;
          const ay = wm[5];
          const by = wm[5] + wm[4] * it.h;
          const [l, r] = [ed.snapPx(mapX(Math.min(ax, bx))), ed.snapPx(mapX(Math.max(ax, bx)))];
          const [tp, bt] = [ed.snapPx(mapY(Math.min(ay, by))), ed.snapPx(mapY(Math.max(ay, by)))];
          props.width = Math.max(1, r - l);
          props.height = t === 'LINE' ? 0 : Math.max(1, bt - tp);
          // A flipped layer stores its angle on the other side.
          world = [wm[0], 0, wm[0] < 0 ? l + props.width : l, 0, wm[4], wm[4] < 0 ? tp + props.height : tp];
        } else {
          // The center follows the box; sides — along their own axes (the angle is kept).
          const ccx = wm[0] * (it.w / 2) + wm[1] * (it.h / 2) + wm[2];
          const ccy = wm[3] * (it.w / 2) + wm[4] * (it.h / 2) + wm[5];
          const [ncx, ncy] = [mapX(ccx), mapY(ccy)];
          let w = it.w;
          let h = it.h;
          if (!fixedGroup) {
            w = Math.max(1, Math.round(it.w * Math.hypot(wm[0] * sx, wm[3] * sy)));
            h = t === 'LINE' ? 0 : Math.max(1, Math.round(it.h * Math.hypot(wm[1] * sx, wm[4] * sy)));
            props.width = w;
            props.height = h;
          }
          world = [wm[0], wm[1], ncx - wm[0] * (w / 2) - wm[1] * (h / 2), wm[3], wm[4], ncy - wm[3] * (w / 2) - wm[4] * (h / 2)];
        }
        props.transform = multiply(invert(it.parentWorld), world);
        if (!fixedGroup) {
          if (sx !== 1) Object.assign(props, sizingProps(doc, it.id, 'width', 'FIXED'));
          if (sy !== 1) Object.assign(props, sizingProps(doc, it.id, 'height', 'FIXED'));
        }
        doc.set(it.id, props);
        // Children follow their constraints (Ctrl — they stay as they were).
        if (!fixedGroup && doc.children(it.id).length) {
          const to: [number, number] = ignoreConstraints ? [it.w, it.h] : [props.width ?? it.w, props.height ?? it.h];
          applyConstraints(doc, it.id, [it.w, it.h], to, (id) => m.snapshot.get(id) ?? doc.props(id));
        }
      }
    });
  }

  private up(e: PointerEvent) {
    const ed = this.ed;
    const m = this.mode;
    this.mode = { kind: 'idle' };
    if (m.kind === 'intercept') {
      const [sx, sy] = this.local(e);
      const [wx, wy] = ed.screenToWorld(sx, sy);
      this.interceptor?.up(e, wx, wy);
      return;
    }
    if (m.kind === 'zoom') {
      const [sx, sy] = this.local(e);
      if (ed.marquee) {
        const r = ed.marquee;
        ed.marquee = null;
        ed.fitRect([Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])], 0);
      } else ed.zoomAt(sx, sy, m.out || e.altKey ? 0.5 : 2);
      ed.dirty = true;
      return;
    }
    ed.guides = [];
    ed.spacings = [];
    // Reordering in a row: the dragged one goes to its place in the new order.
    if (m.kind === 'reorder' && m.moved) {
      const a = m.arr.axis === 'x' ? 0 : 1;
      const [sx, sy] = this.local(e);
      const [wx, wy] = ed.screenToWorld(sx, sy);
      const delta = a === 0 ? wx - m.start[0] : wy - m.start[1];
      const me = m.arr.items[m.index]!.b;
      const plan = reorderPlan(m.arr, m.index, (me[a]! + me[a + 2]!) / 2 + delta);
      const d = plan.starts[m.index]! - me[a]!;
      ed.doc.transact(() => this.shiftFrom(m.arr.items[m.index]!.id, m.origins.get(m.arr.items[m.index]!.id)!, a === 0 ? d : 0, a === 0 ? 0 : d));
    }
    if (m.kind === 'move' || m.kind === 'resize' || m.kind === 'create' || m.kind === 'line' || m.kind === 'rotate' || m.kind === 'resizeMany' || m.kind === 'rotateMany' || m.kind === 'scale' || m.kind === 'gap' || m.kind === 'reorder') ed.endLive();
    if (m.kind === 'rotate' || m.kind === 'resizeMany' || m.kind === 'rotateMany' || m.kind === 'scale' || m.kind === 'gap' || m.kind === 'reorder') ed.doc.endGroup();
    if (m.kind === 'rotate' || m.kind === 'rotateMany') {
      ed.rotating = false;
      ed.dirty = true;
    }
    if (m.kind === 'line') {
      // Click without a drag — a 100 px line to the right.
      if (!m.moved) ed.doc.set(m.id, { width: 100 });
      ed.doc.endGroup();
      ed.tool = 'select';
      ed.dirty = true;
      this.onToolChange?.();
    }
    if (m.kind === 'move' && m.moved) this.drop(m);
    ed.drop = null;
    if (m.kind === 'move' || m.kind === 'resize') ed.doc.endGroup();
    if (m.kind === 'move' && !m.moved && m.widgetClick) this.onWidgetClick?.(m.widgetClick.widget, m.widgetClick.path, m.widgetClick.node);
    if (m.kind === 'move' && !m.moved && !e.shiftKey) {
      // A plain click on an already selected layer among several — keep only it.
      const [sx, sy] = this.local(e);
      const [wx, wy] = ed.screenToWorld(sx, sy);
      const t = this.pick(wx, wy, e.ctrlKey || e.metaKey);
      // Alt — make the layer the alignment key object (again — unset it), the selection doesn't change.
      if (t && e.altKey && ed.selection.length > 1 && ed.selection.includes(t)) {
        ed.keyObject = ed.keyObject === t ? null : t;
        ed.dirty = true;
        this.onKeyObject?.();
      } else if (t && ed.selection.length > 1) ed.select([t]);
    }
    if (m.kind === 'marquee') {
      // Click on a frame's empty area without a drag — select the frame itself.
      const dragged = ed.marquee && (Math.abs(ed.marquee[2] - ed.marquee[0]) > 0 || Math.abs(ed.marquee[3] - ed.marquee[1]) > 0);
      if (m.clickSelects && !dragged) ed.select([m.clickSelects]);
      ed.marquee = null;
      ed.dirty = true;
    }
    if (m.kind === 'create') this.finishCreate(m);
  }

  private finishCreate(m: Extract<Mode, { kind: 'create' }>) {
    const ed = this.ed;
    const isText = ed.doc.type(m.id) === 'TEXT';
    if (isText) {
      // Click — text with auto width, caret at the center of the first line;
      // drag — a fixed-width box with auto height.
      if (m.moved) ed.doc.set(m.id, { textAutoResize: 'HEIGHT' });
      else ed.doc.set(m.id, { textAutoResize: 'WIDTH_AND_HEIGHT', transform: [1, 0, m.anchor[0], 0, 1, m.anchor[1] - 14] });
    } else if (!m.moved) {
      // Click without a drag — a shape of the default size.
      const t = ed.doc.type(m.id);
      if (t === 'SECTION') ed.doc.set(m.id, { width: 400, height: 300 });
      else {
        const size = t === 'FRAME' ? 200 : 100;
        ed.doc.set(m.id, { width: size, height: size });
      }
    }
    ed.tool = 'select';
    ed.dirty = true;
    this.onToolChange?.();
    // Creating and typing text is one undo step: the text editor opens its own group
    // inside the current one and closes it on exiting the edit.
    if (isText) this.onEditText?.(m.id, true);
    ed.doc.endGroup();
  }

  private dblclick(e: MouseEvent) {
    // Double click — select the deepest node under the pointer (entering a group or frame).
    const ed = this.ed;
    const [sx, sy] = this.local(e);
    const [wx, wy] = ed.screenToWorld(sx, sy);
    if (this.interceptor?.dblclick?.(e, wx, wy)) return;
    // Double click on a handle: the handle's axis — “hug contents”, with Alt — “fill”.
    const handle = ed.selection.length === 1 ? this.handleAt(sx, sy) : -1;
    if (handle >= 0) {
      const id = ed.selection[0]!;
      const axes: Axis[] = handle % 4 === 1 ? ['height'] : handle % 4 === 3 ? ['width'] : ['width', 'height'];
      const mode = e.altKey ? 'FILL' : 'HUG';
      if (mode === 'FILL' ? canFill(ed.doc, id) : canHug(ed.doc, id)) {
        ed.doc.transact(() => axes.forEach((a) => setSizing(ed.doc, id, a, mode)));
        return;
      }
    }
    const t = this.pick(wx, wy, true);
    if (t && !(ed.selection.length === 1 && ed.selection[0] === t)) ed.select([t]);
    else if (t && ed.doc.type(t) === 'TEXT') this.onEditText?.(t, false, [wx, wy]);
    else if (t && ed.doc.type(t) === 'VECTOR') this.onEditVector?.(t);
    else if (t) ed.select([t]);
  }

  /**
   * Wheel and touchpad. A mouse wheel notch (large step, lines or pages) — smooth:
   * scroll by one step, zoom with Ctrl — by 20% per notch (previously exp(−100 × 0.01) — 2.7×).
   * Touchpad (small frequent steps) — immediate: scroll follows the fingers, pinch — one to one (Chrome
   * sends a pinch as Ctrl+wheel with deltaY = −100·ln(scale)).
   */
  private wheel(e: WheelEvent) {
    e.preventDefault();
    const ed = this.ed;
    let [sx, sy] = this.local(e);
    // Over sidebars, zoom about the canvas center instead of an off-canvas point.
    if (sx < 0 || sy < 0 || sx > ed.viewW || sy > ed.viewH) [sx, sy] = [ed.viewW / 2, ed.viewH / 2];
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? ed.viewH : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    const notch = e.deltaMode !== 0 || Math.max(Math.abs(dx), Math.abs(dy)) >= WHEEL_NOTCH;
    if (e.ctrlKey || e.metaKey) {
      if (notch) ed.zoomSmooth(sx, sy, WHEEL_ZOOM ** (-Math.sign(dy) * Math.min(3, Math.abs(dy) / 100)));
      else ed.zoomAt(sx, sy, Math.exp(-dy * 0.01));
      return;
    }
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
    if (notch) ed.panSmooth(dx, dy);
    else ed.setCamera({ ...ed.camera, x: ed.camera.x + dx / ed.camera.zoom, y: ed.camera.y + dy / ed.camera.zoom });
  }
}

/** Mouse wheel step: this or more — a notch (smooth), less — touchpad (immediate). */
const WHEEL_NOTCH = 50;
/** Zoom per wheel notch with Ctrl. */
const WHEEL_ZOOM = 1.2;

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}
