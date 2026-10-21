// Declarations for opentype.js 2 (the package has no types) — only what text-outline.ts uses.
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'C' | 'Q' | 'Z';
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export interface OtPath {
    commands: PathCommand[];
  }
  export interface Glyph {
    index: number;
    getPath(x: number, y: number, fontSize: number): OtPath;
  }
  export interface Font {
    numGlyphs: number;
    unitsPerEm: number;
    glyphs: { get(index: number): Glyph };
    charToGlyphIndex(s: string): number;
    tables: {
      post?: { underlinePosition?: number; underlineThickness?: number };
      os2?: { yStrikeoutPosition?: number; yStrikeoutSize?: number };
    };
  }
  export function parse(buffer: ArrayBuffer): Font;
  const opentype: { parse(buffer: ArrayBuffer): Font };
  export default opentype;
}
