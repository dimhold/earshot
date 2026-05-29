/**
 * Asking the operating system what it can record from.
 *
 * ffmpeg answers this on Windows and macOS. On Linux the answer comes from
 * PulseAudio via `pactl`, and a fallback is not needed because pulse resolves
 * `@DEFAULT_SOURCE@` and `@DEFAULT_MONITOR@` on its own.
 */

import { spawn } from 'node:child_process';
import {
  buildListArgs,
  chooseDevice,
  deviceAddress,
  parseAvfoundationDevices,
  parseDshowDevices,
  parsePactlSources,
  CaptureError,
  type DeviceEntry,
} from './ffmpegArgs.js';
import { makeLogger } from '../core/logger.js';

const log = makeLogger('AUDIO');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

export async function listDevices(
  ffmpegPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<DeviceEntry[]> {
  const args = buildListArgs(platform);
  if (args === null) {
    try {
      const { stdout } = await run('pactl', ['list', 'short', 'sources']);
      return parsePactlSources(stdout);
    } catch {
      log.warn('pactl not found, so devices cannot be listed. Pulse defaults still work.');
      return [];
    }
  }

  // `-list_devices` always exits non-zero because there is no real input; the
  // listing itself is on stderr.
  const { stderr } = await run(ffmpegPath, args);
  return platform === 'win32' ? parseDshowDevices(stderr) : parseAvfoundationDevices(stderr);
}

/**
 * Work out the ffmpeg device string for the requested source.
 *
 * Returns null on Linux, where the pulse defaults are better than anything we
 * could pick by name.
 */
export async function resolveDevice(opts: {
  ffmpegPath: string;
  platform: NodeJS.Platform;
  kind: 'mic' | 'system';
  requested: string | null;
}): Promise<string | null> {
  if (opts.requested) return opts.requested;
  if (opts.platform !== 'win32' && opts.platform !== 'darwin') return null;

  const devices = await listDevices(opts.ffmpegPath, opts.platform);
  const chosen = chooseDevice(devices, opts.kind);
  if (!chosen) {
    if (opts.kind === 'system') {
      throw new CaptureError(
        'no loopback device found. Capturing system audio needs a virtual output device: ' +
          'VB-CABLE or Stereo Mix on Windows, BlackHole on macOS. ' +
          'See docs/audio-capture.md, then pass it with --device.',
      );
    }
    throw new CaptureError(
      'no audio input device found. Run `earshot --list-devices` to see what ffmpeg can see.',
    );
  }
  log.info(`using device: ${chosen.name}`);
  return deviceAddress(opts.platform, chosen);
}

export function formatDeviceList(devices: DeviceEntry[]): string {
  if (devices.length === 0) return 'No capture devices found.';
  const lines = devices.map((d) => {
    const idx = d.index === undefined ? '' : `[${d.index}] `;
    const tag = d.loopback ? '  (loopback)' : '';
    return `  ${idx}${d.name}${tag}`;
  });
  return ['Capture devices:', ...lines].join('\n');
}
