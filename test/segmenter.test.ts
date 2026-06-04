import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Segmenter, rms, type Utterance } from '../src/stt/segmenter.js';

const SAMPLE_RATE = 16000;

function options(overrides: Partial<ConstructorParameters<typeof Segmenter>[0]> = {}) {
  return {
    sampleRate: SAMPLE_RATE,
    speechThreshold: 600,
    silenceHangoverMs: 700,
    preRollMs: 300,
    maxUtteranceMs: 15000,
    minUtteranceMs: 300,
    ...overrides,
  };
}

/** `ms` of a 300 Hz tone at the given peak amplitude. */
function tone(ms: number, amplitude: number): Buffer {
  const count = Math.round((ms * SAMPLE_RATE) / 1000);
  const buf = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / SAMPLE_RATE) * amplitude), i * 2);
  }
  return buf;
}

const silence = (ms: number) => tone(ms, 8);
const speech = (ms: number) => tone(ms, 6000);

function feed(seg: Segmenter, parts: Buffer[], chunkBytes?: number): Utterance[] {
  const all = Buffer.concat(parts);
  const out: Utterance[] = [];
  if (chunkBytes === undefined) {
    out.push(...seg.push(all));
  } else {
    for (let i = 0; i < all.length; i += chunkBytes) {
      out.push(...seg.push(all.subarray(i, Math.min(i + chunkBytes, all.length))));
    }
  }
  out.push(...seg.flush());
  return out;
}

describe('rms', () => {
  it('is zero for an empty buffer', () => {
    assert.equal(rms(Buffer.alloc(0)), 0);
  });

  it('measures a constant signal exactly', () => {
    const buf = Buffer.alloc(8);
    for (let i = 0; i < 4; i++) buf.writeInt16LE(1000, i * 2);
    assert.equal(rms(buf), 1000);
  });

  it('separates room tone from speech level', () => {
    assert.ok(rms(silence(100)) < 100);
    assert.ok(rms(speech(100)) > 3000);
  });
});

describe('Segmenter', () => {
  it('emits nothing while the room is quiet', () => {
    const seg = new Segmenter(options());
    assert.deepEqual(feed(seg, [silence(5000)]), []);
  });

  it('closes an utterance after the silence hangover', () => {
    const seg = new Segmenter(options());
    const utterances = feed(seg, [silence(1000), speech(1200), silence(2000)]);
    assert.equal(utterances.length, 1);
    const [u] = utterances as [Utterance];
    assert.ok(Math.abs(u.voicedMs - 1200) < 60, `voicedMs was ${u.voicedMs}`);
    // pre-roll (300) + speech (1200) + hangover (700)
    assert.ok(Math.abs(u.durationMs - 2200) < 80, `durationMs was ${u.durationMs}`);
    assert.equal(u.pcm.length, Math.round((u.durationMs / 1000) * SAMPLE_RATE) * 2);
  });

  it('keeps the pre-roll so the first syllable survives', () => {
    const seg = new Segmenter(options());
    const [u] = feed(seg, [silence(1000), speech(1000), silence(1500)]) as [Utterance];
    // Onset is at 1000 ms and the clip must begin 300 ms earlier.
    assert.ok(Math.abs(u.startMs - 700) < 40, `startMs was ${u.startMs}`);
  });

  it('does not invent a pre-roll longer than the audio it has seen', () => {
    const seg = new Segmenter(options());
    const [u] = feed(seg, [silence(100), speech(1000), silence(1500)]) as [Utterance];
    assert.ok(u.startMs >= 0);
    assert.ok(u.startMs < 120, `startMs was ${u.startMs}`);
  });

  it('splits two sentences separated by a real pause', () => {
    const seg = new Segmenter(options());
    const utterances = feed(seg, [
      silence(500),
      speech(900),
      silence(1200),
      speech(900),
      silence(1200),
    ]);
    assert.equal(utterances.length, 2);
    assert.ok(utterances[1]!.startMs > utterances[0]!.startMs + 1000);
  });

  it('keeps a short pause inside one utterance', () => {
    const seg = new Segmenter(options());
    const utterances = feed(seg, [
      silence(500),
      speech(700),
      silence(300), // shorter than the 700 ms hangover
      speech(700),
      silence(1200),
    ]);
    assert.equal(utterances.length, 1);
  });

  it('discards a click that is loud but too short', () => {
    const seg = new Segmenter(options());
    assert.deepEqual(feed(seg, [silence(500), speech(120), silence(1500)]), []);
  });

  it('force-flushes somebody who never pauses', () => {
    const seg = new Segmenter(options({ maxUtteranceMs: 2000 }));
    const utterances = feed(seg, [silence(300), speech(9000), silence(1000)]);
    assert.ok(utterances.length >= 4, `expected several forced flushes, got ${utterances.length}`);
    for (const u of utterances) assert.ok(u.durationMs <= 2100, `durationMs was ${u.durationMs}`);
  });

  it('flushes an utterance that is still open at end of stream', () => {
    const seg = new Segmenter(options());
    const utterances = feed(seg, [silence(400), speech(1000)]);
    assert.equal(utterances.length, 1);
  });

  it('produces the same result whatever the chunk size', () => {
    const parts = [silence(500), speech(900), silence(1200), speech(1100), silence(1200)];
    const whole = feed(new Segmenter(options()), parts);
    for (const chunkBytes of [2, 640, 1000, 4096, 77]) {
      const chunked = feed(new Segmenter(options()), parts, chunkBytes);
      assert.equal(chunked.length, whole.length, `count differed at chunkBytes=${chunkBytes}`);
      chunked.forEach((u, i) => {
        assert.ok(
          Math.abs(u.startMs - whole[i]!.startMs) < 25,
          `startMs differed at chunkBytes=${chunkBytes}`,
        );
        assert.equal(u.pcm.length, whole[i]!.pcm.length);
      });
    }
  });

  it('tracks how much audio it has consumed', () => {
    const seg = new Segmenter(options());
    seg.push(silence(1000));
    assert.ok(Math.abs(seg.position - 1000) < 25, `position was ${seg.position}`);
    assert.equal(seg.currentState, 'idle');
    seg.push(speech(200));
    assert.equal(seg.currentState, 'speech');
  });
});
