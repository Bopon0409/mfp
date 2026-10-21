// Arrange along an arc or circle (MFP extension): different selected
// layers are placed with their centers on a circle with the given radius, start angle and arc sweep,
// optionally rotated “top outward”. Angles are in screen degrees: 0 — right, −90 — up,
// clockwise.

export interface ArcOptions {
  cx: number;
  cy: number;
  radius: number;
  /** Angle of the first layer. */
  start: number;
  /** Arc sweep: 360 — a full circle (layers at equal fractions), less — from start to end inclusive. */
  sweep: number;
  /** Rotate layers top outward (along the tangent). */
  rotate: boolean;
}

export interface ArcPlace {
  x: number;
  y: number;
  /** Angle of a point on the circle, screen degrees. */
  angle: number;
  /** Layer rotation (counterclockwise is positive) with rotate; otherwise undefined. */
  rotation?: number;
}

/** Positions for n layers in order. */
export function arcPlaces(n: number, o: ArcOptions): ArcPlace[] {
  const full = Math.abs(o.sweep) >= 359.999;
  const step = n <= 1 ? 0 : o.sweep / (full ? n : n - 1);
  return Array.from({ length: n }, (_, i) => {
    const angle = o.start + step * i;
    const a = (angle * Math.PI) / 180;
    const place: ArcPlace = { x: o.cx + o.radius * Math.cos(a), y: o.cy + o.radius * Math.sin(a), angle };
    if (o.rotate) {
      // The layer top (−y) faces outward: clockwise rotation by angle + 90 — negative in the model.
      let r = -(angle + 90);
      r = ((((r + 180) % 360) + 360) % 360) - 180;
      place.rotation = Math.round(r * 1000) / 1000;
    }
    return place;
  });
}

/**
 * Layer order around the circle — by their current angle around the common center (starting at the
 * top, clockwise): rearranging again does not shuffle the layers.
 */
export function arcOrder<T extends { x: number; y: number }>(items: T[], cx: number, cy: number): T[] {
  const ang = (p: { x: number; y: number }) => {
    const a = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
    return (((a + 90) % 360) + 360) % 360;
  };
  return [...items].sort((p, q) => ang(p) - ang(q));
}
