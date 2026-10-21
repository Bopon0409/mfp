// Shared storage of identical property values.
// In imported documents values repeat massively (instance copies: fills,
// paths, glyph layouts, fonts): the giant file has 656K object values, 16K of them unique.
// Values with identical content are stored as one frozen object; the model does not copy
// such values (they cannot be modified), and edits always create new values.

import type { Props } from './types.ts';

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

export class Interner {
  private table = new Map<string, unknown>();
  private keys = new WeakMap<object, string>();

  /** Values with identical content become one shared frozen object. */
  value<T>(v: T): T {
    if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v;
    const key = JSON.stringify(v);
    const shared = this.table.get(key);
    if (shared !== undefined) return shared as T;
    deepFreeze(v);
    this.table.set(key, v);
    this.keys.set(v as object, key);
    return v;
  }

  /** The value's content as JSON (for shared values — without re-serializing). */
  key(v: unknown): string {
    if (v !== null && typeof v === 'object') {
      const k = this.keys.get(v);
      if (k !== undefined) return k;
    }
    return JSON.stringify(v);
  }

  props(p: Props): Props {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) out[k] = this.value(v);
    return out as Props;
  }

  get size() {
    return this.table.size;
  }
}
