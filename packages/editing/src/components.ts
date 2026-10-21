// Components and instances live in @mfp/core (shared with plugins: they do not need the wasm layout).
export {
  ComponentSync,
  DesignSync,
  detachInstance,
  instanceRoot,
  instantiate,
  isInstanceNode,
  resetOverrides,
  stripRefs,
} from '@mfp/core';
