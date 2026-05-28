/**
 * Tiny tagged console logger.
 *
 * Every subsystem logs under a fixed tag so a running session is easy to scan:
 *   [APP] [AUDIO] [STT] [TRANSCRIPT] [VIEW]
 *
 * Everything goes to stderr except transcript lines, which the app prints to
 * stdout. That split means `earshot > notes.txt` gives you the transcript and
 * nothing else.
 */

export type LogTag = 'APP' | 'AUDIO' | 'STT' | 'TRANSCRIPT' | 'VIEW';

let quiet = false;

/** Silence info/warn logging. Errors are always printed. */
export function setQuiet(value: boolean): void {
  quiet = value;
}

export function isQuiet(): boolean {
  return quiet;
}

function stamp(at = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}.${p(at.getMilliseconds(), 3)}`;
}

function emit(tag: LogTag, args: unknown[]): void {
  process.stderr.write(`${stamp()} [${tag}] ${args.map(render).join(' ')}\n`);
}

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  return String(value);
}

export function makeLogger(tag: LogTag) {
  return {
    info: (...args: unknown[]) => {
      if (!quiet) emit(tag, args);
    },
    warn: (...args: unknown[]) => {
      if (!quiet) emit(tag, args);
    },
    error: (...args: unknown[]) => emit(tag, args),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
