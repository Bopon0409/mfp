#!/usr/bin/env node
// mfp — MFP command line.
//   mfp info <file.mfp|.fig>                         summary: pages, nodes, images
//   mfp render <file> [--node id] [--scale 2] [-o out.png]   PNG of a node or the first page
//   mfp mcp [file]                                   MCP server (stdio) for agents
//   mfp plugin check <folder…> [--json]               compatibility of Figma-format plugins

import { writeFileSync } from 'node:fs';
import { serveMcp } from './mcp.ts';
import { userPages } from '@mfp/core';
import { Session } from './session.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string, short?: string) => {
  const i = rest.findIndex((a) => a === `--${name}` || (short && a === `-${short}`));
  return i >= 0 ? rest[i + 1] : undefined;
};
const file = rest.find((a, i) => !a.startsWith('-') && !(i > 0 && rest[i - 1]!.startsWith('-')));

const usage = () => {
  console.error('Использование:\n  mfp info <файл>\n  mfp render <файл> [--node id] [--scale 2] [-o out.png]\n  mfp mcp [файл]\n  mfp plugin check <папка плагина…> [--json]');
  process.exit(1);
};

switch (cmd) {
  case 'info': {
    if (!file) usage();
    const s = await Session.open(file!);
    console.log(JSON.stringify(s.info(), null, 2));
    break;
  }
  case 'render': {
    if (!file) usage();
    const s = await Session.open(file!);
    // Node — by id or by name.
    const arg = flag('node');
    const node = !arg ? userPages(s.doc)[0]! : s.doc.has(arg) ? arg : (s.find({ name: arg, limit: 1 })[0]?.id as string | undefined);
    if (!node) throw new Error(`Нет узла «${arg}»`);
    const t0 = performance.now();
    const r = await s.render(node, Number(flag('scale') ?? 1));
    const out = flag('out', 'o') ?? `${s.name}.png`;
    writeFileSync(out, r.png);
    console.log(`${out}: ${r.width}×${r.height}, ${(performance.now() - t0).toFixed(0)} мс`);
    break;
  }
  case 'mcp':
    await serveMcp(file);
    break;
  case 'plugin': {
    if (rest[0] !== 'check') usage();
    const dirs = rest.slice(1).filter((a) => !a.startsWith('-'));
    if (!dirs.length) usage();
    const { checkPlugin, formatReport } = await import('./plugin-check.ts');
    const reports = [];
    for (const dir of dirs) reports.push(await checkPlugin(dir));
    if (rest.includes('--json')) console.log(JSON.stringify(reports, null, 2));
    else console.log(reports.map(formatReport).join('\n\n'));
    process.exitCode = reports.some((r) => r.verdict === 'fails') ? 1 : 0;
    break;
  }
  default:
    usage();
}
