// Text layout via SkParagraph (CanvasKit: HarfBuzz for ligatures and kerning, ICU for
// line breaking) — for text created or modified in MFP. Runs of text with their own
// formatting, “…” truncation and line limits, vertical trim to cap height,
// paragraphs with lists, indents and spacing, Balance / Pretty wrapping. TextLayout also provides
// geometry for editing on the canvas: caret, selection, character under a point, word, lines.

import type { CanvasKit, Canvas, Paragraph, FontWeight, Paint as CKPaint, TextStyle as CKTextStyle } from 'canvaskit-wasm';
import { textSegments, effectiveStyle, type Document, type Paint, type Props, type RGBA } from '@mfp/core';
import type { SceneTextCase, SceneTextLayout, SceneTextRun } from '@mfp/io-figma';
import { fontStack, parseStyle, variableStack, type FontLibrary } from './fonts.ts';

export interface TextSpec extends Omit<SceneTextLayout, 'autoWidth'> {
  /** Color of runs without their own color (the node fill). */
  color: RGBA;
  /** Box width; undefined — fit content (auto width). */
  width?: number;
  /** Height of a fixed-size box — for “…” truncation by height. */
  height?: number;
  /** All runs in this color (outline mode). */
  override?: RGBA;
  /** Opacity multiplier (node opacity given to the paint). */
  alpha?: number;
}

/** Line of text: characters [start, end), bounds and baseline — in text box coordinates. */
export interface TextLine {
  start: number;
  end: number;
  /** End excluding trailing spaces of the line. */
  endText: number;
  x: number;
  y: number;
  width: number;
  height: number;
  baseline: number;
}

const SOLID_BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

/** Paint color for text: the first visible solid one (for a gradient — the first stop). */
export function paintColor(fills: readonly Paint[] | undefined): RGBA | undefined {
  for (const f of fills ?? []) {
    if (f.visible === false) continue;
    const o = f.opacity ?? 1;
    if (f.type === 'SOLID') return { r: f.color.r, g: f.color.g, b: f.color.b, a: o };
    if (f.type === 'GRADIENT_FREEFORM' && f.points[0]) return { ...f.points[0].color, a: f.points[0].color.a * o };
    if (f.type !== 'IMAGE' && f.type !== 'VIDEO' && f.type !== 'LOTTIE' && f.type !== 'MODEL3D' && f.type !== 'PATTERN' && f.type !== 'SHADER' && f.type !== 'GRADIENT_FREEFORM' && f.gradientStops[0]) {
      const c = f.gradientStops[0].color;
      return { r: c.r, g: c.g, b: c.b, a: c.a * o };
    }
  }
  return undefined;
}

const lineHeightOf = (lh: Props['lineHeight'], fontSize: number): number | undefined =>
  !lh || lh.unit === 'AUTO' ? undefined : lh.unit === 'PIXELS' ? lh.value / fontSize : lh.value / 100;
const letterSpacingOf = (ls: Props['letterSpacing'], fontSize: number): number => (!ls ? 0 : ls.unit === 'PIXELS' ? ls.value : (ls.value / 100) * fontSize);

/** Layout parameters from the text node's properties (with runs that have their own formatting). */
export function textLayoutOf(p: Props): SceneTextLayout {
  const characters = p.characters ?? '';
  const fontSize = p.fontSize ?? 12;
  const base = {
    fontSize,
    family: p.fontName?.family ?? 'Inter',
    style: p.fontName?.style ?? 'Regular',
    lineHeight: lineHeightOf(p.lineHeight, fontSize),
    letterSpacing: letterSpacingOf(p.letterSpacing, fontSize),
    textCase: p.textCase ?? 'ORIGINAL',
    decoration: p.textDecoration ?? 'NONE',
  };
  const runs: SceneTextRun[] = textSegments(p.textRuns, characters.length).map(({ start, end, style }) => {
    const s = effectiveStyle(p, style);
    const size = s.fontSize ?? 12;
    const run: SceneTextRun = {
      start,
      end,
      family: s.fontName?.family ?? 'Inter',
      style: s.fontName?.style ?? 'Regular',
      fontSize: size,
      letterSpacing: letterSpacingOf(s.letterSpacing, size),
      lineHeight: lineHeightOf(s.lineHeight, size),
      textCase: s.textCase ?? 'ORIGINAL',
      decoration: s.textDecoration ?? 'NONE',
    };
    if (style.fills) run.color = paintColor(style.fills) ?? { r: 0, g: 0, b: 0, a: 0 };
    if (s.textDecoration && s.textDecoration !== 'NONE') {
      if (s.textDecorationStyle && s.textDecorationStyle !== 'SOLID') run.decorationStyle = s.textDecorationStyle;
      const t = s.textDecorationThickness;
      if (t && t.unit !== 'AUTO') run.decorationThickness = t.unit === 'PIXELS' ? t.value : (t.value / 100) * size;
      if (s.textDecorationColor && s.textDecorationColor !== 'AUTO') run.decorationColor = s.textDecorationColor;
      if (s.textDecoration === 'UNDERLINE') {
        const o = s.textDecorationOffset;
        if (o && o.unit !== 'AUTO') run.decorationOffset = o.unit === 'PIXELS' ? o.value : (o.value / 100) * size;
        if (s.textDecorationSkipInk === false) run.skipInk = false;
      }
    }
    if (s.fontVariations?.length) run.variations = s.fontVariations.map((v) => ({ axis: v.axis, value: v.value }));
    if (s.openTypeFeatures && Object.keys(s.openTypeFeatures).length) run.features = s.openTypeFeatures;
    if (s.hyperlink) run.link = true;
    return run;
  });
  const out: SceneTextLayout = {
    characters,
    ...base,
    align: p.textAlignHorizontal ?? 'LEFT',
    alignV: p.textAlignVertical ?? 'TOP',
    // With min/max limits, the “fit content” width is stored in the node — layout uses it (wrapping at the max).
    autoWidth: (p.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'WIDTH_AND_HEIGHT' && p.minWidth == null && p.maxWidth == null,
    runs,
  };
  // Paragraphs: list and level — by the paragraph's first character.
  if ((p.textRuns ?? []).some((r) => r.style.listType || r.style.indentation) || (p.listType ?? 'NONE') !== 'NONE' || (p.indentation ?? 0) > 0) {
    const paragraphs: NonNullable<SceneTextLayout['paragraphs']> = [];
    let pos = 0;
    for (const line of characters.split('\n')) {
      // Empty last paragraph — by the line break before it (a new list item immediately with a marker).
      const s = effectiveStyle(p, styleAtIndex(p, pos < characters.length ? pos : Math.max(0, pos - 1)));
      paragraphs.push({ listType: s.listType ?? 'NONE', indentation: s.indentation ?? 0 });
      pos += line.length + 1;
    }
    out.paragraphs = paragraphs;
  }
  if (p.paragraphSpacing) out.paragraphSpacing = p.paragraphSpacing;
  if (p.paragraphIndent) out.paragraphIndent = p.paragraphIndent;
  if (p.listSpacing) out.listSpacing = p.listSpacing;
  if (p.maxLines != null && p.maxLines > 0) out.maxLines = p.maxLines;
  if (p.textTruncation === 'ENDING') out.ellipsis = true;
  if (p.leadingTrim === 'CAP_HEIGHT') out.leadingTrim = true;
  if (p.textWrap === 'BALANCE' || p.textWrap === 'PRETTY') out.wrap = p.textWrap;
  if (p.hangingPunctuation) out.hangingPunctuation = true;
  if (p.hangingList) out.hangingList = true;
  if (p.textFit === 'SHRINK' && (p.textAutoResize ?? 'WIDTH_AND_HEIGHT') === 'NONE') {
    const biggest = Math.max(fontSize, ...runs.map((r) => r.fontSize));
    out.fit = Math.min(1, Math.max(0.01, (p.textFitMinSize ?? 6) / biggest));
  }
  return out;
}

function styleAtIndex(p: Props, i: number) {
  let pos = 0;
  for (const r of p.textRuns ?? []) {
    if (i < pos + r.length) return r.style;
    pos += r.length;
  }
  return {};
}

/** Case — per character, without changing length (caret indices match the text). */
export function applyTextCase(s: string, c: SceneTextCase | undefined): string {
  if (c === 'UPPER') return [...s].map((ch) => sameLength(ch, ch.toLocaleUpperCase())).join('');
  if (c === 'LOWER') return [...s].map((ch) => sameLength(ch, ch.toLocaleLowerCase())).join('');
  if (c === 'TITLE') return s.replace(/(^|[\s\-–—«"(])(\p{L})/gu, (_, a: string, b: string) => a + sameLength(b, b.toLocaleUpperCase()));
  return s;
}
const sameLength = (a: string, b: string) => (b.length === a.length ? b : a);

function weightOf(ck: CanvasKit, w: number): FontWeight {
  const W = ck.FontWeight;
  if (w <= 150) return W.Thin;
  if (w <= 250) return W.ExtraLight;
  if (w <= 350) return W.Light;
  if (w <= 450) return W.Normal;
  if (w <= 550) return W.Medium;
  if (w <= 650) return W.SemiBold;
  if (w <= 750) return W.Bold;
  if (w <= 850) return W.ExtraBold;
  return W.Black;
}

/** Spec runs (the old form without runs — one run for the whole text). */
function runsOf(spec: TextSpec): SceneTextRun[] {
  if (spec.runs?.length) return spec.runs;
  return [
    {
      start: 0,
      end: spec.characters.length,
      family: spec.family,
      style: spec.style,
      fontSize: spec.fontSize,
      letterSpacing: spec.letterSpacing,
      lineHeight: spec.lineHeight,
      textCase: spec.textCase,
      decoration: spec.decoration,
    },
  ];
}

const color4 = (ck: CanvasKit, c: RGBA, alpha: number) => ck.Color4f(c.r, c.g, c.b, c.a * alpha);

/** Underline is drawn by the layout itself (SkParagraph has no offset, and it always skips descenders). */
const ownUnderline = (run: SceneTextRun) => run.decoration === 'UNDERLINE' && (run.decorationOffset !== undefined || run.skipInk === false);

function textStyle(ck: CanvasKit, run: SceneTextRun, spec: TextSpec, perRunHeight: boolean): CKTextStyle {
  const { weight, italic } = parseStyle(run.style);
  // Axes: the family's variable files; the style weight goes to the wght axis if it isn't set.
  const variable = run.variations?.length ? run.variations : null;
  const variations = variable && !variable.some((v) => v.axis === 'wght') ? [...variable, { axis: 'wght', value: weight }] : variable;
  const alpha = spec.alpha ?? 1;
  const c = spec.override ?? run.color ?? spec.color;
  const color = color4(ck, c, alpha);
  const features: { name: string; value: number }[] = [];
  for (const [tag, on] of Object.entries(run.features ?? {})) features.push({ name: tag, value: on ? 1 : 0 });
  if (run.textCase === 'SMALL_CAPS' || run.textCase === 'SMALL_CAPS_FORCED') features.push({ name: 'smcp', value: 1 });
  if (run.textCase === 'SMALL_CAPS_FORCED') features.push({ name: 'c2sc', value: 1 });
  const D = ck.DecorationStyle;
  return new ck.TextStyle({
    color,
    fontFamilies: variable ? variableStack(run.family) : fontStack(run.family),
    fontSize: run.fontSize,
    fontStyle: { weight: weightOf(ck, weight), slant: italic ? ck.FontSlant.Italic : ck.FontSlant.Upright },
    ...(variations ? { fontVariations: variations } : {}),
    letterSpacing: run.letterSpacing,
    decoration: ownUnderline(run) ? ck.NoDecoration : run.decoration === 'UNDERLINE' ? ck.UnderlineDecoration : run.decoration === 'STRIKETHROUGH' ? ck.LineThroughDecoration : ck.NoDecoration,
    decorationColor: run.decorationColor && !spec.override ? color4(ck, run.decorationColor, alpha) : color,
    decorationStyle: run.decorationStyle === 'WAVY' ? D.Wavy : run.decorationStyle === 'DOTTED' ? D.Dotted : D.Solid,
    ...(run.decorationThickness !== undefined ? { decorationThickness: Math.max(0.1, run.decorationThickness / Math.max(1, run.fontSize / 14)) } : {}),
    ...(features.length ? { fontFeatures: features } : {}),
    // Different line heights across runs: the line uses the largest (the excess split evenly above and below).
    ...(perRunHeight && run.lineHeight !== undefined ? { heightMultiplier: run.lineHeight, halfLeading: true } : {}),
  });
}

interface Block {
  p: Paragraph;
  /** Paragraph characters [start, end) in the text (without the line break). */
  start: number;
  end: number;
  x: number;
  y: number;
  /** Paragraph indices are shifted by the first-line indent placeholder. */
  shift: number;
  marker?: { p: Paragraph; x: number; y: number; text: string };
  /** Hanging punctuation: line bands (by paragraph y) and the line's x offset. */
  hang?: { top: number; bottom: number; dx: number }[];
}

/** Characters that hang past the box edge: at the line start and (with right alignment) at the end. */
const HANG_START = '"\'«‹“„‚‘([{—–-•';
const HANG_END = '.,:;!?»›”’"\')]}…—–-';

/** Text layout: SkParagraph paragraphs and geometry for editing. The caller calls delete(). */
export class TextLayout {
  readonly blocks: Block[];
  /** Content width (the longest line or the box width). */
  readonly width: number;
  readonly height: number;
  /** Upward offset for vertical trim. */
  readonly trim: number;
  /** Fraction of the font size the text is laid out at (“fit”; otherwise 1). */
  fitScale = 1;
  readonly length: number;
  private ck: CanvasKit;
  /** Underlines drawn by the layout itself (characters [start, end)). */
  private underlines: OwnUnderline[];

  constructor(ck: CanvasKit, blocks: Block[], width: number, height: number, trim: number, length: number, underlines: OwnUnderline[] = []) {
    this.ck = ck;
    this.blocks = blocks;
    this.width = width;
    this.height = height;
    this.trim = trim;
    this.length = length;
    this.underlines = underlines;
  }

  draw(canvas: Canvas, x: number, y: number) {
    for (const b of this.blocks) {
      const ox = x + b.x;
      const oy = y + b.y - this.trim;
      if (b.hang) {
        for (const l of b.hang) {
          canvas.save();
          canvas.clipRect(this.ck.LTRBRect(-1e6, oy + l.top, 1e6, oy + l.bottom), this.ck.ClipOp.Intersect, false);
          canvas.drawParagraph(b.p, ox + l.dx, oy);
          canvas.restore();
        }
      } else canvas.drawParagraph(b.p, ox, oy);
      if (b.marker) canvas.drawParagraph(b.marker.p, x + b.marker.x, y + b.marker.y - this.trim);
    }
    if (this.underlines.length) this.drawUnderlines(canvas, x, y);
  }

  /**
   * Our own underlines: the top of the line sits at an offset from the line's baseline; descenders
   * (g, p, y) are skipped with a gap unless that is turned off.
   */
  private drawUnderlines(canvas: Canvas, x: number, y: number) {
    const ck = this.ck;
    const lines = this.lines();
    const paint = new ck.Paint();
    paint.setAntiAlias(true);
    for (const u of this.underlines) {
      paint.setColor(u.color);
      for (const [x0, y0, x1, y1] of this.rects(u.start, u.end)) {
        const mid = (y0 + y1) / 2;
        const line = lines.find((l) => mid >= l.y && mid <= l.y + l.height) ?? lines[0];
        if (!line || x1 - x0 < 0.5) continue;
        const top = line.baseline + u.offset;
        // Line segments without descenders.
        let spans: [number, number][] = [[x0, x1]];
        if (u.skipInk) {
          const gap = Math.max(1, u.thickness);
          for (const [a, b] of this.inkIntervals(top, top + u.thickness)) spans = spans.flatMap(([s, e]) => (b + gap <= s || a - gap >= e ? [[s, e] as [number, number]] : ([[s, a - gap], [b + gap, e]] as [number, number][]).filter(([p, q]) => q - p > 0.5)));
        }
        for (const [s, e] of spans) this.underlineSpan(canvas, paint, u, x + s, x + e, y + top);
      }
    }
    paint.delete();
  }

  /** Underline segment [x0, x1] with its top at y: solid, dotted or wavy. */
  private underlineSpan(canvas: Canvas, paint: CKPaint, u: OwnUnderline, x0: number, x1: number, y: number) {
    const ck = this.ck;
    const t = u.thickness;
    if (u.style === 'SOLID') {
      paint.setStyle(ck.PaintStyle.Fill);
      canvas.drawRect(ck.LTRBRect(x0, y, x1, y + t), paint);
      return;
    }
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(t);
    const b = new ck.PathBuilder();
    if (u.style === 'DOTTED') {
      paint.setStrokeCap(ck.StrokeCap.Round);
      for (let cx = x0 + t / 2; cx <= x1 - t / 2 + 0.01; cx += t * 2) {
        b.moveTo(cx, y + t / 2);
        b.lineTo(cx, y + t / 2);
      }
    } else {
      // Wave: half-waves as quadratic curves, amplitude — one and a half thicknesses.
      paint.setStrokeCap(ck.StrokeCap.Butt);
      const half = Math.max(2, t * 3);
      const amp = t * 1.5;
      const cy = y + amp;
      b.moveTo(x0, cy);
      for (let px = x0, k = 0; px < x1; px += half, k++) b.quadTo(px + half / 2, cy + (k % 2 ? amp : -amp) * 2, Math.min(x1, px + half), cy);
    }
    const path = b.detachAndDelete();
    canvas.drawPath(path, paint);
    path.delete();
    paint.setStrokeCap(ck.StrokeCap.Butt);
  }

  /** Where glyphs cross the band [top, bottom] (layout coordinates): x segments. */
  private inkIntervals(top: number, bottom: number): [number, number][] {
    const out: [number, number][] = [];
    for (const b of this.blocks) {
      const oy = b.y - this.trim;
      for (const line of b.p.getShapedLines()) {
        if (line.top + oy > bottom || line.bottom + oy < top) continue;
        for (const run of line.runs) {
          const n = run.glyphs.length;
          if (!n) continue;
          const font = new this.ck.Font(run.typeface, run.size);
          const hits = font.getGlyphIntercepts(run.glyphs, run.positions.subarray(0, n * 2), top - oy, bottom - oy);
          font.delete();
          for (let i = 0; i + 1 < hits.length; i += 2) out.push([b.x + hits[i]!, b.x + hits[i + 1]!]);
        }
      }
    }
    return out;
  }

  /** Offset of a line with a hanging character: y — from the top of the paragraph. */
  private dxAt(b: Block, y: number): number {
    if (!b.hang) return 0;
    return b.hang.find((l) => y >= l.top && y < l.bottom)?.dx ?? 0;
  }

  /** Lines (characters — text indices), in text box coordinates. */
  lines(): TextLine[] {
    const out: TextLine[] = [];
    for (const b of this.blocks) {
      for (const m of b.p.getLineMetrics()) {
        const map = (i: number) => Math.max(b.start, Math.min(b.end, b.start + i - b.shift));
        out.push({
          start: map(m.startIndex),
          end: map(m.endIndex),
          endText: map(m.endExcludingWhitespaces),
          x: b.x + m.left + this.dxAt(b, m.baseline),
          y: b.y + m.baseline - m.ascent - this.trim,
          width: m.width,
          height: m.height,
          baseline: b.y + m.baseline - this.trim,
        });
      }
    }
    return out;
  }

  private blockOf(i: number): Block {
    for (const b of this.blocks) if (i <= b.end) return b;
    return this.blocks[this.blocks.length - 1]!;
  }

  /** Caret before character i: x, top and line height (at a soft wrap — at the start of the next line). */
  caret(i: number): { x: number; y: number; height: number } {
    const b = this.blockOf(i);
    const local = Math.max(0, Math.min(b.end, i) - b.start) + b.shift;
    const len = b.end - b.start + b.shift;
    const R = this.ck.RectHeightStyle.Max;
    const W = this.ck.RectWidthStyle.Tight;
    const lines = b.p.getLineMetrics();
    const lineOf = (y: number) => lines.find((m) => y < m.baseline + m.descent + 0.5) ?? lines[lines.length - 1];
    if (local < len) {
      const r = b.p.getRectsForRange(local, local + 1, R, W)[0];
      if (r) return { x: b.x + r.rect[0]! + this.dxAt(b, (r.rect[1]! + r.rect[3]!) / 2), y: b.y + r.rect[1]! - this.trim, height: r.rect[3]! - r.rect[1]! };
    }
    if (local > 0 && len > b.shift) {
      const r = b.p.getRectsForRange(local - 1, local, R, W)[0];
      if (r) return { x: b.x + r.rect[2]! + this.dxAt(b, (r.rect[1]! + r.rect[3]!) / 2), y: b.y + r.rect[1]! - this.trim, height: r.rect[3]! - r.rect[1]! };
    }
    // Empty paragraph: line start taking alignment into account.
    const m = lineOf(0);
    return { x: b.x + (m?.left ?? 0), y: b.y + (m ? m.baseline - m.ascent : 0) - this.trim, height: m?.height ?? 0 };
  }

  /** Selection rectangles [start, end) — per line. */
  rects(start: number, end: number): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    if (end <= start) return out;
    for (const b of this.blocks) {
      if (b.end < start || b.start > end) continue;
      const a = Math.max(start, b.start) - b.start + b.shift;
      const z = Math.min(end, b.end) - b.start + b.shift;
      if (z > a) {
        for (const r of b.p.getRectsForRange(a, z, this.ck.RectHeightStyle.Max, this.ck.RectWidthStyle.Tight)) {
          const dx = this.dxAt(b, (r.rect[1]! + r.rect[3]!) / 2);
          out.push([b.x + r.rect[0]! + dx, b.y + r.rect[1]! - this.trim, b.x + r.rect[2]! + dx, b.y + r.rect[3]! - this.trim]);
        }
      }
      // The line break after a paragraph is selected — a bar at the end of its last line.
      if (end > b.end && start <= b.end && b !== this.blocks[this.blocks.length - 1]) {
        const c = this.caret(b.end);
        out.push([c.x, c.y, c.x + Math.max(3, c.height / 4), c.y + c.height]);
      }
    }
    return out;
  }

  /** Character under point (x, y) of the text box: caret position 0…length. */
  indexAt(x: number, y: number): number {
    let b = this.blocks[0]!;
    for (const blk of this.blocks) {
      if (y + this.trim >= blk.y) b = blk;
    }
    const ly = y + this.trim - b.y;
    const pos = b.p.getGlyphPositionAtCoordinate(x - b.x - this.dxAt(b, ly), ly).pos - b.shift;
    return Math.max(b.start, Math.min(b.end, b.start + pos));
  }

  /** List markers and numbers: text, x and baseline (for export). */
  markers(): { text: string; x: number; baseline: number; start: number }[] {
    const out: { text: string; x: number; baseline: number; start: number }[] = [];
    for (const b of this.blocks) {
      if (!b.marker) continue;
      const m = b.marker.p.getLineMetrics()[0];
      out.push({ text: b.marker.text, x: b.marker.x, baseline: b.marker.y + (m?.baseline ?? 0) - this.trim, start: b.start });
    }
    return out;
  }

  /** Word around character i: [start, end). */
  wordAt(i: number): [number, number] {
    const b = this.blockOf(i);
    const local = Math.max(0, Math.min(b.end, i) - b.start) + b.shift;
    const w = b.p.getWordBoundary(local);
    return [Math.max(b.start, b.start + w.start - b.shift), Math.min(b.end, b.start + w.end - b.shift)];
  }

  /** Paragraph around character i: [start, end) without the line break. */
  paragraphAt(i: number): [number, number] {
    const b = this.blockOf(i);
    return [b.start, b.end];
  }

  delete() {
    for (const b of this.blocks) {
      b.p.delete();
      b.marker?.p.delete();
    }
    this.blocks.length = 0;
  }
}

const BULLETS = ['•', '◦', '▪'];
const toLetters = (n: number) => {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return s;
};
const toRoman = (n: number) => {
  const map: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let s = '';
  for (const [v, r] of map) while (n >= v) (s += r), (n -= v);
  return s;
};
/** Numbering by level: 1. → a. → i. */
const ordinal = (n: number, level: number) => (level % 3 === 0 ? `${n}.` : level % 3 === 1 ? `${toLetters(n)}.` : `${toRoman(n)}.`);

/** Underline drawn by the layout: characters [start, end), top of the line — offset from the baseline. */
interface OwnUnderline {
  start: number;
  end: number;
  offset: number;
  thickness: number;
  color: Float32Array;
  style: 'SOLID' | 'WAVY' | 'DOTTED';
  skipInk: boolean;
}

/**
 * Text layout from a spec. With fit (our own) — if the text doesn't fit the box height, the font size
 * is reduced (by bisection, 8 steps) to the largest at which it fits, but not
 * below the fit fraction.
 */
export function layoutText(ck: CanvasKit, fonts: FontLibrary, spec: TextSpec): TextLayout {
  const full = layoutOnce(ck, fonts, spec);
  if (!spec.fit || spec.width === undefined || spec.height === undefined) return full;
  const box = spec.height + 0.5;
  if (full.height <= box) return full;
  full.delete();
  let lo = spec.fit;
  let hi = 1;
  let best: TextLayout | null = null;
  for (let i = 0; i < 8; i++) {
    const k = (lo + hi) / 2;
    const l = layoutOnce(ck, fonts, scaledSpec(spec, k));
    if (l.height <= box) {
      best?.delete();
      best = l;
      l.fitScale = k;
      lo = k;
    } else {
      l.delete();
      hi = k;
    }
  }
  if (best) return best;
  const floor = layoutOnce(ck, fonts, scaledSpec(spec, spec.fit));
  floor.fitScale = spec.fit;
  return floor;
}

/** The same text at fraction k of the font size: font sizes, letter spacing, paragraph and list indents. */
export function scaledSpec(spec: TextSpec, k: number): TextSpec {
  const out: TextSpec = { ...spec, fit: undefined, fontSize: spec.fontSize * k, letterSpacing: spec.letterSpacing * k };
  if (spec.runs) out.runs = spec.runs.map((r) => ({ ...r, fontSize: r.fontSize * k, letterSpacing: r.letterSpacing * k, ...(r.decorationThickness !== undefined ? { decorationThickness: r.decorationThickness * k } : {}), ...(r.decorationOffset !== undefined ? { decorationOffset: r.decorationOffset * k } : {}) }));
  if (spec.paragraphSpacing) out.paragraphSpacing = spec.paragraphSpacing * k;
  if (spec.paragraphIndent) out.paragraphIndent = spec.paragraphIndent * k;
  if (spec.listSpacing) out.listSpacing = spec.listSpacing * k;
  return out;
}

function layoutOnce(ck: CanvasKit, fonts: FontLibrary, spec: TextSpec): TextLayout {
  const text = spec.characters;
  const runs = runsOf(spec);
  // Text with axes needs variable files (once loaded — onLoad, the text is re-laid out).
  for (const r of runs) if (r.variations?.length) fonts.ensureVariable({ family: r.family, style: r.style });
  // The same line height (in pixels) for all runs — a single line “strut”.
  const heights = runs.map((r) => (r.lineHeight === undefined ? -1 : r.lineHeight * r.fontSize));
  const uniform = heights.every((h) => h === heights[0]) && heights[0]! >= 0;
  const align = { LEFT: ck.TextAlign.Left, CENTER: ck.TextAlign.Center, RIGHT: ck.TextAlign.Right, JUSTIFIED: ck.TextAlign.Justify }[spec.align];
  const first = runs[0]!;

  /** Paragraph [start, end) of the text: runs with their own formatting, width width. */
  const build = (start: number, end: number, width: number | undefined, opts: { maxLines?: number; indent?: number } = {}) => {
    const { weight, italic } = parseStyle(first.style);
    const strut =
      uniform && first.lineHeight !== undefined
        ? {
            strutEnabled: true,
            forceStrutHeight: true,
            fontFamilies: fontStack(first.family),
            fontStyle: { weight: weightOf(ck, weight), slant: italic ? ck.FontSlant.Italic : ck.FontSlant.Upright },
            fontSize: first.fontSize,
            heightMultiplier: first.lineHeight,
            halfLeading: true,
          }
        : undefined;
    const head = runs.find((r) => r.end > start) ?? first;
    const style = new ck.ParagraphStyle({
      textAlign: align,
      textStyle: { color: color4(ck, spec.override ?? head.color ?? spec.color, spec.alpha ?? 1), fontFamilies: fontStack(head.family), fontSize: head.fontSize },
      strutStyle: strut,
      ...(opts.maxLines ? { maxLines: opts.maxLines, ...(spec.ellipsis ? { ellipsis: '…' } : {}) } : {}),
    });
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(style, fonts.provider);
    let shift = 0;
    if (opts.indent) {
      // First-line indent — empty space at the start of the paragraph (shifts indices by one character).
      builder.pushStyle(textStyle(ck, head, spec, !uniform));
      builder.addPlaceholder(opts.indent, 0.01, ck.PlaceholderAlignment.Baseline, ck.TextBaseline.Alphabetic, 0);
      builder.pop();
      shift = 1;
    }
    let any = false;
    for (const r of runs) {
      const a = Math.max(start, r.start);
      const b = Math.min(end, r.end);
      if (b <= a) continue;
      builder.pushStyle(textStyle(ck, r, spec, !uniform));
      builder.addText(applyTextCase(text.slice(a, b), r.textCase));
      builder.pop();
      any = true;
    }
    if (!any) {
      // An empty paragraph still takes a line (for the caret) — with the formatting of the run at its position.
      builder.pushStyle(textStyle(ck, runs.find((r) => r.end >= start) ?? head, spec, !uniform));
      builder.addText('​');
      builder.pop();
    }
    const p = builder.build();
    builder.delete();
    p.layout(width ?? 1e6);
    if (width === undefined) p.layout(Math.ceil(p.getMaxIntrinsicWidth()) + 1);
    return { p, shift };
  };

  const listUsed = spec.paragraphs?.some((p) => p.listType !== 'NONE' || p.indentation > 0) ?? false;
  const multi = listUsed || !!spec.paragraphSpacing || !!spec.paragraphIndent || !!spec.wrap;
  const blocks: Block[] = [];
  // No more lines than: the given number, or as many as fit in a fixed-height box (with “…”).
  let limit = spec.maxLines;
  if (!multi) {
    let lay = build(0, text.length, spec.width, { maxLines: limit });
    if (spec.ellipsis && spec.height !== undefined && !limit) {
      const fit = lay.p.getLineMetrics().filter((m) => m.baseline + m.descent <= spec.height! + 0.5).length;
      if (fit < lay.p.getLineMetrics().length) {
        lay.p.delete();
        lay = build(0, text.length, spec.width, { maxLines: Math.max(1, fit) });
      }
    }
    blocks.push({ p: lay.p, start: 0, end: text.length, x: 0, y: 0, shift: lay.shift });
  } else {
    const W = spec.width;
    let y = 0;
    let pos = 0;
    let lines = 0;
    const counters: number[] = [];
    const paras = text.split('\n');
    for (let i = 0; i < paras.length; i++) {
      const start = pos;
      const end = pos + paras[i]!.length;
      pos = end + 1;
      const info = spec.paragraphs?.[i] ?? { listType: 'NONE' as const, indentation: 0 };
      const list = info.listType !== 'NONE';
      // Level indent step — based on the paragraph's font size.
      const step = Math.round((runs.find((r) => r.end > start) ?? first).fontSize * 1.6);
      // Hanging markers: the item text is at the level's edge, the marker in the margin to the left (past the box edge).
      const x = (list && !spec.hangingList ? info.indentation + 1 : info.indentation) * step;
      const width = W === undefined ? undefined : Math.max(1, W - x);
      const left = limit !== undefined ? limit - lines : undefined;
      if (left !== undefined && left <= 0) break;
      let lay = build(start, end, width, { maxLines: left, indent: list ? 0 : spec.paragraphIndent });
      // Balance wrapping: the narrowest width with the same number of lines; Pretty — no lone word at the end.
      if (spec.wrap && width !== undefined && lay.p.getLineMetrics().length > 1) {
        const count = lay.p.getLineMetrics().length;
        const lastWords = (p: Paragraph) => {
          const m = p.getLineMetrics();
          const l = m[m.length - 1]!;
          return applyTextCase(text.slice(start, end), 'ORIGINAL').slice(l.startIndex - lay.shift, l.endExcludingWhitespaces - lay.shift).trim().split(/\s+/).length;
        };
        if (spec.wrap === 'BALANCE' || lastWords(lay.p) < 2) {
          let lo = width * 0.5;
          let hi = width;
          let best = width;
          for (let k = 0; k < 10; k++) {
            const mid = (lo + hi) / 2;
            lay.p.layout(mid);
            const ok = lay.p.getLineMetrics().length === count && (spec.wrap === 'BALANCE' || lastWords(lay.p) >= 2);
            if (ok) (best = mid), (hi = mid);
            else lo = mid;
          }
          lay.p.layout(best);
          // Alignment — across the full box width: a narrow paragraph is shifted.
          const shiftX = spec.align === 'CENTER' ? (width - best) / 2 : spec.align === 'RIGHT' ? width - best : 0;
          blocks.push({ p: lay.p, start, end, x: x + shiftX, y, shift: lay.shift });
        } else blocks.push({ p: lay.p, start, end, x, y, shift: lay.shift });
      } else blocks.push({ p: lay.p, start, end, x, y, shift: lay.shift });
      const block = blocks[blocks.length - 1]!;
      // List marker or number — right-aligned in the indent margin, on the first line's baseline.
      if (list) {
        for (let l = counters.length; l <= info.indentation; l++) counters[l] = 0;
        counters.length = info.indentation + 1;
        counters[info.indentation] = (counters[info.indentation] ?? 0) + 1;
        const label = info.listType === 'UNORDERED' ? BULLETS[info.indentation % BULLETS.length]! : ordinal(counters[info.indentation]!, info.indentation);
        const head = runs.find((r) => r.end > start) ?? first;
        const mb = ck.ParagraphBuilder.MakeFromFontProvider(new ck.ParagraphStyle({ textAlign: ck.TextAlign.Left, textStyle: { color: ck.BLACK } }), fonts.provider);
        mb.pushStyle(textStyle(ck, { ...head, decoration: 'NONE', textCase: 'ORIGINAL' }, spec, false));
        mb.addText(label);
        mb.pop();
        const mp = mb.build();
        mb.delete();
        mp.layout(1e6);
        mp.layout(Math.ceil(mp.getMaxIntrinsicWidth()) + 1);
        const firstLine = lay.p.getLineMetrics()[0];
        const markerLine = mp.getLineMetrics()[0];
        const gap = head.fontSize * 0.4;
        block.marker = {
          p: mp,
          x: x - gap - mp.getMaxIntrinsicWidth(),
          y: y + (firstLine?.baseline ?? 0) - (markerLine?.baseline ?? 0),
          text: label,
        };
      } else counters.length = 0;
      lines += lay.p.getLineMetrics().length;
      y += lay.p.getHeight();
      const next = spec.paragraphs?.[i + 1];
      if (i < paras.length - 1) y += list && next && next.listType !== 'NONE' ? (spec.listSpacing ?? 0) : (spec.paragraphSpacing ?? 0);
    }
  }
  let width = 0;
  let bottom = 0;
  for (const b of blocks) {
    width = Math.max(width, b.x + (spec.width === undefined ? b.p.getMaxIntrinsicWidth() : b.p.getMaxWidth()));
    bottom = Math.max(bottom, b.y + b.p.getHeight());
  }
  if (spec.width !== undefined) width = spec.width;
  // Vertical trim: top — the first line's cap height, bottom — the last line's baseline.
  let trim = 0;
  if (spec.leadingTrim && blocks.length) {
    const firstLine = blocks[0]!.p.getLineMetrics()[0];
    const lastBlock = blocks[blocks.length - 1]!;
    const lm = lastBlock.p.getLineMetrics();
    const lastLine = lm[lm.length - 1];
    if (firstLine && lastLine) {
      const cap = fonts.capHeight({ family: first.family, style: first.style }) * first.fontSize;
      trim = blocks[0]!.y + firstLine.baseline - cap;
      bottom = lastBlock.y + lastLine.baseline;
    }
  }
  if (spec.hangingPunctuation) hangPunctuation(ck, blocks, text, spec.align);
  const underlines: OwnUnderline[] = runs.filter(ownUnderline).map((r) => {
    const alpha = spec.alpha ?? 1;
    const c = spec.override ?? r.color ?? spec.color;
    return {
      start: r.start,
      end: r.end,
      offset: r.decorationOffset ?? r.fontSize * 0.1,
      thickness: Math.max(0.5, r.decorationThickness ?? r.fontSize / 14),
      color: r.decorationColor && !spec.override ? color4(ck, r.decorationColor, alpha) : color4(ck, c, alpha),
      style: r.decorationStyle ?? 'SOLID',
      skipInk: r.skipInk !== false,
    };
  });
  return new TextLayout(ck, blocks, width, Math.max(0, bottom - trim), trim, text.length, underlines);
}

/**
 * Hanging punctuation: a line that starts with a quote, bracket or dash (with right
 * alignment — ends with a period, comma or quote) is shifted by the character's width — the character
 * sits past the box edge. Line bands extend to the middle of the gap to neighbors (first and last — unbounded).
 */
function hangPunctuation(ck: CanvasKit, blocks: Block[], text: string, align: TextSpec['align']) {
  const R = ck.RectHeightStyle.Tight;
  const W = ck.RectWidthStyle.Tight;
  for (const b of blocks) {
    const metrics = b.p.getLineMetrics();
    const hang: NonNullable<Block['hang']> = [];
    metrics.forEach((m, k) => {
      const prev = metrics[k - 1];
      const next = metrics[k + 1];
      const top = prev ? (prev.baseline + prev.descent + m.baseline - m.ascent) / 2 : -1e6;
      const bottom = next ? (m.baseline + m.descent + next.baseline - next.ascent) / 2 : 1e6;
      let dx = 0;
      const width = (i: number) => {
        const r = b.p.getRectsForRange(i, i + 1, R, W)[0];
        return r ? r.rect[2]! - r.rect[0]! : 0;
      };
      if (align === 'RIGHT') {
        const i = m.endExcludingWhitespaces - 1;
        if (i - b.shift >= 0 && HANG_END.includes(text[b.start + i - b.shift] ?? '')) dx = width(i);
      } else if (align !== 'CENTER') {
        const i = m.startIndex;
        if (i - b.shift >= 0 && HANG_START.includes(text[b.start + i - b.shift] ?? '')) dx = -width(i);
      }
      hang.push({ top, bottom, dx });
    });
    if (hang.some((l) => l.dx)) b.hang = hang;
  }
}

/** Text box size (for auto width and auto height). */
export function measureText(ck: CanvasKit, fonts: FontLibrary, spec: TextSpec): { width: number; height: number } {
  const t = layoutText(ck, fonts, spec);
  const size = { width: spec.width ?? Math.ceil(t.width), height: spec.leadingTrim ? Math.round(t.height) : Math.ceil(t.height) };
  t.delete();
  return size;
}

/** Fonts needed by the text (all runs). */
export function textFonts(p: Props): { family: string; style: string }[] {
  const seen = new Map<string, { family: string; style: string }>();
  const add = (f: Props['fontName']) => f && seen.set(`${f.family}|${f.style}`, f);
  add(p.fontName ?? { family: 'Inter', style: 'Regular' });
  for (const r of p.textRuns ?? []) add(r.style.fontName);
  return [...seen.values()];
}

/** Value within min/max (min takes precedence). */
const limitTo = (v: number, min?: number | null, max?: number | null) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v));

/**
 * Fit the text box size to its content (per textAutoResize mode).
 * Center- or right-aligned text with auto width grows in both directions or to the left.
 * Returns the changes (or null) — the caller applies them.
 */
export function fitTextProps(ck: CanvasKit, fonts: FontLibrary, doc: Document, id: string): Props | null {
  if (doc.type(id) !== 'TEXT') return null;
  const p = doc.props(id);
  // Ready imported glyphs and text on a path (bounds follow the path) don't resize to the text.
  if (p.textGlyphs || p.textPath) return null;
  const mode = p.textAutoResize ?? 'WIDTH_AND_HEIGHT';
  if (mode === 'NONE') return null;
  const layout = textLayoutOf(p);
  const auto = mode === 'WIDTH_AND_HEIGHT';
  const width = p.width ?? 0;
  const measure = (w?: number) => measureText(ck, fonts, { ...layout, color: SOLID_BLACK, width: w });
  let size = measure(auto ? undefined : Math.max(1, width));
  // min/max limits: if the “fit content” width exceeds the max, the text wraps at the max.
  const maxW = p.maxWidth ?? Infinity;
  if (auto && size.width > maxW) size = { ...measure(Math.max(1, maxW)), width: maxW };
  const height = limitTo(size.height, p.minHeight, p.maxHeight);
  if (!auto) return height === p.height ? null : { height };
  const w = Math.max(1, limitTo(size.width, p.minWidth, p.maxWidth));
  if (w === width && height === p.height) return null;
  const out: Props = { width: w, height };
  const shift = layout.align === 'CENTER' ? (w - width) / 2 : layout.align === 'RIGHT' ? w - width : 0;
  if (shift && width > 1) {
    const t = p.transform ?? [1, 0, 0, 0, 1, 0];
    out.transform = [t[0], t[1], t[2] - t[0] * shift, t[3], t[4], t[5] - t[3] * shift];
  }
  return out;
}
