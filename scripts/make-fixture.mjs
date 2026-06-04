/**
 * Generate the test fixture: 16 kHz mono Int16 PCM containing three synthetic
 * "utterances" separated by silence.
 *
 * The fixture is synthesised rather than recorded on purpose. It is
 * deterministic, it is a few hundred kilobytes, it carries nobody's voice, and
 * the tests that use it are about segmentation and wiring rather than about
 * recognition accuracy.
 *
 *   npm run make-fixture
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 16000;
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test-assets',
  'three-utterances-16k.pcm',
);

/** Layout in milliseconds: quiet, loud, quiet, loud, ... */
const LAYOUT = [
  { ms: 800, amplitude: 0 },
  { ms: 1400, amplitude: 6000 },
  { ms: 1000, amplitude: 0 },
  { ms: 900, amplitude: 6000 },
  { ms: 1000, amplitude: 0 },
  { ms: 120, amplitude: 9000 }, // a click: loud but far too short to be speech
  { ms: 1000, amplitude: 0 },
  { ms: 1600, amplitude: 6000 },
  { ms: 900, amplitude: 0 },
];

/**
 * A sum of three tones with a slow amplitude wobble. Not speech, but it has the
 * one property the energy segmenter cares about: it is reliably above the
 * threshold while it lasts.
 */
function sample(index, amplitude) {
  if (amplitude === 0) {
    // Room tone, well below any sane threshold.
    return Math.round(Math.sin(index * 0.01) * 12);
  }
  const t = index / SAMPLE_RATE;
  const wobble = 0.75 + 0.25 * Math.sin(2 * Math.PI * 3 * t);
  const tone =
    Math.sin(2 * Math.PI * 180 * t) * 0.6 +
    Math.sin(2 * Math.PI * 420 * t) * 0.3 +
    Math.sin(2 * Math.PI * 900 * t) * 0.1;
  return Math.max(-32768, Math.min(32767, Math.round(tone * wobble * amplitude)));
}

const totalSamples = LAYOUT.reduce((n, part) => n + Math.round((part.ms * SAMPLE_RATE) / 1000), 0);
const pcm = Buffer.alloc(totalSamples * 2);

let cursor = 0;
for (const part of LAYOUT) {
  const count = Math.round((part.ms * SAMPLE_RATE) / 1000);
  for (let i = 0; i < count; i++) {
    pcm.writeInt16LE(sample(cursor, part.amplitude), cursor * 2);
    cursor++;
  }
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, pcm);
console.log(`[earshot] wrote ${OUT} (${pcm.length} bytes, ${(totalSamples / SAMPLE_RATE).toFixed(1)}s)`);
