// Shader fill: SkSL code with the function
// half4 main(float2 p), p — a point of the layer in its units. The renderer itself sets uniforms size
// (layer size) and time (seconds — animation on the canvas and in presentation). Other uniforms are
// fill parameters: the label, default value and limits go in a comment after the declaration:
//   uniform float scale; // Scale: 3 (0.5..20)
//   uniform half4 tint;  // Color: #FF5A36
// The built-in shaders (SHADER_PRESETS) are our own, written for MFP.

export interface ShaderParam {
  name: string;
  /** A number, a vector (2–3 numbers) or a color (half4/float4 with a default color). */
  kind: 'float' | 'vec' | 'color';
  size: number;
  label: string;
  value: number[];
  min?: number;
  max?: number;
}

/** Uniforms set by the renderer (not parameters). */
export const SHADER_BUILTINS = new Set(['size', 'time']);

// Keep trailing // annotations, but never interpret declarations inside comments.
const parameterSource = (code: string) => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) =>
  comment.startsWith('/*') ? comment.replace(/[^\n]/g, ' ') : comment);
const uncommented = (code: string) => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');

/** Shader parameters from uniform declarations (in code order). */
export function shaderParams(code: string): ShaderParam[] {
  const out: ShaderParam[] = [];
  const source = parameterSource(code);
  const re = /\/\/[^\n]*|\buniform\s+(float|half)([234]?)\s+(\w+)\s*;[ \t]*(?:\/\/[ \t]*([^\n]*))?/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (!m[1]) continue;
    const name = m[3]!;
    if (SHADER_BUILTINS.has(name)) continue;
    const size = Number(m[2] || 1);
    const note = (m[4] ?? '').trim();
    const [label = name, rest = ''] = note.includes(':') ? [note.slice(0, note.indexOf(':')).trim(), note.slice(note.indexOf(':') + 1).trim()] : [note || name, ''];
    const hex = /#([0-9a-f]{6})([0-9a-f]{2})?/i.exec(rest);
    if (size === 4 && hex) {
      const n = (i: number) => parseInt(hex[1]!.slice(i, i + 2), 16) / 255;
      out.push({ name, kind: 'color', size, label, value: [n(0), n(2), n(4), hex[2] ? parseInt(hex[2], 16) / 255 : 1] });
      continue;
    }
    const nums = (rest.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const range = /\((-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)\)/.exec(rest);
    const def = range ? (rest.slice(0, range.index).match(/-?\d+(\.\d+)?/g) ?? []).map(Number) : nums;
    const value = Array.from({ length: size }, (_, i) => def[i] ?? def[0] ?? 0);
    out.push({ name, kind: size === 1 ? 'float' : 'vec', size, label, value, ...(range ? { min: Number(range[1]), max: Number(range[2]) } : {}) });
  }
  return out;
}

/** The shader changes over time (declares uniform time). */
export const shaderUsesTime = (code: string) => /\buniform\s+(float|half)\s+time\s*;/.test(uncommented(code));

/** Validate child shaders before calling CanvasKit (wrong child counts can assert in WASM). */
export function shaderContractError(code: string, kind: 'fill' | 'effect'): string | null {
  const children = [...uncommented(code).matchAll(/\buniform\s+shader\s+([^;]+);/g)].map((m) => m[1]!.trim());
  if (kind === 'fill') return children.length ? 'Заливка не принимает входной shader. Используйте эффект для обработки слоя.' : null;
  return children.length === 1 && children[0] === 'content' ? null : 'Эффект должен объявлять ровно один uniform shader content;';
}

export const SHADER_EFFECT_PRESETS: { id: string; name: string; code: string }[] = [
  {
    id: 'effect-duotone', name: 'Дуотон',
    code: `uniform shader content;
uniform half4 dark; // Тёмный: #182248
uniform half4 light; // Светлый: #FFCD88
uniform float amount; // Сила: 1 (0..1)
half4 main(float2 p) {
  half4 c = content.eval(p);
  half3 rgb = c.a > 0 ? c.rgb / c.a : half3(0);
  half l = dot(rgb, half3(0.2126, 0.7152, 0.0722));
  half3 mapped = mix(dark.rgb, light.rgb, l);
  return half4(mix(c.rgb, mapped * c.a, half(amount)), c.a);
}`,
  },
  {
    id: 'effect-invert', name: 'Инверсия',
    code: `uniform shader content;
uniform float amount; // Сила: 1 (0..1)
half4 main(float2 p) {
  half4 c = content.eval(p);
  return half4(mix(c.rgb, half3(c.a) - c.rgb, half(amount)), c.a);
}`,
  },
  {
    id: 'effect-wave', name: 'Волновое искажение',
    code: `uniform shader content;
uniform float2 size;
uniform float time;
uniform float amplitude; // Амплитуда: 4 (0..40)
uniform float frequency; // Частота: 3 (0.1..12)
uniform float speed; // Скорость: 1 (0..5)
half4 main(float2 p) {
  float x = p.x + sin(p.y / max(size.y, 1.0) * 6.283185 * frequency + time * speed) * amplitude;
  return content.eval(float2(x, p.y));
}`,
  },
];

const NOISE = `
float hash(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
float noise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + float2(1.0, 0.0)), u.x), mix(hash(i + float2(0.0, 1.0)), hash(i + float2(1.0, 1.0)), u.x), u.y);
}`;

export const SHADER_PRESETS: { id: string; name: string; code: string }[] = [
  {
    id: 'mesh',
    name: 'Сетчатый градиент',
    code: `uniform float2 size;
uniform float time;
uniform half4 colorA; // Цвет 1: #FF6B4A
uniform half4 colorB; // Цвет 2: #FFC24B
uniform half4 colorC; // Цвет 3: #6B5BFF
uniform half4 colorD; // Цвет 4: #2DD4BF
uniform float warp; // Изгиб: 0.5 (0..1)
uniform float speed; // Скорость: 0.3 (0..2)

half4 main(float2 p) {
  float2 uv = p / size;
  float t = time * speed;
  uv += warp * 0.22 * float2(sin(uv.y * 5.0 + t), cos(uv.x * 4.0 - t * 1.3));
  float sx = smoothstep(0.0, 1.0, uv.x);
  half4 top = mix(colorA, colorB, half(sx));
  half4 bottom = mix(colorC, colorD, half(sx));
  return mix(top, bottom, half(smoothstep(0.0, 1.0, uv.y)));
}
`,
  },
  {
    id: 'grain',
    name: 'Зернистый градиент',
    code: `uniform float2 size;
uniform half4 colorA; // Цвет 1: #7C3AED
uniform half4 colorB; // Цвет 2: #F472B6
uniform float angle; // Угол: 45 (0..360)
uniform float grain; // Зерно: 0.14 (0..0.5)

float hash(float2 p) { return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }

half4 main(float2 p) {
  float a = radians(angle);
  float2 d = float2(cos(a), sin(a));
  float2 uv = p / size - 0.5;
  float t = clamp(dot(uv, d) / (abs(d.x) + abs(d.y)) + 0.5, 0.0, 1.0);
  half4 c = mix(colorA, colorB, half(t));
  float n = hash(floor(p)) - 0.5;
  return half4(clamp(c.rgb + half(n * grain), 0.0, 1.0), c.a);
}
`,
  },
  {
    id: 'clouds',
    name: 'Облака',
    code: `uniform float2 size;
uniform float time;
uniform half4 colorA; // Фон: #0F172A
uniform half4 colorB; // Облака: #38BDF8
uniform float scale; // Масштаб: 3 (0.5..20)
uniform float speed; // Скорость: 0.15 (0..2)
${NOISE}

half4 main(float2 p) {
  float2 uv = p / max(size.x, size.y) * scale;
  float t = time * speed;
  float v = 0.0;
  float amp = 0.5;
  for (int k = 0; k < 5; k++) {
    v += amp * noise(uv + float2(t, t * 0.6));
    uv = uv * 2.0 + float2(1.7, 9.2);
    amp *= 0.5;
  }
  return mix(colorA, colorB, half(smoothstep(0.25, 0.8, v)));
}
`,
  },
  {
    id: 'waves',
    name: 'Волны',
    code: `uniform float2 size;
uniform float time;
uniform half4 colorA; // Цвет 1: #1E3A8A
uniform half4 colorB; // Цвет 2: #93C5FD
uniform float count; // Полос: 8 (1..40)
uniform float height; // Изгиб: 0.06 (0..0.3)
uniform float speed; // Скорость: 0.6 (0..3)

half4 main(float2 p) {
  float2 uv = p / size;
  float y = uv.y + height * sin(uv.x * 12.566 + time * speed);
  float s = 0.5 + 0.5 * sin(y * count * 6.2832);
  return mix(colorA, colorB, half(smoothstep(0.3, 0.7, s)));
}
`,
  },
  {
    id: 'halftone',
    name: 'Полутон',
    code: `uniform float2 size;
uniform half4 colorA; // Фон: #FFFFFF
uniform half4 colorB; // Точки: #111827
uniform float cell; // Шаг: 14 (3..60)
uniform float angle; // Наклон: 45 (0..90)

half4 main(float2 p) {
  float a = radians(angle);
  float2 q = float2(cos(a) * p.x - sin(a) * p.y, sin(a) * p.x + cos(a) * p.y) / cell;
  float2 f = fract(q) - 0.5;
  float tone = clamp(1.0 - (p.x / size.x + p.y / size.y) * 0.5, 0.0, 1.0);
  float r = 0.62 * sqrt(tone);
  float edge = 1.0 / cell;
  float m = 1.0 - smoothstep(r - edge, r + edge, length(f));
  return mix(colorA, colorB, half(m));
}
`,
  },
  {
    id: 'plasma',
    name: 'Плазма',
    code: `uniform float2 size;
uniform float time;
uniform float scale; // Масштаб: 1 (0.2..5)
uniform float speed; // Скорость: 0.5 (0..3)
uniform float shift; // Оттенок: 0 (0..6.28)

half4 main(float2 p) {
  float2 uv = p / max(size.x, size.y) * 6.0 * scale;
  float t = time * speed;
  float v = sin(uv.x + t) + sin(uv.y * 1.3 - t) + sin((uv.x + uv.y) * 0.7 + t * 0.7) + sin(length(uv - 3.0) * 1.5 - t);
  float3 c = 0.5 + 0.5 * sin(v + shift + float3(0.0, 2.1, 4.2));
  return half4(half3(c), 1.0);
}
`,
  },
];
