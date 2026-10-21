import type { SceneNode } from '@mfp/io-figma';

/** Undo only a container's temporary size scale in its direct children's local
 * transforms. Their own morph positions/sizes remain independent. */
export function compensateContainerChildren(node: SceneNode, sx: number, sy: number) {
  if (Math.abs(sx) < 1e-8 || Math.abs(sy) < 1e-8) return;
  for (const child of node.children) {
    const m = child.transform;
    child.transform = [m[0] / sx, m[1] / sx, m[2] / sx, m[3] / sy, m[4] / sy, m[5] / sy];
  }
}
