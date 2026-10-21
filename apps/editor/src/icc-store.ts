// Print (ICC) profiles chosen by the user: stored on the device (OPFS, “icc” folder), not
// included in document files. We do not download profiles ourselves: the print shop has its own
// (FOGRA39, ISO Coated v2, SWOP…), and that is the one to choose. Without OPFS, session only.

import { iccCmyk, parseIcc } from '@mfp/core';

const memory = new Map<string, Uint8Array>();

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle('icc', { create: true });
  } catch {
    return null;
  }
}

const safe = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);

/** Saved profiles (file names). */
export async function listProfiles(): Promise<string[]> {
  const d = await dir();
  const names = new Set(memory.keys());
  if (d) for await (const h of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) if (h.kind === 'file') names.add(h.name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

export async function readProfile(name: string): Promise<Uint8Array | null> {
  const m = memory.get(name);
  if (m) return m;
  const d = await dir();
  if (!d) return null;
  try {
    return new Uint8Array(await (await (await d.getFileHandle(name)).getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Add a profile from a file: it must be a CMYK print profile with a table for conversion to inks.
 * Returns the name it was saved under.
 */
export async function addProfile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const p = parseIcc(bytes);
  if (p.colorSpace !== 'CMYK') throw new Error(`это профиль ${p.colorSpace.trim()}, а нужен профиль печати CMYK`);
  if (!iccCmyk(p)) throw new Error('в профиле нет таблицы перевода в краски (B2A)');
  const name = safe(file.name);
  const d = await dir();
  if (d) {
    const w = await (await d.getFileHandle(name, { create: true })).createWritable();
    await w.write(bytes as FileSystemWriteChunkType);
    await w.close();
  } else memory.set(name, bytes);
  return name;
}

/** Profile name for the label: from the profile itself, otherwise the file name. */
export async function profileTitle(name: string): Promise<string> {
  const bytes = await readProfile(name);
  if (!bytes) return name;
  try {
    return parseIcc(bytes).description || name;
  } catch {
    return name;
  }
}
