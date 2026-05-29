/**
 * FfmpegAudioSource — live capture through an ffmpeg subprocess.
 *
 * ffmpeg does the platform-specific work (DirectShow, AVFoundation,
 * PulseAudio), the resampling to 16 kHz and the conversion to mono Int16, and
 * writes the raw stream to stdout. This class reads that pipe, keeps samples
 * aligned and re-raises failures with the ffmpeg error text attached, because
 * "spawn failed" on its own tells you nothing about which device was wrong.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { SampleAligner, type AudioSource } from './audioSource.js';
import { buildCaptureArgs, type CaptureSpec } from './ffmpegArgs.js';
import { makeLogger } from '../core/logger.js';

const log = makeLogger('AUDIO');

/** How much of ffmpeg's stderr to keep for the error message. */
const STDERR_KEEP = 4000;

export class FfmpegAudioSource extends EventEmitter implements AudioSource {
  readonly sampleRate: number;
  readonly description: string;

  private readonly ffmpegPath: string;
  private readonly args: string[];
  private readonly aligner = new SampleAligner();
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stderrTail = '';
  private stopping = false;

  constructor(ffmpegPath: string, spec: CaptureSpec) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.sampleRate = spec.sampleRate;
    this.args = buildCaptureArgs(spec);
    this.description =
      spec.kind === 'file'
        ? `file ${spec.file}`
        : `${spec.kind === 'system' ? 'system audio' : 'microphone'}${spec.device ? ` (${spec.device})` : ''}`;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    log.info(`ffmpeg ${this.args.join(' ')}`);

    const proc = spawn(this.ffmpegPath, this.args, { windowsHide: true });
    this.proc = proc;

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        this.emit(
          'error',
          new Error(
            `ffmpeg not found at "${this.ffmpegPath}". Install it, or point at it with --ffmpeg.`,
          ),
        );
        return;
      }
      this.emit('error', err);
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      const aligned = this.aligner.push(chunk);
      if (aligned.length > 0) this.emit('data', aligned);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_KEEP);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) log.warn(`ffmpeg: ${line.trim()}`);
      }
    });

    proc.on('close', (code) => {
      this.proc = null;
      if (this.stopping || code === 0 || code === null) {
        this.emit('end');
        return;
      }
      this.emit(
        'error',
        new Error(`ffmpeg exited with code ${code}.${this.stderrTail ? `\n${this.stderrTail.trim()}` : ''}`),
      );
    });

    // ffmpeg fails fast on a bad device, so a short grace period turns a
    // confusing silent session into an error at start time.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 400);
      proc.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg could not start capture.\n${this.stderrTail.trim()}`));
      });
      proc.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.stopping = true;
    this.proc = null;
    if (!proc) return;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 1500);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
