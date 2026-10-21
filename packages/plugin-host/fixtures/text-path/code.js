(async () => {
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  const circle = figma.createEllipse();
  circle.resize(240, 240);
  const path = figma.createTextPath(circle, 2, 0.5);
  path.characters = 'TEXT ON A PATH · MFP · ';
  path.fontSize = 24;
  path.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.25, b: 0.8 } }];
  path.name = 'TextPath API · circle';
  figma.currentPage.selection = [path];
  figma.viewport.scrollAndZoomIntoView([path]);
  figma.notify(path.type + ' · segment ' + path.textPathStartData.segment);
  figma.closePlugin();
})();
