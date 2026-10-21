// Decoding a fig-kiwi message with the schema stored in the file itself.
// We do not hardcode the Figma schema: we read the one that came with the file,
// so new format versions decode without a parser update.

import { compileSchema, decodeBinarySchema } from 'kiwi-schema';
import type { FigKiwiPayload } from './container.ts';
import type { FigMessage } from './types.ts';

export interface DecodedFig {
  /** Schema definitions (for debugging and compatibility reports). */
  schema: ReturnType<typeof decodeBinarySchema>;
  message: FigMessage;
}

export function decodeFigKiwi(payload: FigKiwiPayload): DecodedFig {
  const [schemaBytes, messageBytes] = payload.chunks;
  if (!schemaBytes || !messageBytes) throw new Error('Нет чанков схемы или сообщения');
  const schema = decodeBinarySchema(schemaBytes);
  const compiled = compileSchema(schema) as { decodeMessage(bytes: Uint8Array): FigMessage };
  const message = compiled.decodeMessage(messageBytes);
  return { schema, message };
}
