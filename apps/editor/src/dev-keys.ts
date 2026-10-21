/** Exact viewing shortcuts. A letter alone is not enough: Ctrl+K opens actions,
 * but Ctrl+Alt+K changes the design. Enter is routed to selection by the caller. */
export function devKeyAllowed(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, oldOutlines = false, hasSelection = false): boolean {
  const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (e.code === 'Backslash') return true;
    if (e.altKey) return !e.shiftKey && ['c', 's', 'a', 'enter'].includes(k);
    if (e.code === 'Slash' || e.code === 'Quote') return true;
    if (e.shiftKey) return ['c', 's', 'a', 'e'].includes(k) || (k === 'o' && !oldOutlines) || e.code === 'Digit4';
    return ['c', 's', 'f', 'k', 'a', 'o', 'l', '=', '+', '-'].includes(k) || ['NumpadAdd', 'NumpadSubtract'].includes(e.code) || k.startsWith('arrow');
  }
  if (e.altKey) return !e.shiftKey && (['Digit1', 'Digit2', 'Digit8', 'Digit9'].includes(e.code) || ['arrowleft', 'arrowright', 'l'].includes(k));
  if (e.code === 'Space') return true;
  if (e.shiftKey) return ['Digit0', 'Digit1', 'Digit2'].includes(e.code) || ['c', 'g', 'r', 'n', 'enter', 'tab'].includes(k) || k.startsWith('arrow') || (k === 'o' && oldOutlines) || (e.code === 'Slash' && !hasSelection);
  return ['v', 'h', 'c', 't', 'm', 'z', 'n', 'pageup', 'pagedown', 'escape', 'enter', 'tab', '=', '+', '-', '?'].includes(k) || k.startsWith('arrow') || e.code === 'Backslash';
}
