/**
 * Recognizer — turn one utterance of PCM into text.
 *
 * Keeping this to a single method makes the engine swappable (a whisper.cpp
 * binding or a Vosk sidecar would satisfy the same contract) and makes the
 * pipeline testable with a fake that returns canned lines.
 */

export interface Recognizer {
  /** Human readable engine name, shown once at startup. */
  readonly name: string;
  /** Utterances still waiting for a result. */
  readonly pending: number;
  start(): Promise<void>;
  /** Resolves with the transcribed text, or an empty string when nothing was said. */
  transcribe(pcm: Buffer): Promise<string>;
  stop(): Promise<void>;
}
