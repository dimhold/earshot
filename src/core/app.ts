/**
 * App — builds the concrete pipeline for a real session and runs it.
 *
 * This is where the abstract parts meet the machine: ffmpeg for capture, a
 * Python sidecar for transcription, a file on disk and a loopback HTTP server
 * for the live view.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { FfmpegAudioSource } from '../audio/ffmpegSource.js';
import { PcmFileSource } from '../audio/pcmFileSource.js';
import { resolveDevice } from '../audio/devices.js';
import type { AudioSource } from '../audio/audioSource.js';
import { Segmenter } from '../stt/segmenter.js';
import { WhisperRecognizer } from '../stt/whisperRecognizer.js';
import { Transcript, formatLine } from '../transcript/transcript.js';
import { TranscriptWriter } from '../transcript/writer.js';
import { LiveView } from '../view/server.js';
import { Pipeline } from './pipeline.js';
import { makeLogger, setQuiet } from './logger.js';
import type { Config } from './config.js';

const log = makeLogger('APP');

/** Raw PCM needs no decoding, so ffmpeg is skipped for those extensions. */
const RAW_PCM = /\.(pcm|raw)$/i;

export class App {
  private readonly config: Config;
  private pipeline: Pipeline | null = null;
  private recognizer: WhisperRecognizer | null = null;
  private writer: TranscriptWriter | null = null;
  private view: LiveView | null = null;
  private shuttingDown = false;

  constructor(config: Config) {
    this.config = config;
  }

  async run(): Promise<void> {
    const cfg = this.config;
    setQuiet(cfg.quiet);

    const source = await this.buildSource();
    const transcript = new Transcript();
    const segmenter = new Segmenter({ sampleRate: cfg.sampleRate, ...cfg.vad });

    const recognizer = new WhisperRecognizer({
      pythonPath: cfg.stt.pythonPath,
      serverScript: cfg.stt.serverScript,
      modelDir: cfg.stt.modelDir,
      model: cfg.stt.model,
      device: cfg.stt.device,
      computeType: cfg.stt.computeType,
      language: cfg.stt.language,
    });
    this.recognizer = recognizer;

    this.writer = new TranscriptWriter({
      textPath: cfg.output.textPath,
      jsonlPath: cfg.output.jsonlPath,
      header: `# earshot session ${transcript.sessionStart.toISOString()} — ${source.description}`,
    });

    if (cfg.view.enabled) {
      this.view = new LiveView(cfg.view.host, cfg.view.port);
      await this.view.start();
      this.view.setStatus({ message: 'loading model', source: source.description, live: false });
      if (cfg.view.open) openInBrowser(this.view.url);
    }

    await recognizer.start();
    log.info(`listening to ${source.description}`);
    log.info(`transcript: ${cfg.output.textPath}`);
    this.view?.setStatus({ message: 'listening', source: source.description, live: true });

    const pipeline = new Pipeline({ source, segmenter, recognizer, transcript });
    this.pipeline = pipeline;

    pipeline.on('line', (line) => {
      process.stdout.write(`${formatLine(line)}\n`);
      this.writer?.write(line);
      this.view?.append(line);
    });
    pipeline.on('utterance', () => {
      this.view?.setStatus({
        message: `transcribing (${pipeline.pending} in flight)`,
        source: source.description,
        live: true,
      });
    });
    pipeline.on('warning', (err: Error) => log.warn(`dropped an utterance: ${err.message}`));

    this.installSignalHandlers();

    await pipeline.run();
    log.info(`captured ${transcript.lines.length} lines.`);
    await this.shutdown(0);
  }

  private async buildSource(): Promise<AudioSource> {
    const cfg = this.config;

    if (cfg.source.kind === 'file') {
      const file = path.resolve(cfg.source.file!);
      if (RAW_PCM.test(file)) return new PcmFileSource(file, cfg.sampleRate);
      return new FfmpegAudioSource(cfg.ffmpegPath, {
        platform: process.platform,
        kind: 'file',
        file,
        sampleRate: cfg.sampleRate,
      });
    }

    const device = await resolveDevice({
      ffmpegPath: cfg.ffmpegPath,
      platform: process.platform,
      kind: cfg.source.kind,
      requested: cfg.source.device,
    });

    return new FfmpegAudioSource(cfg.ffmpegPath, {
      platform: process.platform,
      kind: cfg.source.kind,
      device,
      sampleRate: cfg.sampleRate,
    });
  }

  private installSignalHandlers(): void {
    const onSignal = () => {
      log.info('stopping, finishing the last utterance…');
      void this.shutdown(0);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  async shutdown(code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      await this.pipeline?.stop();
      await this.recognizer?.stop();
      await this.writer?.close();
      await this.view?.stop();
    } catch (err) {
      log.error(`error during shutdown: ${(err as Error).message}`);
    }
    log.info(`transcript saved to ${this.config.output.textPath}`);
    process.exit(code);
  }
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    log.warn(`could not open a browser. The live view is at ${url}`);
  }
}
