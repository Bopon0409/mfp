// Crop a region from a PNG and upscale it (visual render comparison): node scripts/crop.ts in.png x y w h scale out.png
import { readFileSync, writeFileSync } from 'node:fs';
import CanvasKitInit from 'canvaskit-wasm';
const [inp, xs, ys, ws, hs, ss, out] = process.argv.slice(2);
const ck = await CanvasKitInit();
const img = ck.MakeImageFromEncoded(readFileSync(inp!))!;
const [x, y, w, h, s] = [xs, ys, ws, hs, ss].map(Number) as [number, number, number, number, number];
const surf = ck.MakeSurface(w * s, h * s)!;
const c = surf.getCanvas();
c.clear(ck.WHITE);
c.drawImageRectOptions(img, ck.XYWHRect(x, y, w, h), ck.XYWHRect(0, 0, w * s, h * s), ck.FilterMode.Nearest, ck.MipmapMode.None, null);
const snap = surf.makeImageSnapshot();
writeFileSync(out!, snap.encodeToBytes()!);
console.log('size', img.width(), img.height());
