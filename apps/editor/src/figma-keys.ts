/** Additional Figma bindings. Physical keys keep US shortcuts usable in Cyrillic. */
export type FigmaKey = 'front' | 'back' | 'layoutGuides' | 'flatten' | 'mask';
export function figmaKeyOf(e: KeyboardEvent, mac: boolean): FigmaKey | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.isComposing || e.getModifierState?.('AltGraph')) return null;
  if (!mod && !e.altKey && !e.shiftKey) {
    if (e.code === 'BracketRight') return 'front';
    if (e.code === 'BracketLeft') return 'back';
  }
  if (!mod && !e.altKey && e.shiftKey && e.code === 'KeyG') return 'layoutGuides';
  if (!mod && e.altKey && e.shiftKey && e.code === 'KeyF') return 'flatten';
  if (mac && e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyM') return 'mask';
  return null;
}
