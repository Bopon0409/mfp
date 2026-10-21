// Link between the presentation tab (and the preview window) and the editor: a BroadcastChannel
// keyed by the editor tab token from the URL (?player=token). Doesn't depend on window.opener:
// presentation survives a reload and opens in embedded browsers and in an iframe.

import type { Snapshot } from '@mfp/core';

export const channelName = (token: string) => `mfp-player:${token}`;

/** A thread on a presentation screen: the point is in screen coordinates. */
export interface PlayerThread {
  id: string;
  at: [number, number];
  author: { name: string; color: string };
  text: string;
  created: number;
  replies: { id: string; author: { name: string; color: string }; text: string; created: number }[];
}

/** Presentation → editor. */
export type ToEditor =
  /** Document needed (the first time and after edits). page — the presentation page. */
  | { type: 'hello'; from: string; page: string | null }
  | { type: 'image'; from: string; id: number; hash: string }
  /** Screen threads. */
  | { type: 'comments'; from: string; screen: string }
  /** New thread at a screen point (thread — reply in the thread). */
  | { type: 'comment'; from: string; screen: string; at: [number, number] | null; thread: string | null; text: string }
  | { type: 'bye'; from: string };

/** Editor → presentation. */
export type ToPlayer =
  | { type: 'doc'; to: string; snapshot: Snapshot; page: string; name: string }
  | { type: 'image'; to: string; id: number; bytes: Uint8Array | null }
  /** The document in the editor changed. */
  | { type: 'changed' }
  | { type: 'comments'; to: string; screen: string; threads: PlayerThread[]; canWrite: boolean; error?: string }
  /** Comments changed (own or others'). */
  | { type: 'commentsChanged' };
