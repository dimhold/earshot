import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, after } from 'node:test';
import {
  Transcript,
  formatClock,
  formatLine,
  isSilenceArtifact,
  normalizeForFilter,
} from '../src/transcript/transcript.js';
import { TranscriptWriter } from '../src/transcript/writer.js';

const START = new Date(2026, 7, 16, 14, 31, 7, 0);
const scratch = mkdtempSync(path.join(tmpdir(), 'earshot-test-'));

after(() => rmSync(scratch, { recursive: true, force: true }));

describe('formatting', () => {
  it('pads the clock', () => {
    assert.equal(formatClock(new Date(2026, 0, 2, 3, 4, 5)), '03:04:05');
  });

  it('renders a line the same way the file and the console do', () => {
    assert.equal(
      formatLine({ seq: 0, at: START, offsetMs: 0, text: 'we should ship it' }),
      '[14:31:07] we should ship it',
    );
  });
});

describe('silence artifact filter', () => {
  it('strips trailing punctuation before comparing', () => {
    assert.equal(normalizeForFilter('  Thank you.  '), 'thank you');
    assert.equal(normalizeForFilter('Bye!'), 'bye');
  });

  it('drops the stock phrases Whisper produces on near-silence', () => {
    assert.equal(isSilenceArtifact('Thank you.', 400), true);
    assert.equal(isSilenceArtifact('Thanks for watching!', 900), true);
  });

  it('keeps the same words when somebody actually said them', () => {
    assert.equal(isSilenceArtifact('Thank you.', 3000), false);
    assert.equal(isSilenceArtifact('thank you for the review', 400), false);
  });
});

describe('Transcript', () => {
  it('numbers lines and timestamps them from the session start', () => {
    const t = new Transcript(START);
    const first = t.append({ text: 'one', offsetMs: 0, voicedMs: 2000 });
    const second = t.append({ text: 'two', offsetMs: 65_000, voicedMs: 2000 });
    assert.equal(first?.seq, 0);
    assert.equal(second?.seq, 1);
    assert.equal(formatClock(second!.at), '14:32:12');
  });

  it('ignores empty and whitespace-only results', () => {
    const t = new Transcript(START);
    assert.equal(t.append({ text: '', offsetMs: 0, voicedMs: 2000 }), null);
    assert.equal(t.append({ text: '   \n', offsetMs: 0, voicedMs: 2000 }), null);
    assert.equal(t.lines.length, 0);
  });

  it('trims the text it stores', () => {
    const t = new Transcript(START);
    assert.equal(t.append({ text: '  hello there  ', offsetMs: 0, voicedMs: 2000 })?.text, 'hello there');
  });

  it('emits a line event for anything it keeps', () => {
    const t = new Transcript(START);
    const seen: string[] = [];
    t.on('line', (line) => seen.push(line.text));
    t.append({ text: 'kept', offsetMs: 0, voicedMs: 2000 });
    t.append({ text: 'Thank you.', offsetMs: 100, voicedMs: 200 });
    assert.deepEqual(seen, ['kept']);
  });

  it('renders the whole session as text', () => {
    const t = new Transcript(START);
    t.append({ text: 'one', offsetMs: 0, voicedMs: 2000 });
    t.append({ text: 'two', offsetMs: 1000, voicedMs: 2000 });
    assert.equal(t.toText(), '[14:31:07] one\n[14:31:08] two');
  });
});

describe('TranscriptWriter', () => {
  it('writes a header and one line per utterance', async () => {
    const textPath = path.join(scratch, 'session.txt');
    const writer = new TranscriptWriter({ textPath, header: '# earshot session' });
    writer.write({ seq: 0, at: START, offsetMs: 0, text: 'first' });
    writer.write({ seq: 1, at: START, offsetMs: 1000, text: 'second' });
    await writer.close();

    assert.equal(readFileSync(textPath, 'utf8'), '# earshot session\n[14:31:07] first\n[14:31:07] second\n');
  });

  it('writes jsonl alongside when asked', async () => {
    const textPath = path.join(scratch, 'json-session.txt');
    const jsonlPath = path.join(scratch, 'json-session.jsonl');
    const writer = new TranscriptWriter({ textPath, jsonlPath });
    writer.write({ seq: 0, at: START, offsetMs: 1234.7, text: 'hello' });
    await writer.close();

    const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim()) as Record<string, unknown>;
    assert.equal(record.seq, 0);
    assert.equal(record.text, 'hello');
    assert.equal(record.offsetMs, 1235);
    assert.equal(record.at, START.toISOString());
  });

  it('creates the directory it was pointed at', async () => {
    const textPath = path.join(scratch, 'deep', 'nested', 'out.txt');
    const writer = new TranscriptWriter({ textPath });
    writer.write({ seq: 0, at: START, offsetMs: 0, text: 'made it' });
    await writer.close();
    assert.match(readFileSync(textPath, 'utf8'), /made it/);
  });
});
