/**
 * Transcript — the assembled result, and the one place that decides what counts
 * as a line worth keeping.
 *
 * Whisper returns text for every clip it is given, including clips that were
 * only room tone. On near-silence it reliably produces a handful of stock
 * phrases picked up from its training data ("Thank you.", "Thanks for
 * watching!"), so a short clip whose entire text is one of those is dropped.
 * The filter is exact-match and only applies to clips with very little voiced
 * audio, so a real "thank you" in the middle of a sentence survives.
 */

import { EventEmitter } from 'node:events';

export interface TranscriptLine {
  /** 0-based line number in this session. */
  seq: number;
  /** Wall clock time the utterance started. */
  at: Date;
  /** Offset from the start of the session, in milliseconds. */
  offsetMs: number;
  text: string;
}

export interface AppendInput {
  text: string;
  offsetMs: number;
  /** Voiced milliseconds in the clip, used by the near-silence filter. */
  voicedMs: number;
}

/**
 * Exact texts Whisper emits when handed something that is not speech. Lowercase
 * and stripped of trailing punctuation before comparison.
 */
export const SILENCE_ARTIFACTS = new Set([
  'thank you',
  'thanks for watching',
  'thanks for watching!',
  'you',
  'bye',
  'okay',
  '.',
  '。',
  'μ',
]);

/** Clips with less voiced audio than this are checked against the artifact list. */
export const ARTIFACT_MAX_VOICED_MS = 1200;

export function normalizeForFilter(text: string): string {
  return text.trim().toLowerCase().replace(/[.,!?…]+$/u, '').trim();
}

export function isSilenceArtifact(text: string, voicedMs: number): boolean {
  if (voicedMs > ARTIFACT_MAX_VOICED_MS) return false;
  return SILENCE_ARTIFACTS.has(normalizeForFilter(text));
}

/** `14:31:07`, the format used in the file, the console and the live view. */
export function formatClock(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
}

export function formatLine(line: TranscriptLine): string {
  return `[${formatClock(line.at)}] ${line.text}`;
}

export class Transcript extends EventEmitter {
  private readonly startedAt: Date;
  private readonly items: TranscriptLine[] = [];

  constructor(startedAt: Date = new Date()) {
    super();
    this.startedAt = startedAt;
  }

  get lines(): readonly TranscriptLine[] {
    return this.items;
  }

  get sessionStart(): Date {
    return this.startedAt;
  }

  /**
   * Add a transcribed utterance. Returns the stored line, or null when the text
   * was empty or looked like a silence artifact.
   */
  append(input: AppendInput): TranscriptLine | null {
    const text = input.text.trim();
    if (!text) return null;
    if (isSilenceArtifact(text, input.voicedMs)) return null;

    const line: TranscriptLine = {
      seq: this.items.length,
      at: new Date(this.startedAt.getTime() + input.offsetMs),
      offsetMs: input.offsetMs,
      text,
    };
    this.items.push(line);
    this.emit('line', line);
    return line;
  }

  toText(): string {
    return this.items.map(formatLine).join('\n');
  }
}
