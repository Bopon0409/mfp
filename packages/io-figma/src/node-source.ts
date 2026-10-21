// Node.js: a file on disk as a ByteSource (without loading it entirely into memory).

import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import type { ByteSource } from './source.ts';

export class FileSource implements ByteSource {
  private fd: number;
  readonly size: number;
  /** How many bytes were actually read from disk — for reports. */
  bytesRead = 0;

  constructor(path: string) {
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, buf, done, length - done, offset + done);
      if (n === 0) break;
      done += n;
    }
    this.bytesRead += done;
    return done === length ? buf : buf.subarray(0, done);
  }

  close() {
    closeSync(this.fd);
  }
}
