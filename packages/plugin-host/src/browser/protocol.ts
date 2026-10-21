// Messages between the editor main thread and the plugin Worker.

import type { Op, Snapshot } from '@mfp/core';
import type { PluginBundle, WidgetMessage } from '../runtime.ts';

/** Editor camera: center of the visible area (world), zoom, canvas size (CSS px). */
export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

/** Origin of editor edits for plugin events: LOCAL — this user, REMOTE — others, null — no events (page loading). */
export type OpsOrigin = 'LOCAL' | 'REMOTE' | null;

export type ToWorker =
  | {
      type: 'start';
      bundle: PluginBundle;
      snapshot: Snapshot;
      page: string;
      selection: string[];
      storage: Record<string, unknown>;
      codegen?: boolean;
      editorType?: 'figma' | 'dev';
      viewport?: ViewportState;
      /** figma.motion.playheadPosition: timeline playhead, seconds (null — no panel). */
      playhead?: number | null;
      command?: string;
      parameters?: Record<string, unknown>;
      user?: { id: string | null; name: string; photoUrl: string | null; color: string; sessionId: number } | null;
      /** run — after the parameters are entered (run message). */
      deferRun?: boolean;
    }
  /** Quick action parameter input. */
  | { type: 'parameterInput'; requestId: number; key: string; query: string; parameters: Record<string, unknown> }
  /** Parameters entered: the run event. */
  | { type: 'run'; command: string; parameters?: Record<string, unknown> }
  | { type: 'generate'; requestId: number; nodeId: string; language: string }
  /** Editor edits into the plugin's document copy, in application order; seq — batch number. */
  | { type: 'docOps'; ops: Op[]; origin: OpsOrigin; seq: number }
  /** The document copy diverged from the editor: replace it with a snapshot. */
  | { type: 'reset'; snapshot: Snapshot; seq: number }
  | { type: 'setSelection'; ids: string[]; page: string }
  | { type: 'viewport'; viewport: ViewportState }
  | { type: 'playhead'; t: number | null }
  | { type: 'uiMessage'; message: unknown }
  | { type: 'stop' }
  | { type: 'storageResult'; id: number; value: unknown }
  | { type: 'fontLoaded'; id: number; ok: boolean }
  /** Response to a plugin request (request). */
  | { type: 'response'; id: number; value?: unknown; error?: string }
  /** Widget: render, click, property menu. */
  | { type: 'widget'; msg: WidgetMessage };

/** What the plugin asks of the editor (rendering, image storage, network). */
export type PluginRequest = 'export' | 'imageBytes' | 'imageFromUrl' | 'flatten' | 'fonts' | 'saveVersion';

export type FromWorker =
  /** Plugin edits; seen — the last batch of editor edits the plugin has already seen. */
  | { type: 'ops'; ops: Op[]; seen: number }
  /** The document copy rejected the editor edits: a snapshot is needed. */
  | { type: 'resync' }
  | { type: 'selection'; ids: string[] }
  | { type: 'page'; id: string }
  | { type: 'setViewport'; center?: { x: number; y: number }; zoom?: number }
  | { type: 'showUI'; html: string; options: { width?: number; height?: number; visible?: boolean; title?: string } | null }
  | { type: 'postToUI'; message: unknown }
  | { type: 'uiVisible'; visible: boolean }
  | { type: 'uiResize'; width: number; height: number }
  | { type: 'uiClose' }
  | { type: 'notify'; message: string }
  | { type: 'zoomTo'; ids: string[] }
  | { type: 'storageSet'; key: string; value: unknown }
  | { type: 'storageDelete'; key: string }
  | { type: 'log'; level: string; args: string[] }
  | { type: 'loadFont'; id: number; font: { family: string; style: string } }
  | { type: 'exit'; state: string; message: string | null; error: string | null }
  | { type: 'commitUndo' }
  | { type: 'codegenResult'; requestId: number; results: unknown; error: string | null }
  | { type: 'codegenRefresh' }
  | { type: 'request'; id: number; method: PluginRequest; args: unknown }
  /** Parameter suggestions (response to parameterInput). */
  | { type: 'suggestions'; requestId: number; suggestions?: { name: string; data?: unknown }[]; error?: string; loading?: string }
  /** Plugin image (createImage) into the editor storage. */
  | { type: 'image'; hash: string; bytes: Uint8Array }
  /** figma.openExternal. */
  | { type: 'openExternal'; url: string };
