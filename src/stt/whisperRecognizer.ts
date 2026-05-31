/**
 * WhisperRecognizer — faster-whisper running as a local Python sidecar.
 *
 * faster-whisper is a CTranslate2 reimplementation of Whisper that installs
 * from prebuilt CPU wheels, so nobody has to own a C++ toolchain to run this.
 * It is also fully offline once the weights are on disk.
 *
 * Node and Python talk over stdin and stdout with a length-prefixed binary
 * protocol (see python/stt_server.py). No port is opened, no file is written
 * between the two, and the pipe dies with the process.
 *
 * The sidecar processes frames strictly in order, so the sequence number is
 * enough to match a result back to the promise that is waiting for it.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { Recognizer } from './recognizer.js';
import { makeLogger } from '../core/logger.js';

const log = makeLogger('STT');

export interface WhisperOptions {
  pythonPath: string;
  serverScript: string;
  modelDir: string;
  model: string;
  device: string;
  computeType: string;
  language: string;
  /** How long to wait for the model to load. The first run also downloads it. */
  readyTimeoutMs?: number;
}

interface Waiter {
  resolve(text: string): void;
  reject(err: Error): void;
}

export class WhisperRecognizer implements Recognizer {
  readonly name: string;

  private readonly opts: WhisperOptions;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private nextSeq = 0;
  private readonly waiters = new Map<number, Waiter>();
  private stderrTail: string[] = [];

  constructor(opts: WhisperOptions) {
    this.opts = opts;
    this.name = `faster-whisper ${opts.model} (${opts.device}/${opts.computeType})`;
  }

  get pending(): number {
    return this.waiters.size;
  }

  async start(): Promise<void> {
    const { pythonPath, serverScript, model, device, computeType, language, modelDir } = this.opts;
    log.info(`starting sidecar: ${this.name}`);

    const args = [
      serverScript,
      '--model',
      model,
      '--device',
      device,
      '--compute-type',
      computeType,
      '--language',
      language,
    ];

    const proc = spawn(pythonPath, args, {
      windowsHide: true,
      env: {
        ...process.env,
        // Keep the weights inside the project instead of the user's home cache,
        // and make it obvious where the disk went.
        HF_HOME: modelDir,
        // Nothing here needs to phone home once the model is on disk.
        PYTHONUNBUFFERED: '1',
      },
    });
    this.proc = proc;

    proc.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ENOENT'
          ? `Python not found at "${pythonPath}". Create the venv (see the README) or pass --python.`
          : err.message;
      this.failAll(new Error(message));
    });

    proc.on('close', (code) => {
      this.proc = null;
      if (this.waiters.size > 0) {
        this.failAll(
          new Error(
            `transcription sidecar exited with code ${code}.\n${this.stderrTail.join('\n')}`,
          ),
        );
      }
    });

    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      if (!line.trim()) return;
      this.stderrTail = [...this.stderrTail, line].slice(-20);
      log.info(`py: ${line}`);
    });

    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onMessage(line));

    await this.waitUntilReady(this.opts.readyTimeoutMs ?? 300_000);
  }

  private onMessage(line: string): void {
    if (!line.trim()) return;
    let msg: { ready?: boolean; seq?: number; text?: string; error?: string };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      log.warn(`non-JSON from sidecar: ${line}`);
      return;
    }
    if (msg.ready) {
      this.ready = true;
      log.info('model loaded.');
      return;
    }
    if (typeof msg.seq !== 'number') return;
    const waiter = this.waiters.get(msg.seq);
    this.waiters.delete(msg.seq);
    if (!waiter) return;
    if (msg.error) waiter.reject(new Error(msg.error));
    else waiter.resolve((msg.text ?? '').trim());
  }

  private waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.ready) {
          clearInterval(timer);
          resolve();
        } else if (!this.proc) {
          clearInterval(timer);
          reject(new Error(`sidecar died before it was ready.\n${this.stderrTail.join('\n')}`));
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('sidecar did not become ready in time.'));
        }
      }, 200);
      timer.unref?.();
    });
  }

  transcribe(pcm: Buffer): Promise<string> {
    const proc = this.proc;
    if (!proc || !this.ready) return Promise.reject(new Error('recognizer is not running.'));
    const seq = this.nextSeq++;
    const promise = new Promise<string>((resolve, reject) => {
      this.waiters.set(seq, { resolve, reject });
    });
    const header = Buffer.alloc(4);
    header.writeUInt32LE(pcm.length, 0);
    proc.stdin.write(header);
    proc.stdin.write(pcm);
    return promise;
  }

  private failAll(err: Error): void {
    for (const waiter of this.waiters.values()) waiter.reject(err);
    this.waiters.clear();
    log.error(err.message);
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      /* pipe already gone */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 2000);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
