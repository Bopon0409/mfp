// Test WGSL shader (MFP's own): glowing dots floating upward. Needed only for the WGSL
// fill tests: parameter layout (frameData, inputDimsData, then one vec4 per parameter),
// colors and numbers, default values.
import type { WgslFill } from '@mfp/core';

const color = (name: string, label: string, value: number[]) => ({ name, label, kind: 'color' as const, value });
const float = (name: string, label: string, value: number, min: number, max: number) => ({ name, label, kind: 'float' as const, value: [value], min, max });

const uniforms = [
  color('dotColor', 'Цвет точек', [1, 0.6, 0.2, 1]),
  color('haloColor', 'Цвет ореола', [1, 0.85, 0.5, 1]),
  color('backgroundColor', 'Цвет фона', [0.02, 0.02, 0.04, 1]),
  float('backgroundOpacity', 'Прозрачность фона', 0, 0, 1),
  float('density', 'Плотность', 0.6, 0, 1),
  float('centerX', 'Центр', 50, 0, 100),
  float('spreadWidth', 'Ширина', 28, 1, 100),
  float('dotSize', 'Размер точек', 3, 0.5, 12),
  float('sizeVariation', 'Разброс размера', 0.4, 0, 1),
  float('brightness', 'Яркость', 1.2, 0, 4),
  float('halo', 'Ореол', 0.5, 0, 2),
  float('flicker', 'Мерцание', 0.3, 0, 1),
  float('blur', 'Размытие', 0.2, 0, 1),
  float('depth', 'Глубина', 0.5, 0, 1),
  float('speed', 'Скорость', 40, 0, 200),
  float('speedVariation', 'Разброс скорости', 0.3, 0, 1),
  float('burst', 'Всплеск', 0, 0, 1),
  float('flow', 'Течение', 0.2, 0, 1),
  float('swirl', 'Завихрение', 0.1, 0, 1),
  float('chaos', 'Хаос', 0.2, 0, 1),
  float('wind', 'Ветер', 0, -1, 1),
  float('lifetime', 'Время жизни', 3, 0.5, 10),
  float('lifetimeVariation', 'Разброс времени жизни', 0.3, 0, 0.9),
  float('fadeStart', 'Начало затухания', 100, 0, 100),
  float('fadeSoftness', 'Плавность затухания', 15, 1, 50),
  float('seed', 'Зерно', 1, 0, 100),
];

const fields = ['frameData', 'inputDimsData', ...uniforms.map((u) => u.name)].map((n) => `  ${n}: vec4f,`).join('\n');

const source = `
struct Uniforms {
${fields}
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsIn {
  @location(0) pos: vec2f,
  @location(1) uv: vec2f,
};
struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

// Integer hash 4 → 4 (mixing with multiplications and shifts).
fn hash4(v: vec4u) -> vec4u {
  var s = v * vec4u(747796405u) + vec4u(2891336453u);
  s = s ^ (s >> vec4u(16u));
  s = s * vec4u(277803737u);
  return s ^ (s >> vec4u(16u));
}

@vertex fn vs(input: VsIn) -> VsOut {
  var out: VsOut;
  out.position = vec4f(input.pos, 0.0, 1.0);
  out.uv = input.uv;
  return out;
}

@fragment fn fs(input: VsOut) -> @location(0) vec4f {
  let time = u.frameData.x;
  let size = u.inputDimsData.xy;
  let px = input.uv * size;
  let cell = vec2u(px / 24.0);
  let h = vec4f(hash4(vec4u(cell, u32(u.seed.x), 0u))) / 4294967295.0;
  let rise = fract(h.y + time * u.speed.x / size.y);
  let center = vec2f((f32(cell.x) + 0.5) * 24.0 + u.wind.x * 12.0, size.y * (1.0 - rise));
  let d = distance(px, center);
  let glow = u.brightness.x * exp(-d * d / (u.dotSize.x * u.dotSize.x)) * step(1.0 - u.density.x, h.x);
  let halo = u.halo.x * exp(-d / (u.dotSize.x * 6.0)) * step(1.0 - u.density.x, h.x);
  let bg = u.backgroundColor.rgb * u.backgroundOpacity.x;
  let rgb = bg + u.dotColor.rgb * glow + u.haloColor.rgb * halo * 0.25;
  return vec4f(rgb, clamp(u.backgroundOpacity.x + glow + halo * 0.25, 0.0, 1.0));
}
`;

export const GLOW: WgslFill = { name: 'Светящиеся точки', source, uniforms } as WgslFill;
