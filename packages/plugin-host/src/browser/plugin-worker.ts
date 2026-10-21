// Plugin Web Worker: its own document copy + QuickJS (session in session.ts).
// The main thread (UI, rendering) is not blocked even if the plugin computes for a long time.

import { WorkerSession } from './session.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

const session = new WorkerSession((m: FromWorker) => (self as unknown as Worker).postMessage(m));

self.onmessage = (e: MessageEvent<ToWorker>) => {
  void session.handle(e.data);
};
