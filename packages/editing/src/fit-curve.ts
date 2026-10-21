// Fitting cubic curves to points: the pencil (freehand line — smooth curves) and path
// simplification. Schneider's algorithm (P. J. Schneider, “An Algorithm for Automatically Fitting Digitized
// Curves”, Graphics Gems, 1990): least-squares curve with chord-length parameterization,
// Newton refinement of the parameters, splitting at the point of maximum error. Sharp corners
// (the hand turned abruptly) are break points: each side gets its own curves, a corner stays a corner.

export interface CurvePoint {
  x: number;
  y: number;
}
/** Cubic curve: start, two control points, end. */
export type Cubic = [CurvePoint, CurvePoint, CurvePoint, CurvePoint];
type P = CurvePoint;

const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: P, k: number): P => ({ x: a.x * k, y: a.y * k });
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const norm = (a: P): P => {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};

function bezier(q: Cubic, t: number): P {
  const u = 1 - t;
  return {
    x: u * u * u * q[0].x + 3 * u * u * t * q[1].x + 3 * u * t * t * q[2].x + t * t * t * q[3].x,
    y: u * u * u * q[0].y + 3 * u * u * t * q[1].y + 3 * u * t * t * q[2].y + t * t * t * q[3].y,
  };
}

/** Points closer than eps to each other become one. */
export function dedupe(points: readonly P[], eps = 1e-6): P[] {
  const out: P[] = [];
  for (const p of points) if (!out.length || dist(out[out.length - 1]!, p) > eps) out.push({ x: p.x, y: p.y });
  return out;
}

/** Simpler polyline (Ramer–Douglas–Peucker): points deviating less than tolerance are dropped. */
export function simplifyPolyline(points: readonly P[], tolerance: number): P[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a]!;
    const pb = points[b]!;
    const d = sub(pb, pa);
    const len = Math.hypot(d.x, d.y);
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i]!;
      const e = len > 1e-12 ? Math.abs(d.x * (p.y - pa.y) - d.y * (p.x - pa.x)) / len : dist(p, pa);
      if (e > worst) {
        worst = e;
        at = i;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]).map((p) => ({ ...p }));
}

/**
 * Indices of corner points: the polyline direction turns sharper than minAngle (radians). Directions are
 * taken at distance reach along the polyline on both sides (hand jitter does not create false corners).
 */
export function cornerIndices(points: readonly P[], minAngle = (70 * Math.PI) / 180, reach = 4): number[] {
  const out: number[] = [];
  const n = points.length;
  if (n < 3) return out;
  // Length along the polyline.
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1]! + dist(points[i - 1]!, points[i]!));
  const at = (i: number, dir: 1 | -1): P => {
    let j = i;
    while (j + dir >= 0 && j + dir < n && Math.abs(s[j + dir]! - s[i]!) < reach) j += dir;
    if (j + dir >= 0 && j + dir < n && j === i) j += dir;
    return points[j]!;
  };
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const a = norm(sub(points[i]!, at(i, -1)));
    const b = norm(sub(at(i, 1), points[i]!));
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
    if (angle < minAngle) continue;
    // Of adjacent corners (one turn spread over several points) — the sharpest.
    if (s[i]! - last < reach && out.length) {
      const prev = out[out.length - 1]!;
      const pa = norm(sub(points[prev]!, at(prev, -1)));
      const pb = norm(sub(at(prev, 1), points[prev]!));
      if (angle > Math.acos(Math.max(-1, Math.min(1, dot(pa, pb))))) out[out.length - 1] = i;
      continue;
    }
    out.push(i);
    last = s[i]!;
  }
  return out;
}

/** Curves through the points with error at most error; corners are break points (see cornerIndices). */
export function fitCurve(points: readonly P[], error: number, corners: readonly number[] = []): Cubic[] {
  const pts = dedupe(points);
  if (pts.length < 2) return [];
  const cuts = [0, ...corners.filter((i) => i > 0 && i < pts.length - 1), pts.length - 1];
  const out: Cubic[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k]!;
    const b = cuts[k + 1]!;
    if (b - a < 1) continue;
    const d = pts.slice(a, b + 1);
    const t1 = norm(sub(d[1]!, d[0]!));
    const t2 = norm(sub(d[d.length - 2]!, d[d.length - 1]!));
    fitCubic(d, 0, d.length - 1, t1, t2, error, out);
  }
  return out;
}

function fitCubic(d: P[], first: number, last: number, tHat1: P, tHat2: P, error: number, out: Cubic[]) {
  if (last - first === 1) {
    const l = dist(d[last]!, d[first]!) / 3;
    out.push([d[first]!, add(d[first]!, mul(tHat1, l)), add(d[last]!, mul(tHat2, l)), d[last]!]);
    return;
  }
  let u = chordParams(d, first, last);
  let bez = generate(d, first, last, u, tHat1, tHat2);
  let [maxError, split] = maxDeviation(d, first, last, bez, u);
  if (maxError < error) {
    out.push(bez);
    return;
  }
  if (maxError < error * 4) {
    for (let i = 0; i < 4; i++) {
      const u2 = reparameterize(d, first, last, u, bez);
      bez = generate(d, first, last, u2, tHat1, tHat2);
      [maxError, split] = maxDeviation(d, first, last, bez, u2);
      if (maxError < error) {
        out.push(bez);
        return;
      }
      u = u2;
    }
  }
  const center = norm(sub(d[split - 1]!, d[split + 1]!));
  fitCubic(d, first, split, tHat1, center, error, out);
  fitCubic(d, split, last, mul(center, -1), tHat2, error, out);
}

function chordParams(d: P[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1]! + dist(d[i]!, d[i - 1]!));
  const total = u[u.length - 1]! || 1;
  return u.map((x) => x / total);
}

/** Fit one cubic for Delete and heal: preserve endpoints and endpoint directions. */
export function fitSingleCurve(points: readonly P[], startDirection?: P, endDirection?: P): Cubic | null {
  const d = dedupe(points);
  if (d.length < 2) return null;
  const last = d.length - 1;
  const t1 = norm(startDirection && Math.hypot(startDirection.x, startDirection.y) > 1e-9 ? startDirection : sub(d[1]!, d[0]!));
  const t2 = norm(endDirection && Math.hypot(endDirection.x, endDirection.y) > 1e-9 ? endDirection : sub(d[last - 1]!, d[last]!));
  let u = chordParams(d, 0, last);
  let best = generate(d, 0, last, u, t1, t2);
  let error = maxDeviation(d, 0, last, best, u)[0];
  for (let i = 0; i < 4; i++) {
    const next = reparameterize(d, 0, last, u, best);
    if (next.some((v, j) => !Number.isFinite(v) || v < 0 || v > 1 || (j > 0 && v < next[j - 1]!))) break;
    const candidate = generate(d, 0, last, next, t1, t2);
    const e = maxDeviation(d, 0, last, candidate, next)[0];
    if (e >= error) break;
    best = candidate; error = e; u = next;
  }
  return best;
}

function generate(d: P[], first: number, last: number, u: number[], tHat1: P, tHat2: P): Cubic {
  const p0 = d[first]!;
  const p3 = d[last]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i]!;
    const v = 1 - t;
    const b0 = v * v * v;
    const b1 = 3 * t * v * v;
    const b2 = 3 * t * t * v;
    const b3 = t * t * t;
    const a0 = mul(tHat1, b1);
    const a1 = mul(tHat2, b2);
    c00 += dot(a0, a0);
    c01 += dot(a0, a1);
    c11 += dot(a1, a1);
    const tmp = sub(d[first + i]!, add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a0, tmp);
    x1 += dot(a1, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let al = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let ar = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const seg = dist(p3, p0);
  const eps = 1e-6 * seg;
  if (al < eps || ar < eps) al = ar = seg / 3;
  return [p0, add(p0, mul(tHat1, al)), add(p3, mul(tHat2, ar)), p3];
}

function maxDeviation(d: P[], first: number, last: number, bez: Cubic, u: number[]): [number, number] {
  let max = 0;
  let split = Math.floor((first + last) / 2);
  for (let i = first + 1; i < last; i++) {
    const e = dist(bezier(bez, u[i - first]!), d[i]!);
    if (e > max) {
      max = e;
      split = i;
    }
  }
  return [max, split];
}

function reparameterize(d: P[], first: number, last: number, u: number[], bez: Cubic): number[] {
  return u.map((t, i) => newton(bez, d[first + i]!, t));
}

/** Newton step: the parameter of the curve point closest to P. */
function newton(q: Cubic, p: P, t: number): number {
  const qt = bezier(q, t);
  const q1 = [mul(sub(q[1], q[0]), 3), mul(sub(q[2], q[1]), 3), mul(sub(q[3], q[2]), 3)] as const;
  const q2 = [mul(sub(q1[1], q1[0]), 2), mul(sub(q1[2], q1[1]), 2)] as const;
  const v = 1 - t;
  const q1t = add(add(mul(q1[0], v * v), mul(q1[1], 2 * v * t)), mul(q1[2], t * t));
  const q2t = add(mul(q2[0], v), mul(q2[1], t));
  const num = (qt.x - p.x) * q1t.x + (qt.y - p.y) * q1t.y;
  const den = q1t.x * q1t.x + q1t.y * q1t.y + (qt.x - p.x) * q2t.x + (qt.y - p.y) * q2t.y;
  if (Math.abs(den) < 1e-12) return t;
  const r = t - num / den;
  return Math.max(0, Math.min(1, r));
}
