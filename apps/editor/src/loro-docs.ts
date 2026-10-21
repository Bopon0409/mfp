// A document from Loro bytes (snapshot or updates), for comparing branches, connecting team
// libraries, etc.; a bridge to edit the document later and export an update.

import { Document } from '@mfp/core';
import { LoroBridge, loroReady } from '@mfp/sync';

export async function docFromLoro(...updates: Uint8Array[]): Promise<{ doc: Document; bridge: LoroBridge }> {
  await loroReady();
  const doc = new Document({ clientId: Math.floor(Math.random() * 2 ** 31) });
  const bridge = new LoroBridge(doc);
  for (const u of updates) bridge.importUpdate(u);
  doc.clearHistory();
  return { doc, bridge };
}
