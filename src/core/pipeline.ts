/**
 * Pipeline — the wiring, and nothing else.
 *
 *   AudioSource ──PCM──► Segmenter ──utterance──► Recognizer ──text──► Transcript
 *
 * Utterances are handed to the recogniser the moment they close, so a slow
 * transcription never stalls capture, but the results are applied to the
 * transcript through a promise chain so lines can never land out of order. That
 * matters because Whisper takes longer on a long clip than a short one, and a
 * transcript with sentences swapped is worse than one that is a second late.
 *
 * Nothing here knows about ffmpeg, Python, HTTP or the filesystem, which is why
 * the pipeline test can drive the whole path from a fixture file.
 */

import { EventEmitter } from 'node:events';
import type { AudioSource } from '../audio/audioSource.js';
import type { Segmenter, Utterance } from '../stt/segmenter.js';
import type { Recognizer } from '../stt/recognizer.js';
import type { Transcript, TranscriptLine } from '../transcript/transcript.js';

export interface PipelineParts {
  source: AudioSource;
  segmenter: Segmenter;
  recognizer: Recognizer;
  transcript: Transcript;
}

export interface PipelineEvents {
  line: (line: TranscriptLine) => void;
  /** An utterance closed and is now waiting on the recogniser. */
  utterance: (utterance: Utterance) => void;
  /** A dropped or non-fatal failure. The session keeps going. */
  warning: (err: Error) => void;
  error: (err: Error) => void;
  end: () => void;
}

export class Pipeline extends EventEmitter {
  private readonly parts: PipelineParts;
  private tail: Promise<void> = Promise.resolve();
  private ended: Promise<void> | null = null;
  private markEnded: (() => void) | null = null;
  private stopped = false;

  constructor(parts: PipelineParts) {
    super();
    this.parts = parts;
  }

  /** Utterances handed to the recogniser but not yet written down. */
  get pending(): number {
    return this.parts.recognizer.pending;
  }

  /**
   * Start capture and resolve when the source has ended and every utterance it
   * produced has been transcribed.
   */
  async run(): Promise<void> {
    const { source, segmenter } = this.parts;

    this.ended = new Promise<void>((resolve, reject) => {
      this.markEnded = resolve;
      source.on('data', (pcm: Buffer) => {
        for (const utterance of segmenter.push(pcm)) this.dispatch(utterance);
      });
      source.on('end', () => {
        for (const utterance of segmenter.flush()) this.dispatch(utterance);
        resolve();
      });
      source.on('error', (err: Error) => {
        if (this.stopped) resolve();
        else reject(err);
      });
    });

    await source.start();
    await this.ended;
    await this.tail;
    this.emit('end');
  }

  private dispatch(utterance: Utterance): void {
    this.emit('utterance', utterance);
    // Kick off transcription now, apply the result in order.
    const transcribed = this.parts.recognizer.transcribe(utterance.pcm);
    this.tail = this.tail
      .then(() => transcribed)
      .then((text) => {
        const line = this.parts.transcript.append({
          text,
          offsetMs: utterance.startMs,
          voicedMs: utterance.voicedMs,
        });
        if (line) this.emit('line', line);
      })
      .catch((err: unknown) => {
        this.emit('warning', err as Error);
      });
  }

  /** Stop capture, transcribe whatever is still open, then settle. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.parts.source.stop();
    for (const utterance of this.parts.segmenter.flush()) this.dispatch(utterance);
    // A source that was cut off mid-stream never emits `end`, so release the
    // caller sitting in run().
    this.markEnded?.();
    await this.tail;
  }
}
