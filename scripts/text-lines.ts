// Text layout check against .fig data: lines of each text from the .fig via derivedTextData.baselines
// (index of the line's first character and baseline position) versus our layout with the same
// properties and width. Texts with fonts we don't have (not found in Fontsource) are not counted.
//
// Run: node scripts/text-lines.ts fixtures/design.fig [more.fig …] [--verbose]

import { join } from 'node:path';
import CanvasKitInit from 'canvaskit-wasm';
import { Document } from '@mfp/core';
import { buildScene, decodeFigKiwi, guidKey, openFig, sceneToCore } from '@mfp/io-figma';
import { FileSource } from '@mfp/io-figma/node';
import { FontLibrary, layoutText, textFonts, textLayoutOf } from '@mfp/renderer';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const files = args.filter((a) => !a.startsWith('--'));
const ck = await CanvasKitInit({ locateFile: (f: string) => join('node_modules/canvaskit-wasm/bin', f) });
const fonts = new FontLibrary(ck);

let total = 0;
let matched = 0;
let texts = 0;
let textsExact = 0;
let baselines = 0;
let baselinesOk = 0;
const missing = new Map<string, number>();
const worst: string[] = [];

for (const file of files) {
  const archive = await openFig(new FileSource(file));
  const msg = decodeFigKiwi(archive.kiwi).message as { nodeChanges: Record<string, any>[] };
  const { doc, ids } = sceneToCore(buildScene(msg as never), new Document({ clientId: 1 }));
  let fileTotal = 0;
  let fileMatched = 0;
  for (const n of msg.nodeChanges) {
    if (n.type !== 'TEXT' || !n.derivedTextData?.baselines?.length || !n.guid) continue;
    const id = ids.get(guidKey(n.guid));
    if (!id || !doc.has(id)) continue;
    const props = doc.props(id);
    let ok = true;
    for (const f of textFonts(props)) {
      if (!(await fonts.ensure(f))) {
        const k = `${f.family} / ${f.style}`;
        missing.set(k, (missing.get(k) ?? 0) + 1);
        ok = false;
      }
    }
    if (!ok) continue;
    delete props.textGlyphs;
    const spec = textLayoutOf(props);
    const fixed = !spec.autoWidth;
    const layout = layoutText(ck, fonts, { ...spec, color: { r: 0, g: 0, b: 0, a: 1 }, width: fixed ? Math.max(1, props.width ?? 1) : undefined, height: props.textAutoResize === 'NONE' ? props.height : undefined });
    const y0 = spec.alignV === 'TOP' ? 0 : ((props.height ?? 0) - layout.height) * (spec.alignV === 'CENTER' ? 0.5 : 1);
    const ours = layout.lines();
    layout.delete();
    const theirs = n.derivedTextData.baselines as { firstCharacter: number; position: { y: number } }[];
    const starts = new Set(ours.map((l) => l.start));
    const hit = theirs.filter((b) => starts.has(b.firstCharacter)).length;
    fileTotal += theirs.length;
    fileMatched += hit;
    texts++;
    if (hit === theirs.length && ours.length === theirs.length) textsExact++;
    else worst.push(`  ${n.name}: ${JSON.stringify(String(props.characters ?? '').slice(0, 80))}\n    наши ${JSON.stringify(ours.map((l) => l.start))}\n    .fig ${JSON.stringify(theirs.map((b) => b.firstCharacter))}`);
    // Baseline of the first line — with vertical trim and vertical alignment.
    if (ours[0]) {
      baselines++;
      const d = Math.abs(y0 + ours[0].baseline - theirs[0]!.position.y);
      if (d <= 0.6) baselinesOk++;
      else if (verbose) worst.push(`  базовая линия «${n.name}»: наша ${(y0 + ours[0].baseline).toFixed(2)}, .fig ${theirs[0]!.position.y.toFixed(2)} (trim ${props.leadingTrim ?? 'NONE'}, ${JSON.stringify(props.lineHeight)}, ${props.fontName?.family} ${props.fontSize})`);
    }
  }
  total += fileTotal;
  matched += fileMatched;
  console.log(`${file}: строк ${fileTotal}, совпало ${fileMatched} (${((fileMatched / Math.max(1, fileTotal)) * 100).toFixed(1)}%)`);
}
const pct = (a: number, b: number) => ((a / Math.max(1, b)) * 100).toFixed(1);
console.log(`Итого: текстов ${texts}, все строки совпали у ${textsExact} (${pct(textsExact, texts)}%); строк ${total}, совпало ${matched} (${pct(matched, total)}%)`);
console.log(`Базовая линия первой строки (±0,6 px): ${baselinesOk} из ${baselines} (${pct(baselinesOk, baselines)}%)`);
if (missing.size) console.log('Нет шрифта:', [...missing].map(([k, v]) => `${k} ×${v}`).join(', '));
if (verbose) for (const w of worst.slice(0, 40)) console.log(w);
