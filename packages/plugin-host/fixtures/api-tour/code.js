// Walks through the main parts of the Plugin API and reports the result via notify.
async function main() {
  const page = figma.currentPage;
  const frame = figma.createFrame();
  frame.name = 'Card';
  frame.resize(320, 200);
  frame.x = 100;
  frame.y = 50;
  frame.fills = [figma.util.solidPaint('#1e88e5')];

  const title = figma.createText();
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  title.characters = 'Hello from the plugin';
  title.fontSize = 24;
  frame.appendChild(title);
  title.x = 16;
  title.y = 16;

  const badge = figma.createEllipse();
  frame.appendChild(badge);
  badge.resize(40, 40);
  badge.x = 264;
  badge.y = 16;
  badge.rotation = 45;

  const copy = frame.clone();
  copy.y = frame.y + 240;

  const group = figma.group([frame, copy], page);
  group.name = 'Cards';

  frame.setPluginData('role', 'card');
  frame.setSharedPluginData('mfp', 'version', '1');

  await figma.clientStorage.setAsync('runs', ((await figma.clientStorage.getAsync('runs')) || 0) + 1);
  const runs = await figma.clientStorage.getAsync('runs');

  let readonlyError = '';
  try {
    frame.width = 10;
  } catch (e) {
    readonlyError = String(e.message);
  }

  let badFillError = '';
  try {
    badge.fills = [{ type: 'SOLID', color: { r: 2, g: 0, b: 0 } }];
  } catch (e) {
    badFillError = String(e.message);
  }

  await new Promise((resolve) => setTimeout(resolve, 10));

  const report = {
    frameChildren: frame.children.map((c) => c.type),
    copyChildren: copy.children.length,
    groupChildren: group.children.map((c) => c.name),
    groupBox: [Math.round(group.x), Math.round(group.y), Math.round(group.width), Math.round(group.height)],
    frameInGroup: [Math.round(frame.x), Math.round(frame.y)],
    absFrameX: Math.round(frame.absoluteTransform[0][2]),
    badgeRotation: Math.round(badge.rotation),
    pluginData: frame.getPluginData('role'),
    sharedData: frame.getSharedPluginData('mfp', 'version'),
    keys: frame.getPluginDataKeys(),
    textFound: page.findAll((n) => n.type === 'TEXT').length,
    sameNodeIdentity: frame.children[0] === title,
    parentIsFrame: title.parent === frame,
    runs,
    readonlyError: readonlyError.includes('read only'),
    badFillError: badFillError.length > 0,
    mixedIsSymbol: typeof figma.mixed === 'symbol',
    colorFromHex: figma.util.rgb('#ff8000'),
  };
  figma.notify(JSON.stringify(report));
  figma.closePlugin('done');
}
main().catch((e) => figma.closePlugin('error: ' + e.message));
