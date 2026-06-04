/**
 * End-to-end wiring, driven by a fixture file instead of a live device.
 *
 * The fixture (test-assets/three-utterances-16k.pcm, regenerate with
 * `npm run make-fixture`) is three loud stretches separated by silence, plus a
 * short click that should be thrown away. That is enough to check the whole
 * path: capture, segmentation, the recogniser call, ordering, and the lines
 * that come out the other end.
 *
 * The recogniser is faked. Whisper's accuracy is not what this test is about,
 * and a test that loads a 150 MB model is a test nobody runs.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { PcmFileSource } from '../src/audio/pcmFileSource.js';
import { Pipeline } from '../src/core/pipeline.js';
import { Segmenter } from '../src/stt/segmenter.js';
import type { Recognizer } from '../src/stt/recognizer.js';
import { Transcript } from '../src/transcript/transcript.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-assets',
  'three-utterances-16k.pcm',
);

const SAMPLE_RATE = 16000;

function vad() {
  return {
    sampleRate: SAMPLE_RATE,
    speechThreshold: 600,
    silenceHangoverMs: 700,
    preRollMs: 300,
    maxUtteranceMs: 15000,
    minUtteranceMs: 300,
  };
}

/** Records what it was asked to transcribe and answers after a chosen delay. */
class FakeRecognizer implements Recognizer {
  readonly name = 'fake';
  readonly received: number[] = [];
  private inFlight = 0;

  constructor(private readonly delaysMs: number[] = []) {}

  get pending(): number {
    return this.inFlight;
  }

  async start(): Promise<void> {}

  async transcribe(pcm: Buffer): Promise<string> {
    const index = this.received.length;
    this.received.push(pcm.length);
    this.inFlight++;
    await delay(this.delaysMs[index] ?? 0);
    this.inFlight--;
    return `utterance ${index}`;
  }

  async stop(): Promise<void> {}
}

class ThrowingRecognizer implements Recognizer {
  readonly name = 'throwing';
  readonly pending = 0;
  private calls = 0;
  async start(): Promise<void> {}
  async transcribe(): Promise<string> {
    this.calls++;
    if (this.calls === 2) throw new Error('sidecar hiccup');
    return `line ${this.calls}`;
  }
  async stop(): Promise<void> {}
}

function build(recognizer: Recognizer) {
  const source = new PcmFileSource(FIXTURE, SAMPLE_RATE, { chunkBytes: 3200 });
  const transcript = new Transcript(new Date(2026, 7, 16, 14, 0, 0));
  const pipeline = new Pipeline({
    source,
    segmenter: new Segmenter(vad()),
    recognizer,
    transcript,
  });
  return { pipeline, transcript, source };
}

describe('Pipeline over a fixture file', () => {
  it('produces one line per utterance and drops the click', async () => {
    const recognizer = new FakeRecognizer();
    const { pipeline, transcript } = build(recognizer);

    const lines: string[] = [];
    pipeline.on('line', (line) => lines.push(line.text));
    await pipeline.run();

    assert.equal(recognizer.received.length, 3, 'the 120 ms click must not reach the recogniser');
    assert.deepEqual(lines, ['utterance 0', 'utterance 1', 'utterance 2']);
    assert.equal(transcript.lines.length, 3);
  });

  it('timestamps lines from the position in the audio, not from wall clock', async () => {
    const { pipeline, transcript } = build(new FakeRecognizer());
    await pipeline.run();

    const offsets = transcript.lines.map((l) => Math.round(l.offsetMs / 100) * 100);
    // Fixture layout: 800 silence, 1400 speech, 1000 gap, 900 speech, 1000 gap,
    // 120 click, 1000 gap, 1600 speech. Each utterance opens 300 ms of pre-roll
    // before its onset, so 800-300, 3200-300 and 6220-300.
    assert.deepEqual(offsets, [500, 2900, 5900]);
    assert.equal(transcript.lines[0]!.at.getTime() - transcript.sessionStart.getTime(), 500);
  });

  it('keeps lines in order even when an early utterance transcribes slowly', async () => {
    // The first clip takes far longer than the two after it.
    const recognizer = new FakeRecognizer([120, 0, 0]);
    const { pipeline } = build(recognizer);

    const lines: string[] = [];
    pipeline.on('line', (line) => lines.push(line.text));
    await pipeline.run();

    assert.deepEqual(lines, ['utterance 0', 'utterance 1', 'utterance 2']);
  });

  it('hands the recogniser the pre-roll as well as the speech', async () => {
    const recognizer = new FakeRecognizer();
    const { pipeline } = build(recognizer);
    await pipeline.run();

    // First utterance: 300 ms pre-roll + 1400 ms tone + 700 ms hangover.
    const seconds = recognizer.received[0]! / 2 / SAMPLE_RATE;
    assert.ok(Math.abs(seconds - 2.4) < 0.1, `first clip was ${seconds.toFixed(2)}s`);
  });

  it('survives one failed utterance and keeps the rest', async () => {
    const { pipeline, transcript } = build(new ThrowingRecognizer());
    const warnings: string[] = [];
    pipeline.on('warning', (err: Error) => warnings.push(err.message));
    await pipeline.run();

    assert.deepEqual(warnings, ['sidecar hiccup']);
    assert.deepEqual(
      transcript.lines.map((l) => l.text),
      ['line 1', 'line 3'],
    );
  });

  it('stops cleanly part way through', async () => {
    const recognizer = new FakeRecognizer();
    const source = new PcmFileSource(FIXTURE, SAMPLE_RATE, { chunkBytes: 3200, chunkDelayMs: 1 });
    const pipeline = new Pipeline({
      source,
      segmenter: new Segmenter(vad()),
      recognizer,
      transcript: new Transcript(),
    });

    const running = pipeline.run();
    await delay(30);
    await pipeline.stop();
    await running;

    assert.ok(recognizer.received.length < 3, 'stopping early should cut the session short');
  });
});
