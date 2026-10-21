// Text editing on the canvas: the canvas itself draws the text (the same layout as the node,
// with per-run styles), selection and caret on top; input goes through an invisible field
// (keyboard, IME, clipboard). Mouse: click — caret, drag — selection, double
// click — word, triple — paragraph, Shift — extend. Ctrl+B / I / U, Ctrl+Shift+X — apply to
// the selection (without a selection — to what is typed next); Ctrl+Shift+7 / 8 — numbered and
// bulleted list, Tab / Shift+Tab in a list — level; Ctrl+K — link.
// The whole edit is one undo step; empty text is deleted on exit.

import { invert, MIXED, effectiveStyle, rangeValue, spliceRuns, styleAt, compactText, textSegments, type Matrix, type NodeProps, type TextStyle, type TextStyleKey } from '@mfp/core';
import { textKeyOf, textKeyStyle } from './text-keys.ts';
import { restyleText, styleWeight, toggleBold, toggleItalic, type EffectiveTextStyle } from '@mfp/core';
import { graphemes, layoutText, PathTextMap, textFonts, textLayoutOf, textPathScale, type FontLibrary, type TextLayout } from '@mfp/renderer';
import type { Canvas, Paint } from 'canvaskit-wasm';
import type { Editor } from './editor.ts';
import type { PointerInterceptor } from './vector.ts';
import { canvasAccent } from './appearance.ts';

const MULTI_CLICK_MS = 450;

export class TextEditing implements PointerInterceptor {
  private ed: Editor;
  private fonts: FontLibrary;
  private stage: HTMLElement;
  private area: HTMLTextAreaElement | null = null;
  /** The node was created by this edit: if empty on exit, it disappears without a trace and without an undo step. */
  private isNew = false;
  id: string | null = null;
  /** Formatting for what is typed next (Ctrl+B without a selection, an edit in the panel). */
  private typing: TextStyle | null = null;
  /** Layout as on the canvas; y — vertical alignment offset; map — for text on a path. */
  private cache: { key: string; layout: TextLayout; y: number; map: PathTextMap | null } | null = null;
  private drag: { anchor: number; unit: 1 | 2 | 3 } | null = null;
  private clicks = { n: 0, t: 0, x: 0, y: 0 };
  /** Up / down arrows remember the original horizontal position. */
  private goalX: number | null = null;
  private timer = 0;
  private shownAt = 0;
  private paints: { sel: Paint; caret: Paint } | null = null;
  private accentV = -1;
  /** Selection or formatting changed (the panel shows the selected text). */
  onChange: (() => void)[] = [];
  notify: (message: string) => void = () => {};
  private fontRequest = 0;

  constructor(ed: Editor, fonts: FontLibrary, stage: HTMLElement) {
    this.ed = ed;
    this.fonts = fonts;
    this.stage = stage;
    ed.overlays.push((canvas) => this.draw(canvas));
    ed.onDocument.push(() => this.sync());
    ed.onCamera.push(() => this.placeArea());
    ed.onPage.push(() => this.commit());
    ed.onSelection.push(() => {
      if (this.id && !(ed.selection.length === 1 && ed.selection[0] === this.id)) this.commit();
    });
    document.addEventListener('selectionchange', () => {
      if (this.area && document.activeElement === this.area) this.selected();
    });
  }

  get active() {
    return this.id !== null;
  }

  /** Text selection [start, end) or null (not editing). */
  get range(): [number, number] | null {
    return this.area ? [this.area.selectionStart, this.area.selectionEnd] : null;
  }

  // ---------- Start and end ----------

  /** at — the double-click point (world): the caret goes there; without it the whole text is selected. */
  start(id: string, isNew = false, at?: [number, number]) {
    const { ed } = this;
    const doc = ed.doc;
    if (doc.type(id) !== 'TEXT') return;
    this.commit();
    const request = ++this.fontRequest;
    const required = textFonts(doc.props(id));
    const unavailable = required.filter(f => !this.fonts.has(f));
    if (unavailable.length) {
      // Imported outlines are display data, not a font. Do not discard them by
      // allowing the first keystroke to reflow text using a fallback typeface.
      ed.select([id]);
      this.notify('Загружаем шрифт перед редактированием текста…');
      void Promise.all(unavailable.map(f => this.fonts.ensure(f))).then(results => {
        if (request !== this.fontRequest || ed.doc !== doc || !doc.has(id) || ed.selection.length !== 1 || ed.selection[0] !== id) return;
        const missing = unavailable.filter((_, i) => !results[i]);
        if (missing.length) {
          this.notify(`Для правки нужен шрифт: ${missing.map(f => `${f.family} ${f.style}`).join(', ')}. Загрузите .ttf/.otf или выберите замену в «Нет шрифтов».`);
          return;
        }
        this.start(id, isNew, at);
      });
      return;
    }
    this.id = id;
    this.isNew = isNew;
    this.typing = null;
    const characters = doc.get(id, 'characters') ?? '';
    doc.beginGroup();
    if (isNew) doc.set(id, { autoRename: true });
    for (const f of textFonts(doc.props(id))) void this.fonts.ensure(f);
    ed.select([id]);
    ed.hideHandles = true;

    const area = document.createElement('textarea');
    area.className = 'text-input';
    area.value = characters;
    area.spellcheck = false;
    area.setAttribute('autocomplete', 'off');
    area.addEventListener('input', () => this.input());
    area.addEventListener('keydown', (e) => this.key(e));
    area.addEventListener('keyup', () => this.selected());
    // Wheel over the field — canvas zoom and scroll, as everywhere.
    area.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        ed.canvasEl.dispatchEvent(new WheelEvent('wheel', e));
      },
      { passive: false },
    );
    this.stage.append(area);
    this.area = area;
    area.focus({ preventScroll: true });
    const caret = at ? this.indexAtWorld(at) : -1;
    if (caret >= 0) area.setSelectionRange(caret, caret);
    else area.select();
    this.timer = window.setInterval(() => {
      if (this.id) this.ed.dirty = true;
    }, 265);
    this.selected();
  }

  commit() {
    this.fontRequest++;
    const id = this.id;
    if (!id) return;
    this.id = null;
    const { ed } = this;
    this.area?.remove();
    this.area = null;
    window.clearInterval(this.timer);
    this.cache?.layout.delete();
    this.cache = null;
    this.drag = null;
    this.typing = null;
    ed.hideHandles = false;
    const doc = ed.doc;
    let record = true;
    if (doc.has(id)) {
      const text = doc.get(id, 'characters') ?? '';
      if (!text.trim().length) {
        doc.delete(id);
        ed.select([]);
        // New and empty — as if it never existed.
        record = !this.isNew;
      }
    }
    doc.endGroup(record);
    ed.dirty = true;
    for (const cb of this.onChange) cb();
    if (!document.activeElement || document.activeElement === document.body) ed.canvasEl.focus();
  }

  // ---------- Text and selection ----------

  /** Field input: the difference from the document text — insertion and deletion; insertion uses the neighbor's or the pending style. */
  private input() {
    const { ed, area } = this;
    const id = this.id;
    if (!id || !area) return;
    const doc = ed.doc;
    if (!doc.has(id)) return this.commit();
    const old = doc.get(id, 'characters') ?? '';
    const next = area.value;
    if (next === old) return;
    let p = 0;
    const max = Math.min(old.length, next.length);
    while (p < max && old.charCodeAt(p) === next.charCodeAt(p)) p++;
    let s = 0;
    while (s < max - p && old.charCodeAt(old.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
    const removed = old.length - p - s;
    const inserted = next.length - p - s;
    const props = doc.props(id);
    const inherit = p > 0 ? styleAt(props.textRuns, p - 1) : styleAt(props.textRuns, p + removed);
    const style = inserted && this.typing ? { ...inherit, ...this.typing } : undefined;
    const runs = spliceRuns(props.textRuns, old.length, p, removed, inserted, style);
    const c = compactText(props, runs, next.length);
    doc.set(id, { characters: next, ...c.props, textRuns: c.runs, ...(props.textGlyphs ? { textGlyphs: undefined } : {}) });
    if (inserted) this.typing = null;
    this.goalX = null;
    this.selected();
  }

  /** The document changed (box size, undo, someone else's edit) — adjust the field and layout. */
  private sync() {
    const { ed, area } = this;
    const id = this.id;
    if (!id || !area) return;
    if (!ed.doc.has(id)) return this.commit();
    const text = ed.doc.get(id, 'characters') ?? '';
    if (area.value !== text) {
      const [a, b] = [area.selectionStart, area.selectionEnd];
      area.value = text;
      area.setSelectionRange(Math.min(a, text.length), Math.min(b, text.length));
    }
    this.placeArea();
  }

  /** Selection changed: redraw, show the caret, notify the panel. */
  private selected() {
    this.shownAt = performance.now();
    this.placeArea();
    this.ed.dirty = true;
    for (const cb of this.onChange) cb();
  }

  private setSelection(anchor: number, focus: number) {
    const area = this.area;
    if (!area) return;
    area.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? 'backward' : 'forward');
    this.selected();
  }

  /** The selection end where the caret is (considering direction). */
  private get focus(): number {
    const a = this.area!;
    return a.selectionDirection === 'backward' ? a.selectionStart : a.selectionEnd;
  }

  private get anchor(): number {
    const a = this.area!;
    return a.selectionDirection === 'backward' ? a.selectionEnd : a.selectionStart;
  }

  // ---------- Layout as on the canvas ----------

  /** Node layout with the same parameters the canvas draws with; y — vertical alignment offset. */
  private layout(): { layout: TextLayout; y: number; map: PathTextMap | null } | null {
    const id = this.id;
    if (!id) return null;
    const doc = this.ed.doc;
    const p = doc.props(id);
    delete p.textGlyphs;
    const spec = textLayoutOf(p);
    // Text on a path — a single line, as the canvas draws it.
    const path = p.textPath;
    const width = spec.autoWidth || path ? undefined : (p.width ?? 1);
    const height = spec.autoWidth || path ? undefined : p.height;
    const scale = path ? textPathScale(p) : null;
    const key = JSON.stringify([spec, width, height, p.height, path, scale, this.fonts.version]);
    if (this.cache?.key === key) return this.cache;
    this.cache?.layout.delete();
    this.cache?.map?.delete();
    const layout = layoutText(this.ed.ck, this.fonts, { ...spec, color: { r: 0, g: 0, b: 0, a: 1 }, width, height });
    const y = path || spec.alignV === 'TOP' ? 0 : ((p.height ?? 0) - layout.height) * (spec.alignV === 'CENTER' ? 0.5 : 1);
    const map = path ? new PathTextMap(this.ed.ck, path.data, path.offset ?? 0, layout.width, spec.align, layout.lines()[0]?.baseline ?? 0, ...scale!) : null;
    this.cache = { key, layout, y, map };
    return this.cache;
  }

  /** Layout coordinates → node (for text on a path — on the path). */
  private toNode(x: number, y: number): [number, number] {
    const L = this.cache;
    if (L?.map?.ok) {
      const [lx, ly] = L.map.toLocal(x, y);
      return [lx, ly];
    }
    return [x, y + (L?.y ?? 0)];
  }

  /** Node coordinates → layout. */
  private fromNode(x: number, y: number): [number, number] {
    const L = this.cache;
    if (L?.map?.ok) return L.map.fromLocal(x, y);
    return [x, y - (L?.y ?? 0)];
  }

  /** World point → node coordinates. */
  private local(wx: number, wy: number): [number, number] {
    const m = invert(this.ed.worldMatrix(this.id!) as Matrix);
    return [m[0] * wx + m[1] * wy + m[2], m[3] * wx + m[4] * wy + m[5]];
  }

  private indexAtWorld([wx, wy]: [number, number]): number {
    const L = this.layout();
    if (!L) return 0;
    const [x, y] = this.fromNode(...this.local(wx, wy));
    return L.layout.indexAt(x, y);
  }

  private inside(wx: number, wy: number): boolean {
    const doc = this.ed.doc;
    const [x, y] = this.local(wx, wy);
    // Text on a path extends beyond the path bounds by a line height.
    const pad = 4 / this.ed.camera.zoom + (doc.get(this.id!, 'textPath') ? (doc.get(this.id!, 'fontSize') ?? 12) * 1.5 : 0);
    return x >= -pad && y >= -pad && x <= (doc.get(this.id!, 'width') ?? 0) + pad && y <= (doc.get(this.id!, 'height') ?? 0) + pad;
  }

  /** The invisible field sits at the caret (the IME candidate window appears next to it). */
  private placeArea() {
    const { ed, area } = this;
    const id = this.id;
    if (!area || !id || !ed.doc.has(id)) return;
    const L = this.layout();
    const c = L ? L.layout.caret(this.focus) : { x: 0, y: 0, height: 0 };
    const m = ed.worldMatrix(id);
    const [nx, ny] = this.toNode(c.x, c.y);
    const [sx, sy] = ed.worldToScreen(m[0] * nx + m[1] * ny + m[2], m[3] * nx + m[4] * ny + m[5]);
    area.style.left = `${sx}px`;
    area.style.top = `${sy}px`;
    area.style.height = `${Math.max(8, c.height * ed.camera.zoom)}px`;
  }

  // ---------- Pointer ----------

  down(e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.id || e.button !== 0) return false;
    if (!this.inside(wx, wy)) {
      // Click outside the text — editing is finished, the click is handled by the tools.
      this.commit();
      return false;
    }
    e.preventDefault();
    const now = performance.now();
    const c = this.clicks;
    const near = Math.hypot(e.clientX - c.x, e.clientY - c.y) < 5;
    c.n = near && now - c.t < MULTI_CLICK_MS ? Math.min(3, c.n + 1) : 1;
    c.t = now;
    c.x = e.clientX;
    c.y = e.clientY;
    const i = this.indexAtWorld([wx, wy]);
    const L = this.layout();
    if (c.n === 2 && L) {
      const [a, b] = L.layout.wordAt(i);
      this.setSelection(a, b);
    } else if (c.n === 3 && L) {
      const [a, b] = L.layout.paragraphAt(i);
      this.setSelection(a, b);
    } else if (e.shiftKey) this.setSelection(this.anchor, i);
    else this.setSelection(i, i);
    this.drag = { anchor: c.n === 1 ? (e.shiftKey ? this.anchor : i) : this.anchor, unit: c.n as 1 | 2 | 3 };
    this.goalX = null;
    this.area?.focus({ preventScroll: true });
    return true;
  }

  move(_e: PointerEvent, wx: number, wy: number): boolean {
    if (!this.id) return false;
    if (!this.drag) {
      const over = this.inside(wx, wy);
      if (over) this.ed.canvasEl.style.cursor = 'text';
      return over;
    }
    const i = this.indexAtWorld([wx, wy]);
    const L = this.layout();
    if (this.drag.unit === 1 || !L) this.setSelection(this.drag.anchor, i);
    else {
      // Drag after a double / triple click — by words / paragraphs.
      const span = this.drag.unit === 2 ? L.layout.wordAt(i) : L.layout.paragraphAt(i);
      const a = this.area!;
      const [s, e] = [Math.min(a.selectionStart, span[0]), Math.max(a.selectionEnd, span[1])];
      this.setSelection(i < this.drag.anchor ? e : s, i < this.drag.anchor ? s : e);
    }
    return true;
  }

  up(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    return true;
  }

  dblclick(): boolean {
    // Double and triple clicks are counted in down.
    return this.id !== null;
  }

  // ---------- Keys ----------

  private key(e: KeyboardEvent) {
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
    const area = this.area!;
    const done = () => e.preventDefault();
    if (e.key === 'Escape' || (e.key === 'Enter' && mod)) return done(), this.commit();
    if (mod && !e.shiftKey && !e.altKey && k === 'b') return done(), this.toggleBold();
    if (mod && !e.shiftKey && !e.altKey && k === 'i') return done(), this.toggleItalic();
    if (mod && !e.shiftKey && !e.altKey && k === 'u') return done(), this.toggleDecoration('UNDERLINE');
    if (mod && e.shiftKey && !e.altKey && k === 'x') return done(), this.toggleDecoration('STRIKETHROUGH');
    if (mod && e.shiftKey && e.code === 'Digit7') return done(), this.toggleList('ORDERED');
    if (mod && e.shiftKey && e.code === 'Digit8') return done(), this.toggleList('UNORDERED');
    if (mod && !e.shiftKey && !e.altKey && k === 'k') return done(), this.linkPrompt();
    // Shortcuts: alignment, font size, weight, spacing — for the selected run.
    const tk = textKeyOf(e);
    if (tk) {
      done();
      if (tk.kind === 'align') this.ed.doc.set(this.id!, { textAlignHorizontal: tk.value });
      else this.apply((st) => textKeyStyle(tk, st, this.fonts.localStyles(st.fontName.family)));
      return;
    }
    // Enter in an empty list item — leave the list.
    if (e.key === 'Enter' && !mod && !e.shiftKey && area.selectionStart === area.selectionEnd) {
      const i = area.selectionStart;
      const empty = (i === 0 || area.value[i - 1] === '\n') && (i === area.value.length || area.value[i] === '\n');
      const lt = this.value('listType');
      if (empty && lt !== 'NONE' && lt !== MIXED) return done(), this.apply(() => ({ listType: 'NONE', indentation: 0 }), true);
    }
    if (e.key === 'Tab') {
      done();
      const v = this.value('listType');
      if (v !== 'NONE' && v !== MIXED) return this.indent(e.shiftKey ? -1 : 1);
      if (!e.shiftKey) area.setRangeText('\t', area.selectionStart, area.selectionEnd, 'end');
      return this.input();
    }
    const L = this.layout();
    if (!L) return;
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod) {
      done();
      const c = L.layout.caret(this.focus);
      const x = (this.goalX ??= c.x);
      const lines = L.layout.lines();
      const row = lines.findIndex((l) => c.y < l.y + l.height - 0.5);
      const target = e.key === 'ArrowUp' ? row - 1 : row + 1;
      let i: number;
      if (target < 0) i = 0;
      else if (target >= lines.length) i = area.value.length;
      else i = L.layout.indexAt(x, lines[target]!.y + lines[target]!.height / 2);
      const keep = this.goalX;
      this.setSelection(e.shiftKey ? this.anchor : i, i);
      this.goalX = keep;
      return;
    }
    if ((e.key === 'Home' || e.key === 'End') && !mod) {
      done();
      const f = this.focus;
      const lines = L.layout.lines();
      const line = lines.find((l, n) => f >= l.start && (f < l.end || n === lines.length - 1 || (f === l.end && lines[n + 1]?.start !== f))) ?? lines[lines.length - 1];
      if (!line) return;
      const i = e.key === 'Home' ? line.start : line.endText;
      this.setSelection(e.shiftKey ? this.anchor : i, i);
      return;
    }
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') this.goalX = null;
  }

  // ---------- Formatting of the selection ----------

  /** Property value of the selection (without a selection — of what is typed next): a single one or MIXED. */
  value<K extends TextStyleKey>(key: K): NodeProps[K] | typeof MIXED {
    const id = this.id;
    const area = this.area;
    if (!id || !area) return MIXED;
    const p = this.ed.doc.props(id);
    const [a, b] = [area.selectionStart, area.selectionEnd];
    if (a === b && this.typing?.[key] !== undefined) return this.typing[key] as NodeProps[K];
    return rangeValue(p, p.textRuns, area.value.length, a, b, key);
  }

  /** Resolved styles of the selection's runs (without a selection — the caret style with pending formatting). */
  styles(): EffectiveTextStyle[] {
    const id = this.id;
    const area = this.area;
    if (!id || !area) return [];
    const [a, b] = [area.selectionStart, area.selectionEnd];
    if (a === b) return [this.caretStyle()];
    const p = this.ed.doc.props(id);
    return textSegments(p.textRuns, area.value.length)
      .filter((s) => s.end > a && s.start < b)
      .map((s) => effectiveStyle(p, s.style));
  }

  /** Resolved style at the caret (with pending formatting). */
  private caretStyle(): EffectiveTextStyle {
    const p = this.ed.doc.props(this.id!);
    const i = this.area!.selectionStart;
    return effectiveStyle(p, { ...styleAt(p.textRuns, Math.max(0, i - 1)), ...(this.typing ?? {}) });
  }

  /**
   * Change the formatting of the selection: fn receives the run's resolved style and returns new
   * values. Without a selection — formatting of what is typed next (paragraph properties apply to the paragraph at once).
   */
  apply(fn: (s: EffectiveTextStyle) => TextStyle, paragraph = false) {
    const id = this.id;
    const area = this.area;
    if (!id || !area) return;
    const [a, b] = [area.selectionStart, area.selectionEnd];
    if (a === b && !paragraph && area.value.length) {
      this.typing = { ...(this.typing ?? {}), ...fn(this.caretStyle()) };
    } else {
      this.ed.doc.transact(() => restyleText(this.ed.doc, id, a, b, fn, paragraph));
    }
    for (const f of textFonts({ ...this.ed.doc.props(id), ...(this.typing?.fontName ? { fontName: this.typing.fontName } : {}) })) void this.fonts.ensure(f);
    // Focus goes back to the text, but after the current event: otherwise Enter from a panel field
    // reaches the text and replaces the selection with a line break.
    setTimeout(() => this.area?.focus({ preventScroll: true }));
    this.selected();
  }

  /** Whether all runs of the selection satisfy the condition (at the caret — the pending formatting). */
  private every(test: (s: EffectiveTextStyle) => boolean): boolean {
    const id = this.id!;
    const [a, b] = [this.area!.selectionStart, this.area!.selectionEnd];
    if (a === b) return test(this.caretStyle());
    const p = this.ed.doc.props(id);
    let pos = 0;
    let all = true;
    const runs = p.textRuns ?? [];
    const len = this.area!.value.length;
    const segs: [number, number, TextStyle][] = [];
    for (const r of runs) {
      segs.push([pos, pos + r.length, r.style]);
      pos += r.length;
    }
    if (pos < len) segs.push([pos, len, {}]);
    for (const [s, e, st] of segs) if (e > a && s < b && !test(effectiveStyle(p, st))) all = false;
    return all;
  }

  toggleBold() {
    const on = !this.every((s) => styleWeight(s.fontName.style).weight >= 600);
    this.apply((s) => ({ fontName: { family: s.fontName.family, style: toggleBold(s.fontName.style, on) } }));
  }

  toggleItalic() {
    const on = !this.every((s) => styleWeight(s.fontName.style).italic);
    this.apply((s) => ({ fontName: { family: s.fontName.family, style: toggleItalic(s.fontName.style, on) } }));
  }

  toggleDecoration(d: 'UNDERLINE' | 'STRIKETHROUGH') {
    const on = !this.every((s) => s.textDecoration === d);
    this.apply(() => ({ textDecoration: on ? d : 'NONE' }));
  }

  toggleList(type: 'ORDERED' | 'UNORDERED') {
    const on = this.value('listType') !== type;
    this.apply(() => ({ listType: on ? type : 'NONE' }), true);
  }

  private indent(d: number) {
    this.apply((s) => ({ indentation: Math.max(0, Math.min(8, (s.indentation ?? 0) + d)) }), true);
  }

  /** Link on the selection (Ctrl+K): the URL; empty — remove the link. */
  private linkPrompt() {
    const area = this.area;
    if (!area || area.selectionStart === area.selectionEnd) return;
    const cur = this.value('hyperlink');
    const url = window.prompt('Ссылка (пусто — убрать)', cur && cur !== MIXED ? cur.value : 'https://');
    if (url === null) return this.area?.focus({ preventScroll: true });
    const v = url.trim();
    this.apply(() => (v ? { hyperlink: { type: 'URL', value: v }, textDecoration: 'UNDERLINE' } : { hyperlink: null, textDecoration: 'NONE' }));
  }

  // ---------- Drawing ----------

  private draw(canvas: Canvas) {
    const id = this.id;
    const area = this.area;
    if (!id || !area || !this.ed.doc.has(id)) return;
    const L = this.layout();
    if (!L) return;
    const ck = this.ed.ck;
    // The theme changed the selection color — recreate the paints.
    if (this.paints && this.accentV !== canvasAccent.version) {
      for (const p of Object.values(this.paints)) p.delete();
      this.paints = null;
    }
    if (!this.paints) {
      this.accentV = canvasAccent.version;
      const sel = new ck.Paint();
      sel.setColor(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 0.28));
      sel.setAntiAlias(true);
      const caret = new ck.Paint();
      caret.setColor(ck.Color4f(canvasAccent.r, canvasAccent.g, canvasAccent.b, 1));
      caret.setStrokeWidth(1.5);
      caret.setAntiAlias(true);
      this.paints = { sel, caret };
    }
    const m = this.ed.worldMatrix(id);
    const toScreen = (x: number, y: number) => {
      const [nx, ny] = this.toNode(x, y);
      return this.ed.worldToScreen(m[0] * nx + m[1] * ny + m[2], m[3] * nx + m[4] * ny + m[5]);
    };
    const [a, b] = [area.selectionStart, area.selectionEnd];
    if (a !== b) {
      // For text on a path — per character (a line rectangle wouldn't fit on a curve).
      const text = (this.ed.doc.get(id, 'characters') ?? '').slice(a, b);
      const rects = L.map ? graphemes(text).flatMap(([i, j]) => L.layout.rects(a + i, a + j)) : L.layout.rects(a, b);
      for (const [x0, y0, x1, y1] of rects) {
        const pb = new ck.PathBuilder();
        [toScreen(x0, y0), toScreen(x1, y0), toScreen(x1, y1), toScreen(x0, y1)].forEach(([x, y], k) => (k ? pb.lineTo(x, y) : pb.moveTo(x, y)));
        pb.close();
        const path = pb.detachAndDelete();
        canvas.drawPath(path, this.paints.sel);
        path.delete();
      }
    } else if (document.activeElement === area && Math.floor((performance.now() - this.shownAt) / 530) % 2 === 0) {
      // The caret blinks; after movement — visible immediately.
      const c = L.layout.caret(this.focus);
      const [x0, y0] = toScreen(c.x, c.y);
      const [x1, y1] = toScreen(c.x, c.y + c.height);
      canvas.drawLine(x0, y0, x1, y1, this.paints.caret);
    }
  }
}
