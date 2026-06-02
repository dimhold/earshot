/**
 * Writing the transcript to disk as it happens.
 *
 * Lines are appended and flushed one at a time rather than buffered until exit,
 * because the interesting case for a tool like this is the session that ends
 * with a closed laptop lid rather than a clean Ctrl+C.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { formatLine, type TranscriptLine } from './transcript.js';

export interface TranscriptWriterOptions {
  textPath: string;
  jsonlPath?: string | null;
  /** Header written once at the top of the text file. */
  header?: string;
}

export class TranscriptWriter {
  private readonly text: WriteStream;
  private readonly jsonl: WriteStream | null;

  constructor(options: TranscriptWriterOptions) {
    mkdirSync(path.dirname(options.textPath), { recursive: true });
    this.text = createWriteStream(options.textPath, { flags: 'a', encoding: 'utf8' });
    if (options.header) this.text.write(`${options.header}\n`);

    if (options.jsonlPath) {
      mkdirSync(path.dirname(options.jsonlPath), { recursive: true });
      this.jsonl = createWriteStream(options.jsonlPath, { flags: 'a', encoding: 'utf8' });
    } else {
      this.jsonl = null;
    }
  }

  write(line: TranscriptLine): void {
    this.text.write(`${formatLine(line)}\n`);
    this.jsonl?.write(
      `${JSON.stringify({
        seq: line.seq,
        at: line.at.toISOString(),
        offsetMs: Math.round(line.offsetMs),
        text: line.text,
      })}\n`,
    );
  }

  async close(): Promise<void> {
    await Promise.all([closeStream(this.text), this.jsonl ? closeStream(this.jsonl) : null]);
  }
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}
