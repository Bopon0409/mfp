import { describe, expect, it } from 'vitest';
import { decodePathCommands } from '@mfp/io-figma';
import { svgPathToBlob } from '../src/core-scene.ts';

const cmds = (svg: string) => {
  const out: string[] = [];
  decodePathCommands(svgPathToBlob(svg), {
    moveTo: (x, y) => out.push(`M${x},${y}`),
    lineTo: (x, y) => out.push(`L${x},${y}`),
    quadTo: (a, b, x, y) => out.push(`Q${a},${b},${x},${y}`),
    cubicTo: (a, b, c, d, x, y) => out.push(`C${a},${b},${c},${d},${x},${y}`),
    close: () => out.push('Z'),
  });
  return out;
};

describe('SVG path → contours', () => {
  it('format with spaces (import)', () => {
    expect(cmds('M 0 0 L 10 0 L 10 10 Z')).toEqual(['M0,0', 'L10,0', 'L10,10', 'Z']);
  });
  it('Skia format: command right next to a number, negatives without a space', () => {
    expect(cmds('M149.5 40C116.5 40.25 90 67 90 100L-1.5-2Z')).toEqual(['M149.5,40', 'C116.5,40.25,90,67,90,100', 'L-1.5,-2', 'Z']);
  });
  it('repeated command without a letter; after M — L', () => {
    expect(cmds('M0 0 10 0 10 10L20 20 30 30Z')).toEqual(['M0,0', 'L10,0', 'L10,10', 'L20,20', 'L30,30', 'Z']);
  });
});
