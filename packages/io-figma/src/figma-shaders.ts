import type { ShaderPaint, WgslFill } from '@mfp/core';

// Executable Figma shader code is not stored in the .fig file — only a reference to the tool and parameters.
// The code itself is not bundled with the product: it can be registered (for example, from source the
// user exported themselves); otherwise the fill stays unresolved and is shown as a placeholder.
const registry = new Map<string, WgslFill>();

export function registerFigmaShader(toolId: string, version: string, fill: WgslFill) {
  registry.set(`${toolId}@${version}`, fill);
}

/** Resolve only the version for which the user supplied the executable source. */
export function resolveFigmaShader(paint: ShaderPaint): ShaderPaint {
  if (paint.code || paint.wgsl || !paint.figma) return paint;
  const def = paint.figma.definition as { customToolArtifactRef?: { customToolId?: string; customToolVersion?: string }; componentPropDefs?: { id: unknown; name: string; varValue?: unknown }[] } | undefined;
  const ref = def?.customToolArtifactRef;
  const wgsl = ref?.customToolId && ref.customToolVersion ? registry.get(`${ref.customToolId}@${ref.customToolVersion}`) : undefined;
  if (!wgsl) return paint;
  const key = (id: unknown) => {
    const x = id as { sessionID?: number; localID?: number } | undefined;
    return x ? `${x.sessionID}:${x.localID}` : '';
  };
  const assignments = new Map(paint.figma.assignments.map((x) => {
    const a = x as { defID: unknown; varValue: unknown };
    return [key(a.defID), a.varValue] as const;
  }));
  const params: Record<string, number[]> = {};
  for (const d of def?.componentPropDefs ?? []) {
    const value = (assignments.get(key(d.id)) ?? d.varValue) as { value?: { floatValue?: number; colorValue?: { r: number; g: number; b: number; a: number } } } | undefined;
    const v = value?.value;
    if (typeof v?.floatValue === 'number' && Number.isFinite(v.floatValue)) params[d.name] = [v.floatValue];
    else if (v?.colorValue) { const c = v.colorValue; params[d.name] = [c.r, c.g, c.b, c.a]; }
  }
  return { ...paint, wgsl, params: { ...params, ...paint.params } };
}
