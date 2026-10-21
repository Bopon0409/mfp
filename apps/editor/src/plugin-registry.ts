// Installed plugins. Sources: own files (plugin folder), the MFP catalog (package at a URL), the
// examples folder on the development server. Stored in OPFS: plugins/<id>.json — manifest, code and UI.
// Plugins in Figma format — our own, open-source or with the author's consent.

import { parseManifest, type PluginBundle } from '@mfp/plugin-host';

export type PluginSource = 'local' | 'catalog' | 'dev';

export interface InstalledPlugin {
  bundle: PluginBundle;
  source: PluginSource;
  /** Catalog: package URL (folder with manifest.json). */
  url?: string;
  installed: number;
}

/** Catalog entry (catalog.json). */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  license: string;
  /** Source code (repository). */
  source?: string;
  /** Package folder relative to catalog.json, or a full URL. */
  url: string;
}

const DIR = 'plugins';
const fileName = (id: string) => `${id.replace(/[^\w.-]/g, '_')}.json`;

/** Plugin package at a folder URL: manifest.json, main and ui. */
export async function fetchBundle(base: string): Promise<{ bundle: PluginBundle; warnings: string[] }> {
  const root = base.endsWith('/') ? base : `${base}/`;
  const file = async (f: string) => {
    const res = await fetch(new URL(f, new URL(root, location.href)));
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    return res.text();
  };
  const { manifest, warnings } = parseManifest(JSON.parse(await file('manifest.json')));
  const html = typeof manifest.ui === 'string' ? await file(manifest.ui) : undefined;
  // Multiple windows (ui is an object): all go to the plugin as __uiFiles__.
  let uiFiles: Record<string, string> | undefined;
  if (manifest.ui && typeof manifest.ui === 'object') {
    uiFiles = {};
    for (const [k, f] of Object.entries(manifest.ui)) uiFiles[k] = await file(String(f));
  }
  return { bundle: { manifest, code: await file(manifest.main), html, ...(uiFiles ? { uiFiles } : {}) }, warnings };
}

export class PluginRegistry {
  private stored: Map<string, InstalledPlugin> | null = null;
  private dev: Promise<InstalledPlugin[]> | null = null;
  private devEnabled: boolean;

  constructor(opts: { dev: boolean }) {
    this.devEnabled = opts.dev;
  }

  /** All plugins by name: installed and (on the development server) examples. */
  async list(): Promise<InstalledPlugin[]> {
    const own = await this.load();
    const dev = this.devEnabled ? await (this.dev ??= this.loadDev()) : [];
    const ids = new Set(own.keys());
    return [...own.values(), ...dev.filter((p) => !ids.has(p.bundle.manifest.id))].sort((a, b) => a.bundle.manifest.name.localeCompare(b.bundle.manifest.name));
  }

  async get(id: string): Promise<InstalledPlugin | undefined> {
    return (await this.list()).find((p) => p.bundle.manifest.id === id);
  }

  async install(bundle: PluginBundle, source: PluginSource, url?: string): Promise<InstalledPlugin> {
    const p: InstalledPlugin = { bundle, source, ...(url ? { url } : {}), installed: Date.now() };
    const dir = await this.dir();
    const handle = await dir.getFileHandle(fileName(bundle.manifest.id), { create: true });
    const w = await handle.createWritable();
    await w.write(JSON.stringify(p));
    await w.close();
    (await this.load()).set(bundle.manifest.id, p);
    return p;
  }

  async remove(id: string) {
    const map = await this.load();
    if (!map.delete(id)) return;
    try {
      await (await this.dir()).removeEntry(fileName(id));
    } catch {
      // The file is gone.
    }
  }

  private async dir() {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(DIR, { create: true });
  }

  private async load(): Promise<Map<string, InstalledPlugin>> {
    if (this.stored) return this.stored;
    const map = new Map<string, InstalledPlugin>();
    try {
      const dir = await this.dir();
      for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (h.kind !== 'file' || !h.name.endsWith('.json')) continue;
        try {
          const p = JSON.parse(await (await (h as FileSystemFileHandle).getFile()).text()) as InstalledPlugin;
          if (p?.bundle?.manifest?.id) map.set(p.bundle.manifest.id, p);
        } catch {
          // Corrupted entry — skip.
        }
      }
    } catch {
      // OPFS unavailable (private mode) — examples only.
    }
    this.stored = map;
    return map;
  }

  /** Examples from the development server (/api/plugins). */
  private async loadDev(): Promise<InstalledPlugin[]> {
    // The built app has no such URL: a page (or nothing) comes instead of JSON — no examples.
    const names: string[] = await fetch('/api/plugins')
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : []))
      .catch(() => []);
    const out: InstalledPlugin[] = [];
    for (const name of names) {
      try {
        const url = `/plugins/${encodeURIComponent(name)}/`;
        out.push({ bundle: (await fetchBundle(url)).bundle, source: 'dev', url, installed: 0 });
      } catch {
        // Not a plugin or has no files.
      }
    }
    return out;
  }
}
