/**
 * Segmenter — cuts a continuous PCM stream into utterances.
 *
 * Whisper transcribes a clip, not a stream, so something has to decide where
 * one clip ends and the next begins. This does it with an energy threshold and
 * a small state machine:
 *
 *   idle ──(loud frame)──► speech ──(700 ms of quiet)──► emit utterance ──► idle
 *
 * Two details matter more than the threshold itself. A rolling pre-roll buffer
 * keeps the 300 ms before onset, because the energy detector always notices a
 * word slightly after it started and without the pre-roll every line loses its
 * first syllable. And a hard cap flushes an utterance that runs long, because
 * somebody who talks for two minutes without a pause should not wait two
 * minutes for a line to appear.
 *
 * The class is pure: it takes buffers, returns utterances, keeps no timers and
 * reads no clock. Time is counted in samples, so a test replaying a fixture
 * gets exactly the offsets a live device would produce.
 */

export interface SegmenterOptions {
  sampleRate: number;
  /** RMS on the Int16 scale (0..32767) above which a frame counts as speech. */
  speechThreshold: number;
  silenceHangoverMs: number;
  preRollMs: number;
  maxUtteranceMs: number;
  minUtteranceMs: number;
  /** Analysis frame size. 20 ms is the usual compromise for energy VAD. */
  frameMs?: number;
}

export interface Utterance {
  /** 16-bit mono PCM, ready for the recogniser. */
  pcm: Buffer;
  /** Offset from the start of the stream, in milliseconds. */
  startMs: number;
  /** Length of the clip, including pre-roll and trailing silence. */
  durationMs: number;
  /** How much of that was above the speech threshold. */
  voicedMs: number;
}

export type SegmenterState = 'idle' | 'speech';

/** Root mean square of an even-length Int16LE buffer. */
export function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / samples);
}

export class Segmenter {
  private readonly opts: Required<SegmenterOptions>;
  private readonly frameBytes: number;

  private carry: Buffer = Buffer.alloc(0);
  private elapsedMs = 0;

  private state: SegmenterState = 'idle';
  private preRoll: Buffer[] = [];
  private preRollMs = 0;
  private segment: Buffer[] = [];
  private segmentMs = 0;
  private voicedMs = 0;
  private silenceMs = 0;
  private segmentStartMs = 0;

  constructor(options: SegmenterOptions) {
    const frameMs = options.frameMs ?? 20;
    this.opts = { ...options, frameMs };
    this.frameBytes = Math.round((options.sampleRate * frameMs) / 1000) * 2;
    if (this.frameBytes <= 0) throw new Error('frame size must be positive');
  }

  get currentState(): SegmenterState {
    return this.state;
  }

  /** Milliseconds of audio consumed so far. */
  get position(): number {
    return this.elapsedMs;
  }

  /** Feed a chunk of Int16LE mono PCM. Returns whatever utterances it completed. */
  push(chunk: Buffer): Utterance[] {
    const buf = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    const out: Utterance[] = [];
    let offset = 0;
    while (offset + this.frameBytes <= buf.length) {
      const frame = buf.subarray(offset, offset + this.frameBytes);
      offset += this.frameBytes;
      const done = this.pushFrame(frame);
      if (done) out.push(done);
    }
    this.carry = Buffer.from(buf.subarray(offset));
    return out;
  }

  /** End of stream. Emits a final utterance if one is open and long enough. */
  flush(): Utterance[] {
    const out: Utterance[] = [];
    if (this.carry.length >= 2) {
      const done = this.pushFrame(this.carry.subarray(0, this.carry.length - (this.carry.length % 2)));
      if (done) out.push(done);
      this.carry = Buffer.alloc(0);
    }
    if (this.state === 'speech') {
      const done = this.close();
      if (done) out.push(done);
    }
    return out;
  }

  private pushFrame(frame: Buffer): Utterance | null {
    const frameMs = (frame.length / 2 / this.opts.sampleRate) * 1000;
    const loud = rms(frame) >= this.opts.speechThreshold;
    this.elapsedMs += frameMs;

    if (this.state === 'idle') {
      if (!loud) {
        this.preRoll.push(frame);
        this.preRollMs += frameMs;
        while (this.preRollMs > this.opts.preRollMs && this.preRoll.length > 0) {
          const dropped = this.preRoll.shift()!;
          this.preRollMs -= (dropped.length / 2 / this.opts.sampleRate) * 1000;
        }
        return null;
      }
      // Onset. The utterance starts at the beginning of the pre-roll, not here.
      this.state = 'speech';
      this.segment = [...this.preRoll, frame];
      this.segmentMs = this.preRollMs + frameMs;
      this.segmentStartMs = this.elapsedMs - this.segmentMs;
      this.voicedMs = frameMs;
      this.silenceMs = 0;
      this.preRoll = [];
      this.preRollMs = 0;
      return null;
    }

    this.segment.push(frame);
    this.segmentMs += frameMs;
    if (loud) {
      this.voicedMs += frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }

    if (this.silenceMs >= this.opts.silenceHangoverMs) return this.close();
    if (this.segmentMs >= this.opts.maxUtteranceMs) return this.close();
    return null;
  }

  private close(): Utterance | null {
    const pcm = Buffer.concat(this.segment);
    const utterance: Utterance = {
      pcm,
      startMs: this.segmentStartMs,
      durationMs: this.segmentMs,
      voicedMs: this.voicedMs,
    };
    const tooShort = this.voicedMs < this.opts.minUtteranceMs;

    this.state = 'idle';
    this.segment = [];
    this.segmentMs = 0;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.preRoll = [];
    this.preRollMs = 0;

    return tooShort ? null : utterance;
  }
}
