// What's happening: page, selection, camera and document changes — live.
// MIT, MFP.

figma.showUI(__html__, { width: 320, height: 420, title: "What's happening" });

function state() {
  const v = figma.viewport;
  figma.ui.postMessage({
    type: 'state',
    page: figma.currentPage.name,
    selection: figma.currentPage.selection.map((n) => `${n.name} (${n.type})`),
    zoom: Math.round(v.zoom * 100),
    center: { x: Math.round(v.center.x), y: Math.round(v.center.y) },
  });
}

function label(c) {
  if (c.style !== undefined) return c.style ? c.style.name : 'style';
  if (!c.node) return c.id;
  if (c.node.removed) return `${c.node.type} ${c.id}`;
  return `${c.node.name} (${c.node.type})`;
}

(async () => {
  await figma.loadAllPagesAsync();
  figma.on('documentchange', (e) => {
    figma.ui.postMessage({
      type: 'changes',
      items: e.documentChanges.slice(0, 40).map((c) => ({ type: c.type, origin: c.origin, what: label(c), props: (c.properties || []).join(', ') })),
      total: e.documentChanges.length,
    });
  });
})();
figma.on('selectionchange', state);
figma.on('currentpagechange', state);
// The camera has no events — poll every half second.
setInterval(state, 500);
state();
