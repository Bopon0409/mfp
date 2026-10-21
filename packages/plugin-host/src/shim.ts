// Code that runs INSIDE the QuickJS sandbox before the plugin code.
// Creates the global `figma` object, compatible with the Figma Plugin API, on top of
// the single bridge to the host: __mfp_call(method, argsJson) → resultJson.
//
// Nodes are Proxies: property reads and writes go to the host synchronously, so
// the plugin sees the current state right after a change.
// Values cross the bridge as JSON; node references are {"$node": id}, figma.mixed is {"$mixed": true}.

export const FIGMA_SHIM = String.raw`
(() => {
  const hostCall = globalThis.__mfp_call;
  const takeBytes = globalThis.__mfp_take;
  const putBytes = globalThis.__mfp_put;
  delete globalThis.__mfp_call;
  delete globalThis.__mfp_take;
  delete globalThis.__mfp_put;

  const mixed = Symbol('figma.mixed');
  const proxies = new Map();
  let skipInvisible = null;
  const assertAccessible = (id) => {
    if (skipInvisible === null) skipInvisible = call('skipInvisible');
    if (skipInvisible) call('assertAccessible', id);
  };

  function toWire(value) {
    return JSON.stringify(value, (key, v) => {
      if (v === mixed) return { $mixed: true };
      if (v && typeof v === 'object' && v.__mfpNodeId) return { $node: v.__mfpNodeId };
      if (v instanceof Uint8Array) return { $blob: putBytes(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
      if (v instanceof ArrayBuffer) return { $blob: putBytes(v.slice(0)) };
      return v;
    });
  }

  function revive(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v.$node) return nodeProxy(v.$node);
    if (v.$blob) return new Uint8Array(takeBytes(v.$blob));
    if (v.$mixed) return mixed;
    if (Array.isArray(v)) return v.map(revive);
    const out = {};
    for (const k of Object.keys(v)) out[k] = revive(v[k]);
    return out;
  }

  function call(method, ...args) {
    const raw = hostCall(method, toWire(args));
    const result = raw === undefined ? undefined : JSON.parse(raw);
    if (result && typeof result === 'object' && result.$error) throw new Error(result.$error);
    return revive(result);
  }

  // ---------- Async operations: a promise in the sandbox, resolved by the host ----------
  let promiseSeq = 0;
  const promises = new Map();
  function callAsync(method, ...args) {
    const id = ++promiseSeq;
    return new Promise((resolve, reject) => {
      promises.set(id, { resolve, reject });
      call(method, id, ...args);
    });
  }

  // ---------- Timers ----------
  let timerSeq = 0;
  const timers = new Map();
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = ++timerSeq;
    timers.set(id, { fn, rest, repeat: false });
    call('setTimer', id, Number(ms) || 0);
    return id;
  };
  globalThis.setInterval = (fn, ms, ...rest) => {
    const id = ++timerSeq;
    timers.set(id, { fn, rest, repeat: true, ms: Number(ms) || 0 });
    call('setTimer', id, Number(ms) || 0);
    return id;
  };
  globalThis.clearTimeout = globalThis.clearInterval = (id) => {
    if (timers.delete(id)) call('clearTimer', id);
  };

  // ---------- Network: fetch (addresses per manifest.networkAccess) ----------
  globalThis.fetch = (url, init) => {
    const i = init ? Object.assign({}, init) : null;
    if (i && i.body !== undefined && i.body !== null && typeof i.body !== 'string' && !(i.body instanceof Uint8Array) && !(i.body instanceof ArrayBuffer)) i.body = String(i.body);
    return callAsync('fetch', String(url), i).then((r) => {
      let used = false;
      const take = () => {
        if (used) throw new TypeError('Body has already been consumed');
        used = true;
        return r.body;
      };
      const headers = r.headers || {};
      return {
        ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, redirected: r.redirected, type: r.type,
        headersObject: headers,
        headers: {
          get: (n) => (String(n).toLowerCase() in headers ? headers[String(n).toLowerCase()] : null),
          has: (n) => String(n).toLowerCase() in headers,
          forEach: (cb) => Object.keys(headers).forEach((k) => cb(headers[k], k)),
        },
        async arrayBuffer() { const b = take(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
        async text() { return call('utf8', take()); },
        async json() { return JSON.parse(call('utf8', take())); },
      };
    });
  };

  // ---------- Console ----------
  const fmt = (args) => args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  });
  const counts = new Map();
  const timersStart = new Map();
  globalThis.console = {
    log: (...a) => call('log', 'log', fmt(a)),
    info: (...a) => call('log', 'info', fmt(a)),
    warn: (...a) => call('log', 'warn', fmt(a)),
    error: (...a) => call('log', 'error', fmt(a)),
    debug: (...a) => call('log', 'debug', fmt(a)),
    trace: (...a) => call('log', 'debug', fmt(a)),
    dir: (...a) => call('log', 'log', fmt(a)),
    table: (...a) => call('log', 'log', fmt(a)),
    group: (...a) => { if (a.length) call('log', 'log', fmt(a)); },
    groupCollapsed: (...a) => { if (a.length) call('log', 'log', fmt(a)); },
    groupEnd: () => {},
    clear: () => {},
    assert: (cond, ...a) => { if (!cond) call('log', 'error', fmt(['Assertion failed', ...a])); },
    count: (label = 'default') => { const n = (counts.get(label) || 0) + 1; counts.set(label, n); call('log', 'log', [label + ': ' + n]); },
    countReset: (label = 'default') => { counts.delete(label); },
    time: (label = 'default') => { timersStart.set(label, Date.now()); },
    timeLog: (label = 'default') => { call('log', 'log', [label + ': ' + (Date.now() - (timersStart.get(label) || Date.now())) + ' ms']); },
    timeEnd: (label = 'default') => { call('log', 'log', [label + ': ' + (Date.now() - (timersStart.get(label) || Date.now())) + ' ms']); timersStart.delete(label); },
  };

  // ---------- Nodes ----------
  const NODE_METHODS = {
    appendChild(id, child) { call('appendChild', id, child); },
    insertChild(id, index, child) { call('insertChild', id, index, child); },
    remove(id) { call('remove', id); },
    resize(id, w, h) { call('resize', id, w, h); },
    resizeWithoutConstraints(id, w, h) { call('resizeWithoutConstraints', id, w, h); },
    rescale(id, scale) { call('rescale', id, scale); },
    clone(id) { return call('clone', id); },
    getPluginData(id, key) { return call('getPluginData', id, key); },
    setPluginData(id, key, value) { call('setPluginData', id, key, String(value)); },
    getPluginDataKeys(id) { return call('getPluginDataKeys', id); },
    getSharedPluginData(id, ns, key) { return call('getSharedPluginData', id, ns, key); },
    setSharedPluginData(id, ns, key, value) { call('setSharedPluginData', id, ns, key, String(value)); },
    getSharedPluginDataKeys(id, ns) { return call('getSharedPluginDataKeys', id, ns); },
    findAll(id, cb) {
      const out = [];
      const walk = (n) => { for (const c of n.children || []) { if (!cb || cb(c)) out.push(c); walk(c); } };
      walk(nodeProxy(id));
      return out;
    },
    findOne(id, cb) {
      const walk = (n) => {
        for (const c of n.children || []) {
          if (cb(c)) return c;
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(nodeProxy(id));
    },
    findChildren(id, cb) { return (nodeProxy(id).children || []).filter((c) => !cb || cb(c)); },
    findChild(id, cb) { return (nodeProxy(id).children || []).find(cb) || null; },
    findAllWithCriteria(id, criteria) {
      const types = criteria && criteria.types;
      return NODE_METHODS.findAll(id, (n) => !types || types.includes(n.type));
    },
    // Text by ranges.
    getStyledTextSegments(id, fields, start, end) { return call('styledSegments', id, fields, start ?? null, end ?? null); },
    insertCharacters(id, start, characters, useStyle) { call('insertCharacters', id, start, characters, useStyle || 'BEFORE'); },
    deleteCharacters(id, start, end) { call('deleteCharacters', id, start, end); },
    getRangeFontWeight(id, start, end) { return call('getRange', id, 'fontWeight', start, end); },
    getRangeAllFontNames(id, start, end) { return call('getRange', id, 'allFontNames', start, end); },
    // Async variants, required with documentAccess: "dynamic-page".
    async loadAsync(id) {},
    // Styles, variables, collections, components and instances.
    async getMainComponentAsync(id) { return call('nodeMethod', id, 'getMainComponent', []); },
    async getStyleConsumersAsync(id) { return call('nodeMethod', id, 'getStyleConsumers', []); },
    async getPublishStatusAsync(id) { return 'UNPUBLISHED'; },
    // Prototype.
    async setReactionsAsync(id, reactions) { call('set', id, 'reactions', reactions); },
    // Vector network.
    async setVectorNetworkAsync(id, network) { call('set', id, 'vectorNetwork', network); },
    // Pattern paints (PatternPaint) are set this way; regular ones too.
    async setFillsAsync(id, paints) { call('set', id, 'fills', paints); },
    async setStrokesAsync(id, paints) { call('set', id, 'strokes', paints); },
    async setFillStyleIdAsync(id, style) { call('set', id, 'fillStyleId', style && style.id !== undefined ? style.id : style); },
    async setStrokeStyleIdAsync(id, style) { call('set', id, 'strokeStyleId', style && style.id !== undefined ? style.id : style); },
    async setEffectStyleIdAsync(id, style) { call('set', id, 'effectStyleId', style && style.id !== undefined ? style.id : style); },
    async setGridStyleIdAsync(id, style) { call('set', id, 'gridStyleId', style && style.id !== undefined ? style.id : style); },
    async setTextStyleIdAsync(id, style) { call('set', id, 'textStyleId', style && style.id !== undefined ? style.id : style); },
    async setRangeTextStyleIdAsync(id, start, end, style) { call('setRange', id, 'textStyleId', start, end, style && style.id !== undefined ? style.id : style); },
    async setRangeFillStyleIdAsync(id, start, end, style) { call('setRange', id, 'fillStyleId', start, end, style && style.id !== undefined ? style.id : style); },
    toString(id) { return '[object ' + call('get', id, 'type') + 'Node]'; },
    // “Run again” buttons, proportions.
    setRelaunchData(id, data) { call('setRelaunchData', id, data || {}); },
    getRelaunchData(id) { return call('getRelaunchData', id); },
    lockAspectRatio(id) { call('set', id, 'constrainProportions', true); },
    unlockAspectRatio(id) { call('set', id, 'constrainProportions', false); },
    // Export and code.
    exportAsync(id, settings) { return callAsync('exportAsync', id, settings || null); },
    getCSSAsync(id) { return callAsync('getCSS', id); },
    // Developer mode: page measurements.
    getMeasurements(id) { return call('dev', 'getMeasurements', id); },
    getMeasurementsForNode(id, node) { return call('dev', 'getMeasurementsForNode', id, node); },
    addMeasurement(id, start, end, options) { return call('dev', 'addMeasurement', id, start, end, options || null); },
    editMeasurement(id, mid, value) { return call('dev', 'editMeasurement', id, mid, value); },
    deleteMeasurement(id, mid) { call('dev', 'deleteMeasurement', id, mid); },
    // Node events: on a page — nodechange.
    on(id, type, cb) { nodeOn(id, type, cb); },
    off(id, type, cb) { nodeOff(id, type, cb); },
    once(id, type, cb) { const wrap = (...a) => { nodeOff(id, type, wrap); cb(...a); }; nodeOn(id, type, wrap); },
  };

  // Node event subscribers: "id|type" → handlers; the host is told whether a type has subscribers.
  const nodeListeners = new Map();
  const nodeCounts = new Map();
  function nodeOn(id, type, cb) {
    const key = id + '|' + type;
    if (!nodeListeners.has(key)) nodeListeners.set(key, new Set());
    const set = nodeListeners.get(key);
    if (set.has(cb)) return;
    set.add(cb);
    const n = (nodeCounts.get(type) || 0) + 1;
    nodeCounts.set(type, n);
    if (n === 1) call('listen', type, true);
  }
  function nodeOff(id, type, cb) {
    const set = nodeListeners.get(id + '|' + type);
    if (!set || !set.delete(cb)) return;
    const n = (nodeCounts.get(type) || 1) - 1;
    nodeCounts.set(type, n);
    if (n === 0) call('listen', type, false);
  }

  // getRangeFontSize / setRangeFontSize etc.: a style property on a range.
  for (const [name, key] of [
    ['FontSize', 'fontSize'], ['FontName', 'fontName'], ['TextCase', 'textCase'], ['TextDecoration', 'textDecoration'],
    ['TextDecorationStyle', 'textDecorationStyle'], ['TextDecorationThickness', 'textDecorationThickness'], ['TextDecorationColor', 'textDecorationColor'], ['TextDecorationOffset', 'textDecorationOffset'], ['TextDecorationSkipInk', 'textDecorationSkipInk'],
    ['LetterSpacing', 'letterSpacing'], ['LineHeight', 'lineHeight'], ['Fills', 'fills'], ['Hyperlink', 'hyperlink'],
    ['ListOptions', 'listOptions'], ['Indentation', 'indentation'], ['OpenTypeFeatures', 'openTypeFeatures'],
    ['TextStyleId', 'textStyleId'], ['FillStyleId', 'fillStyleId'],
  ]) {
    NODE_METHODS['getRange' + name] = (id, start, end) => call('getRange', id, key, start, end);
    NODE_METHODS['setRange' + name] = (id, start, end, value) => { call('setRange', id, key, start, end, value); };
    NODE_METHODS['setRange' + name + 'Async'] = async (id, start, end, value) => { call('setRange', id, key, start, end, value); };
  }

  for (const name of ['setValueForMode', 'resolveForConsumer', 'setVariableCodeSyntax', 'removeVariableCodeSyntax', 'addMode', 'removeMode', 'renameMode',
    'setBoundVariable', 'setExplicitVariableModeForCollection', 'clearExplicitVariableModeForCollection',
    'addComponentProperty', 'editComponentProperty', 'deleteComponentProperty', 'createInstance', 'setProperties', 'swapComponent', 'resetOverrides', 'detachInstance',
    // Motion: keys, motion styles, timeline duration.
    'applyManualKeyframeTrack', 'removeManualKeyframeTrack', 'applyAnimationStyle', 'removeAnimationStyle', 'setTimelineDuration']) {
    NODE_METHODS[name] = (id, ...args) => call('nodeMethod', id, name, args);
  }

  function nodeProxy(id) {
    let p = proxies.get(id);
    if (p) return p;
    p = new Proxy({ __mfpNodeId: id }, {
      get(target, prop) {
        assertAccessible(id);
        if (prop === '__mfpNodeId') return id;
        if (prop === 'id') return id;
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') return undefined; // a node is not a promise
        const m = NODE_METHODS[prop];
        if (m) return (...args) => { assertAccessible(id); return m(id, ...args); };
        return call('get', id, prop);
      },
      set(target, prop, value) {
        assertAccessible(id);
        call('set', id, prop, value);
        return true;
      },
      has(target, prop) {
        assertAccessible(id);
        if (prop in NODE_METHODS || prop === 'id') return true;
        return call('has', id, prop);
      },
    });
    proxies.set(id, p);
    return p;
  }

  // ---------- Events ----------
  const listeners = new Map();
  const on = (type, cb) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    const set = listeners.get(type);
    set.add(cb);
    if (set.size === 1) call('listen', type, true);
  };
  const off = (type, cb) => {
    const set = listeners.get(type);
    if (set && set.delete(cb) && set.size === 0) call('listen', type, false);
  };
  const emit = (type, ...args) => { for (const cb of [...(listeners.get(type) || [])]) cb(...args); };

  const uiListeners = new Set();

  const ui = {
    onmessage: undefined,
    postMessage(msg, options) { call('postToUI', msg, options || null); },
    on(type, cb) { if (type === 'message') uiListeners.add(cb); },
    off(type, cb) { if (type === 'message') uiListeners.delete(cb); },
    once(type, cb) {
      if (type !== 'message') return;
      const wrap = (...a) => { uiListeners.delete(wrap); cb(...a); };
      uiListeners.add(wrap);
    },
    show() { call('uiVisible', true); },
    hide() { call('uiVisible', false); },
    resize(w, h) { call('uiResize', w, h); },
    reposition(x, y) {},
    close() { call('uiClose'); },
  };

  const viewport = {
    get center() { return call('viewport', 'center'); },
    set center(v) { call('setViewport', 'center', v); },
    get zoom() { return call('viewport', 'zoom'); },
    set zoom(v) { call('setViewport', 'zoom', v); },
    get bounds() { return call('viewport', 'bounds'); },
    scrollAndZoomIntoView(nodes) { call('scrollAndZoomIntoView', nodes); },
  };

  const create = (type) => () => call('create', type);

  // Image: hash and bytes on request.
  const imageOf = (hash) => ({
    hash,
    getBytesAsync() { return callAsync('imageBytes', hash); },
    getSizeAsync() { return callAsync('imageSize', hash); },
  });
  const booleanOp = (op) => (nodes, parent, index) => call('booleanOp', op, nodes, parent, index ?? null);

  // Codegen (developer mode): the generate handler and preferences.
  const codegenListeners = new Map();
  const codegen = {
    on(type, cb) { codegenListeners.set(type, cb); },
    off(type) { codegenListeners.delete(type); },
    once(type, cb) { codegenListeners.set(type, (...a) => { codegenListeners.delete(type); return cb(...a); }); },
    get preferences() { return call('meta', 'codegenPreferences'); },
    refresh() { call('codegenRefresh'); },
  };

  // Quick action parameters.
  let parameterInput = null;
  const parameters = {
    on(type, cb) { if (type === 'input') parameterInput = cb; },
    off(type, cb) { if (type === 'input' && (!cb || parameterInput === cb)) parameterInput = null; },
    once(type, cb) { if (type === 'input') parameterInput = (...a) => { parameterInput = null; return cb(...a); }; },
  };

  // Paid plugins: MFP doesn't sell plugins — status “not paid”, no purchase (the plugin runs
  // in free mode, like for a user who hasn't paid).
  const firstRun = Date.now();
  const payments = {
    get status() { return { type: 'UNPAID' }; },
    getUserFirstRanSecondsAgo() { return Math.floor((Date.now() - firstRun) / 1000); },
    async initiateCheckoutAsync() { throw new Error('Оплата плагинов в MFP не поддерживается'); },
    requestCheckout() { throw new Error('Оплата плагинов в MFP не поддерживается'); },
    setPaymentStatusInDevelopment() {},
    async getPluginPaymentTokenAsync() { throw new Error('Оплата плагинов в MFP не поддерживается'); },
  };


  // ---------- Widgets (the Figma widget API) ----------
  // Widget code registers a component; the host asks to render a widget node — the component is called
  // with its synced state, the tree (handlers as paths) goes to the host. A click and the property menu
  // call a handler by path (after a sandbox restart — render first).
  let widgetComponent = null;
  let renderCtx = null;
  const widgetNodes = new Map();
  const renderQueue = new Set();
  const flat = (list) => {
    const out = [];
    const add = (c) => {
      if (Array.isArray(c)) c.forEach(add);
      else if (c !== null && c !== undefined && c !== false && c !== true) out.push(c);
    };
    add(list);
    return out;
  };
  function widgetH(type, props, ...children) {
    return { type, props: props || {}, children: flat(children) };
  }
  function widgetState(nodeId) { return call('widget', 'getState', nodeId) || {}; }
  function scheduleRender(nodeId) {
    if (renderQueue.has(nodeId)) return;
    renderQueue.add(nodeId);
    Promise.resolve().then(() => {
      renderQueue.delete(nodeId);
      renderWidget(nodeId);
    });
  }
  function setSynced(nodeId, key, value) {
    call('widget', 'setState', nodeId, key, value === undefined ? null : value);
    scheduleRender(nodeId);
  }
  function renderWidget(nodeId) {
    if (!widgetComponent) throw new Error('Виджет не зарегистрирован (figma.widget.register)');
    const ctx = { nodeId, state: widgetState(nodeId), created: {}, menu: null, effects: [] };
    renderCtx = ctx;
    let tree;
    try {
      tree = widgetH(widgetComponent);
    } finally {
      renderCtx = null;
    }
    const handlers = new Map();
    const serialize = (el, path) => {
      if (typeof el === 'string' || typeof el === 'number') return String(el);
      if (!el || typeof el !== 'object') return null;
      if (typeof el.type === 'function') {
        renderCtx = ctx;
        let out;
        try {
          out = el.type(Object.assign({}, el.props, el.children.length ? { children: el.children } : {}));
        } finally {
          renderCtx = null;
        }
        return serialize(out, path);
      }
      const props = {};
      for (const k of Object.keys(el.props)) {
        const v = el.props[k];
        if (k === 'key' || k === 'children') continue;
        if (typeof v === 'function') {
          const h = handlers.get(path) || {};
          h[k] = v;
          handlers.set(path, h);
          props[k] = true;
        } else props[k] = v;
      }
      const children = [];
      el.children.forEach((c, i) => {
        const sc = serialize(c, path + '.' + i);
        if (sc !== null) children.push(sc);
      });
      return { type: el.type, props, children, path };
    };
    const out = serialize(tree, '0');
    widgetNodes.set(nodeId, { handlers, menu: ctx.menu });
    call('widget', 'rendered', nodeId, out, ctx.menu ? ctx.menu.items : null, ctx.created);
    for (const fn of ctx.effects) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }
  function widgetEntry(nodeId) {
    if (!widgetNodes.has(nodeId)) renderWidget(nodeId);
    return widgetNodes.get(nodeId);
  }
  const keepAlive = new Set();
  function waitForTask(p) {
    const pr = Promise.resolve(p);
    keepAlive.add(pr);
    pr.finally(() => keepAlive.delete(pr));
    return pr;
  }
  const widget = {
    h: widgetH,
    Fragment: 'Fragment', AutoLayout: 'AutoLayout', Frame: 'Frame', Text: 'Text', Span: 'Span', Rectangle: 'Rectangle',
    Ellipse: 'Ellipse', Line: 'Line', Image: 'Image', SVG: 'SVG', Input: 'Input',
    register(fn) {
      widgetComponent = fn;
      call('widget', 'registered');
    },
    useSyncedState(key, initial) {
      const ctx = renderCtx;
      if (!ctx) throw new Error('useSyncedState — только при отрисовке виджета');
      if (!(key in ctx.state)) {
        const v = typeof initial === 'function' ? initial() : initial;
        ctx.state[key] = v;
        ctx.created[key] = v === undefined ? null : v;
      }
      const nodeId = ctx.nodeId;
      return [ctx.state[key], (v) => {
        const cur = widgetState(nodeId)[key];
        setSynced(nodeId, key, typeof v === 'function' ? v(cur) : v);
      }];
    },
    useSyncedMap(key) {
      const ctx = renderCtx;
      if (!ctx) throw new Error('useSyncedMap — только при отрисовке виджета');
      const nodeId = ctx.nodeId;
      const mapKey = '$map:' + key;
      const read = () => Object.assign({}, widgetState(nodeId)[mapKey] || {});
      const snapshot = Object.assign({}, ctx.state[mapKey] || {});
      return {
        get(k) { return snapshot[k]; },
        has(k) { return k in snapshot; },
        set(k, v) { const m = read(); m[k] = v; snapshot[k] = v; setSynced(nodeId, mapKey, m); },
        delete(k) { const m = read(); delete m[k]; delete snapshot[k]; setSynced(nodeId, mapKey, m); },
        keys() { return Object.keys(snapshot); },
        values() { return Object.values(snapshot); },
        entries() { return Object.entries(snapshot); },
        get size() { return Object.keys(snapshot).length; },
      };
    },
    usePropertyMenu(items, cb) {
      if (renderCtx) renderCtx.menu = { items: (items || []).map((it) => Object.assign({}, it)), cb };
    },
    useEffect(fn) { if (renderCtx) renderCtx.effects.push(fn); },
    useWidgetNodeId() { return renderCtx ? renderCtx.nodeId : null; },
    useWidgetId() { return renderCtx ? renderCtx.nodeId : null; },
    useStickable() {},
    useStickableHost() {},
    useDefaultTextStyle() {},
    waitForTask,
  };

  globalThis.figma = {
    mixed,
    widget,
    parameters,
    payments,
    apiVersion: '1.0.0',
    get editorType() { return call('meta', 'editorType'); },
    get mode() { return call('meta', 'mode'); },
    codegen,
    // Motion: timeline cursor, motion styles, spring. Custom animation styles
    // (CustomAnimationStyle) are not supported — when they are unavailable.
    motion: {
      get playheadPosition() { const t = call('motion', 'playhead'); return t === null ? undefined : t; },
      figmaAnimationStyles() { return call('motion', 'styles'); },
      physicalSpringToNormalized(spring) { return call('motion', 'spring', spring); },
    },
    createCustomAnimationStyle() { throw new Error('"createCustomAnimationStyle" is not a supported API'); },
    getLocalCustomAnimationStyles() { throw new Error('"getLocalCustomAnimationStyles" is not a supported API'); },
    async getLocalCustomAnimationStylesAsync() { throw new Error('"getLocalCustomAnimationStylesAsync" is not a supported API'); },
    // Developer mode: annotation categories.
    annotations: {
      async getAnnotationCategoriesAsync() { return call('dev', 'categories'); },
      async getAnnotationCategoryByIdAsync(id) { return call('dev', 'category', id); },
      async addAnnotationCategoryAsync(c) { return call('dev', 'addCategory', c); },
    },
    get pluginId() { return call('meta', 'pluginId'); },
    get command() { return call('meta', 'command'); },
    get fileKey() { return undefined; },
    get currentUser() { return call('meta', 'currentUser'); },
    get root() { return call('root'); },
    get currentPage() { return call('currentPage'); },
    set currentPage(page) { call('setCurrentPage', page); },
    async setCurrentPageAsync(page) { call('setCurrentPage', page); },
    getNodeById(id) { return call('getNodeById', id); },
    async getNodeByIdAsync(id) { return call('getNodeById', id); },
    createRectangle: create('RECTANGLE'),
    createEllipse: create('ELLIPSE'),
    createLine: create('LINE'),
    createPolygon: create('POLYGON'),
    createStar: create('STAR'),
    createVector: create('VECTOR'),
    createText: create('TEXT'),
    createTextPath(node, startSegment, startPosition) { return call('createTextPath', node, startSegment, startPosition); },
    createFrame: create('FRAME'),
    createComponent: create('COMPONENT'),
    createSection: create('SECTION'),
    createSlice: create('SLICE'),
    createImage(data) { return imageOf(call('createImage', data).hash); },
    createComponentFromNode(node) { return call('createComponentFromNode', node); },
    getSelectionColors() { return call('selectionColors'); },
    openExternal(url) { call('openExternal', String(url)); },
    listAvailableFontsAsync() { return callAsync('listFonts'); },
    saveVersionHistoryAsync(title, description) { return callAsync('saveVersion', String(title ?? ''), description === undefined ? '' : String(description)); },
    get activeUsers() { return call('activeUsers'); },
    createImageAsync(src) { return callAsync('createImageAsync', String(src)).then((r) => imageOf(r.hash)); },
    createVideoAsync(data) { return Promise.resolve().then(() => ({ hash: call('createVideo', data).hash })); },
    getImageByHash(hash) { return hash ? imageOf(String(hash)) : null; },
    createNodeFromSvg(svg) { return call('createNodeFromSvg', String(svg)); },
    union: booleanOp('UNION'),
    subtract: booleanOp('SUBTRACT'),
    intersect: booleanOp('INTERSECT'),
    exclude: booleanOp('EXCLUDE'),
    flatten(nodes, parent, index) { return call('flatten', nodes, parent ?? null, index ?? null); },
    ungroup(node) { return call('ungroup', node); },
    base64Encode(data) { return call('base64Encode', data); },
    base64Decode(text) { return call('base64Decode', String(text)); },
    get skipInvisibleInstanceChildren() { return skipInvisible = call('skipInvisible'); },
    set skipInvisibleInstanceChildren(value) { skipInvisible = call('skipInvisible', value); },
    // History: an undo step is each batch of plugin edits.
    commitUndo() { call('commitUndo'); },
    triggerUndo() {},
    createPage() { return call('createPage'); },
    group(nodes, parent, index) { return call('group', nodes, parent, index ?? null); },
    loadFontAsync(font) { return callAsync('loadFont', font); },
    async loadAllPagesAsync() {},
    notify(message, options) {
      call('notify', String(message), options || null);
      return { cancel() {} };
    },
    showUI(html, options) { call('showUI', String(html), options || null); },
    ui,
    viewport,
    closePlugin(message) { call('closePlugin', message === undefined ? null : String(message)); },
    on, off,
    once(type, cb) { const wrap = (...a) => { off(type, wrap); cb(...a); }; on(type, wrap); },
    clientStorage: {
      getAsync: (key) => callAsync('storageGet', key),
      setAsync: (key, value) => callAsync('storageSet', key, value),
      deleteAsync: (key) => callAsync('storageDelete', key),
      keysAsync: () => callAsync('storageKeys'),
    },
    // Styles.
    getLocalPaintStyles() { return call('ds', 'localStyles', 'PAINT'); },
    async getLocalPaintStylesAsync() { return call('ds', 'localStyles', 'PAINT'); },
    getLocalTextStyles() { return call('ds', 'localStyles', 'TEXT'); },
    async getLocalTextStylesAsync() { return call('ds', 'localStyles', 'TEXT'); },
    getLocalEffectStyles() { return call('ds', 'localStyles', 'EFFECT'); },
    async getLocalEffectStylesAsync() { return call('ds', 'localStyles', 'EFFECT'); },
    getLocalGridStyles() { return call('ds', 'localStyles', 'GRID'); },
    async getLocalGridStylesAsync() { return call('ds', 'localStyles', 'GRID'); },
    getStyleById(id) { return call('ds', 'getStyleById', id); },
    async getStyleByIdAsync(id) { return call('ds', 'getStyleById', id); },
    async importStyleByKeyAsync(key) {
      for (const t of ['PAINT', 'TEXT', 'EFFECT', 'GRID']) for (const s of call('ds', 'localStyles', t)) if (s.key === key) return s;
      throw new Error('Стиля с ключом ' + key + ' нет');
    },
    createPaintStyle() { return call('ds', 'createStyle', 'PAINT'); },
    createTextStyle() { return call('ds', 'createStyle', 'TEXT'); },
    createEffectStyle() { return call('ds', 'createStyle', 'EFFECT'); },
    createGridStyle() { return call('ds', 'createStyle', 'GRID'); },
    // Components.
    combineAsVariants(nodes, parent, index) { return call('ds', 'combineAsVariants', nodes, parent, index ?? null); },
    async importComponentByKeyAsync(key) {
      throw new Error('Компоненты библиотек подключаются в меню «Дизайн-система» → «Библиотеки»');
    },
    // Variables.
    variables: {
      getLocalVariables(type) { return call('ds', 'localVariables', type ?? null); },
      async getLocalVariablesAsync(type) { return call('ds', 'localVariables', type ?? null); },
      getLocalVariableCollections() { return call('ds', 'localCollections'); },
      async getLocalVariableCollectionsAsync() { return call('ds', 'localCollections'); },
      getVariableById(id) { return call('ds', 'getVariableById', id); },
      async getVariableByIdAsync(id) { return call('ds', 'getVariableById', id); },
      getVariableCollectionById(id) { return call('ds', 'getCollectionById', id); },
      async getVariableCollectionByIdAsync(id) { return call('ds', 'getCollectionById', id); },
      createVariable(name, collection, resolvedType) { return call('ds', 'createVariable', name, collection, resolvedType); },
      createVariableCollection(name) { return call('ds', 'createCollection', name); },
      createVariableAlias(variable) { return { type: 'VARIABLE_ALIAS', id: variable.id }; },
      async createVariableAliasByIdAsync(id) { return { type: 'VARIABLE_ALIAS', id }; },
      setBoundVariableForPaint(paint, field, variable) { return call('ds', 'paintWithVariable', paint, field, variable); },
      setBoundVariableForEffect(effect, field, variable) { return call('ds', 'effectWithVariable', effect, field, variable); },
      setBoundVariableForLayoutGrid(grid, field, variable) { return Object.assign({}, grid, { boundVariables: Object.assign({}, grid.boundVariables || {}, variable ? { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } } : {}) }); },
      async importVariableByKeyAsync(key) { return call('ds', 'importVariableByKey', key); },
    },
    util: {
      rgb(color) { return call('parseColor', color, false); },
      rgba(color) { return call('parseColor', color, true); },
      solidPaint(color, overrides) {
        const c = call('parseColor', color, true);
        return Object.assign({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }, overrides || {});
      },
    },
  };

  // ---------- Host entry: events, UI messages, timers, promises ----------
  globalThis.__mfp_dispatch = (kind, json) => {
    const data = json === undefined ? undefined : revive(JSON.parse(json));
    switch (kind) {
      case 'uiMessage': {
        const props = { origin: data.origin || 'null' };
        if (typeof figma.ui.onmessage === 'function') figma.ui.onmessage(data.message, props);
        for (const cb of [...uiListeners]) cb(data.message, props);
        break;
      }
      case 'timer': {
        const t = timers.get(data.id);
        if (!t) break;
        if (!t.repeat) timers.delete(data.id);
        else call('setTimer', data.id, t.ms);
        t.fn(...t.rest);
        break;
      }
      case 'settle': {
        const p = promises.get(data.id);
        if (!p) break;
        promises.delete(data.id);
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.value);
        break;
      }
      case 'event':
        emit(data.type, ...(data.args || []));
        break;
      case 'parameterInput': {
        const id = data.requestId;
        const result = {
          setSuggestions(list) {
            call('suggestions', id, (list || []).map((x) => (typeof x === 'string' ? { name: x } : { name: String(x && x.name), data: x ? x.data : undefined })), null, null);
          },
          setError(message) { call('suggestions', id, null, String(message), null); },
          setLoadingMessage(message) { call('suggestions', id, null, null, String(message)); },
        };
        if (typeof parameterInput !== 'function') {
          result.setSuggestions([]);
          break;
        }
        Promise.resolve()
          .then(() => parameterInput({ key: data.key, query: data.query, parameters: data.parameters || {}, result }))
          .catch((e) => result.setError(String((e && e.message) || e)));
        break;
      }
      case 'nodeEvent':
        for (const cb of [...(nodeListeners.get(data.id + '|' + data.type) || [])]) cb(...(data.args || []));
        break;
      case 'widgetRender':
        renderWidget(data.nodeId);
        break;
      case 'widgetEvent': {
        const entry = widgetEntry(data.nodeId);
        const h = entry && entry.handlers.get(data.path);
        const fn = h && h[data.kind];
        if (typeof fn === 'function') waitForTask(Promise.resolve().then(() => fn(data.event || {})));
        break;
      }
      case 'widgetMenu': {
        const entry = widgetEntry(data.nodeId);
        const menu = entry && entry.menu;
        if (menu && typeof menu.cb === 'function') waitForTask(Promise.resolve().then(() => menu.cb({ propertyName: data.propertyName, propertyValue: data.propertyValue })));
        break;
      }
      case 'codegen': {
        const cb = codegenListeners.get('generate');
        const done = (res, err) => call('codegenResult', data.requestId, res === undefined ? null : res, err);
        if (!cb) {
          done(null, 'Плагин не подписан на figma.codegen.on("generate")');
          break;
        }
        Promise.resolve()
          .then(() => cb({ node: nodeProxy(data.nodeId), language: data.language }))
          .then((res) => done(Array.isArray(res) ? res : [], null), (e) => done(null, String((e && e.message) || e)));
        break;
      }
    }
  };
})();
`;
