import { decodeFigKiwi, openFig, guidKey } from '@mfp/io-figma';
import { FileSource } from '@mfp/io-figma/node';
for (const file of process.argv.slice(2)) {
  const archive = await openFig(new FileSource(file));
  const msg = decodeFigKiwi(archive.kiwi).message as { nodeChanges: any[] };
  const types = new Map<string, number>();
  for (const n of msg.nodeChanges) types.set(n.type, (types.get(n.type) ?? 0) + 1);
  const vars = msg.nodeChanges.filter((n) => n.type === 'VARIABLE' || n.type === 'VARIABLE_SET' || n.type === 'VARIABLE_OVERRIDE');
  let aliases = 0;
  const visit = (v: any) => { if (v && typeof v === 'object') { if (v.alias) aliases++; for (const x of Object.values(v)) visit(x); } };
  for (const n of msg.nodeChanges) { visit(n.fillPaints); visit(n.strokePaints); visit(n.variableData); visit(n.parameterConsumptionMap); }
  console.log(file, 'VARIABLE*:', vars.length, 'alias refs:', aliases, 'types:', [...types].filter(([t]) => /VAR|STYLE|SET/i.test(t ?? '')).map(([t, c]) => `${t}=${c}`).join(' '));
  for (const v of vars.slice(0, 4)) {
    const { guid, parentIndex, ...rest } = v;
    console.log('  ', guidKey(guid), v.type, v.name, JSON.stringify(rest).slice(0, 400));
  }
}
