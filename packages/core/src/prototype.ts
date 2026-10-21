// Prototype: transition curves, values for variable actions, and the playback session.
//
// The session (PrototypeSession) works on its own copy of the document: switching an instance's variant
// (interactive components) and variable values change the copy and leave the original document alone.
// The session does not draw: it receives pointer and key events (the node path under the cursor is computed
// by the presentation, which knows the geometry including scrolling) and tells the presentation what to animate: a transition between
// screens, an overlay, a variant change, scrolling.

import { componentSetOf, propertyOwner, swapComponent } from './components.ts';
import { IDENTITY, multiply } from './geometry.ts';
import type { Document } from './document.ts';
import type { Easing, FlowStartingPoint, PrototypeAction, PrototypeDevice, PrototypeValue, Reaction, RGBA, Transition, Trigger, VariableValue } from './types.ts';
import { colorHex, collectionOf, findVariable, isAlias, isColor, modeFor, resolveVariable, setExplicitMode, setVariableValue } from './variables.ts';

// ---------- Curves ----------

/** Cubic Bézier (like CSS cubic-bezier): progress 0–1 → value. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton's method, then bisection if the derivative is small.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let [lo, hi] = [0, 1];
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** Spring: position (0 → 1) at time t, s; mass, stiffness, damping, initial velocity. */
export function springAt(t: number, mass: number, stiffness: number, damping: number, velocity = 0): number {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const x0 = -1; // initial offset from the target
  const v0 = velocity;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * w0 * t);
    return 1 + e * (x0 * Math.cos(wd * t) + ((v0 + zeta * w0 * x0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) {
    const e = Math.exp(-w0 * t);
    return 1 + e * (x0 + (v0 + w0 * x0) * t);
  }
  const s = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + s;
  const r2 = -zeta * w0 - s;
  const c2 = (v0 - r1 * x0) / (r2 - r1);
  const c1 = x0 - c2;
  return 1 + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
}

/** Built-in curves (CSS equivalents in developer mode). */
export const EASING_BEZIER: Partial<Record<Easing['type'], [number, number, number, number]>> = {
  EASE_IN: [0.42, 0, 1, 1],
  EASE_OUT: [0, 0, 0.58, 1],
  EASE_IN_AND_OUT: [0.42, 0, 0.58, 1],
  LINEAR: [0, 0, 1, 1],
  EASE_IN_BACK: [0.3, -0.05, 0.7, -0.5],
  EASE_OUT_BACK: [0.45, 1.45, 0.8, 1],
  EASE_IN_AND_OUT_BACK: [0.7, -0.4, 0.4, 1.4],
};

/** Built-in springs: mass, stiffness, damping. */
export const SPRING_PRESETS: Partial<Record<Easing['type'], [number, number, number]>> = {
  GENTLE: [1, 100, 15],
  QUICK: [1, 300, 20],
  BOUNCY: [1, 600, 15],
  SLOW: [1, 80, 20],
};

/** Whether this is a spring (its duration comes from physics). */
export const isSpring = (e: Easing) => !!SPRING_PRESETS[e.type] || e.type === 'CUSTOM_SPRING';

/** How long the spring takes to settle (offset below 0.1%), s. */
export function springDuration(mass: number, stiffness: number, damping: number, velocity = 0): number {
  let settled = 0;
  for (let t = 0; t < 10; t += 1 / 120) {
    if (Math.abs(springAt(t, mass, stiffness, damping, velocity) - 1) > 0.001) settled = t;
  }
  return Math.max(0.05, settled + 1 / 120);
}

/** Curve function: progress 0–1 (fraction of the duration) → value (springs may exceed 1). */
export function easingFunction(easing: Easing | undefined, duration: number): (p: number) => number {
  if (!easing) return (p) => p;
  if (easing.type === 'HOLD') return (p) => (p >= 1 ? 1 : 0);
  // bounce: a spring that settles within the transition duration.
  const bounce = easing.easingFunctionSpring?.bounce;
  if (bounce !== undefined && isSpring(easing)) {
    const sp = normalizedSpring(bounce, duration);
    return (p) => (p >= 1 ? 1 : springAt(p * duration, sp.mass, sp.stiffness, sp.damping, 0));
  }
  const sp = easing.easingFunctionSpring ?? (SPRING_PRESETS[easing.type] ? { mass: SPRING_PRESETS[easing.type]![0], stiffness: SPRING_PRESETS[easing.type]![1], damping: SPRING_PRESETS[easing.type]![2], initialVelocity: 0 } : undefined);
  if (sp && isSpring(easing)) return (p) => (p >= 1 ? 1 : springAt(p * duration, sp.mass, sp.stiffness, sp.damping, sp.initialVelocity));
  const b = easing.easingFunctionCubicBezier;
  const pts = b ? [b.x1, b.y1, b.x2, b.y2] : EASING_BEZIER[easing.type];
  if (!pts || easing.type === 'LINEAR') return (p) => p;
  return cubicBezier(pts[0]!, pts[1]!, pts[2]!, pts[3]!);
}

/**
 * Spring with bounce (0…1) that settles in duration seconds: natural period —
 * duration, damping ratio ζ = 1 − bounce.
 */
export function normalizedSpring(bounce: number, duration: number): { mass: number; stiffness: number; damping: number } {
  const d = Math.max(0.01, duration);
  const b = Math.max(0, Math.min(1, bounce));
  const w = (2 * Math.PI) / d;
  return { mass: 1, stiffness: w * w, damping: 2 * w * (1 - b) };
}

/** Bounce (0…1) of a physical spring: 1 − damping ratio (like figma.motion.physicalSpringToNormalized). */
export function physicalSpringToNormalized(sp: { mass: number; stiffness: number; damping: number }): number {
  const zeta = sp.damping / (2 * Math.sqrt(Math.max(1e-9, sp.stiffness * sp.mass)));
  return Math.max(0, Math.min(1, 1 - zeta));
}

// ---------- Variable action values ----------

const num = (v: VariableValue | undefined) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : typeof v === 'string' ? Number(v) : NaN);
const truthy = (v: VariableValue | undefined) => (typeof v === 'string' ? v !== '' && v !== 'false' : !!v);

/** A value (or a Figma expression: ADDITION, EQUALS, AND…) in the context of a layer. */
export function evaluatePrototypeValue(doc: Document, v: PrototypeValue | undefined, nodeId: string | null): VariableValue | undefined {
  if (!v) return undefined;
  const val = v.value;
  if (v.type === 'VARIABLE_ALIAS' || isAlias(val)) return isAlias(val) ? resolveVariable(doc, val.id, nodeId) : undefined;
  if (v.type !== 'EXPRESSION') return val as VariableValue | undefined;
  const e = val as { expressionFunction: string; expressionArguments: PrototypeValue[] };
  const args = (e.expressionArguments ?? []).map((a) => evaluatePrototypeValue(doc, a, nodeId));
  const [a, b] = args;
  switch (e.expressionFunction) {
    case 'ADDITION':
      return typeof a === 'string' || typeof b === 'string' ? `${String(a ?? '')}${String(b ?? '')}` : num(a) + num(b);
    case 'SUBTRACTION':
      return num(a) - num(b);
    case 'MULTIPLICATION':
      return num(a) * num(b);
    case 'DIVISION':
      return num(b) === 0 ? 0 : num(a) / num(b);
    case 'NEGATE':
      return -num(a);
    case 'EQUALS':
      return JSON.stringify(a) === JSON.stringify(b);
    case 'NOT_EQUAL':
      return JSON.stringify(a) !== JSON.stringify(b);
    case 'LESS_THAN':
      return num(a) < num(b);
    case 'LESS_THAN_OR_EQUAL':
      return num(a) <= num(b);
    case 'GREATER_THAN':
      return num(a) > num(b);
    case 'GREATER_THAN_OR_EQUAL':
      return num(a) >= num(b);
    case 'AND':
      return args.every(truthy);
    case 'OR':
      return args.some(truthy);
    case 'NOT':
      return !truthy(a);
    case 'STRINGIFY':
      return isColor(a) ? '' : String(a ?? '');
    default:
      return undefined;
  }
}

// ---------- Screens and flows ----------

const SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

/** The layer's screen: a frame directly on the page or in a section. */
export function screenOf(doc: Document, id: string): string | null {
  let found: string | null = null;
  for (let n: string | null = id; n; n = doc.parent(n)) {
    const p = doc.parent(n);
    if (!p) break;
    const pt = doc.type(p);
    if ((pt === 'PAGE' || pt === 'SECTION') && SCREEN_TYPES.has(doc.type(n)!)) found = n;
    if (pt === 'PAGE') break;
  }
  return found;
}

/** Where actions lead (including condition branches): target id and “Change to” (component variant). */
export function actionDestinations(actions: readonly PrototypeAction[], out: { to: string; change: boolean }[] = []): { to: string; change: boolean }[] {
  for (const a of actions) {
    if (a.type === 'NODE' && a.destinationId) out.push({ to: a.destinationId, change: a.navigation === 'CHANGE_TO' });
    if (a.type === 'CONDITIONAL') for (const b of a.conditionalBlocks) actionDestinations(b.actions, out);
  }
  return out;
}

/**
 * Pages needed by a presentation starting from page page: the page itself and every page its layers' connections lead to (and
 * further along the chain) — the prototype spans the whole file. Variants of interactive components and overlays
 * can also be on other pages.
 */
export function prototypePages(doc: Document, page: string): string[] {
  const pages = [page];
  const seen = new Set(pages);
  for (let i = 0; i < pages.length; i++) {
    for (const id of doc.descendants(pages[i]!)) {
      const reactions = doc.get(id, 'reactions');
      if (!reactions?.length) continue;
      for (const r of reactions) {
        for (const { to } of actionDestinations(r.actions)) {
          const p = doc.has(to) ? pageOf(doc, to) : null;
          if (p && !seen.has(p)) {
            seen.add(p);
            pages.push(p);
          }
        }
      }
    }
  }
  return pages;
}

/** The layer's page. */
export function pageOf(doc: Document, id: string): string | null {
  for (let n: string | null = id; n; n = doc.parent(n)) if (doc.type(n) === 'PAGE') return n;
  return null;
}

/** The page's flows (whose screen still exists). */
export function flowsOf(doc: Document, page: string): FlowStartingPoint[] {
  return (doc.get(page, 'flowStartingPoints') ?? []).filter((f) => doc.has(f.nodeId));
}

/** The page's first screen: the start of the first flow, otherwise the first frame. */
export function firstScreen(doc: Document, page: string): string | null {
  const flow = flowsOf(doc, page)[0];
  if (flow) return flow.nodeId;
  const walk = (id: string): string | null => {
    for (const c of doc.children(id)) {
      const t = doc.type(c);
      if (SCREEN_TYPES.has(t!)) return c;
      if (t === 'SECTION') {
        const r = walk(c);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(page);
}

/** The page's screens in layer order: frames on the page and in sections. */
export function screensOf(doc: Document, page: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const c of doc.children(id)) {
      const t = doc.type(c);
      if (SCREEN_TYPES.has(t!)) out.push(c);
      else if (t === 'SECTION') walk(c);
    }
  };
  walk(page);
  return out;
}

// ---------- Expressions (variable values and conditions) ----------

const BINARY: Record<string, string> = {
  '+': 'ADDITION',
  '-': 'SUBTRACTION',
  '*': 'MULTIPLICATION',
  '/': 'DIVISION',
  '==': 'EQUALS',
  '!=': 'NOT_EQUAL',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
};
const BINARY_TEXT: Record<string, string> = Object.fromEntries(Object.entries(BINARY).map(([k, v]) => [v, k]));

/** Expression value type (for resolvedType). */
function valueType(v: PrototypeValue): PrototypeValue['resolvedType'] {
  if (v.resolvedType) return v.resolvedType;
  if (v.type === 'BOOLEAN' || v.type === 'FLOAT' || v.type === 'STRING' || v.type === 'COLOR') return v.type;
  return undefined;
}

/**
 * Parse an expression from text: numbers, “strings”, true/false,
 * colors #RRGGBB, {Variable} or {Collection/Variable}; + − × ÷, comparisons, and / or / not, parentheses.
 * Returns the value as in the Plugin API (VariableData) or an error message.
 */
export function parsePrototypeExpression(doc: Document, text: string): PrototypeValue | { error: string } {
  const src = text.trim();
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const takeWord = (words: string[]) => {
    ws();
    const m = /^[A-Za-zА-Яа-яЁё]+/.exec(src.slice(i));
    const w = m?.[0].toLowerCase();
    if (w && words.includes(w)) {
      i += w.length;
      return w;
    }
    return null;
  };
  const op = (ops: string[]) => {
    ws();
    for (const o of ops) {
      if (src.startsWith(o, i)) {
        i += o.length;
        return o;
      }
    }
    return null;
  };
  const expr = (fn: string, args: PrototypeValue[], resolvedType: PrototypeValue['resolvedType']): PrototypeValue => ({ type: 'EXPRESSION', resolvedType, value: { expressionFunction: fn, expressionArguments: args } });
  const atom = (): PrototypeValue => {
    ws();
    const c = src[i];
    if (c === undefined) return fail('Выражение оборвано');
    if (c === '(') {
      i++;
      const v = orExpr();
      ws();
      if (src[i] !== ')') fail('Нет закрывающей скобки');
      i++;
      return v;
    }
    if (c === '{') {
      const end = src.indexOf('}', i);
      if (end < 0) fail('Нет закрывающей }');
      const name = src.slice(i + 1, end);
      i = end + 1;
      const id = findVariable(doc, name);
      if (!id) return fail(`Нет переменной «${name}»`);
      return { type: 'VARIABLE_ALIAS', resolvedType: doc.get(id, 'resolvedType') as PrototypeValue['resolvedType'], value: { type: 'VARIABLE_ALIAS', id } };
    }
    if (c === '"' || c === "'" || c === '«') {
      const close = c === '«' ? '»' : c;
      const end = src.indexOf(close, i + 1);
      if (end < 0) fail('Строка не закрыта');
      const v = src.slice(i + 1, end);
      i = end + 1;
      return { type: 'STRING', resolvedType: 'STRING', value: v };
    }
    const color = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?/.exec(src.slice(i));
    if (color) {
      i += color[0].length;
      const n = parseInt(color[1]!, 16);
      const rgba: RGBA = { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: color[2] ? parseInt(color[2], 16) / 255 : 1 };
      return { type: 'COLOR', resolvedType: 'COLOR', value: rgba };
    }
    const num = /^\d+(?:[.,]\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return { type: 'FLOAT', resolvedType: 'FLOAT', value: Number(num[0].replace(',', '.')) };
    }
    const b = takeWord(['истина', 'true', 'ложь', 'false', 'да', 'нет']);
    if (b) return { type: 'BOOLEAN', resolvedType: 'BOOLEAN', value: b === 'истина' || b === 'true' || b === 'да' };
    return fail(`Непонятно: «${src.slice(i, i + 12)}»`);
  };
  const unary = (): PrototypeValue => {
    if (op(['-', '−'])) {
      const v = unary();
      return v.type === 'FLOAT' && typeof v.value === 'number' ? { ...v, value: -v.value } : expr('NEGATE', [v], 'FLOAT');
    }
    return atom();
  };
  const product = (): PrototypeValue => {
    let a = unary();
    for (let o = op(['*', '×', '/', '÷']); o; o = op(['*', '×', '/', '÷'])) a = expr(o === '*' || o === '×' ? 'MULTIPLICATION' : 'DIVISION', [a, unary()], 'FLOAT');
    return a;
  };
  const sum = (): PrototypeValue => {
    let a = product();
    for (let o = op(['+', '-', '−']); o; o = op(['+', '-', '−'])) {
      const b = product();
      a = expr(o === '+' ? 'ADDITION' : 'SUBTRACTION', [a, b], o === '+' && (valueType(a) === 'STRING' || valueType(b) === 'STRING') ? 'STRING' : 'FLOAT');
    }
    return a;
  };
  const compare = (): PrototypeValue => {
    const a = sum();
    const o = op(['==', '!=', '≠', '<=', '≤', '>=', '≥', '<', '>', '=']);
    if (!o) return a;
    const key = o === '=' ? '==' : o === '≠' ? '!=' : o === '≤' ? '<=' : o === '≥' ? '>=' : o;
    return expr(BINARY[key]!, [a, sum()], 'BOOLEAN');
  };
  const notExpr = (): PrototypeValue => {
    ws();
    if (src[i] === '!' && src[i + 1] !== '=') {
      i++;
      return expr('NOT', [notExpr()], 'BOOLEAN');
    }
    if (takeWord(['не', 'not'])) return expr('NOT', [notExpr()], 'BOOLEAN');
    return compare();
  };
  const andExpr = (): PrototypeValue => {
    const args = [notExpr()];
    while (takeWord(['и', 'and']) ?? op(['&&'])) args.push(notExpr());
    return args.length > 1 ? expr('AND', args, 'BOOLEAN') : args[0]!;
  };
  const orExpr = (): PrototypeValue => {
    const args = [andExpr()];
    while (takeWord(['или', 'or']) ?? op(['||'])) args.push(andExpr());
    return args.length > 1 ? expr('OR', args, 'BOOLEAN') : args[0]!;
  };
  try {
    if (!src) return { error: 'Пустое выражение' };
    const v = orExpr();
    ws();
    if (i < src.length) fail(`Лишнее: «${src.slice(i, i + 12)}»`);
    return v;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Expression as text (for an input field) — the inverse of parsePrototypeExpression. */
export function formatPrototypeValue(doc: Document, v: PrototypeValue | undefined, top = true): string {
  if (!v) return '';
  const val = v.value;
  if (v.type === 'VARIABLE_ALIAS' || isAlias(val)) {
    const id = isAlias(val) ? val.id : '';
    return `{${(id && doc.has(id) ? doc.get(id, 'name') : null) ?? '?'}}`;
  }
  if (v.type === 'BOOLEAN') return val ? 'истина' : 'ложь';
  if (v.type === 'STRING') return `"${String(val ?? '')}"`;
  if (v.type === 'COLOR' && isColor(val)) return colorHex(val as RGBA);
  if (v.type === 'FLOAT') return String(val ?? 0);
  if (v.type !== 'EXPRESSION') return String(val ?? '');
  const e = val as { expressionFunction: string; expressionArguments: PrototypeValue[] };
  const args = (e.expressionArguments ?? []).map((a) => formatPrototypeValue(doc, a, false));
  let out: string;
  if (BINARY_TEXT[e.expressionFunction]) out = `${args[0] ?? ''} ${BINARY_TEXT[e.expressionFunction]} ${args[1] ?? ''}`;
  else if (e.expressionFunction === 'AND') out = args.join(' и ');
  else if (e.expressionFunction === 'OR') out = args.join(' или ');
  else if (e.expressionFunction === 'NOT') return `не ${args[0] ?? ''}`;
  else if (e.expressionFunction === 'NEGATE') return `-${args[0] ?? ''}`;
  else out = args.join(', ');
  return top ? out : `(${out})`;
}

/** Whether the layer has reactions (its own or the instance's main component's). */
export function reactionsOf(doc: Document, id: string): Reaction[] {
  const own = doc.get(id, 'reactions') ?? [];
  if (doc.type(id) !== 'INSTANCE') return own;
  // Instance: its own reactions and its component's reactions (interactive components); its own take precedence.
  const comp = doc.get(id, 'componentId');
  const main = comp && doc.has(comp) ? (doc.get(comp, 'reactions') ?? []) : [];
  const types = new Set(own.map((r) => r.trigger?.type));
  return [...own, ...main.filter((r) => !types.has(r.trigger?.type))];
}

/** Nodes with reactions in the subtree (for highlighting hotspots and keys). */
export function nodesWithReactions(doc: Document, root: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    if (reactionsOf(doc, id).some((r) => r.trigger && r.actions.length)) out.push(id);
    for (const c of doc.children(id)) walk(c);
  };
  walk(root);
  return out;
}

// ---------- Session ----------

/** An overlay on screen. */
export interface OverlayState {
  id: string;
  /** Where it was opened from (for the “manual” position and closing). */
  trigger: string | null;
  relative?: { x: number; y: number };
}

/** What the presentation should animate. */
export type SessionEvent =
  | { type: 'navigate'; from: string | null; to: string; transition: Transition | null; back?: boolean }
  | { type: 'overlay-open'; overlay: OverlayState; transition: Transition | null; swap?: boolean }
  | { type: 'overlay-close'; overlay: OverlayState; transition: Transition | null }
  | { type: 'change'; instance: string; from: string; to: string; transition: Transition | null; before: NodeSnapshot }
  | { type: 'scroll'; container: string; x: number; y: number; transition: Transition | null }
  | { type: 'url'; url: string; newTab: boolean }
  | { type: 'sound'; hash: string; volume: number }
  | { type: 'variables' }
  | { type: 'media'; action: Extract<PrototypeAction, { type: 'UPDATE_MEDIA_RUNTIME' }> }
  | { type: 'no-hotspot' };

/** Subtree state before a variant change (for morph): nodes by name paths. */
export interface NodeSnapshot {
  root: string;
  nodes: { path: string; id: string; props: Record<string, unknown>; type: string }[];
}

/** Subtree snapshot: node properties by name paths (the way morph matches them). */
export function snapshotByPath(doc: Document, root: string): NodeSnapshot {
  const nodes: NodeSnapshot['nodes'] = [];
  const walk = (id: string, path: string) => {
    const seen = new Map<string, number>();
    for (const c of doc.children(id)) {
      const name = doc.get(c, 'name') ?? '';
      const k = seen.get(name) ?? 0;
      seen.set(name, k + 1);
      const p = `${path}/${name}${k ? `#${k}` : ''}`;
      nodes.push({ path: p, id: c, props: { ...(doc.node(c)!.props as Record<string, unknown>) }, type: doc.type(c)! });
      walk(c, p);
    }
  };
  nodes.push({ path: '', id: root, props: { ...(doc.node(root)!.props as Record<string, unknown>) }, type: doc.type(root)! });
  walk(root, '');
  return { root, nodes };
}

interface HistoryEntry {
  screen: string;
  overlays: OverlayState[];
  /** The transition used to leave this screen (back uses the same one, reversed). */
  transition: Transition | null;
}

export interface SessionHost {
  /** An event for the presentation (animation, link, redraw). */
  emit(e: SessionEvent): void;
  /** Timer (trigger delays): return a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  /** The instance is about to change variant (the presentation remembers how it looked — for the dissolve). */
  willChange?(instance: string): void;
}

/**
 * Prototype playback session on its own copy of the document. The path under the pointer (path) is node ids from
 * the screen (or overlay) down to the topmost layer under the cursor.
 */
export class PrototypeSession {
  readonly doc: Document;
  readonly page: string;
  screen: string | null = null;
  overlays: OverlayState[] = [];
  /** Scroll offsets of frames (and the screen). */
  scroll = new Map<string, { x: number; y: number }>();
  /** Layers with an “On scroll” trigger (own and inherited reactions); null — collect again. */
  private scrollers: string[] | null = null;
  private history: HistoryEntry[] = [];
  private host: SessionHost;
  private hoverPath: string[] = [];
  private pressPath: string[] = [];
  /** “While hovering” / “While pressing”: what to restore when the pointer leaves or is released. */
  private reverts = new Map<string, () => void>();
  private timers: (() => void)[] = [];
  private start: string | null;

  constructor(doc: Document, page: string, host: SessionHost, start?: string | null) {
    this.doc = doc;
    this.page = page;
    this.host = host;
    this.start = start ?? firstScreen(doc, page);
  }

  /** The flow the presentation started from (null — not started from the beginning of a flow). */
  flow: FlowStartingPoint | null = null;

  /** Presentation device: the flow's own, otherwise null — the device of the screen's page. */
  get flowDevice(): PrototypeDevice | null {
    return this.flow?.device ?? null;
  }

  /** Start (or restart) from screen start. */
  begin(start = this.start) {
    this.flow = (start && flowsOf(this.doc, this.page).find((f) => f.nodeId === start)) || null;
    this.clearTimers();
    this.history = [];
    this.overlays = [];
    this.scroll.clear();
    this.reverts.clear();
    this.hoverPath = [];
    this.screen = null;
    if (!start || !this.doc.has(start)) return;
    this.show(start, null, false);
  }

  private clearTimers() {
    for (const c of this.timers) c();
    this.timers = [];
  }

  /** Show a screen (the transition is up to the presentation); starts “After delay” triggers. */
  private show(screen: string, transition: Transition | null, push = true, back = false) {
    const from = this.screen;
    if (push && from) this.history.push({ screen: from, overlays: [...this.overlays], transition });
    this.clearTimers();
    this.screen = screen;
    this.overlays = [];
    this.host.emit({ type: 'navigate', from, to: screen, transition, back });
    this.armTimeouts(screen);
  }

  /** “After delay” triggers of the screen and its interactive components. */
  private armTimeouts(root: string) {
    const visit = (id: string) => {
      for (const r of reactionsOf(this.doc, id)) {
        if (r.trigger?.type !== 'AFTER_TIMEOUT') continue;
        const t = r.trigger;
        const cancel = this.host.setTimer(() => this.run(id, r.actions), Math.max(0, t.timeout) * 1000);
        this.timers.push(cancel);
      }
      for (const c of this.doc.children(id)) visit(c);
    };
    if (this.doc.has(root)) visit(root);
  }

  /** A reaction with the trigger along the path (from the topmost layer to the screen). */
  private find(path: string[], types: Trigger['type'][]): { id: string; reaction: Reaction } | null {
    for (let i = path.length - 1; i >= 0; i--) {
      const id = path[i]!;
      if (!this.doc.has(id)) continue;
      const r = reactionsOf(this.doc, id).find((x) => x.trigger && types.includes(x.trigger.type) && x.actions.length);
      if (r) return { id, reaction: r };
    }
    return null;
  }

  /** Click. No hotspot — the presentation highlights them. */
  click(path: string[]) {
    // A click outside an overlay with “Close when clicking outside”.
    const top = this.overlays[this.overlays.length - 1];
    if (top && !path.includes(top.id) && this.doc.get(top.id, 'overlayBackgroundInteraction') === 'CLOSE_ON_CLICK_OUTSIDE') {
      this.closeOverlay(top, null);
      return;
    }
    const hit = this.find(path, ['ON_CLICK', 'ON_DRAG']);
    if (!hit) {
      this.host.emit({ type: 'no-hotspot' });
      return;
    }
    this.run(hit.id, hit.reaction.actions);
  }

  /** Double click (our own): an ON_DOUBLE_CLICK reaction along the path. */
  doubleClick(path: string[]) {
    const hit = this.find(path, ['ON_DOUBLE_CLICK']);
    if (hit) this.run(hit.id, hit.reaction.actions);
  }

  /** Right click (our own): an ON_RIGHT_CLICK reaction along the path; false — none. */
  rightClick(path: string[]): boolean {
    const hit = this.find(path, ['ON_RIGHT_CLICK']);
    if (hit) this.run(hit.id, hit.reaction.actions);
    return !!hit;
  }

  /** Whether the path has a double click: then a single click waits to see if a second one follows. */
  wantsDoubleClick(path: string[]): boolean {
    return !!this.find(path, ['ON_DOUBLE_CLICK']);
  }

  /** Pointer over a path: enter, leave, “While hovering”. */
  hover(path: string[]) {
    const prev = this.hoverPath;
    this.hoverPath = path;
    const left = prev.filter((id) => !path.includes(id));
    const entered = path.filter((id) => !prev.includes(id));
    // Leave goes from top to bottom; enter — from bottom (screen) to top.
    for (let i = left.length - 1; i >= 0; i--) {
      const id = left[i]!;
      const revert = this.reverts.get(`hover:${id}`);
      if (revert) {
        this.reverts.delete(`hover:${id}`);
        revert();
      }
      if (!this.doc.has(id)) continue;
      for (const r of reactionsOf(this.doc, id)) if (r.trigger?.type === 'MOUSE_LEAVE') this.delayed(id, r);
    }
    for (const id of entered) {
      if (!this.doc.has(id)) continue;
      for (const r of reactionsOf(this.doc, id)) {
        if (r.trigger?.type === 'MOUSE_ENTER') this.delayed(id, r);
        else if (r.trigger?.type === 'ON_HOVER') this.whileActive(`hover:${id}`, id, r);
      }
    }
  }

  pointerDown(path: string[]) {
    this.pressPath = path;
    for (let i = path.length - 1; i >= 0; i--) {
      const id = path[i]!;
      if (!this.doc.has(id)) continue;
      for (const r of reactionsOf(this.doc, id)) {
        if (r.trigger?.type === 'MOUSE_DOWN') this.delayed(id, r);
        else if (r.trigger?.type === 'ON_PRESS') this.whileActive(`press:${id}`, id, r);
      }
    }
  }

  pointerUp(path: string[]) {
    for (const id of this.pressPath) {
      const revert = this.reverts.get(`press:${id}`);
      if (revert) {
        this.reverts.delete(`press:${id}`);
        revert();
      }
    }
    this.pressPath = [];
    for (let i = path.length - 1; i >= 0; i--) {
      const id = path[i]!;
      if (!this.doc.has(id)) continue;
      for (const r of reactionsOf(this.doc, id)) if (r.trigger?.type === 'MOUSE_UP') this.delayed(id, r);
    }
  }

  /**
   * Video of layer id: ended (ON_MEDIA_END) or passed a time point (ON_MEDIA_HIT — mediaHitTime between
   * from and to, seconds).
   */
  media(id: string, kind: 'end' | 'time', from = 0, to = 0) {
    if (!this.doc.has(id)) return;
    for (const r of reactionsOf(this.doc, id)) {
      const t = r.trigger;
      if (kind === 'end' && t?.type === 'ON_MEDIA_END') this.run(id, r.actions);
      else if (kind === 'time' && t?.type === 'ON_MEDIA_HIT' && t.mediaHitTime > from && t.mediaHitTime <= to) this.run(id, r.actions);
    }
  }

  /**
   * Input field: a new value (submit — Enter). The value goes into the field's variable (in the layer's mode),
   * then the “On input” reactions of this layer run (on Enter or on every change).
   */
  input(id: string, value: string, submit: boolean) {
    const doc = this.doc;
    const spec = doc.get(id, 'prototypeInput');
    if (!spec) return;
    if (spec.variableId && doc.has(spec.variableId)) {
      const coll = collectionOf(doc, spec.variableId);
      const mode = coll ? modeFor(doc, id, coll) : '';
      doc.transact(() => setVariableValue(doc, spec.variableId!, mode, value), 'prototype');
      this.host.emit({ type: 'variables' });
    }
    for (const r of reactionsOf(doc, id)) if (r.trigger?.type === 'ON_TEXT_INPUT' && r.trigger.submit === submit) this.run(id, r.actions);
  }

  /**
   * Key: ON_KEY_DOWN reactions in the topmost overlay, otherwise on the screen (top to bottom through layers).
   * gamepad — a gamepad button (index in the standard W3C mapping): only triggers with a controller.
   */
  key(keyCode: number, gamepad = false): boolean {
    const roots = [...this.overlays.map((o) => o.id).reverse(), ...(this.screen ? [this.screen] : [])];
    for (const root of roots) {
      const ids = nodesWithReactions(this.doc, root).reverse();
      for (const id of ids) {
        const r = reactionsOf(this.doc, id).find((x) => x.trigger?.type === 'ON_KEY_DOWN' && x.trigger.keyCodes.includes(keyCode) && ((x.trigger.device ?? 'KEYBOARD') !== 'KEYBOARD') === gamepad);
        if (r) {
          this.run(id, r.actions);
          return true;
        }
      }
    }
    return false;
  }

  private delayed(id: string, r: Reaction) {
    const delay = r.trigger && 'delay' in r.trigger ? r.trigger.delay : 0;
    if (delay > 0) this.timers.push(this.host.setTimer(() => this.run(id, r.actions), delay * 1000));
    else this.run(id, r.actions);
  }

  /** “While hovering” / “While pressing”: the action now, its inverse later. */
  private whileActive(key: string, id: string, r: Reaction) {
    const before = { screen: this.screen, overlays: [...this.overlays] };
    const instance = this.changeTarget(id, r.actions);
    const variant = instance ? this.doc.get(instance, 'componentId') : null;
    this.run(id, r.actions);
    // The variant set by hovering: a click over the hover (another variant) does not cancel the leave.
    const shown = instance && this.doc.has(instance) ? this.doc.get(instance, 'componentId') : null;
    this.reverts.set(key, () => {
      if (instance && variant && this.doc.has(instance) && this.doc.get(instance, 'componentId') !== variant) {
        if (this.doc.get(instance, 'componentId') !== shown) return;
        const tr = (r.actions.find((a) => a.type === 'NODE') as Extract<PrototypeAction, { type: 'NODE' }> | undefined)?.transition ?? null;
        this.changeTo(instance, variant, tr);
        return;
      }
      // An overlay opened by hovering is closed.
      const opened = this.overlays.filter((o) => !before.overlays.some((b) => b.id === o.id));
      for (const o of opened.reverse()) this.closeOverlay(o, null);
    });
  }

  /** The instance whose variant the actions will change (for restoring). */
  private changeTarget(trigger: string, actions: PrototypeAction[]): string | null {
    const a = actions.find((x) => x.type === 'NODE' && x.navigation === 'CHANGE_TO') as Extract<PrototypeAction, { type: 'NODE' }> | undefined;
    return a?.destinationId ? this.instanceFor(trigger, a.destinationId) : null;
  }

  /** The instance “Change to” applies to: the nearest one whose component is a variant of the same set. */
  private instanceFor(trigger: string, destination: string): string | null {
    const set = componentSetOf(this.doc, destination);
    for (let n: string | null = trigger; n; n = this.doc.parent(n)) {
      if (this.doc.type(n) !== 'INSTANCE') continue;
      const c = this.doc.get(n, 'componentId');
      if (c === destination || (set && c && componentSetOf(this.doc, c) === set)) return n;
    }
    // A reaction on the variant itself (presenting the main component) — no change.
    void propertyOwner;
    return null;
  }

  /** Change the instance's variant (in the document copy). */
  private changeTo(instance: string, to: string, transition: Transition | null) {
    const from = this.doc.get(instance, 'componentId')!;
    if (from === to) return;
    const before = snapshotByPath(this.doc, instance);
    this.host.willChange?.(instance);
    this.doc.transact(() => swapComponent(this.doc, instance, to), 'prototype');
    this.host.emit({ type: 'change', instance, from, to, transition, before });
    // The new variant: its “After delay” triggers.
    this.armTimeouts(instance);
  }

  private closeOverlay(o: OverlayState, transition: Transition | null) {
    this.overlays = this.overlays.filter((x) => x !== o);
    this.host.emit({ type: 'overlay-close', overlay: o, transition });
  }

  /** Run actions in order. */
  run(trigger: string, actions: PrototypeAction[]) {
    for (const a of actions) this.action(trigger, a);
  }

  private action(trigger: string, a: PrototypeAction) {
    const doc = this.doc;
    switch (a.type) {
      case 'BACK': {
        if (this.overlays.length) {
          this.closeOverlay(this.overlays[this.overlays.length - 1]!, null);
          return;
        }
        const prev = this.history.pop();
        if (!prev) return;
        // Back uses the same transition (the presentation plays it in reverse).
        this.show(prev.screen, prev.transition, false, true);
        this.overlays = prev.overlays;
        return;
      }
      case 'CLOSE': {
        // Close the overlay containing the trigger (otherwise the topmost one).
        const own = [...this.overlays].reverse().find((o) => isInside(doc, trigger, o.id)) ?? this.overlays[this.overlays.length - 1];
        if (own) this.closeOverlay(own, null);
        return;
      }
      case 'URL':
        this.host.emit({ type: 'url', url: a.url, newTab: a.openInNewTab !== false });
        return;
      case 'SOUND':
        if (a.soundHash) this.host.emit({ type: 'sound', hash: a.soundHash, volume: a.volume ?? 1 });
        return;
      case 'SET_VARIABLE': {
        if (!a.variableId || !doc.has(a.variableId)) return;
        const value = evaluatePrototypeValue(doc, a.variableValue, trigger);
        if (value === undefined) return;
        const coll = collectionOf(doc, a.variableId);
        const mode = coll ? modeFor(doc, trigger, coll) : '';
        doc.transact(() => setVariableValue(doc, a.variableId!, mode, value), 'prototype');
        this.host.emit({ type: 'variables' });
        return;
      }
      case 'SET_VARIABLE_MODE': {
        if (!a.variableCollectionId || !a.variableModeId || !this.screen) return;
        // The mode belongs to the screen with the trigger (for an overlay — to the overlay).
        const root = [...this.overlays].reverse().find((o) => isInside(doc, trigger, o.id))?.id ?? this.screen;
        doc.transact(() => setExplicitMode(doc, root, a.variableCollectionId!, a.variableModeId!), 'prototype');
        this.host.emit({ type: 'variables' });
        return;
      }
      case 'CONDITIONAL': {
        for (const block of a.conditionalBlocks) {
          if (block.condition && !truthy(evaluatePrototypeValue(doc, block.condition, trigger))) continue;
          this.run(trigger, block.actions);
          return;
        }
        return;
      }
      case 'UPDATE_MEDIA_RUNTIME':
        this.host.emit({ type: 'media', action: a });
        return;
      case 'NODE': {
        const dest = a.destinationId;
        if (!dest || !doc.has(dest)) return;
        switch (a.navigation) {
          case 'NAVIGATE': {
            const screen = screenOf(doc, dest) ?? dest;
            if (!a.preserveScrollPosition) this.scroll.delete(screen);
            this.show(screen, a.transition);
            return;
          }
          case 'OVERLAY': {
            if (this.overlays.some((o) => o.id === dest)) return;
            const o: OverlayState = { id: dest, trigger, relative: a.overlayRelativePosition };
            this.overlays.push(o);
            this.host.emit({ type: 'overlay-open', overlay: o, transition: a.transition });
            this.armTimeouts(dest);
            return;
          }
          case 'SWAP': {
            const top = [...this.overlays].reverse().find((o) => isInside(doc, trigger, o.id)) ?? this.overlays[this.overlays.length - 1];
            if (!top) {
              this.show(screenOf(doc, dest) ?? dest, a.transition);
              return;
            }
            const o: OverlayState = { id: dest, trigger: top.trigger, relative: top.relative };
            this.overlays = this.overlays.map((x) => (x === top ? o : x));
            this.host.emit({ type: 'overlay-open', overlay: o, transition: a.transition, swap: true });
            this.armTimeouts(dest);
            return;
          }
          case 'SCROLL_TO': {
            const container = scrollContainer(doc, dest);
            if (!container) return;
            const [x, y] = offsetWithin(doc, dest, container);
            this.scroll.set(container, { x: Math.max(0, x), y: Math.max(0, y) });
            this.host.emit({ type: 'scroll', container, x: Math.max(0, x), y: Math.max(0, y), transition: a.transition });
            return;
          }
          case 'CHANGE_TO': {
            const instance = this.instanceFor(trigger, dest);
            if (instance) this.changeTo(instance, dest, a.transition);
            // Another variant means other reactions: collect the “On scroll” layers again.
            this.scrollers = null;
            return;
          }
        }
      }
    }
  }

  /**
   * A container (screen or scrolling frame) was scrolled from prev to next; view — its viewport size.
   * Fires “On scroll” triggers of layers for which it is the nearest scrollable ancestor
   * (for “To mark” — also of the container itself): “To mark” — the scroll passed the mark,
   * “layer appeared” — the layer was outside the viewport and moved into it. No own state: the difference between prev and next decides.
   */
  scrolled(container: string, prev: { x: number; y: number }, next: { x: number; y: number }, view: { w: number; h: number }) {
    if (prev.x === next.x && prev.y === next.y) return;
    const doc = this.doc;
    if (!this.scrollers) {
      this.scrollers = [];
      for (const id of doc.descendants(doc.root)) if (reactionsOf(doc, id).some((r) => r.trigger?.type === 'ON_SCROLL')) this.scrollers.push(id);
    }
    const horizontal = doc.get(container, 'overflowDirection') === 'HORIZONTAL';
    const p = horizontal ? prev.x : prev.y;
    const n = horizontal ? next.x : next.y;
    for (const id of this.scrollers) {
      if (!doc.has(id) || doc.get(id, 'visible') === false) continue;
      const own = id === container;
      if (!own && this.scrollContainer(id) !== container) continue;
      for (const r of reactionsOf(doc, id)) {
        const t = r.trigger;
        if (t?.type !== 'ON_SCROLL') continue;
        let fire = false;
        if (t.scroll === 'OFFSET') {
          // For a nested scrolling frame, “To mark” refers to its own scrolling.
          if (!own && (doc.get(id, 'overflowDirection') ?? 'NONE') !== 'NONE') continue;
          const down = p < t.offset && n >= t.offset;
          const up = p >= t.offset && n < t.offset;
          fire = t.direction === 'DOWN' ? down : t.direction === 'UP' ? up : down || up;
        } else if (!own) {
          const box = boxWithin(doc, id, container);
          fire = !!box && !inView(box, prev, view) && inView(box, next, view);
        }
        if (fire) this.run(id, r.actions);
      }
    }
  }

  /** The layer's nearest scrollable ancestor (a scrolling frame or the screen). */
  private scrollContainer(id: string): string | null {
    const doc = this.doc;
    for (let n = doc.parent(id); n; n = doc.parent(n)) {
      if ((doc.get(n, 'overflowDirection') ?? 'NONE') !== 'NONE') return n;
      const p = doc.parent(n);
      if (!p || doc.type(p) === 'PAGE' || doc.type(p) === 'SECTION') return n;
    }
    return null;
  }

  /** Back through history (presentation button). */
  back() {
    this.action(this.screen ?? '', { type: 'BACK' });
  }
}

/** A node inside root (or root itself). */
export function isInside(doc: Document, id: string, root: string): boolean {
  for (let n: string | null = id; n; n = doc.parent(n)) if (n === root) return true;
  return false;
}

/** Scrollable ancestor (the nearest one that scrolls, otherwise the screen). */
export function scrollContainer(doc: Document, id: string): string | null {
  for (let n = doc.parent(id); n; n = doc.parent(n)) {
    if ((doc.get(n, 'overflowDirection') ?? 'NONE') !== 'NONE') return n;
    const p = doc.parent(n);
    if (p && (doc.type(p) === 'PAGE' || doc.type(p) === 'SECTION')) return n;
  }
  return null;
}

/** Node position inside the container (sum of offsets). */
export function offsetWithin(doc: Document, id: string, container: string): [number, number] {
  let x = 0;
  let y = 0;
  for (let n: string | null = id; n && n !== container; n = doc.parent(n)) {
    const t = doc.get(n, 'transform') ?? [1, 0, 0, 0, 1, 0];
    x += t[2];
    y += t[5];
  }
  return [x, y];
}

/** Reverse transition (for “back”): opposite direction, move in ↔ push, slide out ↔ slide in. */
export function reverseTransition(t: Transition | null): Transition | null {
  if (!t || !('direction' in t)) return t;
  const flip = { LEFT: 'RIGHT', RIGHT: 'LEFT', TOP: 'BOTTOM', BOTTOM: 'TOP' } as const;
  const type = t.type === 'MOVE_IN' ? 'MOVE_OUT' : t.type === 'MOVE_OUT' ? 'MOVE_IN' : t.type === 'SLIDE_IN' ? 'SLIDE_OUT' : t.type === 'SLIDE_OUT' ? 'SLIDE_IN' : t.type;
  return { ...t, type, direction: flip[t.direction] };
}

/** The “Instant” transition. */
export const isInstant = (t: Transition | null | undefined) => !t || t.duration <= 0;

/** Transition duration, s (for springs — from physics if not set). */
export function transitionDuration(t: Transition | null | undefined): number {
  if (!t) return 0;
  if (t.duration > 0) return t.duration;
  const e = t.easing;
  const sp = e.easingFunctionSpring ?? (SPRING_PRESETS[e.type] ? { mass: SPRING_PRESETS[e.type]![0], stiffness: SPRING_PRESETS[e.type]![1], damping: SPRING_PRESETS[e.type]![2], initialVelocity: 0 } : null);
  return sp ? springDuration(sp.mass, sp.stiffness, sp.damping, sp.initialVelocity) : 0;
}

/** Layer bounds in the coordinates of the container's (an ancestor's) content; null — the layer is not inside. */
function boxWithin(doc: Document, id: string, container: string): [number, number, number, number] | null {
  let m = IDENTITY;
  let n: string | null = id;
  for (; n && n !== container; n = doc.parent(n)) m = multiply(doc.get(n, 'transform') ?? IDENTITY, m);
  if (n !== container) return null;
  const w = doc.get(id, 'width') ?? 0;
  const h = doc.get(id, 'height') ?? 0;
  const xs = [0, w, 0, w].map((x, i) => m[0] * x + m[1] * [0, 0, h, h][i]! + m[2]);
  const ys = [0, w, 0, w].map((x, i) => m[3] * x + m[4] * [0, 0, h, h][i]! + m[5]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** The bounds are at least partly within the viewport of the container scrolled to at. */
function inView(b: [number, number, number, number], at: { x: number; y: number }, view: { w: number; h: number }): boolean {
  return b[2] > at.x && b[0] < at.x + view.w && b[3] > at.y && b[1] < at.y + view.h;
}
