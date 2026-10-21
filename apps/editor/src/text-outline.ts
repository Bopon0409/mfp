// Text outlines for export (PDF, SVG “text as outlines”).
// Text from .fig has ready-made glyphs (the renderer returns their outlines). Own text uses the same
// SkParagraph layout as the canvas (glyph ids and positions), and glyph outlines come from font files
// (opentype.js). The layout doesn't say which file shaped a glyph: we take the one whose glyph id
// matches the character map (Latin and Cyrillic in catalog fonts are separate files).

import * as ot from 'opentype.js';
import type { CanvasKit } from 'canvaskit-wasm';
import { applyTextCase, layoutText, PathTextMap, type FontLibrary, type SceneRenderer } from '@mfp/renderer';
import type { FigPaint, SceneNode, SceneTextRun } from '@mfp/io-figma';

const parseFont: (b: ArrayBuffer) => ot.Font = (ot as unknown as { parse?: (b: ArrayBuffer) => ot.Font }).parse ?? (ot as unknown as { default: { parse: (b: ArrayBuffer) => ot.Font } }).default.parse;
const parsed = new WeakMap<ArrayBuffer, ot.Font | null>();

function fontOf(data: ArrayBuffer): ot.Font | null {
  if (parsed.has(data)) return parsed.get(data)!;
  let f: ot.Font | null = null;
  try {
    f = parseFont(data);
  } catch {
    f = null; // WOFF2 and anything else opentype.js can't read
  }
  parsed.set(data, f);
  return f;
}

/** The file that shaped glyph gid of character ch (first — a match in the character map). */
function pickFont(files: ArrayBuffer[], ch: string, gid: number): ot.Font | null {
  let fallback: ot.Font | null = null;
  for (const data of files) {
    const f = fontOf(data);
    if (!f || gid >= f.numGlyphs) continue;
    if (f.charToGlyphIndex(ch) === gid) return f;
    fallback ??= f;
  }
  return fallback;
}

const n3 = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * Glyph offsets from getShapedLines are in UTF-8 bytes; a JS string is UTF-16. Converts an offset
 * to a string index (Cyrillic — 2 bytes per character, dash — 3).
 */
export function utf8Index(text: string): (byte: number) => number {
  const map: number[] = [];
  let byte = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const bytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    for (let k = 0; k < bytes; k++) map[byte + k] = i;
    byte += bytes;
    i += cp > 0xffff ? 2 : 1;
  }
  map[byte] = text.length;
  return (b) => map[b] ?? text.length;
}

function svgOf(cmds: ot.PathCommand[]): string {
  let d = '';
  for (const c of cmds) {
    if (c.type === 'M') d += `M${n3(c.x!)} ${n3(c.y!)}`;
    else if (c.type === 'L') d += `L${n3(c.x!)} ${n3(c.y!)}`;
    else if (c.type === 'Q') d += `Q${n3(c.x1!)} ${n3(c.y1!)} ${n3(c.x!)} ${n3(c.y!)}`;
    else if (c.type === 'C') d += `C${n3(c.x1!)} ${n3(c.y1!)} ${n3(c.x2!)} ${n3(c.y2!)} ${n3(c.x!)} ${n3(c.y!)}`;
    else d += 'Z';
  }
  return d;
}

export interface OutlineRun {
  fills: FigPaint[] | undefined;
  /** SVG path in node coordinates. */
  d: string;
}

/**
 * Node text outlines, by runs with the same fill. null — some glyphs weren't found
 * in the font files (then export draws the text as an image or <text>).
 */
export function textOutlines(ck: CanvasKit, renderer: SceneRenderer, fonts: FontLibrary, n: SceneNode): OutlineRun[] | null {
  if (n.type !== 'TEXT') return [];
  if (n.glyphs?.length) return renderer.textRunsSvg(n);
  const t = n.textLayout;
  if (!t) return [];
  const runs: SceneTextRun[] = t.runs?.length
    ? t.runs
    : [{ start: 0, end: t.characters.length, family: t.family, style: t.style, fontSize: t.fontSize, letterSpacing: t.letterSpacing, lineHeight: t.lineHeight, textCase: t.textCase, decoration: t.decoration }];
  // opentype.js doesn't apply variable font axes — export draws such text as an image or <text>.
  if (runs.some((r) => r.variations?.length)) return null;
  const runAt = (i: number) => runs.find((r) => i >= r.start && i < r.end) ?? runs[runs.length - 1]!;
  const baseFill = n.fills;
  const fillsOf = (r: SceneTextRun): FigPaint[] => (r.color ? [{ type: 'SOLID', color: r.color, opacity: 1, visible: true } as FigPaint] : baseFill);
  // Text on a path — a single line, glyphs are placed on the path (as on the canvas).
  const onPath = !!n.textPath;
  const layout = layoutText(ck, fonts, { ...t, color: { r: 0, g: 0, b: 0, a: 1 }, width: t.autoWidth || onPath ? undefined : n.size.x, height: t.autoWidth || onPath ? undefined : n.size.y });
  const tp = n.textPath;
  const map = tp ? new PathTextMap(ck, tp.data, tp.offset, layout.width, t.align, layout.lines()[0]?.baseline ?? 0, tp.sx, tp.sy) : null;
  const groups = new Map<string, OutlineRun>();
  const add = (fills: FigPaint[], d: string) => {
    const key = JSON.stringify(fills);
    const g = groups.get(key);
    if (g) g.d += d;
    else groups.set(key, { fills, d });
  };
  let missing = 0;
  try {
    const y0 = onPath || t.alignV === 'TOP' ? 0 : (n.size.y - layout.height) * (t.alignV === 'CENTER' ? 0.5 : 1);
    for (const b of layout.blocks) {
      // Paragraph text — as layoutText assembled it: an indent placeholder and runs in their own case.
      const ptext =
        (b.shift ? '￼' : '') +
        runs
          .map((r) => {
            const a = Math.max(b.start, r.start);
            const z = Math.min(b.end, r.end);
            return z > a ? applyTextCase(t.characters.slice(a, z), r.textCase) : '';
          })
          .join('');
      const paragraphs: { p: typeof b.p; x: number; y: number; text: string; run?: SceneTextRun }[] = [{ p: b.p, x: b.x, y: b.y, text: ptext }];
      if (b.marker) paragraphs.push({ p: b.marker.p, x: b.marker.x, y: b.marker.y, text: '', run: runAt(b.start) });
      for (const para of paragraphs) {
        const index = utf8Index(para.text);
        for (const line of para.p.getShapedLines()) {
          for (const run of line.runs) {
            for (let k = 0; k < run.glyphs.length; k++) {
              const gid = run.glyphs[k]!;
              const off = index(run.offsets[k]!);
              const r = para.run ?? runAt(b.start + off - b.shift);
              const cp = para.text.codePointAt(off);
              const ch = cp === undefined ? ' ' : String.fromCodePoint(cp);
              const f = pickFont(fonts.fontFiles(r.family, r.style), ch, gid);
              if (!f) {
                if (gid !== 0 && ch.trim()) missing++;
                continue;
              }
              const x = run.positions[k * 2]! + para.x;
              const y = run.positions[k * 2 + 1]! + para.y - layout.trim + y0;
              const glyph = f.glyphs.get(gid);
              if (map?.ok) {
                // Glyph on a path: rotated around its baseline midpoint, along the tangent.
                const adv = run.positions[(k + 1) * 2]! - x + para.x;
                const [px, py, angle] = map.toLocal(x + adv / 2, y);
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                const at = (gx: number, gy: number): [number, number] => [px + cos * (gx - adv / 2) - sin * gy, py + sin * (gx - adv / 2) + cos * gy];
                const cmds = glyph.getPath(0, 0, run.size).commands.map((c) => {
                  const o = { ...c } as Record<string, number | string>;
                  for (const [kx, ky] of [['x', 'y'], ['x1', 'y1'], ['x2', 'y2']] as const) {
                    if (typeof o[kx] !== 'number') continue;
                    const [tx, ty] = at(o[kx] as number, o[ky] as number);
                    o[kx] = tx;
                    o[ky] = ty;
                  }
                  return o as unknown as typeof c;
                });
                const d = svgOf(cmds);
                if (d) add(fillsOf(r), d);
                continue;
              }
              const d = svgOf(glyph.getPath(x, y, run.size).commands);
              if (d) add(fillsOf(r), d);
            }
            // Underline and strikethrough — rectangles from font metrics (not for text on a path).
            const first = run.offsets.length ? para.run ?? runAt(b.start + index(run.offsets[0]!) - b.shift) : null;
            if (first && first.decoration !== 'NONE' && run.glyphs.length && !map) {
              const f = pickFont(fonts.fontFiles(first.family, first.style), 'a', 0) ?? null;
              const upm = f?.unitsPerEm ?? 1000;
              const k = run.size / upm;
              const under = first.decoration === 'UNDERLINE';
              const thick = first.decorationThickness ?? (under ? f?.tables.post?.underlineThickness ?? 60 : f?.tables.os2?.yStrikeoutSize ?? 60) * k;
              // Line middle from the baseline; own underline offset — to the top of the line.
              const pos = under ? (first.decorationOffset !== undefined ? first.decorationOffset + thick / 2 : -(f?.tables.post?.underlinePosition ?? -100) * k) : -(f?.tables.os2?.yStrikeoutPosition ?? 300) * k;
              const x0 = run.positions[0]! + para.x;
              const x1 = run.positions[run.glyphs.length * 2]! + para.x;
              const yb = run.positions[1]! + para.y - layout.trim + y0 + pos;
              add(first.decorationColor ? [{ type: 'SOLID', color: first.decorationColor, opacity: 1, visible: true } as FigPaint] : fillsOf(first), `M${n3(x0)} ${n3(yb - thick / 2)}H${n3(x1)}V${n3(yb + thick / 2)}H${n3(x0)}Z`);
            }
          }
        }
      }
    }
  } finally {
    layout.delete();
    map?.delete();
  }
  return missing ? null : [...groups.values()];
}
