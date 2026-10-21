// Russian UI strings for the translation dictionary (apps/editor/src/i18n/en.json).
// Parsed with oxc (comments are excluded):
//   - string literals with Cyrillic — “exact” strings;
//   - templates `…${x}…` and concatenations 'a' + x + 'b' with Cyrillic — “templates” with slots {0}, {1}, …;
//   - text and title / placeholder / aria-label attributes in apps/editor/index.html.
//
//   node scripts/i18n-extract.ts                 — summary: how many strings, how many untranslated
//   node scripts/i18n-extract.ts --missing f.json — untranslated strings (for translators)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseSync } from 'rolldown/utils';

const ROOTS = ['apps/editor/src', 'apps/viewer/src', 'packages/plugin-host/src', 'packages/core/src', 'packages/editing/src', 'packages/renderer/src', 'packages/io-figma/src', 'apps/server/src', 'ee'];
const CYR = /[А-Яа-яЁё]/;
const DICT = 'apps/editor/src/i18n/en.json';

type Node = { type?: string; [k: string]: unknown };

const isStr = (n: Node) => n.type === 'Literal' && typeof n.value === 'string';

/** Operands of a concatenation a + b + c (only +). */
function flatPlus(n: Node, out: Node[] = []): Node[] {
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    flatPlus(n.left as Node, out);
    flatPlus(n.right as Node, out);
  } else out.push(n);
  return out;
}

/** Exact strings and templates with {n} from a source file. */
export function extract(file: string, text: string): { exact: string[]; patterns: string[] } {
  const exact: string[] = [];
  const patterns: string[] = [];
  const { program } = parseSync(file, text);
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const node = n as Node;
    if (isStr(node) && CYR.test(node.value as string)) exact.push(node.value as string);
    if (node.type === 'TemplateLiteral') {
      const quasis = (node.quasis as { value: { cooked?: string; raw: string } }[]).map((q) => q.value.cooked ?? q.value.raw);
      if (quasis.some((q) => CYR.test(q))) {
        if (quasis.length === 1) exact.push(quasis[0]!);
        else patterns.push(quasis.map((q, i) => (i ? `{${i - 1}}` : '') + q).join(''));
      }
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const parts = flatPlus(node);
      if (parts.some((p) => isStr(p) && CYR.test(p.value as string)) && parts.some((p) => !isStr(p))) {
        let k = 0;
        let s = '';
        for (const p of parts) s += isStr(p) ? (p.value as string) : `{${k++}}`;
        patterns.push(s);
      }
    }
    for (const key in node) if (key !== 'parent') walk(node[key]);
  };
  walk(program);
  return { exact, patterns };
}

/** Markup text and attributes with Cyrillic. */
export function extractHtml(html: string): string[] {
  const out: string[] = [];
  const body = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const t = m[1]!.trim();
    if (CYR.test(t)) out.push(t);
  }
  for (const m of body.matchAll(/\s(?:title|placeholder|aria-label|data-tip)="([^"]*)"/g)) if (CYR.test(m[1]!)) out.push(m[1]!);
  return out;
}

export function collect(): { exact: Set<string>; patterns: Set<string> } {
  const files = execFileSync('git', ['ls-files', ...ROOTS]).toString().trim().split('\n').filter((f) => /\.ts$/.test(f) && !/(^|\/)test\//.test(f) && !/i18n\//.test(f));
  const exact = new Set<string>();
  const patterns = new Set<string>();
  for (const f of files) {
    const r = extract(f, readFileSync(f, 'utf8'));
    for (const s of r.exact) exact.add(s);
    for (const s of r.patterns) patterns.add(s);
  }
  for (const s of extractHtml(readFileSync('apps/editor/index.html', 'utf8'))) exact.add(s);
  return { exact, patterns };
}

if (import.meta.main) {
  const { exact, patterns } = collect();
  const dict = existsSync(DICT) ? (JSON.parse(readFileSync(DICT, 'utf8')) as { exact: Record<string, string>; patterns: Record<string, string> }) : { exact: {}, patterns: {} };
  const missExact = [...exact].filter((s) => !(s in dict.exact));
  const missPatterns = [...patterns].filter((s) => !(s in dict.patterns));
  console.log(`точных: ${exact.size} (без перевода ${missExact.length}), шаблонов: ${patterns.size} (без перевода ${missPatterns.length})`);
  const i = process.argv.indexOf('--missing');
  if (i > 0) writeFileSync(process.argv[i + 1]!, JSON.stringify({ exact: missExact, patterns: missPatterns }, null, 1));
}
