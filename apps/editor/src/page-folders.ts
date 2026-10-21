// Nested page folders (our own). A folder is a path in the page property pageFolder separated by
// “/”: “Product/Onboarding”. There are no empty folders: a folder exists while it (or something
// deeper) contains a page. Order: a folder sits where its first page is.

/** Folder path without empty parts and extra spaces. */
export function cleanFolder(raw: string | undefined): string {
  return (raw ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

/** A page with folder f lies in folder folder (or deeper). */
export function inFolder(f: string, folder: string): boolean {
  return f === folder || f.startsWith(folder + '/');
}

/** Folder name (last part) and parent. */
export function folderName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
export function parentFolder(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export type PageRow = { kind: 'page'; id: string; depth: number } | { kind: 'folder'; path: string; depth: number; pages: string[]; open: boolean };

/**
 * List rows: pages and folders in document order, a folder sits where its first page is,
 * followed by its pages and subfolders (nothing for a collapsed one).
 */
export function pageTree(pages: readonly { id: string; folder: string }[], collapsed: ReadonlySet<string>): PageRow[] {
  const out: PageRow[] = [];
  const emit = (list: readonly { id: string; folder: string }[], prefix: string, depth: number) => {
    const placed = new Set<string>();
    for (const p of list) {
      if (p.folder === prefix) {
        out.push({ kind: 'page', id: p.id, depth });
        continue;
      }
      const rest = prefix ? p.folder.slice(prefix.length + 1) : p.folder;
      const path = prefix ? `${prefix}/${rest.split('/')[0]}` : rest.split('/')[0]!;
      if (placed.has(path)) continue;
      placed.add(path);
      const inside = list.filter((q) => inFolder(q.folder, path));
      const open = !collapsed.has(path);
      out.push({ kind: 'folder', path, depth, pages: inside.map((q) => q.id), open });
      if (open) emit(inside, path, depth + 1);
    }
  };
  emit(
    pages.map((p) => ({ id: p.id, folder: cleanFolder(p.folder) })),
    '',
    0,
  );
  return out;
}

/** New folder of page f after renaming folder from to to (full paths). */
export function renamedFolder(f: string, from: string, to: string): string {
  return inFolder(f, from) ? cleanFolder(to + f.slice(from.length)) : f;
}

/** Dissolve a folder: its pages and subfolders move one level up. */
export function dissolvedFolder(f: string, folder: string): string {
  if (!inFolder(f, folder)) return f;
  return cleanFolder(parentFolder(folder) + f.slice(folder.length));
}

/** All folders (including intermediate ones) from pages — for the “To folder” menu. */
export function allFolders(folders: readonly string[]): string[] {
  const set = new Set<string>();
  for (const raw of folders) {
    const parts = cleanFolder(raw).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set];
}
