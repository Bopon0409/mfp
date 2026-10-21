import type { Props } from './types.ts';

/** Match the editor's existing short layer names; preserve full text in characters. */
export function nameFromText(characters: string): string {
  return characters.trim().split('\n')[0]!.slice(0, 64) || 'Text';
}

/** Older documents have no flag. Preserve custom names; infer only the naming
 * convention previously used by the editor, without migrating on read. */
export function textAutoRename(p: Props): boolean {
  return p.autoRename ?? (p.name === undefined || p.name === 'Text' || p.name === nameFromText(p.characters ?? ''));
}

export function textNameChange(current: Props, change: Props): Props {
  if (typeof change.name === 'string' && change.name !== current.name && change.autoRename === undefined) return { ...change, autoRename: false };
  if ((typeof change.characters === 'string' || change.autoRename === true) && (change.autoRename ?? textAutoRename(current))) {
    return { ...change, name: nameFromText(change.characters ?? current.characters ?? ''), autoRename: true };
  }
  return change;
}
