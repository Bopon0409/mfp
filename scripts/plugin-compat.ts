// Plugin compatibility dashboard: node scripts/plugin-compat.ts <folder…> [-o report.md] [--title …]
// Finds plugins (folders with manifest.json, excluding node_modules), checks each (mfp plugin check) and
// writes a Markdown summary: how many work, which APIs are most often missing, a per-plugin table.
// Third-party plugin code doesn't get into the repository — only the results.

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { checkPlugin, type CheckReport } from '../apps/cli/src/plugin-check.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = opt('-o');
const title = opt('--title') ?? 'Совместимость плагинов';
const roots = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && args[i - 1]!.startsWith('-')));
if (!roots.length) {
  console.error('Использование: node scripts/plugin-compat.ts <папка…> [-o файл.md] [--title заголовок]');
  process.exit(1);
}

function findPlugins(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 6) return acc;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return acc;
  }
  if (names.includes('manifest.json')) acc.push(dir);
  for (const n of names) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    try {
      if (statSync(p).isDirectory()) findPlugins(p, depth + 1, acc);
    } catch {
      // no access — skip
    }
  }
  return acc;
}

const dirs = roots.flatMap((r) => findPlugins(resolve(r)));
const reports: CheckReport[] = [];
for (const d of dirs) {
  process.stderr.write(`${relative(process.cwd(), d)}… `);
  const r = await checkPlugin(d);
  reports.push(r);
  process.stderr.write(`${r.verdict}\n`);
}

const VERDICT = { works: '✅ работает', partial: '◐ частично', fails: '❌ нет', other: '— FigJam / Slides' } as const;
const count = (v: CheckReport['verdict']) => reports.filter((r) => r.verdict === v).length;
const missing = new Map<string, number>();
for (const r of reports) for (const m of r.apis.missing) missing.set(m.name, (missing.get(m.name) ?? 0) + 1);
const why = (r: CheckReport) => {
  if (r.errors.length) return r.errors[0]!;
  const err = r.runs.find((x) => x.state === 'error');
  if (err) return `ошибка${err.command ? ` («${err.command}»)` : ''}: ${err.error}`;
  if (r.verdict === 'other') return 'плагин для FigJam или Slides';
  if (r.apis.missing.length) return `нет: ${r.apis.missing.map((m) => m.name).join(', ')}`;
  return r.runs.map((x) => (x.state === 'skipped' ? `«${x.command || 'запуск'}» не проверена: ${x.message}` : x.output ? x.output : x.state === 'closed' ? 'закрылся сам' : x.ui ? 'окно' : 'работает')).join('; ');
};
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const lines = [
  `# ${title}`,
  '',
  `Проверено ${new Date().toISOString().slice(0, 10)}: ${reports.length} плагинов — ${count('works')} работают, ${count('partial')} частично, ${count('fails')} не работают${count('other') ? `, ${count('other')} — не для Figma Design (FigJam / Slides)` : ''}.`,
  'Инструмент: `mfp plugin check` (манифест, API в коде против песочницы MFP, прогон команд без окна на образцовом документе).',
  ...(reports.some((r) => r.runs.some((x) => x.state === 'skipped')) ? [`Не до конца проверены (часть команд требует окна плагина или сети): ${reports.filter((r) => r.runs.some((x) => x.state === 'skipped')).map((r) => r.name || basename(r.dir)).join(', ')}.`] : []),
  '',
];
if (missing.size) {
  lines.push('## Чего не хватает чаще всего', '', '| API | плагинов |', '|---|---|');
  for (const [name, n] of [...missing].sort((a, b) => b[1] - a[1]).slice(0, 30)) lines.push(`| \`${name}\` | ${n} |`);
  lines.push('');
}
lines.push('## Плагины', '', '| Плагин | Итог | Подробности |', '|---|---|---|');
for (const r of [...reports].sort((a, b) => (a.name || basename(a.dir)).localeCompare(b.name || basename(b.dir)))) lines.push(`| ${esc(r.name || basename(r.dir))} | ${VERDICT[r.verdict]} | ${esc(why(r)).slice(0, 220)} |`);
lines.push('');
const md = lines.join('\n');
if (out) {
  writeFileSync(out, md);
  console.error(`→ ${out}`);
} else console.log(md);
