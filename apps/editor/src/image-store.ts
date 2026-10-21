// Document images: those added in the editor (paste, drag and drop) live in memory,
// the rest come from the document source (a .fig archive or a .mfp file). When saving
// to .mfp, all used images go into the file.

import type { ImageBytesSource } from '@mfp/io-figma';

export class ImageStore implements ImageBytesSource {
  private added = new Map<string, Uint8Array>();
  /** An image was added (wired by the editor: the cache forgets an earlier failure). */
  onAdd: ((hash: string) => void) | null = null;
  /** Subscribers to new images with bytes (autosave writes them right away, ahead of the edit journal). */
  private listeners = new Set<(hash: string, bytes: Uint8Array) => void>();
  private base: ImageBytesSource | null;

  constructor(base: ImageBytesSource | null) {
    this.base = base;
    if (base?.readImagePreview) this.readImagePreview = async (hash, maxSide) => this.added.get(hash) ?? base.readImagePreview!(hash, maxSide);
  }

  async readImage(hash: string): Promise<Uint8Array | undefined> {
    return this.added.get(hash) ?? (await this.base?.readImage(hash));
  }
  readImagePreview?: (hash: string, maxSide: number) => Promise<Uint8Array | undefined>;

  /** An image with an already computed SHA-1 (plugin: createImage): immediately, no waiting. */
  put(hash: string, bytes: Uint8Array) {
    if (this.added.has(hash)) return;
    this.added.set(hash, bytes);
    this.onAdd?.(hash);
    for (const l of this.listeners) l(hash, bytes);
  }

  /** Watch for new images; returns an unsubscribe function. */
  subscribe(listener: (hash: string, bytes: Uint8Array) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Add an image; the key is the SHA-1 of its contents. */
  async add(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as BufferSource));
    const hash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
    const fresh = !this.added.has(hash);
    this.added.set(hash, bytes);
    this.onAdd?.(hash);
    if (fresh) for (const l of this.listeners) l(hash, bytes);
    return hash;
  }
}
