import { expect, it } from 'vitest';
import { textPathFromStart, textPathStartFromOffset } from '../src/text-path.ts';
import { networkFromSvg, type VectorNetwork } from '@mfp/core';

it('maps a reversed segment and chooses the requested disconnected contour', () => {
  const net: VectorNetwork = {
    vertices: [{x:0,y:0},{x:100,y:0},{x:200,y:0},{x:0,y:50},{x:50,y:50}],
    segments: [{start:0,end:1},{start:2,end:1},{start:3,end:4}],
  };
  expect(textPathFromStart(net,1,0.25)).toMatchObject({offset:175,startData:{segment:1,position:0.25}});
  expect(textPathFromStart(net,2,0.5)).toMatchObject({data:'M0 50L50 50',offset:25});
});
it('integrates a curved segment up to its parameter, not a fraction of its total length', () => {
  const net=networkFromSvg('M0 0C0 100 100 100 100 0')!;
  expect(textPathFromStart(net,0,1).offset).toBeCloseTo(200,2);
  expect(textPathFromStart(net,0,0.5).offset).toBeCloseTo(100,2);
  // Exact integral here is 59.375 at t=0.25.
  expect(textPathFromStart(net,0,0.25).offset).toBeCloseTo(59.375,2);
});
it('rejects empty, fractional and nonfinite starts without inventing a contour', () => {
  const net=networkFromSvg('M0 0L20 0')!;
  for (const s of [-1,1,0.1,NaN,Infinity]) expect(()=>textPathFromStart(net,s,0)).toThrow();
  for (const p of [-1,1.01,NaN,Infinity]) expect(()=>textPathFromStart(net,0,p)).toThrow();
});

it('reads the starting segment of older editor paths without requiring API metadata', () => {
 const net=networkFromSvg('M0 0L100 0L100 50')!;
 expect(textPathStartFromOffset(net,125)).toEqual({segment:1,position:expect.closeTo(0.5,6)});
 const curve=networkFromSvg('M0 0C0 100 100 100 100 0')!;
 expect(textPathStartFromOffset(curve,59.375).position).toBeCloseTo(0.25,4);
});
