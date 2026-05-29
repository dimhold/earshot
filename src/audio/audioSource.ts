/**
 * AudioSource — the one thing every capture backend has to be.
 *
 * A source emits `data` events carrying 16-bit signed little-endian mono PCM at
 * {@link AudioSource.sampleRate}. Everything downstream (the segmenter, the
 * recogniser, the transcript) is written against this interface and knows
 * nothing about ffmpeg, devices or files.
 */

import type { EventEmitter } from 'node:events';

export interface AudioSource extends EventEmitter {
  readonly sampleRate: number;
  /** A short human readable description, used in logs and in the live view. */
  readonly description: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'data', listener: (pcm: Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

/**
 * PCM arrives from pipes in arbitrary chunk sizes, and a chunk can end halfway
 * through a 16-bit sample. This keeps the odd trailing byte and prepends it to
 * the next chunk so no consumer ever sees a misaligned buffer.
 */
export class SampleAligner {
  private remainder: Buffer = Buffer.alloc(0);

  /** Returns an even-length buffer, possibly empty. */
  push(chunk: Buffer): Buffer {
    const joined = this.remainder.length === 0 ? chunk : Buffer.concat([this.remainder, chunk]);
    const usable = joined.length - (joined.length % 2);
    this.remainder = usable === joined.length ? Buffer.alloc(0) : joined.subarray(usable);
    return joined.subarray(0, usable);
  }

  /** Number of bytes currently held back. Zero or one. */
  get pending(): number {
    return this.remainder.length;
  }
}
