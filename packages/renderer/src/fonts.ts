// Fonts for text laid out by the editor itself (new or modified).
// Text imported from Figma is drawn with ready-made glyphs and needs no fonts.
//
// Source — Fontsource (Google Fonts and other fonts, OFL) via jsDelivr, TTF format.
// We load Latin and Cyrillic. Layout takes a single file from a family and does not look for
// glyphs in sibling files, so each subset is registered under its own alias, and the text style
// specifies the whole chain (fontStack) — fallback follows it.
//
// Custom fonts: from the user's computer (Local Font Access API — no installer) and from
// .ttf/.otf files. Such a file contains all glyphs, so it is registered under the family name.
//
// Variable fonts: for text with axes (fontVariations) layout uses the family's variable files —
// from the catalog (Fontsource, WOFF2) under their own aliases; a custom file with an fvar table
// is variable by itself.
//
// Bundle (useBundled): fonts shipped with the app or the company server — a folder with the same
// layout as Fontsource (<id>@latest/<subset>-<weight>-<style>.ttf), plus catalog.json with
// weights. The bundle comes before the network; offline — only custom fonts and the bundle, with
// the nearest weight.

import type { CanvasKit, TypefaceFontProvider } from 'canvaskit-wasm';
import { fontAxes, fontMetrics, fontNames, isWoff2, styleFromFileName, type FontAxis } from './font-names.ts';

export interface FontRef {
  family: string;
  style: string;
}

const SUBSETS = ['latin', 'cyrillic', 'latin-ext'];
const WEIGHTS: Record<string, number> = {
  thin: 100,
  extralight: 200,
  'extra light': 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  'semi bold': 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  'extra bold': 800,
  heavy: 800,
  black: 900,
};

/** Weight and style from a Figma style name (“Semi Bold Italic” → 600, italic). */
export function parseStyle(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase();
  const italic = s.includes('italic') || s.includes('oblique');
  const base = s.replace(/italic|oblique/g, '').trim() || 'regular';
  return { weight: WEIGHTS[base] ?? WEIGHTS[base.replace(/\s+/g, '')] ?? 400, italic };
}

export const DEFAULT_FAMILY = 'Inter';

/** A font from the computer or a file: bytes are read only when the font is needed. */
export interface LocalFace {
  family: string;
  style: string;
  data(): Promise<ArrayBuffer>;
}

/** Name under which a family subset is registered (Latin — under the family's own name). */
function alias(family: string, subset: string) {
  return subset === 'latin' ? family : `${family} [${subset}]`;
}

/** Family chain for layout: all subsets of the font, then the default font. */
export function fontStack(family: string): string[] {
  const out = SUBSETS.map((s) => alias(family, s));
  if (family !== DEFAULT_FAMILY) out.push(...SUBSETS.map((s) => alias(DEFAULT_FAMILY, s)));
  return out;
}

/** Name of a subset's variable file from the catalog. */
function vfAlias(family: string, subset: string) {
  return subset === 'latin' ? `${family} [vf]` : `${family} [vf ${subset}]`;
}

/** Chain for text with axes: the family's variable files, then regular ones (while variable ones load). */
export function variableStack(family: string): string[] {
  return [...SUBSETS.map((s) => vfAlias(family, s)), ...fontStack(family)];
}

/** Font name in the catalog: “Roboto Flex” → roboto-flex. */
const fontId = (family: string) => family.toLowerCase().replace(/\s+/g, '-');

/** Bundle catalog: family → folder id and weights per style. */
export interface BundledCatalog {
  families: Record<string, { id: string; normal: number[]; italic: number[]; subsets?: string[] }>;
}

/** Nearest weight from the list (on a tie — the heavier one, as CSS does for weights from 500). */
export function nearestWeight(weights: number[], want: number): number | null {
  if (!weights.length) return null;
  return weights.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) || (Math.abs(w - want) === Math.abs(best - want) && w > best) ? w : best));
}

export class FontLibrary {
  readonly provider: TypefaceFontProvider;
  /** Offline: the Fontsource catalog is not queried — only custom fonts and the bundle. */
  offline: () => boolean = () => false;
  private bundled: { base: string; catalog: Promise<BundledCatalog | null> } | null = null;
  private loaded = new Set<string>();
  private pending = new Map<string, Promise<boolean>>();
  private failed = new Map<string, FontRef>();
  private local = new Map<string, LocalFace[]>();
  /** Subscribers: a font has loaded — re-lay out text of this family. */
  onLoad: ((family: string) => void)[] = [];
  private cdn: string;
  private api: string;
  /** Family axes: null — not variable. */
  private axesOf = new Map<string, FontAxis[] | null>();
  private axesPending = new Map<string, Promise<FontAxis[] | null>>();
  /** Catalog variable files: “family|style” → loaded (true) or unavailable (false). */
  private variable = new Map<string, boolean>();
  private variablePending = new Map<string, Promise<boolean>>();
  /** Grows with every load — to re-lay out paragraphs that were waiting for a font. */
  version = 0;
  /** Cap height and x-height (fractions of font size) per style — for vertical trim. */
  private metrics = new Map<string, { capHeight: number; xHeight: number }>();
  /** Font files under the names they are registered with (text outlines for PDF and SVG). */
  private files = new Map<string, { data: ArrayBuffer; weight: number; italic: boolean }[]>();

  private ck: CanvasKit;

  constructor(ck: CanvasKit, cdn = 'https://cdn.jsdelivr.net/fontsource/fonts', api = 'https://api.fontsource.org/v1') {
    this.ck = ck;
    this.provider = ck.TypefaceFontProvider.Make();
    this.cdn = cdn;
    this.api = api;
  }

  /** Bundled fonts: base — folder URL, catalog — base/catalog.json (loaded on first need). */
  useBundled(base: string) {
    const root = base.replace(/\/+$/, '');
    const catalog = fetch(`${root}/catalog.json`)
      .then((r) => (r.ok ? (r.json() as Promise<BundledCatalog>) : null))
      .catch(() => null);
    this.bundled = { base: root, catalog };
    // Fonts requested before the bundle (the default font — already in the editor constructor) — again.
    void catalog.then(async (cat) => {
      if (!cat) return;
      await Promise.allSettled([...this.pending.values()]);
      this.retryMissing((family) => family in cat.families);
    });
  }

  /** Reload fonts that failed to load (a bundle or internet access has appeared). */
  retryMissing(filter: (family: string) => boolean = () => true) {
    for (const [key, ref] of this.failed) {
      if (!filter(ref.family)) continue;
      this.failed.delete(key);
      void this.ensure(ref);
    }
  }

  /** Bundle families (for the font list). */
  async bundledFamilies(): Promise<string[]> {
    const cat = await this.bundled?.catalog;
    return cat ? Object.keys(cat.families) : [];
  }

  /** Family axes if already known: undefined — not asked yet, null — not variable. */
  knownAxes(family: string): FontAxis[] | null | undefined {
    return this.axesOf.get(family);
  }

  /** Family axes: for a custom font — from its file's fvar table, for the catalog — from Fontsource data. */
  axes(family: string): Promise<FontAxis[] | null> {
    if (this.axesOf.has(family)) return Promise.resolve(this.axesOf.get(family)!);
    let p = this.axesPending.get(family);
    if (!p) {
      p = this.loadAxes(family).then((a) => {
        this.axesOf.set(family, a);
        this.axesPending.delete(family);
        return a;
      });
      this.axesPending.set(family, p);
    }
    return p;
  }

  private async loadAxes(family: string): Promise<FontAxis[] | null> {
    const own = this.local.get(family);
    if (own?.length) {
      for (const face of own) {
        try {
          const a = fontAxes(await face.data());
          if (a) return a;
        } catch {
          // File unavailable — next one.
        }
      }
      return null;
    }
    if (this.offline()) return null;
    try {
      const res = await fetch(`${this.api}/variable/${fontId(family)}`);
      if (!res.ok) return null;
      const j = (await res.json()) as { axes?: Record<string, { default: string; min: string; max: string; step: string }> };
      const axes = Object.entries(j.axes ?? {}).map(([tag, a]) => ({ tag, min: +a.min, max: +a.max, default: +a.default, step: +a.step || 1 }));
      return axes.length ? axes : null;
    } catch {
      return null;
    }
  }

  /**
   * The family's variable files for text with axes: true — ready (or a custom font), false — none
   * (then the text uses the regular style), undefined — still loading (on load — onLoad).
   */
  ensureVariable(f: FontRef): boolean | undefined {
    if (this.local.has(f.family)) return true;
    const italic = parseStyle(f.style).italic;
    const key = `${f.family}|${italic ? 'italic' : 'normal'}`;
    if (this.variable.has(key)) return this.variable.get(key);
    if (!this.variablePending.has(key)) {
      const p = this.loadVariable(f.family, italic).then((ok) => {
        this.variablePending.delete(key);
        this.variable.set(key, ok);
        if (ok) {
          this.version++;
          for (const cb of this.onLoad) cb(f.family);
        }
        return ok;
      });
      this.variablePending.set(key, p);
    }
    return undefined;
  }

  /** Catalog variable WOFF2 files per subset: all axes (full), standard, or weight only. */
  private async loadVariable(family: string, italic: boolean): Promise<boolean> {
    if (this.offline()) return false;
    const axes = await this.axes(family);
    if (!axes) return false;
    const custom = axes.some((a) => a.tag !== a.tag.toLowerCase());
    const kinds = custom ? ['full', 'standard', 'wght'] : axes.some((a) => a.tag !== 'wght') ? ['standard', 'wght'] : ['wght'];
    const style = italic ? 'italic' : 'normal';
    let any = false;
    await Promise.all(
      SUBSETS.map(async (subset) => {
        for (const kind of kinds) {
          try {
            const res = await fetch(`${this.cdn}/${fontId(family)}:vf@latest/${subset}-${kind}-${style}.woff2`);
            if (!res.ok) continue;
            this.provider.registerFont(await res.arrayBuffer(), vfAlias(family, subset));
            any = true;
            return;
          } catch {
            // The subset may be missing — next file kind.
          }
        }
      }),
    );
    return any;
  }

  /** All families that failed to load (for the “Missing fonts” dialog). */
  get missing(): FontRef[] {
    return [...this.failed.values()];
  }

  private key(f: FontRef) {
    const { weight, italic } = parseStyle(f.style);
    return `${f.family}|${weight}|${italic ? 'italic' : 'normal'}`;
  }

  /** No loads in progress. */
  get idle(): boolean {
    return this.pending.size === 0;
  }

  has(f: FontRef): boolean {
    return this.loaded.has(this.key(f));
  }

  /** Cap height as a fraction of font size (OS/2); font not loaded or no data — 0.7. */
  capHeight(f: FontRef): number {
    return this.metrics.get(this.key(f))?.capHeight ?? 0.7;
  }

  private remember(f: FontRef, data: ArrayBuffer) {
    const m = fontMetrics(data);
    if (m) this.metrics.set(this.key(f), m);
  }

  private keep(name: string, data: ArrayBuffer, weight: number, italic: boolean) {
    const list = this.files.get(name) ?? [];
    const i = list.findIndex((x) => x.weight === weight && x.italic === italic);
    if (i >= 0) list[i] = { data, weight, italic };
    else list.push({ data, weight, italic });
    this.files.set(name, list);
  }

  /**
   * Files the family's text could have been set with: all subsets of the family, then the default
   * font; within each — the closest by weight and style first.
   */
  fontFiles(family: string, style: string): ArrayBuffer[] {
    const want = parseStyle(style);
    const out: ArrayBuffer[] = [];
    for (const name of fontStack(family)) {
      const list = [...(this.files.get(name) ?? [])].sort(
        (a, b) => Math.abs(a.weight - want.weight) + (a.italic === want.italic ? 0 : 1000) - (Math.abs(b.weight - want.weight) + (b.italic === want.italic ? 0 : 1000)),
      );
      for (const f of list) out.push(f.data);
    }
    return out;
  }

  /** Styles of a custom font (empty — not a custom font). */
  localStyles(family: string): string[] {
    return (this.local.get(family) ?? []).map((f) => f.style);
  }

  /** Families from the computer and from files (for hints in the panel). */
  get localFamilies(): string[] {
    return [...this.local.keys()].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Add custom fonts. Texts that previously found no font of these families
   * are loaded again (and re-laid out by onLoad subscribers).
   */
  addLocal(faces: LocalFace[]) {
    const families = new Set<string>();
    for (const face of faces) {
      let list = this.local.get(face.family);
      if (!list) this.local.set(face.family, (list = []));
      const i = list.findIndex((x) => x.style === face.style);
      if (i >= 0) list[i] = face;
      else list.push(face);
      families.add(face.family);
    }
    this.retryMissing((family) => families.has(family));
  }

  /** Font from a file (.ttf, .otf). Returns its family and style; null — not a font. */
  async addFile(data: ArrayBuffer, fileName = ''): Promise<FontRef | null> {
    let names = fontNames(data);
    // WOFF2: tables are Brotli-compressed — CanvasKit (FreeType) gives the family, the file name gives the style.
    if (!names && isWoff2(data)) {
      const tf = this.ck.Typeface.MakeTypefaceFromData(data);
      const family = tf?.getFamilyName();
      tf?.delete();
      if (family) names = { family, style: styleFromFileName(fileName) };
    }
    if (!names) return null;
    this.addLocal([{ ...names, data: async () => data }]);
    // This file may have replaced an already loaded style — load it again.
    this.loaded.delete(this.key(names));
    return (await this.ensure(names)) ? names : null;
  }

  /** Closest style of a custom font: the same name, otherwise the same slant and nearest weight. */
  private pickLocal(f: FontRef): LocalFace | undefined {
    const list = this.local.get(f.family);
    if (!list?.length) return undefined;
    const exact = list.find((x) => x.style.toLowerCase() === f.style.toLowerCase());
    if (exact) return exact;
    const want = parseStyle(f.style);
    let best: LocalFace | undefined;
    let score = Infinity;
    for (const x of list) {
      const p = parseStyle(x.style);
      const d = Math.abs(p.weight - want.weight) + (p.italic === want.italic ? 0 : 1000);
      if (d < score) (best = x), (score = d);
    }
    return best;
  }

  /** Ensures the font is loaded; returns true if it is available. */
  ensure(f: FontRef): Promise<boolean> {
    const key = this.key(f);
    if (this.loaded.has(key)) return Promise.resolve(true);
    if (this.failed.has(key)) return Promise.resolve(false);
    let p = this.pending.get(key);
    if (!p) {
      p = this.load(f).then((ok) => {
        this.pending.delete(key);
        if (ok) {
          this.loaded.add(key);
          this.version++;
          for (const cb of this.onLoad) cb(f.family);
        } else this.failed.set(key, f);
        return ok;
      });
      this.pending.set(key, p);
    }
    return p;
  }

  private async load(f: FontRef): Promise<boolean> {
    const { weight, italic } = parseStyle(f.style);
    const own = this.pickLocal(f);
    if (own) {
      try {
        const data = await own.data();
        this.provider.registerFont(data, f.family);
        this.keep(f.family, data, weight, italic);
        this.remember(f, data);
        await this.domFace(f.family, data, weight, italic ? 'italic' : 'normal');
        return true;
      } catch {
        // File unavailable (font access revoked) — try the catalog.
      }
    }
    // Bundle: the exact style — right away; otherwise, online — the catalog, and the nearest weight of
    // the requested slant (no italic — the upright style) — only offline or if the catalog didn't respond.
    const cat = await this.bundled?.catalog;
    const entry = cat?.families[f.family];
    const bundled = async (exactOnly: boolean) => {
      if (!entry || !this.bundled) return false;
      const st = italic && entry.italic.length ? 'italic' : 'normal';
      const w = nearestWeight(st === 'italic' ? entry.italic : entry.normal, weight);
      if (w === null || (exactOnly && (w !== weight || st !== (italic ? 'italic' : 'normal')))) return false;
      return this.loadFrom(this.bundled.base, entry.id, f, w, st, weight, italic, entry.subsets);
    };
    if (await bundled(true)) return true;
    if (!this.offline() && (await this.loadFrom(this.cdn, fontId(f.family), f, weight, italic ? 'italic' : 'normal', weight, italic).catch(() => false))) return true;
    return bundled(false);
  }

  /** Style subsets from a folder with the Fontsource layout; under the requested weight and style. */
  private async loadFrom(base: string, id: string, f: FontRef, fileWeight: number, style: string, weight: number, italic: boolean, subsets = SUBSETS): Promise<boolean> {
    let any = false;
    await Promise.all(
      SUBSETS.filter((x) => subsets.includes(x)).map(async (subset) => {
        const url = `${base}/${id}@latest/${subset}-${fileWeight}-${style}.ttf`;
        try {
          const res = await fetch(url);
          // A server with a fallback page returns HTML instead of 404 — that's not a font.
          if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return;
          const data = await res.arrayBuffer();
          this.provider.registerFont(data, alias(f.family, subset));
          this.keep(alias(f.family, subset), data, weight, italic);
          if (subset === 'latin' || !this.metrics.has(this.key(f))) this.remember(f, data);
          await this.domFace(alias(f.family, subset), data, weight, style);
          any = true;
        } catch {
          // The subset may be missing (e.g. the font has no Cyrillic) — that's fine.
        }
      }),
    );
    return any;
  }

  /** The same file — for the text editing field (DOM), so it looks like the canvas. */
  private async domFace(family: string, data: ArrayBuffer, weight: number, style: string) {
    if (typeof document === 'undefined' || !('fonts' in document)) return;
    const face = new globalThis.FontFace(family, data, { weight: String(weight), style });
    await face.load();
    document.fonts.add(face);
  }
}
