figma.showUI(__html__, { width: 330, height: 170 });
figma.ui.onmessage = (m) => {
  if (m.type === 'pair') {
    const r = figma.createRectangle(); r.name = 'Undo Rectangle'; r.resize(120, 100);
    r.fills = [{ type: 'SOLID', color: { r: .2, g: .4, b: .9 } }];
    if (m.split) figma.commitUndo();
    const e = figma.createEllipse(); e.name = 'Undo Ellipse'; e.x = 160;
    e.fills = [{ type: 'SOLID', color: { r: .9, g: .4, b: .2 } }];
    figma.viewport.scrollAndZoomIntoView([r, e]);
    figma.commitUndo();
  }
  if (m.type === 'close') figma.closePlugin();
};
