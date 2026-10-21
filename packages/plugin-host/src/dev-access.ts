/** Developer mode plugins may inspect and write plugin metadata, but cannot change design.
 * Keep dispatchers explicit: allowing every get/set-prefixed name would hide writes. */
const READ_METHODS = new Set([
  'meta', 'codegenResult', 'codegenRefresh', 'root', 'currentPage', 'setCurrentPage',
  'getNodeById', 'getRange', 'styledSegments', 'has', 'get', 'loadFont', 'skipInvisible', 'assertAccessible',
  'notify', 'showUI', 'postToUI', 'uiVisible', 'uiResize', 'uiClose', 'closePlugin', 'commitUndo',
  'viewport', 'setViewport', 'scrollAndZoomIntoView', 'suggestions', 'listen',
  'setTimer', 'clearTimer', 'log', 'parseColor', 'storageGet', 'storageSet',
  'storageDelete', 'storageKeys', 'imageBytes', 'imageSize', 'openExternal',
  'listFonts', 'activeUsers', 'getRelaunchData', 'setRelaunchData', 'selectionColors',
  'fetch', 'utf8', 'base64Encode', 'base64Decode', 'exportAsync', 'getCSS',
  'getPluginData', 'setPluginData', 'getPluginDataKeys',
  'getSharedPluginData', 'setSharedPluginData', 'getSharedPluginDataKeys',
]);
const DESIGN_READS = new Set(['localStyles', 'getStyleById', 'localVariables', 'localCollections', 'getVariableById', 'getCollectionById', 'paintWithVariable', 'effectWithVariable']);
const NODE_READS = new Set(['resolveForConsumer', 'getMainComponent', 'getStyleConsumers']);
const DEV_READS = new Set(['categories', 'category', 'getMeasurements', 'getMeasurementsForNode']);

export function devApiAllowed(method: string, args: unknown[]): boolean {
  if (method === 'set') return args[1] === 'selection';
  if (method === 'ds') return DESIGN_READS.has(String(args[0]));
  if (method === 'nodeMethod') return NODE_READS.has(String(args[1]));
  if (method === 'dev') return DEV_READS.has(String(args[0]));
  return READ_METHODS.has(method);
}
