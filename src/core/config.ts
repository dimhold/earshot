/**
 * Configuration: command line flags on top of environment variables on top of
 * defaults.
 *
 * `parseArgs` is deliberately pure (it takes argv, env and the platform as
 * arguments and touches nothing else) so the whole surface can be tested
 * without a machine that has audio hardware on it.
 */

import path from 'node:path';
import { PROJECT_ROOT } from './paths.js';

export type SourceKind = 'mic' | 'system' | 'file';

export interface Config {
  /** Where the audio comes from. */
  source: {
    kind: SourceKind;
    /** Explicit capture device. Resolved at runtime when omitted. */
    device: string | null;
    /** Audio file to transcribe when `kind` is `file`. */
    file: string | null;
  };
  /** Whisper wants 16 kHz mono, and every stage downstream assumes it. */
  sampleRate: number;
  /** ffmpeg binary used for capture and decoding. */
  ffmpegPath: string;
  stt: {
    pythonPath: string;
    serverScript: string;
    /** Where the downloaded model weights are cached. */
    modelDir: string;
    /** faster-whisper model name, e.g. tiny.en, base.en, small.en, large-v3. */
    model: string;
    /** cpu or cuda. */
    device: string;
    /** int8 on CPU, float16 on GPU. */
    computeType: string;
    /** Two letter language code, or `auto` to let the model decide. */
    language: string;
  };
  /** Energy based voice activity detection that cuts the stream into utterances. */
  vad: {
    /** RMS on the Int16 scale (0..32767) above which a frame counts as speech. */
    speechThreshold: number;
    /** Trailing silence in ms that closes an utterance. */
    silenceHangoverMs: number;
    /** Audio retained before speech onset so the first word survives (ms). */
    preRollMs: number;
    /** Force a flush once an utterance reaches this length (ms). */
    maxUtteranceMs: number;
    /** Drop utterances shorter than this (ms). Usually clicks and door slams. */
    minUtteranceMs: number;
  };
  output: {
    /** Plain text transcript, one timestamped line per utterance. */
    textPath: string;
    /** Optional machine readable transcript. */
    jsonlPath: string | null;
  };
  view: {
    enabled: boolean;
    /** Always loopback. The live view is never exposed to the network. */
    host: string;
    port: number;
    /** Open the view in the default browser on start. */
    open: boolean;
  };
  quiet: boolean;
}

export type Command =
  | { command: 'run'; config: Config }
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'list-devices'; ffmpegPath: string };

export class ConfigError extends Error {}

export const DEFAULT_PORT = 8377;
export const SAMPLE_RATE = 16000;

interface ParseOptions {
  argv: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  root?: string;
  /** Injected so tests do not depend on whether a venv exists locally. */
  now?: Date;
}

const FLAGS_WITH_VALUES = new Set([
  '--source',
  '--device',
  '--file',
  '--out',
  '--port',
  '--model',
  '--model-dir',
  '--language',
  '--stt-device',
  '--compute-type',
  '--python',
  '--ffmpeg',
  '--threshold',
  '--silence',
  '--pre-roll',
  '--max-utterance',
  '--min-utterance',
]);

const BOOLEAN_FLAGS = new Set(['--no-view', '--open', '--quiet', '--help', '-h', '--version', '--list-devices']);

/** Flags that mean something on their own but accept a value too. */
const FLAGS_WITH_OPTIONAL_VALUES = new Set(['--jsonl']);

/** Turn argv into a flag map, rejecting anything unrecognised. */
function tokenize(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (!raw.startsWith('-')) {
      throw new ConfigError(`unexpected argument "${raw}". Every option is a flag; see --help.`);
    }
    // Accept both --flag value and --flag=value.
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? null : raw.slice(eq + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null) throw new ConfigError(`${name} does not take a value.`);
      out.set(name, true);
      continue;
    }
    const optional = FLAGS_WITH_OPTIONAL_VALUES.has(name);
    if (!optional && !FLAGS_WITH_VALUES.has(name)) {
      throw new ConfigError(`unknown option "${name}". Run --help for the list.`);
    }
    if (inlineValue !== null) {
      out.set(name, inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) {
      if (optional) {
        out.set(name, true);
        continue;
      }
      throw new ConfigError(`${name} needs a value.`);
    }
    out.set(name, next);
    i++;
  }
  return out;
}

function str(flags: Map<string, string | true>, name: string): string | null {
  const v = flags.get(name);
  if (v === undefined) return null;
  if (v === true) throw new ConfigError(`${name} needs a value.`);
  return v;
}

function num(flags: Map<string, string | true>, name: string, fallback: number): number {
  const raw = str(flags, name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} expects a number, got "${raw}".`);
  return n;
}

function envNum(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** `2026-08-16_14-31-07`, safe on every filesystem we care about. */
export function timestampSlug(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
    `_${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`
  );
}

/** Default Python interpreter: the project venv if the caller did not say otherwise. */
export function defaultPythonPath(root: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
}

export function parseArgs(opts: ParseOptions): Command {
  const { argv, env, platform } = opts;
  const root = opts.root ?? PROJECT_ROOT;
  const now = opts.now ?? new Date();
  const flags = tokenize(argv);

  if (flags.has('--help') || flags.has('-h')) return { command: 'help' };
  if (flags.has('--version')) return { command: 'version' };

  const ffmpegPath = str(flags, '--ffmpeg') ?? envStr(env, 'EARSHOT_FFMPEG', 'ffmpeg');
  if (flags.has('--list-devices')) return { command: 'list-devices', ffmpegPath };

  const kindRaw = str(flags, '--source') ?? envStr(env, 'EARSHOT_SOURCE', 'mic');
  if (kindRaw !== 'mic' && kindRaw !== 'system' && kindRaw !== 'file') {
    throw new ConfigError(`--source must be mic, system or file, got "${kindRaw}".`);
  }
  const kind: SourceKind = kindRaw;
  const file = str(flags, '--file');
  if (kind === 'file' && !file) throw new ConfigError('--source file also needs --file <path>.');
  if (kind !== 'file' && file) throw new ConfigError('--file only applies to --source file.');

  const textPath = str(flags, '--out') ?? path.join(root, 'transcripts', `${timestampSlug(now)}.txt`);
  const jsonlFlag = flags.get('--jsonl');
  const jsonlPath =
    jsonlFlag === undefined
      ? null
      : jsonlFlag === true
        ? textPath.replace(/\.txt$/i, '') + '.jsonl'
        : jsonlFlag;

  const port = num(flags, '--port', envNum(env, 'EARSHOT_PORT', DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`--port must be an integer between 0 and 65535, got "${port}".`);
  }

  const config: Config = {
    source: {
      kind,
      device: str(flags, '--device') ?? (envStr(env, 'EARSHOT_DEVICE', '') || null),
      file,
    },
    sampleRate: SAMPLE_RATE,
    ffmpegPath,
    stt: {
      pythonPath:
        str(flags, '--python') ??
        envStr(env, 'EARSHOT_PYTHON', defaultPythonPath(root, platform)),
      serverScript: path.join(root, 'python', 'stt_server.py'),
      modelDir: path.resolve(
        root,
        str(flags, '--model-dir') ?? envStr(env, 'EARSHOT_MODEL_DIR', 'models'),
      ),
      model: str(flags, '--model') ?? envStr(env, 'EARSHOT_MODEL', 'base.en'),
      device: str(flags, '--stt-device') ?? envStr(env, 'EARSHOT_STT_DEVICE', 'cpu'),
      computeType:
        str(flags, '--compute-type') ?? envStr(env, 'EARSHOT_COMPUTE_TYPE', 'int8'),
      language: str(flags, '--language') ?? envStr(env, 'EARSHOT_LANGUAGE', 'en'),
    },
    vad: {
      speechThreshold: num(flags, '--threshold', envNum(env, 'EARSHOT_VAD_THRESHOLD', 600)),
      silenceHangoverMs: num(flags, '--silence', 700),
      preRollMs: num(flags, '--pre-roll', 300),
      maxUtteranceMs: num(flags, '--max-utterance', 15000),
      minUtteranceMs: num(flags, '--min-utterance', 300),
    },
    output: { textPath: path.resolve(root, textPath), jsonlPath: jsonlPath && path.resolve(root, jsonlPath) },
    view: {
      enabled: !flags.has('--no-view'),
      host: '127.0.0.1',
      port,
      open: flags.has('--open'),
    },
    quiet: flags.has('--quiet'),
  };

  if (config.vad.minUtteranceMs > config.vad.maxUtteranceMs) {
    throw new ConfigError('--min-utterance cannot be larger than --max-utterance.');
  }

  return { command: 'run', config };
}

export const HELP = `
earshot — a live transcript of what your machine is hearing, produced locally.

Usage:
  earshot [options]

Source:
  --source mic|system|file   Where to listen. Default: mic
                             mic    the default recording device
                             system what is coming out of your speakers (loopback)
                             file   transcribe an existing recording
  --device <name>            Explicit capture device (see --list-devices)
  --file <path>              Audio file, with --source file
  --list-devices             Print the capture devices ffmpeg can see, then exit

Transcription:
  --model <name>             faster-whisper model. Default: base.en
                             tiny.en base.en small.en medium.en large-v3
  --language <code>          Language code, or auto. Default: en
  --stt-device cpu|cuda      Default: cpu
  --compute-type <type>      int8 on CPU, float16 on GPU. Default: int8
  --model-dir <path>         Where model weights are cached. Default: ./models
  --python <path>            Python interpreter. Default: ./.venv

Output:
  --out <path>               Transcript file. Default: ./transcripts/<timestamp>.txt
  --jsonl [path]             Also write one JSON object per line
  --no-view                  Do not start the live view
  --port <n>                 Live view port on 127.0.0.1. Default: ${DEFAULT_PORT}
  --open                     Open the live view in your browser
  --quiet                    Only print transcript lines and errors

Tuning:
  --threshold <rms>          Speech threshold, 0..32767. Default: 600
  --silence <ms>             Trailing silence that ends an utterance. Default: 700
  --pre-roll <ms>            Audio kept before onset. Default: 300
  --max-utterance <ms>       Force a flush at this length. Default: 15000
  --min-utterance <ms>       Discard shorter fragments. Default: 300

Other:
  --ffmpeg <path>            ffmpeg binary. Default: ffmpeg on PATH
  -h, --help                 This text
  --version                  Print the version

Nothing leaves the machine. There is no network call anywhere in the pipeline.
`.trimStart();
