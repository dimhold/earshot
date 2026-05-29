/**
 * PcmFileSource — replays a raw PCM or WAV file as if it were a live device.
 *
 * This is what the pipeline tests run against. It exists so the segmenter, the
 * recogniser wiring and the transcript can all be exercised without an audio
 * device, a microphone permission dialog or a person talking into a laptop.
 * It is also genuinely useful: `--source file` uses it for anything that is
 * already 16 kHz mono PCM.
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { AudioSource } from './audioSource.js';

export interface PcmFileSourceOptions {
  /** Bytes handed over per `data` event. Default 3200 = 100 ms at 16 kHz. */
  chunkBytes?: number;
  /**
   * Pause between chunks, in milliseconds. Zero replays the file as fast as
   * possible, which is what tests want.
   */
  chunkDelayMs?: number;
}

/** Strip a RIFF/WAVE header, returning the data chunk. Passes raw PCM through. */
export function stripWavHeader(buf: Buffer): Buffer {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return buf;
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'data') return buf.subarray(body, Math.min(body + size, buf.length));
    offset = body + size + (size % 2);
  }
  return buf;
}

export class PcmFileSource extends EventEmitter implements AudioSource {
  readonly sampleRate: number;
  readonly description: string;

  private readonly path: string;
  private readonly chunkBytes: number;
  private readonly chunkDelayMs: number;
  private cancelled = false;
  private finished: Promise<void> = Promise.resolve();

  constructor(path: string, sampleRate: number, options: PcmFileSourceOptions = {}) {
    super();
    this.path = path;
    this.sampleRate = sampleRate;
    this.chunkBytes = options.chunkBytes ?? 3200;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.description = `file ${path}`;
  }

  async start(): Promise<void> {
    const raw = await readFile(this.path);
    const pcm = stripWavHeader(raw);
    this.finished = this.pump(pcm);
    this.finished.catch((err: unknown) => this.emit('error', err as Error));
  }

  private async pump(pcm: Buffer): Promise<void> {
    for (let offset = 0; offset < pcm.length && !this.cancelled; offset += this.chunkBytes) {
      const end = Math.min(offset + this.chunkBytes, pcm.length);
      const chunk = pcm.subarray(offset, end - ((end - offset) % 2));
      if (chunk.length > 0) this.emit('data', chunk);
      if (this.chunkDelayMs > 0) await delay(this.chunkDelayMs);
    }
    if (!this.cancelled) this.emit('end');
  }

  /** Resolves once the whole file has been emitted. Handy in tests. */
  async done(): Promise<void> {
    await this.finished;
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    await this.finished.catch(() => {});
  }
}
