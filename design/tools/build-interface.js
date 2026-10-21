// Design file “MFP interface — a new look”, built with the editor's own tools:
// variables (an OKLCH palette, a theme with “Dark” and “Light” modes, sizes), text and shadow
// styles, interface icons as vectors via SVG import, components with variants and screen
// mockups built from their instances. Runs in an editor page (started with Vite): call
// window.__designBuild({ root }) from the console or from browser automation.

window.__designBuild = async ({ root }) => {
  const core = await import(`/@fs/${root}/packages/core/src/index.ts`);
  const { importSvg } = await import('/src/svg-import.ts');
  const { ICON } = await import('/src/icons.ts');
  const { alias, createCollection, addMode, createVariable, setVariableValue, bindPaintVariable, setExplicitMode, createStyle, applyStyle, combineAsVariants, instantiate, swapComponent, oklchToRgb } = core;
  const ed = window.mfp.editor;
  const d = ed.doc;
  const log = [];
  const tx = (fn) => d.transact(fn);
  for (const style of ['Regular', 'Medium', 'Semi Bold', 'Bold']) await ed.fonts.ensure({ family: 'Inter', style });

  // ---------- Pages ----------
  const firstPage = ed.pageId;
  tx(() => d.set(firstPage, { name: 'Cover' }));
  const pages = { cover: firstPage };
  tx(() => {
    pages.base = d.create('PAGE', d.root, { name: 'Foundations' });
    pages.comps = d.create('PAGE', d.root, { name: 'Components' });
    pages.screens = d.create('PAGE', d.root, { name: 'Screens' });
  });

  // ---------- Variables ----------
  const V = {};
  const ok = (l, c, h, a = 1) => ({ ...oklchToRgb(l, c, h), a });
  const H = 266;
  const palette = tx(() => createCollection(d, 'Palette'));
  tx(() => d.set(palette, { modes: [{ modeId: d.get(palette, 'modes')[0].modeId, name: 'Value' }] }));
  const prim = (name, web, l, c, h) => {
    const id = tx(() => createVariable(d, name, palette, 'COLOR', ok(l, c, h)));
    tx(() => d.set(id, { description: `oklch(${l} ${c} ${h})`, codeSyntax: { WEB: web }, scopes: ['ALL_FILLS', 'STROKE_COLOR', 'EFFECT_COLOR'] }));
    V[name] = id;
  };
  const GRAYS = [
    [0, 1, 0],
    [25, 0.985, 0.003],
    [50, 0.968, 0.004],
    [100, 0.94, 0.005],
    [150, 0.91, 0.006],
    [200, 0.875, 0.007],
    [300, 0.8, 0.008],
    [400, 0.7, 0.009],
    [500, 0.6, 0.01],
    [600, 0.5, 0.01],
    [700, 0.42, 0.011],
    [750, 0.37, 0.011],
    [800, 0.33, 0.011],
    [850, 0.3, 0.011],
    [875, 0.285, 0.011],
    [900, 0.262, 0.011],
    [925, 0.24, 0.011],
    [950, 0.215, 0.011],
    [975, 0.19, 0.011],
  ];
  for (const [n, l, c] of GRAYS) prim(`Graphite/${n}`, `--gray-${n}`, l, c, H);
  const ACCENT = [
    [100, 0.95, 0.03],
    [200, 0.88, 0.07],
    [300, 0.79, 0.12],
    [400, 0.69, 0.17],
    [500, 0.62, 0.2],
    [600, 0.555, 0.215],
    [700, 0.49, 0.2],
    [800, 0.41, 0.17],
  ];
  for (const [n, l, c] of ACCENT) prim(`Ultramarine/${n}`, `--blue-${n}`, l, c, H);
  for (const [name, web, h, steps] of [
    ['Lilac', 'violet', 305, [[400, 0.71, 0.17], [600, 0.56, 0.22]]],
    ['Coral', 'red', 25, [[400, 0.67, 0.19], [600, 0.575, 0.21]]],
    ['Mint', 'green', 158, [[400, 0.74, 0.15], [600, 0.56, 0.14]]],
    ['Amber', 'amber', 75, [[400, 0.83, 0.15], [600, 0.69, 0.15]]],
    ['Teal', 'teal', 200, [[400, 0.74, 0.12], [600, 0.56, 0.11]]],
  ])
    for (const [n, l, c] of steps) prim(`${name}/${n}`, `--${web}-${n}`, l, c, h);
  log.push(`palette: ${Object.keys(V).length}`);

  const theme = tx(() => createCollection(d, 'Theme'));
  const DARK = d.get(theme, 'modes')[0].modeId;
  tx(() => d.set(theme, { modes: [{ modeId: DARK, name: 'Dark' }] }));
  const LIGHT = tx(() => addMode(d, theme, 'Light'));
  const sem = (name, web, dark, light, desc) => {
    const val = (x) => (typeof x === 'string' ? alias(V[x]) : x);
    const id = tx(() => createVariable(d, name, theme, 'COLOR', val(dark)));
    tx(() => {
      setVariableValue(d, id, LIGHT, val(light));
      d.set(id, { codeSyntax: { WEB: web }, description: desc });
    });
    V[name] = id;
  };
  const expr = (e) => ({ type: 'EXPRESSION', expression: e });
  sem('Background/App', '--bg', 'Graphite/975', 'Graphite/50', 'Behind the panels: file tabs, home, backdrops');
  sem('Background/Panel', '--panel', 'Graphite/925', 'Graphite/0', 'Side panels, windows');
  sem('Background/Field', '--panel-2', 'Graphite/875', 'Graphite/50', 'Input fields, row hover');
  sem('Background/Pressed', '--panel-3', 'Graphite/800', 'Graphite/150', 'Pressed button, field border on hover');
  sem('Background/Menu', '--menu', 'Graphite/900', 'Graphite/0', 'Menus, tooltips, popovers — above the panels');
  sem('Background/Canvas', '--canvas', 'Graphite/950', 'Graphite/100', 'Empty canvas (a file page has its own color)');
  sem('Line/Divider', '--line', 'Graphite/875', 'Graphite/100', 'Between sections');
  sem('Line/Border', '--border', 'Graphite/750', 'Graphite/200', 'Buttons, cards');
  sem('Text/Primary', '--text', 'Graphite/25', 'Graphite/975', 'Values, names');
  sem('Text/Secondary', '--text-2', 'Graphite/200', 'Graphite/700', 'Labels, icons');
  sem('Text/Muted', '--muted', 'Graphite/400', 'Graphite/500', 'Hints, units, inactive');
  sem('Text/On accent', '--on-accent', 'Graphite/0', 'Graphite/0', 'Text and icons on an accent fill');
  sem('Accent/Primary', '--accent', 'Ultramarine/500', 'Ultramarine/600', 'Selection, focus, primary button');
  sem('Accent/Hover', '--accent-2', 'Ultramarine/600', 'Ultramarine/700', 'Primary button under the pointer');
  sem('Accent/Soft', '--accent-soft', expr('alpha({Ultramarine/500}, 0.22)'), expr('alpha({Ultramarine/600}, 0.12)'), 'Selected row, chosen item');
  sem('Accent/Text', '--accent-text', 'Ultramarine/300', 'Ultramarine/600', 'Links and accent text on a panel');
  sem('Meaning/Component', '--component', 'Lilac/400', 'Lilac/600', 'Components and instances');
  sem('Meaning/Error', '--danger', 'Coral/400', 'Coral/600', 'Errors, deletion');
  sem('Meaning/Develop', '--dev', 'Teal/400', 'Teal/600', 'Developer mode');
  sem('Meaning/Warning', '--warning', 'Amber/400', 'Amber/600', 'Warnings');
  log.push(`theme: ${Object.keys(V).length}`);

  const sizes = tx(() => createCollection(d, 'Sizes'));
  tx(() => d.set(sizes, { modes: [{ modeId: d.get(sizes, 'modes')[0].modeId, name: 'Value' }] }));
  const size = (name, web, value, scopes) => {
    const id = tx(() => createVariable(d, name, sizes, 'FLOAT', value));
    tx(() => d.set(id, { codeSyntax: { WEB: web }, scopes }));
    V[name] = id;
  };
  for (const [n, v] of [['S', 4], ['M', 6], ['L', 8], ['XL', 12], ['XXL', 16]]) size(`Radius/${n}`, `--radius-${n.toLowerCase()}`, v, ['CORNER_RADIUS']);
  for (const [n, v] of [[1, 4], [2, 8], [3, 12], [4, 16], [5, 24], [6, 32]]) size(`Spacing/${n}`, `--space-${n}`, v, ['GAP', 'WIDTH_HEIGHT']);
  size('Height/Field', '--field-h', 28, ['WIDTH_HEIGHT']);
  size('Height/Row', '--row-h', 32, ['WIDTH_HEIGHT']);
  size('Height/Header', '--head-h', 48, ['WIDTH_HEIGHT']);
  size('Width/Left panel', '--left-w', 248, ['WIDTH_HEIGHT']);
  size('Width/Right panel', '--right-w', 280, ['WIDTH_HEIGHT']);
  log.push(`variables total: ${Object.keys(V).length}`);

  // ---------- Text and shadow styles ----------
  const TS = {};
  const tstyle = (name, style, fontSize, lh, ls = 0) => {
    TS[name] = tx(() => createStyle(d, 'TEXT', name, { fontName: { family: 'Inter', style }, fontSize, lineHeight: { unit: 'PIXELS', value: lh }, letterSpacing: { unit: 'PERCENT', value: ls } }));
  };
  tstyle('UI/Text', 'Regular', 12, 16);
  tstyle('UI/Text medium', 'Medium', 12, 16);
  tstyle('UI/Caption', 'Regular', 11, 14);
  tstyle('UI/Section', 'Semi Bold', 12, 16);
  tstyle('UI/Title', 'Semi Bold', 13, 18);
  tstyle('UI/Large', 'Semi Bold', 16, 22, -0.5);
  tstyle('Document/Heading 1', 'Bold', 44, 52, -2);
  tstyle('Document/Heading 2', 'Semi Bold', 24, 32, -1);
  tstyle('Document/Heading 3', 'Semi Bold', 16, 22, -0.5);
  tstyle('Document/Body', 'Regular', 15, 24);
  tstyle('Document/Small', 'Regular', 12, 18);
  tstyle('Document/Code', 'Medium', 12, 18);
  const ES = {};
  const shadow = (a, y, r, s = 0) => ({ type: 'DROP_SHADOW', color: { r: 0.02, g: 0.03, b: 0.06, a }, offset: { x: 0, y }, radius: r, spread: s, visible: true, blendMode: 'NORMAL' });
  ES.menu = tx(() => createStyle(d, 'EFFECT', 'Shadow/Menu', { effects: [shadow(0.28, 2, 6), shadow(0.36, 12, 32)] }));
  ES.toolbar = tx(() => createStyle(d, 'EFFECT', 'Shadow/Toolbar', { effects: [shadow(0.2, 1, 3), shadow(0.3, 8, 24)] }));
  ES.card = tx(() => createStyle(d, 'EFFECT', 'Shadow/Card', { effects: [shadow(0.08, 1, 2), shadow(0.1, 6, 16)] }));
  ES.focus = tx(() => createStyle(d, 'EFFECT', 'Shadow/Focus', { effects: [{ type: 'DROP_SHADOW', color: { r: 0.26, g: 0.5, b: 0.97, a: 0.3 }, offset: { x: 0, y: 0 }, radius: 0, spread: 3, visible: true, blendMode: 'NORMAL', boundVariables: { color: alias(V['Accent/Soft']) } }] }));

  // ---------- Nodes ----------
  const SOLID = (c = { r: 0, g: 0, b: 0 }, opacity = 1) => ({ type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity, visible: true });
  const all = (id) => {
    const out = [];
    const w = (n) => {
      for (const c of d.children(n)) {
        out.push(c);
        w(c);
      }
    };
    w(id);
    return out;
  };
  const find = (rootId, name) => all(rootId).find((x) => d.get(x, 'name') === name) ?? null;
  /** Paint: a variable name (bound) or a color { r, g, b, a } (mockup content). */
  const paint = (id, key, spec) => {
    if (typeof spec === 'string') {
      if (!V[spec]) throw new Error(`no variable ${spec}`);
      tx(() => {
        d.set(id, { [key]: [SOLID()] });
        bindPaintVariable(d, id, key, 0, V[spec]);
      });
    } else tx(() => d.set(id, { [key]: [SOLID(spec, spec.a ?? 1)] }));
  };
  const pads = (p) => (Array.isArray(p) ? (p.length === 2 ? [p[0], p[1], p[0], p[1]] : p) : [p ?? 0, p ?? 0, p ?? 0, p ?? 0]);
  function F(parent, o = {}) {
    const pm = d.get(parent, 'layoutMode') ?? 'NONE';
    const props = { name: o.name ?? 'Frame', fills: [], clipsContent: !!o.clip, width: o.w ?? 100, height: o.h ?? 100 };
    if (o.x !== undefined || o.y !== undefined) props.transform = [1, 0, o.x ?? 0, 0, 1, o.y ?? 0];
    if (o.dir) {
      props.layoutMode = o.dir === 'H' ? 'HORIZONTAL' : 'VERTICAL';
      props.itemSpacing = o.gap ?? 0;
      const [pt, pr, pb, pl] = pads(o.pad);
      Object.assign(props, { paddingTop: pt, paddingRight: pr, paddingBottom: pb, paddingLeft: pl });
      const hugMain = o.dir === 'H' ? o.hugW : o.hugH;
      const hugCross = o.dir === 'H' ? o.hugH : o.hugW;
      props.primaryAxisSizingMode = hugMain ? 'AUTO' : 'FIXED';
      props.counterAxisSizingMode = hugCross ? 'AUTO' : 'FIXED';
      props.primaryAxisAlignItems = o.main ?? 'MIN';
      props.counterAxisAlignItems = o.cross ?? 'MIN';
      if (o.wrap) {
        props.layoutWrap = 'WRAP';
        props.counterAxisSpacing = o.rowGap ?? o.gap ?? 0;
      }
    }
    if (o.radius) props.cornerRadius = o.radius;
    if (pm !== 'NONE' && !o.abs) {
      if (pm === 'HORIZONTAL') {
        if (o.fillW) props.layoutGrow = 1;
        if (o.fillH) props.layoutAlign = 'STRETCH';
      } else {
        if (o.fillH) props.layoutGrow = 1;
        if (o.fillW) props.layoutAlign = 'STRETCH';
      }
    }
    if (o.abs) props.layoutPositioning = 'ABSOLUTE';
    if (o.constraints) props.constraints = o.constraints;
    if (o.opacity !== undefined) props.opacity = o.opacity;
    const id = tx(() => d.create(o.type ?? 'FRAME', parent, props));
    if (o.fill) paint(id, 'fills', o.fill);
    if (o.stroke) {
      tx(() => d.set(id, { strokeWeight: o.strokeW ?? 1, strokeAlign: o.strokeAlign ?? 'INSIDE', ...(o.dash ? { dashPattern: o.dash } : {}) }));
      paint(id, 'strokes', o.stroke);
    }
    if (o.effect) tx(() => applyStyle(d, id, 'effectStyleId', ES[o.effect]));
    if (o.mode) tx(() => setExplicitMode(d, id, theme, o.mode));
    return id;
  }
  function T(parent, text, style, color, o = {}) {
    const pm = d.get(parent, 'layoutMode') ?? 'NONE';
    const props = { name: o.name ?? text.slice(0, 32), characters: text, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 12, textAutoResize: o.w ? 'HEIGHT' : 'WIDTH_AND_HEIGHT', fills: [SOLID()] };
    if (o.w) props.width = o.w;
    if (o.align) props.textAlignHorizontal = o.align;
    if (o.x !== undefined || o.y !== undefined) props.transform = [1, 0, o.x ?? 0, 0, 1, o.y ?? 0];
    if (pm !== 'NONE' && o.fillW) {
      if (pm === 'HORIZONTAL') props.layoutGrow = 1;
      else props.layoutAlign = 'STRETCH';
      props.textAutoResize = 'HEIGHT';
    }
    if (o.truncate) Object.assign(props, { textTruncation: 'ENDING', maxLines: 1 });
    if (o.abs) props.layoutPositioning = 'ABSOLUTE';
    const id = tx(() => d.create('TEXT', parent, props));
    tx(() => applyStyle(d, id, 'textStyleId', TS[style]));
    paint(id, 'fills', color);
    return id;
  }
  /** Recolor vectors (an icon, an instance) to a variable or a color. */
  const recolor = (id, color) => {
    for (const v of [id, ...all(id)]) {
      if (d.type(v) === 'TEXT') continue;
      if ((d.get(v, 'strokes') ?? []).length) paint(v, 'strokes', color);
      if ((d.get(v, 'fills') ?? []).length && d.type(v) !== 'FRAME' && d.type(v) !== 'INSTANCE' && d.type(v) !== 'COMPONENT') paint(v, 'fills', color);
    }
  };

  // ---------- Icons: vectors from the app icon set ----------
  let iconsFrame = null;
  let iconsCount = 0;
  const ICONS = {};
  function iconComponent(name, sz = 16) {
    const key = `${name}@${sz}`;
    if (ICONS[key]) return ICONS[key];
    if (!ICON[name]) throw new Error(`no icon ${name}`);
    const svg = ICON[name].replace('class="ic"', `width="${sz}" height="${sz}"`).replace(/currentColor/g, '#000000');
    let comp;
    tx(() => {
      const tmp = importSvg(ed, svg, name, [0, 0]);
      comp = d.create('COMPONENT', iconsFrame, { name: `Icon ${sz}/${name}`, width: sz, height: sz, fills: [] });
      for (const c of [...d.children(tmp)]) {
        d.move(c, comp);
        d.set(c, { constraints: { horizontal: 'SCALE', vertical: 'SCALE' } });
      }
      d.delete(tmp);
    });
    recolor(comp, 'Text/Secondary');
    ICONS[key] = comp;
    iconsCount++;
    return comp;
  }
  function I(parent, name, color = 'Text/Secondary', sz = 16, o = {}) {
    const comp = iconComponent(name, sz);
    const id = tx(() => instantiate(d, comp, parent, [1, 0, o.x ?? 0, 0, 1, o.y ?? 0]));
    if (o.name) tx(() => d.set(id, { name: o.name }));
    if (color !== 'Text/Secondary') recolor(id, color);
    return id;
  }

  // ---------- Components ----------
  const compsPage = pages.comps;
  ed.setPage(compsPage);
  const board = (parent, title, x, y, w, sub) => {
    const f = F(parent, { name: title, x, y, w, h: 100, dir: 'V', gap: 16, pad: 32, hugH: true, fill: 'Background/Panel', radius: 16 });
    T(f, title, 'Document/Heading 2', 'Text/Primary');
    if (sub) T(f, sub, 'Document/Small', 'Text/Muted', { fillW: true });
    return f;
  };
  // Icon board.
  const iconsBoard = board(compsPage, 'Icons', 0, 0, 760, 'Vectors from the app icon set (SVG import), color — the “Text/Secondary” variable; 16 px — panels, 20 px — tools.');
  iconsFrame = F(iconsBoard, { name: 'Set', dir: 'H', gap: 20, pad: 0, wrap: true, rowGap: 20, fillW: true, hugH: true });
  const ICON_LIST = ['move', 'frame', 'rect', 'ellipse', 'pen', 'pencil', 'text', 'comment', 'image', 'plugins', 'sparkle', 'bell', 'history', 'folder', 'trash', 'clock'];
  for (const n of ICON_LIST) iconComponent(n, 20);
  log.push(`icons 20: ${iconsCount}`);
  // Extra 16 px icons (added to the same set as they are used).
  for (const n of ['plus', 'minus', 'chevronDown', 'chevronRight', 'check', 'eye', 'lock', 'play', 'more', 'search', 'link', 'component', 'instance', 'grid', 'alignLeft', 'alignHCenter', 'alignRight', 'alignTop', 'alignVCenter', 'alignBottom', 'text', 'frame', 'rect', 'ellipse', 'image', 'home', 'close', 'code', 'sparkle', 'bell', 'play'].filter((n) => ICON[n])) iconComponent(n, 16);
  log.push(`icons: ${iconsCount}; missing from the set: ${['plus', 'minus', 'chevronDown', 'chevronRight', 'check', 'eye', 'lock', 'play', 'more', 'search', 'link', 'component', 'instance', 'grid', 'alignLeft', 'alignHCenter', 'alignRight', 'alignTop', 'alignVCenter', 'alignBottom', 'home', 'close', 'code'].filter((n) => !ICON[n]).join(', ')}`);
  const has = (n) => !!ICON[n];
  const icon16 = (n, fb) => (has(n) ? n : fb);

  // Variant set: defs — [{ name: 'Type=Primary', build(comp) }], the set — with auto layout.
  const variantSet = (parent, title, defs, o = {}) => {
    const comps = defs.map((def) => {
      const c = F(parent, { type: 'COMPONENT', name: def.name, ...def.frame });
      def.build(c);
      return c;
    });
    const set = tx(() => combineAsVariants(d, comps, parent));
    tx(() =>
      d.set(set, {
        name: title,
        layoutMode: o.dir === 'V' ? 'VERTICAL' : 'HORIZONTAL',
        itemSpacing: 16,
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        primaryAxisSizingMode: 'AUTO',
        counterAxisSizingMode: 'AUTO',
        counterAxisAlignItems: 'CENTER',
        cornerRadius: 8,
        fills: [],
        strokeWeight: 1,
        dashPattern: [4, 4],
      }),
    );
    paint(set, 'strokes', 'Meaning/Component');
    return { set, by: Object.fromEntries(defs.map((def, i) => [def.key ?? def.name, comps[i]])) };
  };
  const section = (parent, title, sub) => {
    const b = board(parent, title, 0, 0, 760, sub);
    return b;
  };
  const compsCol = F(compsPage, { name: 'Components', x: 820, y: 0, w: 1640, h: 100, dir: 'H', gap: 40, hugH: true, wrap: true, rowGap: 40 });
  const colA = F(compsCol, { name: 'Column 1', w: 800, dir: 'V', gap: 40, hugH: true });
  const colB = F(compsCol, { name: 'Column 2', w: 800, dir: 'V', gap: 40, hugH: true });

  // Button.
  const btnBoard = section(colA, 'Button', 'Height 28, corner radius 6, text 12 Medium. One primary button per screen.');
  const BTN = variantSet(
    btnBoard,
    'Button',
    [
      ['Primary', 'Accent/Primary', 'Text/On accent', null],
      ['Default', null, 'Text/Primary', 'Line/Border'],
      ['Quiet', null, 'Text/Secondary', null],
      ['Danger', 'Meaning/Error', 'Text/On accent', null],
    ].map(([kind, fill, color, stroke]) => ({
      name: `Type=${kind}`,
      key: kind,
      frame: { dir: 'H', h: 28, pad: [0, 12], gap: 6, hugW: true, cross: 'CENTER', main: 'CENTER', radius: 6, fill: fill ?? undefined, stroke: stroke ?? undefined },
      build: (c) => T(c, kind === 'Danger' ? 'Delete' : kind === 'Primary' ? 'Share' : kind === 'Default' ? 'Cancel' : 'More', 'UI/Text medium', color, { name: 'Label' }),
    })),
  );
  // Icon button.
  const ibtnBoard = section(colA, 'Icon button', '28 square, 16 icon. Hover and press — fill, no border.');
  const IBTN = variantSet(
    ibtnBoard,
    'Icon button',
    [
      ['Default', null, 'Text/Secondary'],
      ['Hover', 'Background/Field', 'Text/Primary'],
      ['Pressed', 'Background/Pressed', 'Text/Primary'],
      ['Toggled', 'Accent/Soft', 'Accent/Text'],
    ].map(([state, fill, color]) => ({
      name: `State=${state}`,
      key: state,
      frame: { dir: 'H', w: 28, h: 28, main: 'CENTER', cross: 'CENTER', radius: 6, fill: fill ?? undefined },
      build: (c) => I(c, icon16('plus', 'rect'), color, 16, { name: 'Icon' }),
    })),
  );
  // Field.
  const fieldBoard = section(colA, 'Field', 'Scrub label on the left (drag to change the value), value, unit. Focus — accent border and a soft glow.');
  const FIELD = variantSet(
    fieldBoard,
    'Field',
    [
      ['Default', null, 0],
      ['Hover', 'Line/Border', 1],
      ['Focus', 'Accent/Primary', 1],
    ].map(([state, stroke]) => ({
      name: `State=${state}`,
      key: state,
      frame: { dir: 'H', w: 112, h: 28, pad: [0, 8, 0, 4], gap: 4, cross: 'CENTER', radius: 6, fill: 'Background/Field', stroke: stroke ?? undefined, effect: state === 'Focus' ? 'focus' : undefined },
      build: (c) => {
        const lab = F(c, { name: 'Scrub label', dir: 'H', w: 20, h: 20, main: 'CENTER', cross: 'CENTER' });
        T(lab, 'X', 'UI/Caption', 'Text/Muted', { name: 'Letter' });
        const ic = I(lab, 'gap', 'Text/Muted', 16, { name: 'Badge' });
        tx(() => d.set(ic, { visible: false }));
        T(c, '120', 'UI/Text', 'Text/Primary', { name: 'Value', fillW: true });
      },
    })),
  );
  // Tab (segments).
  const tabBoard = section(colA, 'Tabs', 'Segments on a field backdrop: the active one is a raised chip, the rest are text.');
  const TAB = variantSet(
    tabBoard,
    'Tab',
    [
      ['Active', 'Background/Panel', 'Text/Primary', 'Line/Border'],
      ['Default', null, 'Text/Muted', null],
    ].map(([state, fill, color, stroke]) => ({
      name: `State=${state}`,
      key: state,
      frame: { dir: 'H', h: 24, pad: [0, 10], hugW: true, main: 'CENTER', cross: 'CENTER', radius: 5, fill: fill ?? undefined, stroke: stroke ?? undefined },
      build: (c) => T(c, 'Design', 'UI/Text medium', color, { name: 'Label' }),
    })),
  );
  // Layer row.
  const rowBoard = section(colB, 'Layer row', 'Height 32, corner radius 6, 6 from the panel edges. Selection — soft accent; components — lilac.');
  const ROW = variantSet(
    rowBoard,
    'Layer row',
    [
      ['Default', null, 'Text/Secondary'],
      ['Hover', 'Background/Field', 'Text/Primary'],
      ['Selected', 'Accent/Soft', 'Text/Primary'],
    ].map(([state, fill, color]) => ({
      name: `State=${state}`,
      key: state,
      frame: { dir: 'H', w: 236, h: 32, pad: [0, 8, 0, 4], gap: 4, cross: 'CENTER', radius: 6, fill: fill ?? undefined },
      build: (c) => {
        F(c, { name: 'Indent', w: 0, h: 16 });
        I(c, icon16('chevronRight', 'move'), 'Text/Muted', 16, { name: 'Arrow' });
        I(c, 'frame', 'Text/Muted', 16, { name: 'Type' });
        T(c, 'Header', 'UI/Text', color, { name: 'Name', fillW: true });
      },
    })),
    { dir: 'V' },
  );
  // Section header.
  const headBoard = section(colB, 'Section header', '12 Semi Bold title with actions on the right. A new setting is a new section, not a new button.');
  const HEAD = variantSet(headBoard, 'Section header', [
    {
      name: 'Action=Yes',
      key: 'Yes',
      frame: { dir: 'H', w: 236, h: 28, pad: [0, 4, 0, 12], cross: 'CENTER', gap: 4 },
      build: (c) => {
        T(c, 'Fill', 'UI/Section', 'Text/Primary', { name: 'Title', fillW: true });
        const b = tx(() => instantiate(d, IBTN.by['Default'], c, [1, 0, 0, 0, 1, 0]));
        tx(() => d.set(b, { name: 'Action' }));
      },
    },
    {
      name: 'Action=No',
      key: 'No',
      frame: { dir: 'H', w: 236, h: 28, pad: [0, 4, 0, 12], cross: 'CENTER', gap: 4 },
      build: (c) => T(c, 'Position', 'UI/Section', 'Text/Primary', { name: 'Title', fillW: true }),
    },
  ]);
  // Tool.
  const toolBoard = section(colB, 'Tool', 'Bottom toolbar button: 36 × 36, 20 icon. Active — accent fill.');
  const TOOL = variantSet(
    toolBoard,
    'Tool',
    [
      ['Default', null, 'Text/Secondary'],
      ['Hover', 'Background/Field', 'Text/Primary'],
      ['Active', 'Accent/Primary', 'Text/On accent'],
    ].map(([state, fill, color]) => ({
      name: `State=${state}`,
      key: state,
      frame: { dir: 'H', w: 36, h: 36, main: 'CENTER', cross: 'CENTER', radius: 8, fill: fill ?? undefined },
      build: (c) => I(c, 'move', color, 20, { name: 'Icon' }),
    })),
  );
  // Menu item.
  const menuBoard = section(colB, 'Menu item', 'Height 28, corner radius 6; hover — neutral fill, shortcut on the right in muted text.');
  const MENU = variantSet(
    menuBoard,
    'Menu item',
    [
      ['Default', null],
      ['Hover', 'Background/Field'],
    ].map(([state, fill]) => ({
      name: `State=${state}`,
      key: state,
      frame: { dir: 'H', w: 220, h: 28, pad: [0, 10], gap: 8, cross: 'CENTER', radius: 6, fill: fill ?? undefined },
      build: (c) => {
        T(c, 'Duplicate', 'UI/Text', 'Text/Primary', { name: 'Item', fillW: true });
        T(c, 'Ctrl+D', 'UI/Caption', 'Text/Muted', { name: 'Shortcut' });
      },
    })),
  );
  // Checkbox.
  const checkBoard = section(colA, 'Checkbox', '16 × 16, corner radius 4.');
  const CHECK = variantSet(
    checkBoard,
    'Checkbox',
    [
      ['Off', null, 'Line/Border'],
      ['On', 'Accent/Primary', null],
    ].map(([state, fill, stroke]) => ({
      name: `Value=${state}`,
      key: state,
      frame: { dir: 'H', w: 16, h: 16, main: 'CENTER', cross: 'CENTER', radius: 4, fill: fill ?? undefined, stroke: stroke ?? undefined, strokeW: 1.5 },
      build: (c) => {
        if (state === 'On' && has('check')) I(c, 'check', 'Text/On accent', 16, { name: 'Check' });
      },
    })),
  );
  log.push('components done');

  // ---------- Instance helpers ----------
  const use = (comp, parent, o = {}) => {
    const id = tx(() => instantiate(d, comp, parent, [1, 0, o.x ?? 0, 0, 1, o.y ?? 0]));
    const pm = d.get(parent, 'layoutMode') ?? 'NONE';
    const props = {};
    if (o.name) props.name = o.name;
    if (pm === 'HORIZONTAL' && o.fillW) props.layoutGrow = 1;
    if (pm === 'VERTICAL' && o.fillW) props.layoutAlign = 'STRETCH';
    if (o.w) props.width = o.w;
    if (Object.keys(props).length) tx(() => d.set(id, props));
    for (const [name, text] of Object.entries(o.text ?? {})) {
      const t = find(id, name);
      if (t) tx(() => d.set(t, { characters: text }));
    }
    for (const [name, iconName] of Object.entries(o.icon ?? {})) {
      const t = find(id, name);
      const sz = t ? d.get(t, 'width') : 16;
      if (t && ICON[iconName]) tx(() => swapComponent(d, t, iconComponent(iconName, Math.round(sz))));
    }
    for (const [name, color] of Object.entries(o.color ?? {})) {
      const t = find(id, name);
      if (t) recolor(t, color);
    }
    for (const name of o.hide ?? []) {
      const t = find(id, name);
      if (t) tx(() => d.set(t, { visible: false }));
    }
    for (const name of o.show ?? []) {
      const t = find(id, name);
      if (t) tx(() => d.set(t, { visible: true }));
    }
    return id;
  };
  const divider = (parent, o = {}) => F(parent, { name: 'Divider', h: o.vertical ? 100 : 1, w: o.vertical ? 1 : 100, fillW: !o.vertical, fillH: !!o.vertical, fill: 'Line/Divider' });

  // ---------- Editor screen ----------
  const PAGE_CONTENT = {
    ink: { r: 0.09, g: 0.1, b: 0.13 },
    soft: { r: 0.42, g: 0.44, b: 0.5 },
    brand: { r: 0.98, g: 0.42, b: 0.27 },
    sand: { r: 0.97, g: 0.95, b: 0.92 },
    white: { r: 1, g: 1, b: 1 },
    sky: { r: 0.86, g: 0.9, b: 0.98 },
  };
  function sitePreview(parent, x, y) {
    // Canvas content: a website mockup (its own colors, not the interface theme).
    const site = F(parent, { name: 'Home — 1440', x, y, w: 600, h: 640, fill: PAGE_CONTENT.white, dir: 'V', clip: true });
    const nav = F(site, { name: 'Header', dir: 'H', h: 56, pad: [0, 32], gap: 24, cross: 'CENTER', fillW: true });
    T(nav, 'Studio', 'Document/Heading 3', PAGE_CONTENT.ink, { name: 'Logo' });
    F(nav, { name: 'Spacer', h: 1, fillW: true });
    for (const l of ['Work', 'Services', 'Contact']) T(nav, l, 'UI/Text medium', PAGE_CONTENT.soft);
    const hero = F(site, { name: 'Hero', dir: 'V', h: 300, pad: [48, 32], gap: 16, fillW: true, fill: PAGE_CONTENT.sand });
    T(hero, 'Design that\nworks for you', 'Document/Heading 1', PAGE_CONTENT.ink, { name: 'Title' });
    T(hero, 'We design websites and apps — from the first\nsketch to the developer handoff.', 'Document/Body', PAGE_CONTENT.soft, { name: 'Subtitle' });
    const cta = F(hero, { name: 'Button / Primary', dir: 'H', h: 44, pad: [0, 20], hugW: true, main: 'CENTER', cross: 'CENTER', radius: 22, fill: PAGE_CONTENT.brand });
    T(cta, 'Discuss a project', 'UI/Title', PAGE_CONTENT.white);
    const cards = F(site, { name: 'Cards', dir: 'H', h: 220, pad: [24, 32], gap: 16, fillW: true });
    for (const [t, c] of [
      ['Websites', PAGE_CONTENT.sky],
      ['Apps', { r: 0.92, g: 0.88, b: 0.98 }],
      ['Branding', { r: 0.99, g: 0.9, b: 0.86 }],
    ]) {
      const card = F(cards, { name: `Card / ${t}`, dir: 'V', h: 172, pad: 16, gap: 8, fillW: true, radius: 12, fill: c });
      F(card, { name: 'Image', h: 92, fillW: true, radius: 8, fill: { r: 1, g: 1, b: 1, a: 0.7 } });
      T(card, t, 'Document/Heading 3', PAGE_CONTENT.ink);
    }
    return { site, hero };
  }
  function editorScreen(parent, x, y, mode, title) {
    const W = 1440;
    const Hh = 900;
    const scr = F(parent, { name: title, x, y, w: W, h: Hh, dir: 'V', fill: 'Background/App', clip: true, mode });
    // File tabs (desktop).
    const tabs = F(scr, { name: 'File tabs', dir: 'H', h: 38, pad: [6, 8, 0, 8], gap: 2, cross: 'MAX', fillW: true });
    use(IBTN.by['Default'], tabs, { name: 'Home', icon: { Icon: 'folder' } });
    for (const [name, on] of [
      ['Studio website', true],
      ['Design system', false],
      ['Banking app', false],
    ]) {
      const t = F(tabs, { name: `Tab / ${name}`, dir: 'H', w: 184, h: 32, pad: [0, 8, 0, 12], gap: 6, cross: 'CENTER', fill: on ? 'Background/Panel' : undefined, radius: 8 });
      T(t, name, 'UI/Text medium', on ? 'Text/Primary' : 'Text/Muted', { fillW: true, truncate: true });
      if (on && has('close')) I(t, 'close', 'Text/Muted');
    }
    use(IBTN.by['Default'], tabs, { name: 'New file' });
    // Workspace.
    const work = F(scr, { name: 'Workspace', dir: 'H', fillW: true, fillH: true, h: Hh - 38 });
    // Left panel.
    const left = F(work, { name: 'Left panel', dir: 'V', w: 248, fillH: true, fill: 'Background/Panel', h: 100 });
    const lh = F(left, { name: 'Header', dir: 'H', h: 48, pad: [0, 8], gap: 6, cross: 'CENTER', fillW: true });
    const logo = F(lh, { name: 'Logo', dir: 'H', w: 32, h: 32, main: 'CENTER', cross: 'CENTER', radius: 8, fill: 'Accent/Primary' });
    I(logo, 'logo', 'Text/On accent', 20);
    const fname = F(lh, { name: 'File name', dir: 'V', fillW: true, hugH: true, gap: 0 });
    T(fname, 'Studio website', 'UI/Title', 'Text/Primary');
    T(fname, 'My files · saved', 'UI/Caption', 'Text/Muted');
    if (has('chevronDown')) I(lh, 'chevronDown', 'Text/Muted');
    divider(left);
    const lt = F(left, { name: 'Tabs', dir: 'H', h: 44, pad: [0, 12], cross: 'CENTER', fillW: true });
    const seg = F(lt, { name: 'Segments', dir: 'H', h: 28, pad: 2, gap: 2, hugW: true, cross: 'CENTER', radius: 7, fill: 'Background/Field' });
    use(TAB.by['Active'], seg, { text: { Label: 'File' } });
    use(TAB.by['Default'], seg, { text: { Label: 'Assets' } });
    // Pages.
    const pagesSec = F(left, { name: 'Pages', dir: 'V', pad: [6, 6, 8, 6], gap: 0, fillW: true, hugH: true });
    use(HEAD.by['Yes'], pagesSec, { fillW: true, text: { Title: 'Pages' } });
    for (const [p, on] of [
      ['Home', true],
      ['Catalog', false],
      ['Profile', false],
    ]) {
      const r = F(pagesSec, { name: `Page / ${p}`, dir: 'H', h: 28, pad: [0, 8, 0, 10], gap: 8, cross: 'CENTER', fillW: true, radius: 6 });
      if (on && has('check')) I(r, 'check', 'Text/Primary');
      else F(r, { name: 'Space', w: 16, h: 16 });
      T(r, p, on ? 'UI/Text medium' : 'UI/Text', on ? 'Text/Primary' : 'Text/Secondary', { fillW: true });
    }
    divider(left);
    const layersSec = F(left, { name: 'Layers', dir: 'V', pad: [6, 6, 8, 6], gap: 0, fillW: true, fillH: true, h: 100 });
    use(HEAD.by['No'], layersSec, { fillW: true, text: { Title: 'Layers' } });
    const tree = [
      [0, 'frame', 'Home — 1440', 'Default', true],
      [1, 'frame', 'Header', 'Default', false],
      [1, 'frame', 'Hero', 'Selected', true],
      [2, 'text', 'Title', 'Default', null],
      [2, 'text', 'Subtitle', 'Default', null],
      [2, 'component', 'Button / Primary', 'Hover', null],
      [1, 'frame', 'Cards', 'Default', false],
      [1, 'frame', 'Footer', 'Default', false],
      [0, 'frame', 'Catalog — 1440', 'Default', false],
      [0, 'frame', 'Product card', 'Default', false],
    ];
    for (const [depth, type, name, state, open] of tree) {
      const r = use(ROW.by[state], layersSec, { fillW: true, text: { Name: name } });
      const indent = find(r, 'Indent');
      if (indent) tx(() => d.set(indent, { width: depth * 16 }));
      const tw = find(r, 'Arrow');
      if (tw) {
        if (open === null) tx(() => d.set(tw, { opacity: 0 }));
        else if (open && has('chevronDown')) tx(() => swapComponent(d, tw, iconComponent('chevronDown', 16)));
      }
      const ti = find(r, 'Type');
      const iconName = type === 'component' ? icon16('instance', icon16('component', 'frame')) : type;
      if (ti && ICON[iconName] && iconName !== 'frame') tx(() => swapComponent(d, ti, iconComponent(iconName, 16)));
      if (type === 'component') {
        const ti2 = find(r, 'Type');
        if (ti2) recolor(ti2, 'Meaning/Component');
        const nm = find(r, 'Name');
        if (nm) paint(nm, 'fills', 'Meaning/Component');
      }
    }
    divider(work, { vertical: true });
    // Canvas.
    const canvas = F(work, { name: 'Canvas', fillW: true, fillH: true, w: 910, h: 100, fill: 'Background/Canvas', clip: true });
    T(canvas, 'Home — 1440', 'UI/Caption', 'Text/Muted', { x: 163, y: 66 });
    const { hero } = sitePreview(canvas, 163, 86);
    // Selection of the “Hero”: box, handles, size.
    const sel = F(canvas, { name: 'Selection', x: 162, y: 141, w: 602, h: 302, stroke: 'Accent/Primary', strokeW: 1.5, strokeAlign: 'CENTER' });
    void sel;
    for (const [hx, hy] of [
      [158, 137],
      [759, 137],
      [158, 438],
      [759, 438],
    ]) F(canvas, { name: 'Handle', x: hx, y: hy, w: 8, h: 8, fill: 'Graphite/0', stroke: 'Accent/Primary', strokeW: 1.5, radius: 2 });
    const badge = F(canvas, { name: 'Size', x: 418, y: 452, dir: 'H', h: 20, pad: [0, 6], hugW: true, cross: 'CENTER', radius: 4, fill: 'Accent/Primary' });
    T(badge, '600 × 300', 'UI/Caption', 'Text/On accent');
    void hero;
    // Toolbar — centered at the bottom.
    const bar = F(canvas, { name: 'Toolbar', x: 0, y: 0, dir: 'H', h: 48, pad: 6, gap: 2, hugW: true, cross: 'CENTER', radius: 14, fill: 'Background/Menu', stroke: 'Line/Border', effect: 'toolbar', constraints: { horizontal: 'CENTER', vertical: 'MAX' } });
    use(TOOL.by['Active'], bar, { name: 'Move' });
    for (const t of ['frame', 'rect', 'pen', 'text', 'comment']) use(TOOL.by['Default'], bar, { name: t, icon: { Icon: t } });
    F(bar, { name: 'Separator', w: 1, h: 20, fill: 'Line/Border' });
    use(TOOL.by['Default'], bar, { name: 'Actions', icon: { Icon: 'sparkle' } });
    use(TOOL.by['Default'], bar, { name: 'Plugins', icon: { Icon: 'plugins' } });
    // The panel width is known after layout — center it then.
    const bw = d.get(bar, 'width');
    tx(() => d.set(bar, { transform: [1, 0, Math.round((910 - bw) / 2), 0, 1, 862 - 48 - 20] }));
    // Zoom hint at the bottom left.
    const zoom = F(canvas, { name: 'Zoom', x: 16, y: 862 - 40, dir: 'H', h: 24, pad: [0, 8], hugW: true, cross: 'CENTER', radius: 6, fill: 'Background/Menu', stroke: 'Line/Border' });
    T(zoom, '62%', 'UI/Caption', 'Text/Secondary');
    divider(work, { vertical: true });
    // Right panel.
    const right = F(work, { name: 'Right panel', dir: 'V', w: 280, fillH: true, h: 100, fill: 'Background/Panel' });
    const rh = F(right, { name: 'Header', dir: 'H', h: 48, pad: [0, 8, 0, 12], gap: 8, cross: 'CENTER', fillW: true });
    const people = F(rh, { name: 'Participants', dir: 'H', gap: -6, hugW: true, hugH: true, fillW: false });
    for (const [ch, c] of [
      ['A', { r: 0.95, g: 0.45, b: 0.3 }],
      ['M', { r: 0.25, g: 0.7, b: 0.55 }],
    ]) {
      const av = F(people, { name: `Participant ${ch}`, dir: 'H', w: 24, h: 24, main: 'CENTER', cross: 'CENTER', radius: 12, fill: c, stroke: 'Background/Panel', strokeW: 2, strokeAlign: 'OUTSIDE' });
      T(av, ch, 'UI/Caption', PAGE_CONTENT.white);
    }
    F(rh, { name: 'Spacer', h: 1, fillW: true });
    use(IBTN.by['Default'], rh, { name: 'Present', icon: { Icon: 'play' } });
    use(BTN.by['Primary'], rh, { text: { Label: 'Share' } });
    divider(right);
    const rt = F(right, { name: 'Tabs', dir: 'H', h: 44, pad: [0, 8, 0, 12], gap: 8, cross: 'CENTER', fillW: true });
    const seg2 = F(rt, { name: 'Segments', dir: 'H', h: 28, pad: 2, gap: 2, hugW: true, cross: 'CENTER', radius: 7, fill: 'Background/Field' });
    use(TAB.by['Active'], seg2, { text: { Label: 'Design' } });
    use(TAB.by['Default'], seg2, { text: { Label: 'Prototype' } });
    F(rt, { name: 'Spacer', h: 1, fillW: true });
    T(rt, '62%', 'UI/Text', 'Text/Secondary');
    divider(right);
    const props = F(right, { name: 'Properties', dir: 'V', fillW: true, fillH: true, h: 100, clip: true });
    // Selection header.
    const selHead = F(props, { name: 'Selection', dir: 'H', h: 44, pad: [0, 12], gap: 8, cross: 'CENTER', fillW: true });
    I(selHead, 'frame', 'Text/Muted');
    T(selHead, 'Hero', 'UI/Title', 'Text/Primary', { fillW: true });
    const chip = F(selHead, { name: 'Scrub label', dir: 'H', h: 20, pad: [0, 6], hugW: true, cross: 'CENTER', radius: 4, fill: 'Background/Field' });
    T(chip, 'Auto layout', 'UI/Caption', 'Text/Secondary');
    const sec = (title, action, build) => {
      const s = F(props, { name: title, dir: 'V', pad: [4, 12, 12, 0], gap: 8, fillW: true, hugH: true });
      use(HEAD.by[action ? 'Yes' : 'No'], s, { fillW: true, text: { Title: title } });
      const body = F(s, { name: 'Fields', dir: 'V', gap: 8, pad: [0, 0, 0, 12], fillW: true, hugH: true });
      build?.(body);
      divider(props);
      return s;
    };
    const fieldRow = (parent, items) => {
      const r = F(parent, { name: 'Row', dir: 'H', gap: 8, fillW: true, hugH: true });
      for (const [label, value, state] of items) {
        // A “ic:name” label — an icon instead of a letter.
        if (label.startsWith('ic:')) use(FIELD.by[state ?? 'Default'], r, { fillW: true, text: { Value: value }, show: ['Badge'], hide: ['Letter'], icon: { Badge: label.slice(3) } });
        else use(FIELD.by[state ?? 'Default'], r, { fillW: true, text: { Letter: label, Value: value } });
      }
      return r;
    };
    sec('Position', false, (b) => {
      const al = F(b, { name: 'Alignment', dir: 'H', gap: 0, fillW: true, hugH: true, main: 'SPACE_BETWEEN' });
      for (const n of ['alignLeft', 'alignHCenter', 'alignRight', 'alignTop', 'alignVCenter', 'alignBottom']) if (has(n)) use(IBTN.by['Default'], al, { icon: { Icon: n } });
      fieldRow(b, [
        ['X', '0'],
        ['Y', '56', 'Focus'],
      ]);
    });
    sec('Auto layout', true, (b) => {
      fieldRow(b, [
        ['ic:arrowDown', 'Vertical'],
        ['ic:gap', '16'],
      ]);
      fieldRow(b, [
        ['ic:paddingH', '32'],
        ['ic:paddingV', '48'],
      ]);
      fieldRow(b, [
        ['W', '600 · fill'],
        ['H', '300'],
      ]);
    });
    sec('View', false, (b) =>
      fieldRow(b, [
        ['ic:opacity', '100%'],
        ['ic:corner', '0'],
      ]),
    );
    sec('Fill', true, (b) => {
      const r = F(b, { name: 'Paint', dir: 'H', gap: 8, fillW: true, hugH: true, cross: 'CENTER' });
      const f = F(r, { name: 'Color', dir: 'H', h: 28, pad: [0, 8, 0, 6], gap: 8, fillW: true, cross: 'CENTER', radius: 6, fill: 'Background/Field' });
      F(f, { name: 'Swatch', w: 16, h: 16, radius: 4, fill: PAGE_CONTENT.sand, stroke: 'Line/Border' });
      T(f, 'F7F2EB', 'UI/Text', 'Text/Primary', { fillW: true });
      T(f, '100%', 'UI/Text', 'Text/Muted');
      if (has('eye')) use(IBTN.by['Default'], r, { icon: { Icon: 'eye' } });
    });
    sec('Stroke', true);
    sec('Effects', true);
    sec('Export', true);
    return scr;
  }

  // ---------- Home (files) ----------
  function homeScreen(parent, x, y, mode, title) {
    const scr = F(parent, { name: title, x, y, w: 1440, h: 900, dir: 'H', fill: 'Background/App', clip: true, mode });
    const side = F(scr, { name: 'Files menu', dir: 'V', w: 248, fillH: true, h: 100, pad: [12, 8], gap: 2, fill: 'Background/Panel' });
    const brand = F(side, { name: 'Brand', dir: 'H', h: 44, pad: [0, 8], gap: 10, cross: 'CENTER', fillW: true });
    const logo = F(brand, { name: 'Logo', dir: 'H', w: 28, h: 28, main: 'CENTER', cross: 'CENTER', radius: 8, fill: 'Accent/Primary' });
    I(logo, 'logo', 'Text/On accent', 20);
    T(brand, 'MFP', 'UI/Large', 'Text/Primary');
    for (const [label, ic, on] of [
      ['Recent', 'clock', true],
      ['My files', 'folder', false],
      ['Team', 'plugins', false],
      ['Trash', 'trash', false],
    ]) {
      const r = F(side, { name: label, dir: 'H', h: 32, pad: [0, 10], gap: 10, cross: 'CENTER', fillW: true, radius: 6, fill: on ? 'Accent/Soft' : undefined });
      I(r, ic, on ? 'Accent/Text' : 'Text/Secondary', 20);
      T(r, label, on ? 'UI/Text medium' : 'UI/Text', on ? 'Text/Primary' : 'Text/Secondary', { fillW: true });
    }
    divider(side);
    const ph = F(side, { name: 'Projects', dir: 'H', h: 28, pad: [0, 10], cross: 'CENTER', fillW: true });
    T(ph, 'Projects', 'UI/Caption', 'Text/Muted');
    for (const p of ['Studio website', 'Banking app', 'Design system']) {
      const r = F(side, { name: p, dir: 'H', h: 30, pad: [0, 10], gap: 10, cross: 'CENTER', fillW: true, radius: 6 });
      I(r, 'folder', 'Text/Muted');
      T(r, p, 'UI/Text', 'Text/Secondary', { fillW: true });
    }
    divider(scr, { vertical: true });
    const main = F(scr, { name: 'Files', dir: 'V', fillW: true, fillH: true, h: 100, w: 100 });
    const head = F(main, { name: 'Title', dir: 'H', h: 64, pad: [0, 24], gap: 12, cross: 'CENTER', fillW: true });
    T(head, 'Recent', 'UI/Large', 'Text/Primary', { fillW: true });
    const search = F(head, { name: 'Search', dir: 'H', w: 240, h: 32, pad: [0, 10], gap: 8, cross: 'CENTER', radius: 8, fill: 'Background/Field' });
    if (has('search')) I(search, 'search', 'Text/Muted');
    T(search, 'Search files', 'UI/Text', 'Text/Muted');
    use(BTN.by['Default'], head, { text: { Label: 'Import…' } });
    use(BTN.by['Primary'], head, { text: { Label: 'New file' } });
    divider(main);
    const grid = F(main, { name: 'Grid', dir: 'H', wrap: true, gap: 20, rowGap: 20, pad: 24, fillW: true, fillH: true, h: 100 });
    const files = [
      ['Studio website', '2 minutes ago', { r: 0.97, g: 0.95, b: 0.92 }, PAGE_CONTENT.brand],
      ['Banking app', 'yesterday', { r: 0.9, g: 0.94, b: 1 }, { r: 0.2, g: 0.45, b: 0.95 }],
      ['Design system', '3 days ago', { r: 0.93, g: 0.9, b: 0.99 }, { r: 0.55, g: 0.35, b: 0.9 }],
      ['Conference landing page', 'last week', { r: 0.9, g: 0.97, b: 0.93 }, { r: 0.15, g: 0.6, b: 0.4 }],
      ['Icons 2.0', 'in September', { r: 0.99, g: 0.95, b: 0.86 }, { r: 0.85, g: 0.55, b: 0.1 }],
      ['Presentation', 'in September', { r: 0.95, g: 0.95, b: 0.96 }, { r: 0.3, g: 0.32, b: 0.38 }],
    ];
    for (const [name, when, bg, accent] of files) {
      const card = F(grid, { name: `File / ${name}`, dir: 'V', w: 252, h: 210, radius: 12, fill: 'Background/Panel', stroke: 'Line/Divider', clip: true });
      const th = F(card, { name: 'Cover', dir: 'V', h: 150, pad: 20, gap: 8, fillW: true, fill: bg });
      F(th, { name: 'Strip', w: 96, h: 10, radius: 5, fill: accent });
      F(th, { name: 'Row line', w: 150, h: 6, radius: 3, fill: { r: 0, g: 0, b: 0, a: 0.12 } });
      F(th, { name: 'Row line', w: 120, h: 6, radius: 3, fill: { r: 0, g: 0, b: 0, a: 0.12 } });
      const meta = F(card, { name: 'Label', dir: 'V', pad: [10, 12], gap: 2, fillW: true, hugH: true });
      T(meta, name, 'UI/Text medium', 'Text/Primary');
      T(meta, `Edited ${when}`, 'UI/Caption', 'Text/Muted');
    }
    return scr;
  }

  // ---------- Menu (popover) ----------
  function menuScreen(parent, x, y, mode, title) {
    const box = F(parent, { name: title, x, y, w: 260, dir: 'V', pad: 6, gap: 0, hugH: true, radius: 12, fill: 'Background/Menu', stroke: 'Line/Border', effect: 'menu', mode });
    const items = [
      ['Copy', 'Ctrl+C'],
      ['Paste over', 'Ctrl+Shift+V'],
      ['Duplicate', 'Ctrl+D', true],
      null,
      ['Create component', 'Ctrl+Alt+K'],
      ['Add auto layout', 'Shift+A'],
      null,
      ['Delete', 'Del'],
    ];
    for (const it of items) {
      if (!it) {
        F(box, { name: 'Separator', h: 1, fillW: true, fill: 'Line/Divider' });
        continue;
      }
      const [label, hint, hover] = it;
      use(MENU.by[hover ? 'Hover' : 'Default'], box, { fillW: true, text: { Item: label, Shortcut: hint } });
    }
    return box;
  }

  // ---------- Actions (Ctrl+K) ----------
  function actionsScreen(parent, x, y, mode, title) {
    const box = F(parent, { name: title, x, y, w: 560, dir: 'V', hugH: true, radius: 14, fill: 'Background/Menu', stroke: 'Line/Border', effect: 'menu', mode, clip: true });
    const q = F(box, { name: 'Query', dir: 'H', h: 52, pad: [0, 16], gap: 10, cross: 'CENTER', fillW: true });
    I(q, 'search', 'Text/Muted', 20);
    T(q, 'oklch', 'Document/Body', 'Text/Primary', { fillW: true });
    const k = F(q, { name: 'Shortcut', dir: 'H', h: 22, pad: [0, 6], hugW: true, cross: 'CENTER', radius: 5, stroke: 'Line/Border' });
    T(k, 'Esc', 'UI/Caption', 'Text/Muted');
    divider(box);
    const list = F(box, { name: 'Found', dir: 'V', pad: 6, gap: 0, fillW: true, hugH: true });
    const items = [
      ['Variables to CSS › OKLCH colors', 'Design system', '', true],
      ['Color format: OKLCH', 'Developer mode', ''],
      ['Palette: OKLCH mode', 'Fill', ''],
      ['Export tokens (DTCG)', 'Design system', ''],
    ];
    for (const [label, path, hint, on] of items) {
      const r = F(list, { name: label, dir: 'H', h: 40, pad: [0, 12], gap: 10, cross: 'CENTER', fillW: true, radius: 8, fill: on ? 'Accent/Soft' : undefined });
      I(r, 'sparkle', on ? 'Accent/Text' : 'Text/Muted');
      const t = F(r, { name: 'Text', dir: 'V', gap: 0, fillW: true, hugH: true });
      T(t, label, 'UI/Text medium', 'Text/Primary');
      T(t, path, 'UI/Caption', 'Text/Muted');
      if (hint) T(r, hint, 'UI/Caption', 'Text/Muted');
    }
    divider(box);
    const foot = F(box, { name: 'Footer', dir: 'H', h: 36, pad: [0, 16], gap: 16, cross: 'CENTER', fillW: true });
    T(foot, '↑↓ select · Enter run · commands, plugins and layers — in one search', 'UI/Caption', 'Text/Muted', { fillW: true });
    return box;
  }

  // ---------- Screens ----------
  const screensPage = pages.screens;
  ed.setPage(screensPage);
  T(screensPage, 'Editor — dark theme', 'Document/Heading 2', 'Text/Primary', { x: 0, y: -60 });
  editorScreen(screensPage, 0, 0, DARK, 'Editor — dark');
  T(screensPage, 'Editor — light theme (the same mockup, “Light” mode)', 'Document/Heading 2', 'Text/Primary', { x: 1540, y: -60 });
  editorScreen(screensPage, 1540, 0, LIGHT, 'Editor — light');
  log.push('editor done');
  T(screensPage, 'Files', 'Document/Heading 2', 'Text/Primary', { x: 0, y: 1000 });
  homeScreen(screensPage, 0, 1060, DARK, 'Files — dark');
  homeScreen(screensPage, 1540, 1060, LIGHT, 'Files — light');
  T(screensPage, 'Menu', 'Document/Heading 2', 'Text/Primary', { x: 3080, y: -60 });
  menuScreen(screensPage, 3080, 0, DARK, 'Menu — dark');
  menuScreen(screensPage, 3380, 0, LIGHT, 'Menu — light');
  T(screensPage, 'Actions (Ctrl+K)', 'Document/Heading 2', 'Text/Primary', { x: 3080, y: 440 });
  actionsScreen(screensPage, 3080, 500, DARK, 'Actions — dark');
  actionsScreen(screensPage, 3080, 820, LIGHT, 'Actions — light');
  log.push('screens done');

  // ---------- Foundations: colors, text, sizes ----------
  ed.setPage(pages.base);
  const swatchRow = (parent, title, names) => {
    const g = F(parent, { name: title, dir: 'V', gap: 10, fillW: true, hugH: true });
    T(g, title, 'Document/Heading 3', 'Text/Primary');
    const row = F(g, { name: 'Swatches', dir: 'H', gap: 8, wrap: true, rowGap: 12, fillW: true, hugH: true });
    for (const n of names) {
      const cell = F(row, { name: n, dir: 'V', w: 88, gap: 6, hugH: true });
      F(cell, { name: 'Swatch', w: 88, h: 56, radius: 8, fill: n, stroke: 'Line/Divider' });
      T(cell, n.split('/')[1], 'UI/Text medium', 'Text/Primary');
      T(cell, d.get(V[n], 'description') ?? '', 'UI/Caption', 'Text/Muted', { w: 88 });
    }
  };
  const baseBoard = F(pages.base, { name: 'Palette', x: 0, y: 0, w: 1040, dir: 'V', gap: 28, pad: 40, hugH: true, radius: 16, fill: 'Background/Panel', mode: DARK });
  T(baseBoard, 'Palette — OKLCH', 'Document/Heading 2', 'Text/Primary');
  T(baseBoard, 'Colors are defined in OKLCH: lightness steps look even at any hue, the grays are slightly cool (hue 266). Values in the file are sRGB; the OKLCH notation is in the variable description.', 'Document/Body', 'Text/Secondary', { fillW: true });
  swatchRow(baseBoard, 'Graphite', GRAYS.map(([n]) => `Graphite/${n}`));
  swatchRow(baseBoard, 'Ultramarine — accent', ACCENT.map(([n]) => `Ultramarine/${n}`));
  swatchRow(baseBoard, 'Semantic', ['Lilac/400', 'Lilac/600', 'Coral/400', 'Coral/600', 'Mint/400', 'Mint/600', 'Amber/400', 'Amber/600']);
  // Theme: a table of roles in two modes.
  const roles = Object.keys(V).filter((k) => /^(Background|Line|Text|Accent|Meaning)\//.test(k));
  const themeTable = (x, mode, label) => {
    const t = F(pages.base, { name: `Theme — ${label}`, x, y: 0, w: 520, dir: 'V', gap: 4, pad: 32, hugH: true, radius: 16, fill: 'Background/Panel', stroke: 'Line/Divider', mode });
    T(t, `Theme · ${label}`, 'Document/Heading 2', 'Text/Primary');
    T(t, 'Roles, not colors: components and screens refer only to these variables.', 'Document/Small', 'Text/Muted', { fillW: true });
    for (const r of roles) {
      const row = F(t, { name: r, dir: 'H', h: 36, gap: 12, cross: 'CENTER', fillW: true });
      F(row, { name: 'Swatch', w: 28, h: 28, radius: 6, fill: r, stroke: 'Line/Border' });
      const txt = F(row, { name: 'Name', dir: 'V', gap: 0, fillW: true, hugH: true });
      T(txt, r, 'UI/Text medium', 'Text/Primary');
      T(txt, d.get(V[r], 'description') ?? '', 'UI/Caption', 'Text/Muted', { fillW: true, truncate: true });
      T(row, d.get(V[r], 'codeSyntax')?.WEB ?? '', 'Document/Code', 'Accent/Text');
    }
    return t;
  };
  themeTable(1100, DARK, 'Dark');
  themeTable(1660, LIGHT, 'Light');
  // Text.
  const typeBoard = F(pages.base, { name: 'Text', x: 0, y: 1300, w: 1040, dir: 'V', gap: 18, pad: 40, hugH: true, radius: 16, fill: 'Background/Panel', mode: DARK });
  T(typeBoard, 'Text — Inter', 'Document/Heading 2', 'Text/Primary');
  T(typeBoard, 'The base interface text size is 12 px: larger and easier to read. Numbers in fields use tabular figures.', 'Document/Body', 'Text/Secondary', { fillW: true });
  for (const [style, sample] of [
    ['UI/Large', 'Recent files'],
    ['UI/Title', 'Studio website'],
    ['UI/Section', 'Auto layout'],
    ['UI/Text medium', 'Share'],
    ['UI/Text', 'Home — 1440'],
    ['UI/Caption', 'Edited 2 minutes ago'],
  ]) {
    const r = F(typeBoard, { name: style, dir: 'H', gap: 24, cross: 'CENTER', fillW: true, hugH: true });
    T(r, style, 'Document/Code', 'Accent/Text', { w: 180 });
    T(r, sample, style, 'Text/Primary', { fillW: true });
    const st = d.props(TS[style]);
    T(r, `${st.fontSize} / ${st.lineHeight.value} · ${st.fontName.style}`, 'UI/Caption', 'Text/Muted');
  }
  // Sizes.
  const sizeBoard = F(pages.base, { name: 'Sizes', x: 1100, y: 1300, w: 1080, dir: 'V', gap: 18, pad: 40, hugH: true, radius: 16, fill: 'Background/Panel', mode: DARK });
  T(sizeBoard, '4 px grid, corner radii, heights', 'Document/Heading 2', 'Text/Primary');
  const radii = F(sizeBoard, { name: 'Corner radii', dir: 'H', gap: 20, hugH: true, fillW: true });
  for (const [n, v] of [['S', 4], ['M', 6], ['L', 8], ['XL', 12], ['XXL', 16]]) {
    const c = F(radii, { name: n, dir: 'V', gap: 8, hugH: true, w: 96, cross: 'CENTER' });
    F(c, { name: 'Example', w: 72, h: 56, radius: v, fill: 'Background/Field', stroke: 'Line/Border' });
    T(c, `${n} · ${v}`, 'UI/Text medium', 'Text/Secondary');
  }
  const spaces = F(sizeBoard, { name: 'Spacing', dir: 'H', gap: 20, hugH: true, fillW: true, cross: 'MAX' });
  for (const [n, v] of [[1, 4], [2, 8], [3, 12], [4, 16], [5, 24], [6, 32]]) {
    const c = F(spaces, { name: `Spacing ${n}`, dir: 'V', gap: 8, hugH: true, w: 64, cross: 'CENTER' });
    F(c, { name: 'Strip', w: v, h: v, fill: 'Accent/Soft', stroke: 'Accent/Primary' });
    T(c, `${v}`, 'UI/Text medium', 'Text/Secondary');
  }
  T(sizeBoard, 'Field — 28 · layer row — 32 · panel header — 48 · left panel — 248 · right — 280', 'Document/Body', 'Text/Secondary', { fillW: true });

  // ---------- Cover ----------
  ed.setPage(pages.cover);
  const cover = F(pages.cover, { name: 'Cover', x: 0, y: 0, w: 1440, h: 960, dir: 'V', pad: [72, 80], gap: 40, hugH: true, fill: 'Background/App', mode: DARK, clip: true });
  const top = F(cover, { name: 'Title', dir: 'V', gap: 16, fillW: true, hugH: true });
  const tag = F(top, { name: 'Scrub label', dir: 'H', h: 24, pad: [0, 10], hugW: true, cross: 'CENTER', radius: 12, fill: 'Accent/Soft' });
  T(tag, 'Made in MFP · October 2026', 'UI/Text medium', 'Accent/Text');
  T(top, 'MFP interface —\na new look', 'Document/Heading 1', 'Text/Primary');
  T(top, 'A face of its own instead of a copy of the familiar: quiet graphite, deep ultramarine, larger text. The panel layout stays the same — switch from other editors without relearning.', 'Document/Body', 'Text/Secondary', { w: 760 });
  const grid = F(cover, { name: 'Principles', dir: 'H', wrap: true, gap: 16, rowGap: 16, fillW: true, hugH: true });
  const PRINCIPLES = [
    ['1', 'The canvas comes first', 'The interface doesn’t compete with the work: neutral graphite, color only where it means something.'],
    ['2', 'One system — two themes', 'Dark and light are modes of the same variables. Components don’t know which theme they are in.'],
    ['3', 'Perceptual colors', 'An OKLCH palette: even lightness steps, consistent text contrast in both themes.'],
    ['4', 'Effortless to read', '12 px text, tabular figures, primary text contrast above 7 : 1.'],
    ['5', 'Grows without crowding', 'A new feature is a section, a tab or a command (Ctrl+K), not one more button.'],
    ['6', 'A familiar place', 'Panels on the left and right, tools at the bottom — like in the editors you know.'],
  ];
  for (const [n, title, text] of PRINCIPLES) {
    const card = F(grid, { name: `Principle ${n}`, dir: 'V', w: 413, h: 168, pad: 24, gap: 10, radius: 16, fill: 'Background/Panel', stroke: 'Line/Divider' });
    const num = F(card, { name: 'Number', dir: 'H', w: 28, h: 28, main: 'CENTER', cross: 'CENTER', radius: 8, fill: 'Accent/Soft' });
    T(num, n, 'UI/Title', 'Accent/Text');
    T(card, title, 'Document/Heading 3', 'Text/Primary');
    T(card, text, 'Document/Small', 'Text/Secondary', { fillW: true });
  }
  const strip = F(cover, { name: 'Color strip', dir: 'H', h: 40, gap: 0, fillW: true, radius: 10, clip: true, stroke: 'Line/Border' });
  for (const n of ['Graphite/975', 'Graphite/925', 'Graphite/875', 'Graphite/750', 'Graphite/400', 'Graphite/200', 'Graphite/50', 'Ultramarine/300', 'Ultramarine/500', 'Ultramarine/700', 'Lilac/400', 'Mint/400', 'Amber/400', 'Coral/400']) F(strip, { name: n, h: 40, fillW: true, fillH: true, fill: n });
  // Where the interface grows: rules for new features.
  const grow = F(pages.cover, { name: 'Where the interface grows', x: 0, y: 1040, w: 1440, dir: 'V', pad: [56, 80], gap: 24, hugH: true, fill: 'Background/App', mode: DARK });
  T(grow, 'Where the interface grows', 'Document/Heading 2', 'Text/Primary');
  T(grow, 'Every stage adds features. To keep the interface from turning into a dashboard, each kind of addition has its own place.', 'Document/Body', 'Text/Secondary', { w: 760 });
  const rules = F(grow, { name: 'Rules', dir: 'V', gap: 0, fillW: true, hugH: true, radius: 16, fill: 'Background/Panel', stroke: 'Line/Divider', clip: true });
  const RULES = [
    ['Layer setting', 'A right panel section: a header with a “+” action and fields. An empty section is one row with “+”.', 'Position, Auto layout, Fill'],
    ['Working mode', 'A panel tab or a mode switch — panels change their content instead of multiplying.', 'Design / Prototype, developer mode'],
    ['Team', 'A main menu item. Ctrl+K search finds it on its own — no new button.', 'Variables to CSS, Appearance'],
    ['Tool', 'Into a group on the bottom toolbar — a dropdown on the button.', 'Shapes: rectangle, ellipse, star'],
    ['Window', 'A popover at the point of use or floating over the canvas. Modal — only for irreversible actions.', 'Color picker, find and replace'],
    ['Color', 'Only a role in the “Theme” collection — for both themes at once. A hex value in code is a bug.', 'Accent/Soft, Meaning/Warning'],
  ];
  RULES.forEach(([what, where, example], i) => {
    if (i) F(rules, { name: 'Separator', h: 1, fillW: true, fill: 'Line/Divider' });
    const row = F(rules, { name: what, dir: 'H', gap: 24, pad: [16, 24], cross: 'CENTER', fillW: true, hugH: true });
    T(row, what, 'Document/Heading 3', 'Text/Primary', { w: 180 });
    T(row, where, 'Document/Small', 'Text/Secondary', { fillW: true });
    const ex = F(row, { name: 'Example', dir: 'H', h: 24, pad: [0, 10], hugW: true, cross: 'CENTER', radius: 12, fill: 'Accent/Soft' });
    T(ex, example, 'UI/Caption', 'Accent/Text');
  });
  log.push('cover done');

  ed.setPage(pages.cover);
  return { log, pages, nodes: d.descendants ? undefined : undefined, icons: iconsCount, variables: Object.keys(V).length };
};
