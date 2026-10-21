// Build plugin (Vite and rolldown): code stored as a string (the plugin sandbox,
// packages/plugin-host/src/shim.ts) is left untouched by the build minifier — it would ship as is,
// comments included. This plugin runs such code through the oxc minifier (no renaming
// or simplification: only stripping comments and whitespace). Comments remain in the sources.
// Check: the packages/plugin-host tests also run with the processed sandbox (vitest.config.ts, “plugin-host-built”).

import { minifySync } from 'rolldown/utils';

/** Modules where the code is a String.raw`…` template string. */
const TARGETS = [/plugin-host[\\/]src[\\/]shim\.ts$/];

/** Code without comments and extra whitespace (names and statement order unchanged). */
export function compactCode(code: string, name = 'code.js'): string {
  const r = minifySync(name, code, { compress: false, mangle: false });
  if (r.errors.length) throw new Error(`${name}: ${r.errors.map((e) => e.message).join('; ')}`);
  return r.code;
}

/** A module's String.raw`…` → a regular string with the same code without comments. */
export function compactTemplates(source: string, name: string): string {
  return source.replace(/String\.raw`([^`]*)`/g, (whole, body: string) => {
    if (body.includes('${')) return whole;
    return JSON.stringify(compactCode(body, name));
  });
}

export function stripCommentsPlugin() {
  return {
    name: 'mfp-compact-string-code',
    transform(code: string, id: string) {
      if (!TARGETS.some((r) => r.test(id))) return null;
      return { code: compactTemplates(code, id.replace(/^.*[\\/]/, '')), map: null };
    },
  };
}
