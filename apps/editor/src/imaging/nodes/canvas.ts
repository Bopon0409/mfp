// Graph canvas (like Blueprints): nodes with colored headers and typed pins, curved wires,
// pan and zoom, selection box, node palette on right click. Undo uses graph snapshots.
// Keys arrive via key(): the page intercepts them before they reach the elements.

import { h } from '../../dom.ts';
import { showMenuAt, type MenuEntry } from '../../menu.ts';
import { BUILTINS, BUILTIN_MAP, CATEGORY_NAMES } from './defs.ts';
import { MACRO_PREFIX, collapse, expand, isMacro, newId, reaches, usedMacros, type Edge, type Graph, type GraphNode, type MacroDef, type PinDef, type PinType, type Preset } from './model.ts';
import { paramsOf, resolveDef, type NodeDef, type ParamDef } from './runner.ts';

export interface CanvasHost {
  /** Own nodes and presets from the library, for the palette. */
  macros(): MacroDef[];
  presets(): Preset[];
  /** The graph changed: save it. */
  changed(): void;
  savePreset(node: GraphNode, def: NodeDef): void;
  /** A new custom node (from the selection) goes to “My nodes”. */
  addMacro(macro: MacroDef): void;
  ask(title: string, value: string): Promise<string | null>;
  notify(text: string, kind?: 'info' | 'error'): void;
}

export type NodeState = 'run' | 'done' | 'error';

interface NodeView {
  el: HTMLElement;
  pins: Map<string, HTMLElement>;
}

interface PinRef {
  node: string;
  pin: string;
  dir: 'in' | 'out';
  type: PinType;
}

interface Entry {
  title: string;
  group: string;
  hint: string;
  def: NodeDef;
  make: (x: number, y: number) => GraphNode;
}

const SVG = 'http://www.w3.org/2000/svg';
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const SNAP = 8;
const UNDO_LIMIT = 100;
const PIN_TYPES: Record<PinType, string> = { image: 'картинка', text: 'текст' };

export const plural = (n: number, forms: [string, string, string]) => {
  const a = n % 10;
  const b = n % 100;
  return `${n} ${forms[a === 1 && b !== 11 ? 0 : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 1 : 2]}`;
};
export const nodesWord = (n: number) => plural(n, ['нода', 'ноды', 'нод']);

const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const svg = (tag: string, cls: string, d = '') => {
  const el = document.createElementNS(SVG, tag);
  el.setAttribute('class', cls);
  if (d) el.setAttribute('d', d);
  return el;
};
const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
};
const isControl = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, select, button, .nde-check');

/** Copied nodes are shared across all graphs (paste into another graph). */
let clipboard: { nodes: GraphNode[]; edges: Edge[]; macros: MacroDef[] } | null = null;

export class GraphCanvas {
  readonly el: HTMLElement;
  private readonly host: CanvasHost;
  private graph: Graph = { id: '', name: '', nodes: [], edges: [], macros: [] };
  private views = new Map<string, NodeView>();
  private selected = new Set<string>();
  private states = new Map<string, NodeState>();
  private edgeOf = new Map<Element, Edge>();
  private vx = 0;
  private vy = 0;
  private zoom = 1;
  private locked = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private snapshot = '';
  private saveTimer = 0;
  private wireFrame = 0;
  private needsFit = false;
  private pointer = { x: 0, y: 0 };
  private palette: { el: HTMLElement; input: HTMLInputElement; list: Entry[]; active: number; pick: (e: Entry) => void; render: () => void } | null = null;

  private readonly world: HTMLElement;
  private readonly wires: SVGSVGElement;
  private readonly temp: SVGPathElement;
  private readonly box: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly pageList: HTMLDataListElement;

  constructor(host: CanvasHost) {
    this.host = host;
    this.wires = document.createElementNS(SVG, 'svg') as SVGSVGElement;
    this.wires.setAttribute('class', 'nde-wires');
    this.temp = svg('path', 'nde-wire temp') as SVGPathElement;
    this.world = h('div', { class: 'nde-world' }, this.wires as unknown as Node);
    this.box = h('div', { class: 'nde-box', hidden: true });
    this.empty = h('div', { class: 'nde-empty' }, h('div', { class: 'nde-empty-title' }, 'Пустая схема'), h('div', {}, 'Правый или двойной щелчок — добавить ноду'));
    this.zoomLabel = h('span', { class: 'nde-zoom-label' });
    this.pageList = h('datalist', { id: 'nde-pages' });
    const tool = (label: string, title: string, run: () => void) => h('button', { class: 'nde-tool', title, onclick: run }, label);
    this.el = h(
      'div',
      { class: 'nde', tabIndex: 0 },
      this.world,
      this.box,
      this.empty,
      h('div', { class: 'nde-help' }, 'ПКМ — добавить ноду · колесо — масштаб · зажатая ПКМ или колесо — двигать · Alt+щелчок — разорвать провод · Del, Ctrl+D, Ctrl+Z'),
      h(
        'div',
        { class: 'nde-tools' },
        tool('−', 'Мельче', () => this.zoomBy(1 / 1.2)),
        this.zoomLabel,
        tool('+', 'Крупнее', () => this.zoomBy(1.2)),
        tool('Показать всё', 'Вся схема в окне (F)', () => this.fit()),
      ),
      this.pageList,
    );
    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.el.addEventListener('pointermove', (e) => (this.pointer = this.toWorld(e.clientX, e.clientY)));
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('dblclick', (e) => {
      if (this.locked || (e.target as Element).closest('.nde-node, .nde-palette, .nde-tools')) return;
      this.openPalette(e.clientX, e.clientY);
    });
    new ResizeObserver(() => {
      if (this.needsFit && this.el.clientWidth) this.fit();
    }).observe(this.el);
    this.applyView();
  }

  get current() {
    return this.graph;
  }

  setGraph(graph: Graph) {
    this.closePalette();
    this.graph = graph;
    this.selected.clear();
    this.states.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.snapshot = JSON.stringify(graph);
    this.render();
    this.needsFit = true;
    if (this.el.clientWidth) requestAnimationFrame(() => this.fit());
  }

  /** The graph was changed externally (a collaborator in the same file): new data, same view. */
  replaceGraph(graph: Graph) {
    this.graph = graph;
    this.snapshot = JSON.stringify(graph);
    this.selected = new Set([...this.selected].filter((id) => graph.nodes.some((n) => n.id === id)));
    this.render();
  }

  setPageNames(names: string[]) {
    this.pageList.replaceChildren(...names.map((n) => h('option', { value: n })));
  }

  setLocked(on: boolean) {
    this.locked = on;
    this.el.classList.toggle('locked', on);
    for (const c of this.world.querySelectorAll<HTMLInputElement>('input, textarea, select')) c.disabled = on;
    if (on) this.closePalette();
  }

  setState(id: string, state: NodeState) {
    this.states.set(id, state);
    const v = this.views.get(id);
    if (v) for (const s of ['run', 'done', 'error'] as const) v.el.classList.toggle(s, s === state);
    this.queueWires();
  }

  clearStates() {
    this.states.clear();
    for (const v of this.views.values()) v.el.classList.remove('run', 'done', 'error');
    this.queueWires();
  }

  /** A node from the library goes to the center of the visible area. */
  addMacro(m: MacroDef) {
    this.addEntry(this.macroEntry(m), this.centerPoint());
  }

  addPreset(p: Preset) {
    const e = this.presetEntry(p);
    if (e) this.addEntry(e, this.centerPoint());
  }

  /** A custom node was renamed in the library; its copy in the graph gets the same name. */
  renameMacro(id: string, name: string) {
    const m = this.graph.macros.find((x) => x.id === id);
    if (!m) return;
    m.name = name;
    this.render();
    this.commit();
  }

  // ---------- rendering ----------

  private node(id: string) {
    return this.graph.nodes.find((n) => n.id === id);
  }

  private def(n: GraphNode) {
    return resolveDef(n.type, BUILTIN_MAP, this.graph.macros);
  }

  private render() {
    for (const v of this.views.values()) v.el.remove();
    this.views.clear();
    for (const n of this.graph.nodes) this.mount(n);
    this.empty.hidden = this.graph.nodes.length > 0;
    this.drawWires();
  }

  private mount(n: GraphNode, old?: HTMLElement) {
    const def = this.def(n);
    const pins = new Map<string, HTMLElement>();
    const pin = (dir: 'in' | 'out', p: PinDef) => {
      const el = h('span', { class: `nde-pin t-${p.type}`, 'data-dir': dir, 'data-pin': p.id, title: `${p.name}: ${PIN_TYPES[p.type]}${p.optional ? ', можно не подключать' : ''}` });
      pins.set(`${dir}:${p.id}`, el);
      return el;
    };
    const rows: HTMLElement[] = [];
    const count = Math.max(def?.inputs.length ?? 0, def?.outputs.length ?? 0);
    for (let i = 0; i < count; i++) {
      const a = def!.inputs[i];
      const b = def!.outputs[i];
      rows.push(
        h(
          'div',
          { class: 'nde-row' },
          a ? h('span', { class: `nde-port in${a.optional ? ' opt' : ''}` }, pin('in', a), h('span', {}, a.name)) : h('span'),
          b ? h('span', { class: 'nde-port out' }, h('span', {}, b.name), pin('out', b)) : h('span'),
        ),
      );
    }
    const macro = isMacro(n.type) ? this.graph.macros.find((m) => m.id === n.type.slice(MACRO_PREFIX.length)) : undefined;
    const params = def ? this.params(n, def) : [];
    const el = h(
      'div',
      { class: `nde-node cat-${def?.category ?? 'missing'}`, 'data-id': n.id, style: `left:${n.x}px;top:${n.y}px` },
      h(
        'div',
        { class: 'nde-head', title: def?.description ?? '' },
        h('span', { class: 'nde-title' }, n.title ?? def?.title ?? 'Неизвестная нода'),
        n.title && def && !macro ? h('span', { class: 'nde-sub' }, def.title) : null,
        macro ? h('span', { class: 'nde-sub' }, 'своя') : null,
      ),
      rows.length ? h('div', { class: 'nde-pins' }, ...rows) : null,
      params.length ? h('div', { class: 'nde-params' }, ...params) : null,
      macro ? h('div', { class: 'nde-note' }, `${nodesWord(macro.nodes.length)} внутри · ПКМ → «Разобрать»`) : null,
      def ? null : h('div', { class: 'nde-note error' }, `Нет описания ноды «${n.type}» — удалите её`),
    );
    el.classList.toggle('sel', this.selected.has(n.id));
    const state = this.states.get(n.id);
    if (state) el.classList.add(state);
    if (this.locked) for (const c of el.querySelectorAll<HTMLInputElement>('input, textarea, select')) c.disabled = true;
    this.views.set(n.id, { el, pins });
    if (old) old.replaceWith(el);
    else this.world.append(el);
    this.paintPins(n.id);
  }

  private remount(id: string) {
    const n = this.node(id);
    const v = this.views.get(id);
    if (!n || !v) return;
    this.mount(n, v.el);
    this.queueWires();
  }

  private params(n: GraphNode, def: NodeDef): HTMLElement[] {
    const values = paramsOf(def, n);
    const dependent = def.params.some((p) => p.when);
    const out: HTMLElement[] = [];
    for (const p of def.params) {
      if (p.when && !p.when(values)) continue;
      const v = values[p.id];
      const set = (value: unknown, final: boolean) => {
        n.params[p.id] = value;
        if (!final) return this.scheduleSave();
        this.commit();
        if (dependent) this.remount(n.id);
      };
      if (p.kind === 'check') {
        const c = h('input', { type: 'checkbox', checked: !!v, onchange: () => set(c.checked, true) }) as HTMLInputElement;
        out.push(h('label', { class: 'nde-check', title: p.hint ?? '' }, c, p.name));
        continue;
      }
      out.push(h('label', { class: 'nde-param', title: p.hint ?? '' }, h('span', { class: 'nde-param-name' }, p.name), this.control(p, v, set)));
    }
    return out;
  }

  private control(p: ParamDef, v: unknown, set: (value: unknown, final: boolean) => void): HTMLElement {
    if (p.kind === 'select') {
      const numeric = typeof p.default === 'number';
      return h(
        'select',
        { class: 'nde-input', onchange: (e: Event) => set(numeric ? Number((e.target as HTMLSelectElement).value) : (e.target as HTMLSelectElement).value, true) },
        ...(p.options ?? []).map(([value, label]) => h('option', { value, selected: String(v) === value }, label)),
      );
    }
    if (p.kind === 'number') {
      const input = h('input', {
        class: 'nde-input',
        type: 'number',
        min: p.min,
        max: p.max,
        value: String(v ?? ''),
        onchange: () => {
          const x = Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, Number(input.value) || Number(p.default)));
          input.value = String(x);
          set(x, true);
        },
      }) as HTMLInputElement;
      return input;
    }
    const multi = p.kind === 'textarea';
    const input = h(multi ? 'textarea' : 'input', {
      class: 'nde-input',
      value: String(v ?? ''),
      placeholder: p.hint ?? '',
      ...(multi ? { rows: p.rows ?? 3 } : p.id === 'page' ? { list: 'nde-pages' } : {}),
      oninput: () => set(input.value, false),
      onchange: () => set(input.value, true),
    }) as HTMLInputElement | HTMLTextAreaElement;
    return input;
  }

  private paintPins(only?: string) {
    for (const [id, v] of this.views) {
      if (only && id !== only) continue;
      for (const [key, el] of v.pins) {
        const [dir, pin] = key.split(':') as ['in' | 'out', string];
        el.classList.toggle('on', this.graph.edges.some((e) => (dir === 'in' ? e.to.node === id && e.to.pin === pin : e.from.node === id && e.from.pin === pin)));
      }
    }
  }

  private paintSelection() {
    for (const [id, v] of this.views) v.el.classList.toggle('sel', this.selected.has(id));
  }

  private pinPos(node: string, dir: 'in' | 'out', pin: string) {
    const n = this.node(node);
    const v = this.views.get(node);
    const el = v?.pins.get(`${dir}:${pin}`);
    if (!n || !v || !el) return null;
    let x = el.offsetWidth / 2;
    let y = el.offsetHeight / 2;
    let cur: HTMLElement | null = el;
    while (cur && cur !== v.el) {
      x += cur.offsetLeft;
      y += cur.offsetTop;
      cur = cur.offsetParent as HTMLElement | null;
      if (cur) {
        x += cur.clientLeft;
        y += cur.clientTop;
      }
    }
    return { x: n.x + x, y: n.y + y };
  }

  private pinType(node: string, dir: 'in' | 'out', pin: string): PinType | null {
    const n = this.node(node);
    const def = n && this.def(n);
    return (dir === 'in' ? def?.inputs : def?.outputs)?.find((p) => p.id === pin)?.type ?? null;
  }

  private queueWires() {
    if (!this.wireFrame) this.wireFrame = requestAnimationFrame(() => this.drawWires());
  }

  private drawWires() {
    if (this.wireFrame) cancelAnimationFrame(this.wireFrame);
    this.wireFrame = 0;
    this.edgeOf.clear();
    const frag = document.createDocumentFragment();
    for (const e of this.graph.edges) {
      const a = this.pinPos(e.from.node, 'out', e.from.pin);
      const b = this.pinPos(e.to.node, 'in', e.to.pin);
      if (!a || !b) continue;
      const d = curve(a, b);
      const g = svg('g', 'nde-wire-g');
      const line = svg('path', `nde-wire t-${this.pinType(e.from.node, 'out', e.from.pin) ?? 'image'}`, d);
      if (this.states.get(e.from.node) === 'done' && this.states.get(e.to.node) === 'run') line.classList.add('live');
      const hit = svg('path', 'nde-wire-hit', d);
      g.append(line, hit);
      this.edgeOf.set(hit, e);
      frag.append(g);
    }
    this.wires.replaceChildren(frag, this.temp);
  }

  // ---------- view ----------

  private applyView() {
    this.world.style.transform = `translate(${this.vx}px, ${this.vy}px) scale(${this.zoom})`;
    const small = 16 * this.zoom;
    const big = 128 * this.zoom;
    this.el.style.backgroundSize = `${big}px ${big}px, ${big}px ${big}px, ${small}px ${small}px, ${small}px ${small}px`;
    this.el.style.backgroundPosition = `${this.vx}px ${this.vy}px`;
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private toWorld(clientX: number, clientY: number) {
    const r = this.el.getBoundingClientRect();
    return { x: (clientX - r.left - this.vx) / this.zoom, y: (clientY - r.top - this.vy) / this.zoom };
  }

  private centerPoint() {
    return { x: snap((this.el.clientWidth / 2 - this.vx) / this.zoom - 116), y: snap((this.el.clientHeight / 3 - this.vy) / this.zoom) };
  }

  private zoomBy(k: number, cx = this.el.clientWidth / 2, cy = this.el.clientHeight / 2) {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * k));
    this.vx = cx - (cx - this.vx) * (z / this.zoom);
    this.vy = cy - (cy - this.vy) * (z / this.zoom);
    this.zoom = z;
    this.applyView();
  }

  /** Fit the whole graph (or the selected nodes) in the view. */
  fit(only?: Set<string>) {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    this.needsFit = false;
    const list = this.graph.nodes.filter((n) => !only?.size || only.has(n.id));
    if (!list.length) {
      this.zoom = 1;
      this.vx = W / 2;
      this.vy = H / 3;
      return this.applyView();
    }
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const n of list) {
      const el = this.views.get(n.id)?.el;
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + (el?.offsetWidth ?? 232));
      y1 = Math.max(y1, n.y + (el?.offsetHeight ?? 120));
    }
    this.zoom = Math.max(MIN_ZOOM, Math.min(1, (W - 96) / (x1 - x0), (H - 96) / (y1 - y0)));
    this.vx = W / 2 - ((x0 + x1) / 2) * this.zoom;
    this.vy = H / 2 - ((y0 + y1) / 2) * this.zoom;
    this.applyView();
  }

  private onWheel(e: WheelEvent) {
    const t = e.target as HTMLElement;
    if (this.palette?.el.contains(t)) return;
    const scroller = t.closest<HTMLElement>('textarea, select');
    if (scroller && scroller.scrollHeight > scroller.clientHeight) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  }

  // ---------- mouse ----------

  /** Dragging: move fires after a 4 px offset, up always fires (moved tells whether it moved). */
  private drag(e: PointerEvent, move: (ev: PointerEvent) => void, up: (ev: PointerEvent, moved: boolean) => void) {
    const id = e.pointerId;
    const [sx, sy] = [e.clientX, e.clientY];
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      move(ev);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      up(ev, moved);
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  }

  private onPointerDown(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (this.palette) {
      if (this.palette.el.contains(t)) return;
      this.closePalette();
    }
    if (t.closest('.nde-tools')) return;
    if (!isControl(t)) this.el.focus({ preventScroll: true });
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      return this.startPan(e);
    }
    if (e.button !== 0) return;
    const pinEl = t.closest<HTMLElement>('.nde-pin');
    if (pinEl) {
      e.preventDefault();
      const ref = this.pinRef(pinEl);
      if (!ref || this.locked) return;
      if (e.altKey) return this.breakPin(ref);
      return this.startWire(ref, e);
    }
    const edge = this.edgeOf.get(t);
    if (edge) {
      if (e.altKey && !this.locked) {
        this.graph.edges = this.graph.edges.filter((x) => x !== edge);
        this.commit();
        this.drawWires();
      }
      return;
    }
    const nodeEl = t.closest<HTMLElement>('.nde-node');
    if (nodeEl) {
      if (isControl(t)) return;
      e.preventDefault();
      return this.startMove(nodeEl.dataset.id!, e);
    }
    this.startBox(e);
  }

  private startPan(e: PointerEvent) {
    const [sx, sy] = [e.clientX - this.vx, e.clientY - this.vy];
    const button = e.button;
    this.drag(
      e,
      (ev) => {
        this.el.classList.add('panning');
        this.vx = ev.clientX - sx;
        this.vy = ev.clientY - sy;
        this.applyView();
      },
      (ev, moved) => {
        this.el.classList.remove('panning');
        if (!moved && button === 2) this.contextMenu(ev);
      },
    );
  }

  private startMove(id: string, e: PointerEvent) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const was = this.selected.has(id);
    if (!was) {
      if (!additive) this.selected.clear();
      this.selected.add(id);
      this.paintSelection();
    }
    const start = new Map([...this.selected].flatMap((s) => (this.node(s) ? [[s, { x: this.node(s)!.x, y: this.node(s)!.y }] as const] : [])));
    const [sx, sy] = [e.clientX, e.clientY];
    this.drag(
      e,
      (ev) => {
        const dx = (ev.clientX - sx) / this.zoom;
        const dy = (ev.clientY - sy) / this.zoom;
        for (const [s, p] of start) {
          const n = this.node(s)!;
          n.x = snap(p.x + dx);
          n.y = snap(p.y + dy);
          const el = this.views.get(s)!.el;
          el.style.left = `${n.x}px`;
          el.style.top = `${n.y}px`;
        }
        this.queueWires();
      },
      (_ev, moved) => {
        if (moved) return this.commit();
        if (additive && was) this.selected.delete(id);
        else if (!additive) this.selected = new Set([id]);
        this.paintSelection();
      },
    );
  }

  private startBox(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    const [sx, sy] = [e.clientX, e.clientY];
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? new Set(this.selected) : new Set<string>();
    this.drag(
      e,
      (ev) => {
        const [x0, x1] = [Math.min(sx, ev.clientX), Math.max(sx, ev.clientX)];
        const [y0, y1] = [Math.min(sy, ev.clientY), Math.max(sy, ev.clientY)];
        Object.assign(this.box.style, { left: `${x0 - r.left}px`, top: `${y0 - r.top}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
        this.box.hidden = false;
        this.selected = new Set(base);
        for (const [id, v] of this.views) {
          const b = v.el.getBoundingClientRect();
          if (b.right > x0 && b.left < x1 && b.bottom > y0 && b.top < y1) this.selected.add(id);
        }
        this.paintSelection();
      },
      (_ev, moved) => {
        this.box.hidden = true;
        if (!moved && !additive) {
          this.selected.clear();
          this.paintSelection();
        }
      },
    );
  }

  private pinRef(el: Element): PinRef | null {
    const node = el.closest<HTMLElement>('.nde-node')?.dataset.id;
    const dir = (el as HTMLElement).dataset.dir as 'in' | 'out' | undefined;
    const pin = (el as HTMLElement).dataset.pin;
    if (!node || !dir || !pin) return null;
    const type = this.pinType(node, dir, pin);
    return type ? { node, pin, dir, type } : null;
  }

  private canConnect(a: PinRef, b: PinRef) {
    if (a.dir === b.dir || a.node === b.node || a.type !== b.type) return false;
    const [out, inp] = a.dir === 'out' ? [a, b] : [b, a];
    return !reaches(this.graph.edges, inp.node, out.node);
  }

  private connect(a: PinRef, b: PinRef) {
    const [out, inp] = a.dir === 'out' ? [a, b] : [b, a];
    this.graph.edges = this.graph.edges.filter((e) => !(e.to.node === inp.node && e.to.pin === inp.pin));
    this.graph.edges.push({ from: { node: out.node, pin: out.pin }, to: { node: inp.node, pin: inp.pin } });
  }

  /** Pin under the pointer; over a node without a pin, its first matching pin. */
  private targetAt(ev: PointerEvent, from: PinRef): PinRef | null {
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const pinEl = t?.closest('.nde-pin');
    if (pinEl) {
      const ref = this.pinRef(pinEl);
      return ref && this.canConnect(from, ref) ? ref : null;
    }
    const nodeEl = t?.closest<HTMLElement>('.nde-node');
    if (!nodeEl) return null;
    const v = this.views.get(nodeEl.dataset.id!);
    const refs = [...(v?.pins.values() ?? [])].map((p) => this.pinRef(p)).filter((r): r is PinRef => !!r && this.canConnect(from, r));
    return refs.find((r) => r.dir === 'out' || !this.graph.edges.some((e) => e.to.node === r.node && e.to.pin === r.pin)) ?? refs[0] ?? null;
  }

  private startWire(start: PinRef, e: PointerEvent) {
    let from = start;
    let detached: Edge | null = null;
    // A connected input: take its wire and drag it from the output
    if (start.dir === 'in') {
      detached = this.graph.edges.find((x) => x.to.node === start.node && x.to.pin === start.pin) ?? null;
      if (detached) {
        const type = this.pinType(detached.from.node, 'out', detached.from.pin);
        if (type) from = { node: detached.from.node, pin: detached.from.pin, dir: 'out', type };
      }
    }
    const origin = this.pinPos(from.node, from.dir, from.pin);
    if (!origin) return;
    for (const v of this.views.values())
      for (const p of v.pins.values()) {
        const ref = this.pinRef(p);
        p.classList.toggle('ok', !!ref && this.canConnect(from, ref));
      }
    this.views.get(from.node)?.pins.get(`${from.dir}:${from.pin}`)?.classList.add('from');
    this.el.classList.add('wiring');
    const draw = (ev: PointerEvent) => {
      const p = this.toWorld(ev.clientX, ev.clientY);
      this.temp.setAttribute('d', from.dir === 'out' ? curve(origin, p) : curve(p, origin));
      this.temp.setAttribute('class', `nde-wire temp t-${from.type}`);
    };
    if (detached) {
      this.graph.edges = this.graph.edges.filter((x) => x !== detached);
      this.drawWires();
      draw(e);
    }
    this.drag(e, draw, (ev, moved) => {
      this.el.classList.remove('wiring');
      for (const v of this.views.values()) for (const p of v.pins.values()) p.classList.remove('ok', 'from');
      this.temp.removeAttribute('d');
      if (!moved && detached) {
        this.graph.edges.push(detached);
        return this.drawWires();
      }
      const target = moved ? this.targetAt(ev, from) : null;
      if (target) this.connect(from, target);
      if (target || detached) {
        this.commit();
        this.paintPins();
        this.drawWires();
      }
      // Dropped on empty space: a palette with matching nodes; the new node gets connected right away
      if (!target && moved && !document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.nde-node')) this.openPalette(ev.clientX, ev.clientY, from);
    });
  }

  private breakPin(ref: PinRef) {
    const before = this.graph.edges.length;
    this.graph.edges = this.graph.edges.filter((e) => !(ref.dir === 'in' ? e.to.node === ref.node && e.to.pin === ref.pin : e.from.node === ref.node && e.from.pin === ref.pin));
    if (this.graph.edges.length === before) return;
    this.commit();
    this.drawWires();
  }

  // ---------- menu and palette ----------

  private contextMenu(ev: PointerEvent) {
    if (this.locked) return;
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const pinEl = t?.closest('.nde-pin');
    const edge = t ? this.edgeOf.get(t) : undefined;
    const nodeEl = t?.closest<HTMLElement>('.nde-node');
    if (pinEl) {
      const ref = this.pinRef(pinEl);
      if (ref) showMenuAt(ev.clientX, ev.clientY, [{ label: 'Разорвать связи', run: () => this.breakPin(ref) }]);
      return;
    }
    if (edge) {
      showMenuAt(ev.clientX, ev.clientY, [
        {
          label: 'Удалить провод',
          run: () => {
            this.graph.edges = this.graph.edges.filter((x) => x !== edge);
            this.commit();
            this.drawWires();
          },
        },
      ]);
      return;
    }
    if (!nodeEl) return this.openPalette(ev.clientX, ev.clientY);
    const id = nodeEl.dataset.id!;
    if (!this.selected.has(id)) {
      this.selected = new Set([id]);
      this.paintSelection();
    }
    const n = this.node(id)!;
    const def = this.def(n);
    const macro = isMacro(n.type) ? this.graph.macros.find((m) => m.id === n.type.slice(MACRO_PREFIX.length)) : undefined;
    const items: MenuEntry[] = [];
    if (def && !macro && def.params.length) items.push({ label: 'Сохранить как пресет…', run: () => this.host.savePreset(n, def) });
    if (macro) {
      items.push({ label: 'Разобрать на ноды', run: () => this.expandNode(id) });
      const known = this.host.macros().some((m) => m.id === macro.id);
      items.push({ label: known ? 'Уже в «Моих нодах»' : 'Добавить в «Мои ноды»', disabled: known, run: () => this.host.addMacro(structuredClone(macro)) });
    }
    items.push({ label: this.selected.size > 1 ? `Собрать ${this.selected.size} нод в свою ноду…` : 'Собрать в свою ноду…', hint: 'Ctrl+G', run: () => void this.collapseSelection() });
    items.push('sep', { label: 'Дублировать', hint: 'Ctrl+D', run: () => this.duplicate() }, { label: 'Удалить', hint: 'Del', run: () => this.deleteSelection() });
    showMenuAt(ev.clientX, ev.clientY, items);
  }

  private macroEntry(m: MacroDef): Entry {
    return {
      title: m.name,
      group: CATEGORY_NAMES.custom,
      hint: `Своя нода: ${nodesWord(m.nodes.length)} внутри`,
      def: resolveDef(MACRO_PREFIX + m.id, BUILTIN_MAP, [m])!,
      make: (x, y) => {
        const instance: GraphNode = { id: newId(), type: MACRO_PREFIX + m.id, x, y, params: {} };
        const known = [...this.graph.macros, ...this.host.macros().filter((k) => !this.graph.macros.some((g) => g.id === k.id))];
        for (const add of usedMacros([instance], known)) if (!this.graph.macros.some((g) => g.id === add.id)) this.graph.macros.push(add);
        return instance;
      },
    };
  }

  private presetEntry(p: Preset): Entry | null {
    const def = BUILTIN_MAP.get(p.nodeType);
    if (!def) return null;
    return { title: p.name, group: CATEGORY_NAMES.custom, hint: `Пресет: ${def.title}`, def, make: (x, y) => ({ id: newId(), type: p.nodeType, x, y, params: structuredClone(p.params), title: p.name }) };
  }

  private entries(): Entry[] {
    const macros = [...this.host.macros(), ...this.graph.macros.filter((m) => !this.host.macros().some((k) => k.id === m.id))];
    return [
      ...BUILTINS.map((def): Entry => ({ title: def.title, group: CATEGORY_NAMES[def.category], hint: def.description, def, make: (x, y) => ({ id: newId(), type: def.type, x, y, params: {} }) })),
      ...macros.map((m) => this.macroEntry(m)),
      ...this.host.presets().flatMap((p) => this.presetEntry(p) ?? []),
    ];
  }

  private addEntry(entry: Entry, at: { x: number; y: number }, link?: PinRef) {
    if (this.locked) return;
    const n = entry.make(snap(at.x), snap(at.y));
    this.graph.nodes.push(n);
    this.mount(n);
    this.empty.hidden = true;
    if (link) {
      const pins = link.dir === 'out' ? entry.def.inputs : entry.def.outputs;
      const p = pins.filter((x) => x.type === link.type).sort((a, b) => Number(!!a.optional) - Number(!!b.optional))[0];
      if (p) this.connect(link, { node: n.id, pin: p.id, dir: link.dir === 'out' ? 'in' : 'out', type: p.type });
    }
    this.selected = new Set([n.id]);
    this.paintSelection();
    this.paintPins();
    this.commit();
    this.drawWires();
  }

  private openPalette(clientX: number, clientY: number, link?: PinRef) {
    if (this.locked) return;
    this.closePalette();
    const at = this.toWorld(clientX, clientY);
    if (link?.dir === 'in') at.x -= 240;
    const all = this.entries().filter((en) => !link || (link.dir === 'out' ? en.def.inputs : en.def.outputs).some((p) => p.type === link.type));
    const input = h('input', { class: 'img-input nde-palette-search', placeholder: link ? `Ноды со входом «${PIN_TYPES[link.type]}»` : 'Найти ноду' }) as HTMLInputElement;
    const listEl = h('div', { class: 'nde-palette-list', role: 'listbox' });
    const el = h('div', { class: 'nde-palette' }, input, listEl);
    const pal = {
      el,
      input,
      list: all,
      active: 0,
      pick: (en: Entry) => {
        this.closePalette();
        this.addEntry(en, at, link);
      },
      render: () => {
        const q = input.value.trim().toLowerCase();
        pal.list = all.filter((en) => !q || `${en.title} ${en.hint} ${en.group}`.toLowerCase().includes(q));
        pal.active = Math.min(pal.active, Math.max(0, pal.list.length - 1));
        const rows: HTMLElement[] = [];
        let group = '';
        pal.list.forEach((en, i) => {
          if (en.group !== group) rows.push(h('div', { class: 'nde-palette-group' }, (group = en.group)));
          const row = h(
            'button',
            { class: `nde-palette-item cat-${en.def.category}${i === pal.active ? ' on' : ''}`, role: 'option', onclick: () => pal.pick(en), onpointermove: () => i !== pal.active && ((pal.active = i), pal.render()) },
            h('span', { class: 'nde-palette-dot' }),
            h('span', { class: 'nde-palette-text' }, h('span', { class: 'nde-palette-name' }, en.title), h('span', { class: 'nde-palette-hint' }, en.hint)),
          );
          rows.push(row);
        });
        listEl.replaceChildren(...(rows.length ? rows : [h('div', { class: 'nde-palette-empty' }, 'Ничего не нашлось')]));
        listEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
      },
    };
    input.addEventListener('input', () => ((pal.active = 0), pal.render()));
    this.palette = pal;
    pal.render();
    this.el.append(el);
    const r = this.el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(clientX - r.left, r.width - el.offsetWidth - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(clientY - r.top, r.height - el.offsetHeight - 8))}px`;
    input.focus();
  }

  private closePalette() {
    this.palette?.el.remove();
    this.palette = null;
  }

  // ---------- edits ----------

  private commit() {
    clearTimeout(this.saveTimer);
    const now = JSON.stringify(this.graph);
    this.empty.hidden = this.graph.nodes.length > 0;
    if (now === this.snapshot) return;
    this.undoStack.push(this.snapshot);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.snapshot = now;
    this.host.changed();
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.host.changed(), 400);
  }

  private restore(json: string) {
    const g = JSON.parse(json) as Graph;
    Object.assign(this.graph, { nodes: g.nodes, edges: g.edges, macros: g.macros, name: g.name });
    this.snapshot = json;
    this.selected = new Set([...this.selected].filter((id) => this.node(id)));
    this.render();
    this.host.changed();
  }

  private undo() {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.snapshot);
    this.restore(prev);
  }

  private redo() {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.snapshot);
    this.restore(next);
  }

  private deleteSelection() {
    if (!this.selected.size) return;
    const gone = this.selected;
    this.graph.nodes = this.graph.nodes.filter((n) => !gone.has(n.id));
    this.graph.edges = this.graph.edges.filter((e) => !gone.has(e.from.node) && !gone.has(e.to.node));
    this.selected = new Set();
    this.render();
    this.commit();
  }

  /** Copies of nodes with their wires between them; offset is the shift from the originals. */
  private paste(data: { nodes: GraphNode[]; edges: Edge[]; macros: MacroDef[] }, dx: number, dy: number) {
    const ids = new Map(data.nodes.map((n) => [n.id, newId()]));
    const nodes = data.nodes.map((n) => ({ ...structuredClone(n), id: ids.get(n.id)!, x: snap(n.x + dx), y: snap(n.y + dy) }));
    const edges = data.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)).map((e) => ({ from: { node: ids.get(e.from.node)!, pin: e.from.pin }, to: { node: ids.get(e.to.node)!, pin: e.to.pin } }));
    for (const m of data.macros) if (!this.graph.macros.some((x) => x.id === m.id)) this.graph.macros.push(structuredClone(m));
    this.graph.nodes.push(...nodes);
    this.graph.edges.push(...edges);
    this.selected = new Set(nodes.map((n) => n.id));
    this.render();
    this.commit();
  }

  private copySelection() {
    const nodes = this.graph.nodes.filter((n) => this.selected.has(n.id));
    if (!nodes.length) return null;
    return { nodes: structuredClone(nodes), edges: this.graph.edges.filter((e) => this.selected.has(e.from.node) && this.selected.has(e.to.node)), macros: usedMacros(nodes, this.graph.macros) };
  }

  private duplicate() {
    const data = this.copySelection();
    if (data) this.paste(data, 32, 32);
  }

  private async collapseSelection() {
    const ids = new Set(this.selected);
    if (!ids.size) return;
    const fixed = [...ids].map((id) => this.node(id)!).filter((n) => BUILTIN_MAP.get(n.type)?.source || BUILTIN_MAP.get(n.type)?.output);
    if (fixed.length) return this.host.notify('«Запросы», «Картинки» и «На страницу» остаются в схеме — уберите их из выделения', 'error');
    const name = await this.host.ask('Своя нода из выделенных', ids.size === 1 ? `${this.def(this.node([...ids][0]!)!)?.title ?? 'Нода'} (своя)` : 'Моя нода');
    if (!name) return;
    const { graph, macro } = collapse(this.graph, ids, name, (n) => this.def(n) ?? { inputs: [], outputs: [] });
    Object.assign(this.graph, { nodes: graph.nodes, edges: graph.edges, macros: graph.macros });
    this.selected = new Set([this.graph.nodes[this.graph.nodes.length - 1]!.id]);
    this.render();
    this.commit();
    this.host.addMacro(structuredClone(macro));
  }

  private expandNode(id: string) {
    const { graph, ids } = expand(this.graph, id);
    if (!ids.length) return;
    Object.assign(this.graph, { nodes: graph.nodes, edges: graph.edges });
    this.graph.macros = usedMacros(this.graph.nodes, this.graph.macros);
    this.selected = new Set(ids);
    this.render();
    this.commit();
  }

  /** Canvas keys; true means handled (the page will not pass them on). */
  key(e: KeyboardEvent): boolean {
    const pal = this.palette;
    if (pal) {
      if (e.key === 'Escape') return this.closePalette(), true;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        pal.active = Math.max(0, Math.min(pal.list.length - 1, pal.active + (e.key === 'ArrowDown' ? 1 : -1)));
        pal.render();
        return true;
      }
      if (e.key === 'Enter') {
        const en = pal.list[pal.active];
        if (en) pal.pick(en);
        return true;
      }
      return false;
    }
    if (isControl(e.target) && (e.target as Element).closest('input, textarea, select')) return false;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape' && this.selected.size) {
      this.selected.clear();
      this.paintSelection();
      return true;
    }
    if (!mod && e.code === 'KeyF') return this.fit(this.selected), true;
    if (mod && e.code === 'KeyA') {
      this.selected = new Set(this.graph.nodes.map((n) => n.id));
      this.paintSelection();
      return true;
    }
    if (mod && e.code === 'KeyC') {
      clipboard = this.copySelection() ?? clipboard;
      return true;
    }
    const edit = e.key === 'Delete' || e.key === 'Backspace' || (mod && ['KeyD', 'KeyV', 'KeyZ', 'KeyY', 'KeyG'].includes(e.code));
    if (!edit) return false;
    if (this.locked) return true;
    if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
    else if (e.code === 'KeyD') this.duplicate();
    else if (e.code === 'KeyV' && clipboard) {
      const x0 = Math.min(...clipboard.nodes.map((n) => n.x));
      const y0 = Math.min(...clipboard.nodes.map((n) => n.y));
      this.paste(clipboard, this.pointer.x - x0, this.pointer.y - y0);
    } else if (e.code === 'KeyZ' && !e.shiftKey) this.undo();
    else if (e.code === 'KeyZ' || e.code === 'KeyY') this.redo();
    else if (e.code === 'KeyG') void this.collapseSelection();
    return true;
  }
}
