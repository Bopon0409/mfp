import { describe, expect, it } from 'vitest';
import { Document } from '@mfp/core';
import { PluginRuntime, type PluginBundle, type PluginEnvironment } from '../src/index.ts';
import { widgetColor, widgetPaints } from '../src/widget.ts';

/** Counter widget (as written with JSX: figma.widget.h is the factory): a +1 button, property menu for color. */
const COUNTER = `
const { widget } = figma;
const { AutoLayout, Text, Rectangle, useSyncedState, usePropertyMenu, h } = widget;
function Counter() {
  const [count, setCount] = useSyncedState('count', 0);
  const [color, setColor] = useSyncedState('color', '#3D7BFF');
  usePropertyMenu(
    [
      { itemType: 'color-selector', propertyName: 'color', tooltip: 'Цвет', options: [{ option: '#3D7BFF' }, { option: '#F24822' }], selectedOption: color },
      { itemType: 'action', propertyName: 'reset', tooltip: 'Сбросить' },
    ],
    ({ propertyName, propertyValue }) => {
      if (propertyName === 'color') setColor(propertyValue);
      if (propertyName === 'reset') setCount(0);
    },
  );
  return h(AutoLayout, { direction: 'horizontal', spacing: 8, padding: 12, fill: '#FFFFFF', cornerRadius: 8, verticalAlignItems: 'center' },
    h(Text, { fontSize: 20, fill: color }, 'Счёт: ', count),
    h(AutoLayout, { padding: { vertical: 4, horizontal: 10 }, fill: color, cornerRadius: 6, onClick: () => setCount(count + 1) },
      h(Text, { fill: '#FFFFFF', fontWeight: 700 }, '+1')),
    count > 2 ? h(Rectangle, { width: 8, height: 8, fill: '#14AE5C', cornerRadius: 4 }) : null,
  );
}
widget.register(Counter);
`;

function env(): { doc: Document; page: string; widget: string; env: PluginEnvironment } {
  const doc = new Document({ clientId: 1 });
  const page = doc.create('PAGE', doc.root, { name: 'Page 1' });
  const widget = doc.create('FRAME', page, { name: 'Счётчик', widget: { pluginId: 'counter', name: 'Счётчик', state: {} } });
  const e: PluginEnvironment = {
    doc,
    getCurrentPage: () => page,
    setCurrentPage: () => {},
    getSelection: () => [],
    setSelection: () => {},
    notify: () => {},
    showUI: () => {},
    postToUI: () => {},
    setUIVisible: () => {},
    resizeUI: () => {},
    closeUI: () => {},
    viewport: { center: () => ({ x: 0, y: 0 }), zoom: () => 1, bounds: () => ({ x: 0, y: 0, width: 800, height: 600 }), setCenter: () => {}, setZoom: () => {}, scrollAndZoomIntoView: () => {} },
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] },
    log: () => {},
  };
  return { doc, page, widget, env: e };
}

const bundle: PluginBundle = { manifest: { name: 'Счётчик', id: 'counter', api: '1.0.0', main: 'code.js' }, code: COUNTER };
const tick = () => new Promise((r) => setTimeout(r, 0));
const texts = (doc: Document, id: string): string[] => [...(doc.type(id) === 'TEXT' ? [doc.get(id, 'characters') ?? ''] : []), ...doc.children(id).flatMap((c) => texts(doc, c))];
const findHandler = (doc: Document, id: string): string | null => doc.get(id, 'widgetHandler') ?? doc.children(id).map((c) => findHandler(doc, c)).find((x) => x) ?? null;

describe('widgets', () => {
  it('rendering: the component tree becomes layers; default state lives in the node; property menu', async () => {
    const { doc, widget, env: e } = env();
    const rt = await PluginRuntime.start(bundle, e, { deferRun: true });
    rt.widget({ action: 'render', nodeId: widget });
    await tick();
    expect(rt.error).toBeNull();
    expect(doc.get(widget, 'widget')?.state).toEqual({ count: 0, color: '#3D7BFF' });
    expect(doc.get(widget, 'widget')?.menu?.map((m) => m.itemType)).toEqual(['color-selector', 'action']);
    const root = doc.children(widget)[0]!;
    expect(doc.type(root)).toBe('FRAME');
    expect(doc.get(root, 'layoutMode')).toBe('HORIZONTAL');
    expect(doc.get(root, 'itemSpacing')).toBe(8);
    expect(doc.get(root, 'paddingLeft')).toBe(12);
    expect(doc.get(root, 'primaryAxisSizingMode')).toBe('AUTO');
    expect(texts(doc, widget)).toEqual(['Счёт: 0', '+1']);
    const btn = doc.children(root)[1]!;
    expect(doc.get(btn, 'widgetHandler')).toBe('0.1');
    expect(doc.get(btn, 'paddingTop')).toBe(4);
    expect(doc.get(doc.children(btn)[0]!, 'fontName')).toEqual({ family: 'Inter', style: 'Bold' });
    rt.stop();
  });

  it('click runs the handler in the sandbox, state and re-render; property menu; after a restart — with the previous state', async () => {
    const { doc, widget, env: e } = env();
    let rt = await PluginRuntime.start(bundle, e, { deferRun: true });
    rt.widget({ action: 'render', nodeId: widget });
    await tick();
    const path = findHandler(doc, widget)!;
    for (let i = 0; i < 3; i++) {
      rt.widget({ action: 'event', nodeId: widget, path, kind: 'onClick' });
      await tick();
    }
    expect(rt.error).toBeNull();
    expect(doc.get(widget, 'widget')?.state.count).toBe(3);
    expect(texts(doc, widget)[0]).toBe('Счёт: 3');
    // The third element appeared (count > 2).
    expect(doc.children(doc.children(widget)[0]!).length).toBe(3);
    rt.widget({ action: 'menu', nodeId: widget, propertyName: 'color', propertyValue: '#F24822' });
    await tick();
    expect(doc.get(widget, 'widget')?.state.color).toBe('#F24822');
    const label = doc.children(doc.children(widget)[0]!)[0]!;
    expect(doc.get(label, 'fills')).toEqual([{ type: 'SOLID', color: { r: 242 / 255, g: 72 / 255, b: 34 / 255 } }]);
    rt.stop();
    // A new sandbox (another participant, reload): handlers after rendering, state from the node.
    rt = await PluginRuntime.start(bundle, e, { deferRun: true });
    rt.widget({ action: 'menu', nodeId: widget, propertyName: 'reset' });
    await tick();
    expect(rt.error).toBeNull();
    expect(doc.get(widget, 'widget')?.state.count).toBe(0);
    expect(doc.get(widget, 'widget')?.state.color).toBe('#F24822');
    rt.stop();
  });

  it('widget colors and paints', () => {
    expect(widgetColor('#F00')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(widgetColor('#00FF0080')!.a).toBeCloseTo(0.5, 2);
    expect(widgetPaints({ type: 'solid', color: '#000000', opacity: 0.5 })).toEqual([{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }]);
    expect(widgetPaints(['#FFF', { r: 0, g: 0, b: 1, a: 1 }]).length).toBe(2);
  });
});
