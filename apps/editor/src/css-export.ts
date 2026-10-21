// “Copy as CSS”: layer styling as CSS properties — size and position,
// background (color, gradients, image), corner radii, stroke, shadows and blur, opacity, blending,
// rotation; for text — font, size, spacing, color, alignment; for auto layout — flex.

import { invert, multiply, rotationOf, type Document, type Effect, type Matrix, type Paint, type RGBA } from '@mfp/core';
import { freeformCss } from './freeform.ts';

const px = (v: number) => `${Math.round(v * 100) / 100}px`;
const hexOf = (c: { r: number; g: number; b: number }) =>
  '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const color = (c: { r: number; g: number; b: number }, a = 1) =>
  a >= 1 ? hexOf(c) : `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${Math.round(a * 100) / 100})`;

/** Paint → CSS value (color or gradient); null — an image or not expressible. */
function paintCss(p: Paint, w: number, h: number): string | null {
  if (p.visible === false) return null;
  const op = p.opacity ?? 1;
  if (p.type === 'SOLID') return color(p.color, op);
  if (p.type === 'IMAGE') return 'url(image)';
  // Video can't be expressed as a CSS background — treated as an image (a frame).
  if (p.type === 'VIDEO') return 'url(video)';
  // Lottie — via a player (lottie-web, dotlottie) on top of the layer.
  if (p.type === 'LOTTIE') return 'url(lottie)';
  // 3D model — via a glTF player (<model-viewer>, three.js) on top of the layer; in CSS — a still image.
  if (p.type === 'MODEL3D') return 'url(model)';
  // Pattern — as an image tile with a repeating background.
  if (p.type === 'PATTERN') return 'url(pattern)';
  // Shader — as an image (or canvas/WebGL in code).
  if (p.type === 'SHADER') return 'url(shader)';
  // Mesh gradient — approximated: radial spots of the points over the average color.
  if (p.type === 'GRADIENT_FREEFORM') return freeformCss({ points: p.points, opacity: op });
  const t = p.gradientTransform;
  const m = multiply([w, 0, 0, 0, h, 0], invert([t[0][0], t[0][1], t[0][2], t[1][0], t[1][1], t[1][2]] as Matrix));
  const at = (x: number, y: number) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]] as const;
  const stops = [...p.gradientStops].sort((a, b) => a.position - b.position).map((s) => `${color(s.color, s.color.a * op)} ${Math.round(s.position * 1000) / 10}%`).join(', ');
  if (p.type === 'GRADIENT_LINEAR') {
    const [x0, y0] = at(0, 0.5);
    const [x1, y1] = at(1, 0.5);
    // CSS: 0deg — up, clockwise.
    const deg = Math.round(((Math.atan2(x1 - x0, -(y1 - y0)) * 180) / Math.PI + 360) % 360);
    return `linear-gradient(${deg}deg, ${stops})`;
  }
  if (p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_DIAMOND') {
    const [cx, cy] = at(0.5, 0.5);
    return `radial-gradient(50% 50% at ${Math.round((cx / w) * 1000) / 10}% ${Math.round((cy / h) * 1000) / 10}%, ${stops})`;
  }
  if (p.type === 'GRADIENT_ANGULAR') {
    const [cx, cy] = at(0.5, 0.5);
    return `conic-gradient(from 90deg at ${Math.round((cx / w) * 1000) / 10}% ${Math.round((cy / h) * 1000) / 10}%, ${stops})`;
  }
  return null;
}

function shadowCss(e: Effect): string | null {
  if (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW') return null;
  if (e.visible === false) return null;
  const c = e.color as RGBA;
  return `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(e.offset.x)} ${px(e.offset.y)} ${px(e.radius)}${e.spread ? ` ${px(e.spread)}` : ''} ${color(c, c.a)}`;
}

/** CSS of one layer (with a name comment). */
export function cssOf(doc: Document, id: string): string {
  const p = doc.props(id);
  const type = doc.type(id)!;
  const w = p.width ?? 0;
  const h = p.height ?? 0;
  const lines: string[] = [`/* ${p.name ?? ''} */`];
  const add = (k: string, v: string | null | undefined) => v && lines.push(`${k}: ${v};`);
  const parent = doc.parent(id);
  const auto = parent && (doc.get(parent, 'layoutMode') ?? 'NONE') !== 'NONE' && doc.get(id, 'layoutPositioning') !== 'ABSOLUTE';
  const t = p.transform ?? [1, 0, 0, 0, 1, 0];
  if (!auto) {
    add('position', 'absolute');
    add('left', px(t[2]));
    add('top', px(t[5]));
  }
  // Size in percent of the parent (our own) — as in CSS.
  add('width', auto && p.widthPercent ? `${Math.round(p.widthPercent * 100) / 100}%` : px(w));
  add('height', auto && p.heightPercent ? `${Math.round(p.heightPercent * 100) / 100}%` : px(h));
  const rot = rotationOf(t as Matrix);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const parts3d = p.rotateX || p.rotateY || p.translateZ ? [`perspective(${r2(p.perspective ?? 1000)}px)`, ...(p.translateZ ? [`translateZ(${r2(p.translateZ)}px)`] : []), ...(p.rotateX ? [`rotateX(${r2(p.rotateX)}deg)`] : []), ...(p.rotateY ? [`rotateY(${r2(p.rotateY)}deg)`] : [])] : [];
  if (Math.abs(rot) > 0.01 || parts3d.length) add('transform', [...(Math.abs(rot) > 0.01 ? [`rotate(${r2(-rot)}deg)`] : []), ...parts3d].join(' '));
  // Auto layout — flex.
  if ((p.layoutMode ?? 'NONE') !== 'NONE' && p.layoutMode !== 'GRID') {
    add('display', 'flex');
    add('flex-direction', p.layoutMode === 'VERTICAL' ? 'column' : 'row');
    if (p.layoutWrap === 'WRAP') add('flex-wrap', 'wrap');
    const justify: Record<string, string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' };
    const align: Record<string, string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };
    add('justify-content', justify[p.primaryAxisAlignItems ?? 'MIN']);
    add('align-items', align[p.counterAxisAlignItems ?? 'MIN']);
    if (p.primaryAxisAlignItems !== 'SPACE_BETWEEN' && p.itemSpacing) add('gap', px(p.itemSpacing));
    const pad = [p.paddingTop ?? 0, p.paddingRight ?? 0, p.paddingBottom ?? 0, p.paddingLeft ?? 0];
    if (pad.some((v) => v)) add('padding', pad.map(px).join(' '));
  }
  if (auto && p.layoutGrow) add('flex-grow', '1');
  const fills = (p.fills ?? []).filter((f) => f.visible !== false);
  if (type === 'TEXT') {
    const f = p.fontName ?? { family: 'Inter', style: 'Regular' };
    add('font-family', `'${f.family}'`);
    if (/italic/i.test(f.style)) add('font-style', 'italic');
    const weight = /thin/i.test(f.style) ? 100 : /extra ?light/i.test(f.style) ? 200 : /light/i.test(f.style) ? 300 : /medium/i.test(f.style) ? 500 : /semi ?bold/i.test(f.style) ? 600 : /extra ?bold/i.test(f.style) ? 800 : /black|heavy/i.test(f.style) ? 900 : /bold/i.test(f.style) ? 700 : 400;
    add('font-weight', String(weight));
    add('font-size', px(p.fontSize ?? 12));
    const lh = p.lineHeight;
    add('line-height', !lh || lh.unit === 'AUTO' ? 'normal' : lh.unit === 'PERCENT' ? `${Math.round(lh.value) / 100}` : px(lh.value));
    const ls = p.letterSpacing;
    if (ls && ls.value) add('letter-spacing', ls.unit === 'PERCENT' ? `${Math.round(ls.value) / 100}em` : px(ls.value));
    add('text-align', ({ LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' } as Record<string, string>)[p.textAlignHorizontal ?? 'LEFT']);
    if (p.textCase === 'UPPER') add('text-transform', 'uppercase');
    else if (p.textCase === 'LOWER') add('text-transform', 'lowercase');
    else if (p.textCase === 'TITLE') add('text-transform', 'capitalize');
    if (p.textDecoration === 'UNDERLINE') add('text-decoration', 'underline');
    else if (p.textDecoration === 'STRIKETHROUGH') add('text-decoration', 'line-through');
    const solid = fills.find((x) => x.type === 'SOLID');
    if (solid && solid.type === 'SOLID') add('color', color(solid.color, solid.opacity ?? 1));
  } else if (fills.length) {
    // The top paint first (like background layers in CSS).
    const bg = fills
      .slice()
      .reverse()
      .map((x) => paintCss(x, w, h))
      .filter((x): x is string => !!x);
    if (bg.length === 1 && !bg[0]!.includes('gradient') && !bg[0]!.startsWith('url')) add('background', bg[0]);
    else if (bg.length) add('background', bg.map((b, i) => (i < bg.length - 1 && !b.includes('gradient') && !b.startsWith('url') ? `linear-gradient(0deg, ${b}, ${b})` : b)).join(', '));
  }
  // Corner radii.
  if (type !== 'TEXT' && type !== 'LINE') {
    const radii = [p.topLeftRadius, p.topRightRadius, p.bottomRightRadius, p.bottomLeftRadius].map((r) => r ?? p.cornerRadius ?? 0);
    if (type === 'ELLIPSE') add('border-radius', '50%');
    else if (radii.some((r) => r)) add('border-radius', radii.every((r) => r === radii[0]) ? px(radii[0]!) : radii.map(px).join(' '));
  }
  // Stroke.
  const stroke = (p.strokes ?? []).find((s) => s.visible !== false && s.type === 'SOLID');
  if (stroke && stroke.type === 'SOLID' && (p.strokeWeight ?? 1) > 0) {
    const line = `${px(p.strokeWeight ?? 1)} ${p.dashPattern?.length ? 'dashed' : 'solid'} ${color(stroke.color, stroke.opacity ?? 1)}`;
    if (p.strokeAlign === 'OUTSIDE') add('outline', line);
    else {
      add('border', line);
      if (p.strokeAlign !== 'CENTER') add('box-sizing', 'border-box');
    }
  }
  // Effects.
  const effects = (p.effects ?? []).filter((e) => e.visible !== false);
  const shadows = effects.map(shadowCss).filter((x): x is string => !!x);
  if (shadows.length) add(type === 'TEXT' ? 'text-shadow' : 'box-shadow', shadows.join(', '));
  const blur = effects.find((e) => e.type === 'LAYER_BLUR');
  if (blur && 'radius' in blur) add('filter', `blur(${px(blur.radius / 2)})`);
  const bgBlur = effects.find((e) => e.type === 'BACKGROUND_BLUR');
  if (bgBlur && 'radius' in bgBlur) add('backdrop-filter', `blur(${px(bgBlur.radius / 2)})`);
  if ((p.opacity ?? 1) < 1) add('opacity', String(Math.round((p.opacity ?? 1) * 100) / 100));
  const blend = p.blendMode;
  if (blend && blend !== 'PASS_THROUGH' && blend !== 'NORMAL') add('mix-blend-mode', blend.toLowerCase().replace(/_/g, '-'));
  if (p.clipsContent && type === 'FRAME') add('overflow', 'hidden');
  return lines.join('\n');
}
