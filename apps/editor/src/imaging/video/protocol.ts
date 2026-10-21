// Messages between the “Video” tab and its worker.

import type { OutCodec } from './codecs.ts';

export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
  seconds: number;
  codec: string;
  audio: string | null;
  /** Rotation from the container, in degrees. */
  rotation: number;
}

export interface VideoJob {
  modelUrl: string;
  tile: number;
  width: number;
  height: number;
  codec: OutCodec | 'auto';
  /** Process only the beginning, in seconds (trial). */
  limit: number | null;
}

export type VideoRequest =
  | { type: 'open'; file: File }
  | { type: 'frame'; job: VideoJob; time: number; previewWidth: number }
  | { type: 'encode'; job: VideoJob; handle: FileSystemFileHandle | null; previewWidth: number }
  | { type: 'cancel' };

export type VideoEvent =
  | { type: 'info'; info: VideoInfo }
  | { type: 'stage'; text: string; fraction?: number }
  | { type: 'encoder'; text: string }
  | { type: 'progress'; done: number; total: number; elapsed: number; bytes: number }
  | { type: 'preview'; before: ImageBitmap; after: ImageBitmap; seconds: number }
  | { type: 'done'; blob: Blob | null; bytes: number; frames: number; seconds: number; codec: string }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
