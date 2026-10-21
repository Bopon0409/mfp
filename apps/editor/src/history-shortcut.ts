/** Document history must also work when a non-editable floating panel stops bubbling. */
export function historyShortcut(e: KeyboardEvent): 'undo' | 'redo' | null {
  if (e.defaultPrevented || e.isComposing || e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  const target = e.target as HTMLElement | null;
  // The shortcut recorder must receive the chord instead of changing the document.
  if (target?.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""],.keys-modal')) return null;
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  return key === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey ? 'redo' : null;
}
