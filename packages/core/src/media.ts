import type { Props } from './types.ts';

/** Media used by paints (including styled text and vector paths) and prototype audio. */
export function mediaHashes(props: Props): Set<string> {
  const out = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (v.type === 'IMAGE' && typeof v.imageHash === 'string' && v.imageHash) out.add(v.imageHash);
    else if (v.type === 'VIDEO' && typeof v.videoHash === 'string' && v.videoHash) out.add(v.videoHash);
    else if (v.type === 'LOTTIE' && typeof v.lottieHash === 'string' && v.lottieHash) out.add(v.lottieHash);
    else if (v.type === 'MODEL3D' && typeof v.modelHash === 'string' && v.modelHash) out.add(v.modelHash);
    else if (v.type === 'SOUND' && typeof v.soundHash === 'string' && v.soundHash) out.add(v.soundHash);
    else for (const child of Object.values(v)) visit(child);
  };
  for (const value of [props.fills, props.strokes, props.backgrounds, props.textRuns, props.textGlyphs?.runs, props.vectorPaths, props.reactions]) visit(value);
  return out;
}
