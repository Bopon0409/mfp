// Check of CMYK conversion with the Windows system profile (RSWOP.icm): color → CMYK → back to Lab, ΔE.
import { readFileSync } from 'node:fs';
import { iccCmyk, iccCmykToLab, parseIcc, srgbToXyzD50, xyzToLab } from '../packages/core/src/icc.ts';

const path = process.argv[2] ?? 'C:/Windows/System32/spool/drivers/color/RSWOP.icm';
const p = parseIcc(new Uint8Array(readFileSync(path)));
console.log(p.description, p.colorSpace, p.pcs, p.version);
const to = iccCmyk(p, 1)!;
const back = iccCmykToLab(p, 1)!;
const de = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
for (const [name, rgb] of [['белый', [1, 1, 1]], ['чёрный', [0, 0, 0]], ['серый', [0.5, 0.5, 0.5]], ['красный', [0.85, 0.15, 0.15]], ['синий', [0.1, 0.3, 0.7]], ['зелёный', [0.2, 0.6, 0.3]], ['кожа', [0.9, 0.75, 0.65]]] as const) {
  const cmyk = to(rgb[0], rgb[1], rgb[2]);
  const lab = xyzToLab(srgbToXyzD50(rgb[0], rgb[1], rgb[2]));
  const lab2 = back(cmyk);
  console.log(name.padEnd(8), cmyk.map((v) => Math.round(v * 100)).join('/'), 'Lab', lab.map((v) => v.toFixed(1)).join(' '), '→', lab2.map((v) => v.toFixed(1)).join(' '), 'ΔE', de(lab, lab2).toFixed(2));
}
