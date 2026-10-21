import type { FigColor, FigMatrix, FigPaint } from '@mfp/io-figma';
import { interpolateTransform } from './interpolate-transform.ts';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const color = (a: FigColor, b: FigColor, t: number): FigColor => ({
  r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t), a: lerp(a.a ?? 1, b.a ?? 1, t),
});
const gradients = new Set(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']);
const matrix = (m: FigMatrix) => [m.m00, m.m01, m.m02, m.m10, m.m11, m.m12] as Parameters<typeof interpolateTransform>[0];

/** Corresponding gradient stops retain their order. Different paint types or
 * stop counts still need a renderer-level dissolve, not two translucent fills. */
export function interpolateFills(a: FigPaint[], b: FigPaint[], t: number): FigPaint[] {
  if (t <= 0) return a;
  if (t >= 1) return b;
  if (a.length !== b.length) return b;
  return b.map((pb, i) => {
    const pa = a[i]!;
    if (pa.type !== pb.type || pa.visible !== pb.visible || pa.blendMode !== pb.blendMode) return pb;
    const opacity = lerp(pa.opacity ?? 1, pb.opacity ?? 1, t);
    if (pa.type === 'SOLID' && pa.color && pb.color) return { ...pb, opacity, color: color(pa.color, pb.color, t) };
    if (gradients.has(pa.type ?? '') && pa.stops?.length && pa.stops.length === pb.stops?.length && pa.transform && pb.transform) {
      const m = interpolateTransform(matrix(pa.transform), matrix(pb.transform), t);
      return {
        ...pb, opacity,
        transform: { m00: m[0], m01: m[1], m02: m[2], m10: m[3], m11: m[4], m12: m[5] },
        stops: pb.stops.map((stop, j) => ({ position: lerp(pa.stops![j]!.position, stop.position, t), color: color(pa.stops![j]!.color, stop.color, t) })),
      };
    }
    // The same 3D model with a different view angle (“front / side” variants) — angle and clip frame transition smoothly.
    if (pa.type === 'MODEL3D' && pa.model && pb.model && JSON.stringify(pa.model.hash) === JSON.stringify(pb.model.hash)) {
      const ca = pa.model.camera ?? { yaw: 30, pitch: 15, zoom: 1 };
      const cb = pb.model.camera ?? { yaw: 30, pitch: 15, zoom: 1 };
      return {
        ...pb,
        opacity,
        model: {
          ...pb.model,
          camera: { yaw: lerp(ca.yaw, cb.yaw, t), pitch: lerp(ca.pitch, cb.pitch, t), zoom: lerp(ca.zoom, cb.zoom, t) },
          pose: lerp(pa.model.pose ?? 0, pb.model.pose ?? 0, t),
        },
      };
    }
    // Unchanged image/shader/pattern content can animate its opacity as well.
    if (JSON.stringify({ ...pa, opacity: 1 }) === JSON.stringify({ ...pb, opacity: 1 })) return { ...pb, opacity };
    if (pa.type === 'IMAGE' && pb.type === 'IMAGE' && (!pa.blendMode || pa.blendMode === 'NORMAL' || pa.blendMode === 'PASS_THROUGH')) {
      return { type: 'CROSSFADE', crossfade: { from: pa, to: pb, progress: t } };
    }
    return pb;
  });
}
