// Design tokens of the new look — from the design file built in the editor itself (design/interface.mfp):
// the “Palette”, “Theme” (modes “Dark” and “Light”) and “Sizes” collections → CSS variables in
// apps/editor/src/ui/tokens.css. Change a color in the file, run npm run design:tokens, and the interface follows.
//
// The variables apply only to the new look (html[data-ui="new"]) and not in high contrast:
// the classic look and the high-contrast theme don't see them.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cssVariables, localCollections } from '@mfp/core';
import { MemorySource, readMfp } from '@mfp/io-figma';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = 'design/interface.mfp';
const TARGET = 'apps/editor/src/ui/tokens.css';
const NEW = ':root[data-ui="new"]:not([data-contrast])';

const { doc } = await readMfp(new MemorySource(new Uint8Array(readFileSync(resolve(ROOT, SOURCE)))));
const byName = new Map(localCollections(doc).map((c) => [doc.get(c, 'name') ?? '', c]));
const collections = ['Palette', 'Theme', 'Sizes'].map((name) => {
  const c = byName.get(name);
  if (!c) throw new Error(`${SOURCE} has no “${name}” collection`);
  return c;
});
const css = cssVariables(doc, {
  collections,
  colorFormat: 'hex',
  header: `Generated from ${SOURCE} (npm run design:tokens) — edit the design file, not this file`,
  // Theme: the first mode (“Dark”) is the default, the second (“Light”) is data-theme="light".
  selector: ({ collectionName, index }) => (collectionName === 'Theme' && index === 1 ? `${NEW}[data-theme="light"]` : NEW),
});
writeFileSync(resolve(ROOT, TARGET), css);
console.log(`${TARGET}: ${css.split('\n').filter((l) => l.trim().startsWith('--')).length} variables`);
