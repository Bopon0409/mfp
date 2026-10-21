// Parsing large OPFS snapshots off the editor thread keeps tab feedback responsive.
self.onmessage = (e: MessageEvent<string>) => {
  try { postMessage({ value: JSON.parse(e.data) }); }
  catch (error) { postMessage({ error: String(error) }); }
};
