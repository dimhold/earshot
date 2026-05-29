/**
 * Building ffmpeg command lines, and reading its device listings back.
 *
 * Capture is the part of this project that is genuinely different on every
 * operating system, so all of that difference is concentrated here as pure
 * functions over `{platform, kind, device}`. `docs/audio-capture.md` explains
 * what each platform can and cannot do.
 */

export type SourceKind = 'mic' | 'system' | 'file';

export interface CaptureSpec {
  platform: NodeJS.Platform;
  kind: SourceKind;
  /** Resolved device identifier. Required on win32 and darwin for live capture. */
  device?: string | null;
  /** Path to the recording, when kind is `file`. */
  file?: string | null;
  sampleRate: number;
}

export class CaptureError extends Error {}

/**
 * PulseAudio (and pipewire-pulse) resolve these at connect time, which is why
 * Linux needs no device discovery for the common case.
 */
export const PULSE_DEFAULT_MIC = '@DEFAULT_SOURCE@';
export const PULSE_DEFAULT_MONITOR = '@DEFAULT_MONITOR@';

/** Device names that indicate a loopback or virtual output device. */
const LOOPBACK_HINTS =
  /stereo\s*mix|what\s*u\s*hear|vb-?audio|cable\s*output|virtual\s*(audio|cable)|blackhole|soundflower|loopback|monitor of/i;

export function looksLikeLoopback(name: string): boolean {
  return LOOPBACK_HINTS.test(name);
}

export function buildCaptureArgs(spec: CaptureSpec): string[] {
  const head = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  const tail = ['-ac', '1', '-ar', String(spec.sampleRate), '-f', 's16le', '-'];
  return [...head, ...buildInputArgs(spec), ...tail];
}

function buildInputArgs(spec: CaptureSpec): string[] {
  if (spec.kind === 'file') {
    if (!spec.file) throw new CaptureError('a file source needs a file path.');
    return ['-i', spec.file];
  }

  switch (spec.platform) {
    case 'win32': {
      const device = requireDevice(spec, 'Windows');
      // DirectShow buffers generously by default, which shows up as latency in
      // the transcript. 50 ms is small enough to feel live and large enough to
      // survive a busy machine.
      return ['-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${device}`];
    }
    case 'darwin': {
      const device = requireDevice(spec, 'macOS');
      // avfoundation input is "video:audio"; an empty video half means audio only.
      return ['-f', 'avfoundation', '-i', `:${device}`];
    }
    default: {
      const device =
        spec.device || (spec.kind === 'system' ? PULSE_DEFAULT_MONITOR : PULSE_DEFAULT_MIC);
      return ['-f', 'pulse', '-i', device];
    }
  }
}

function requireDevice(spec: CaptureSpec, platformName: string): string {
  if (spec.device) return spec.device;
  throw new CaptureError(
    `no capture device resolved for --source ${spec.kind} on ${platformName}. ` +
      'Run `earshot --list-devices` and pass one with --device.',
  );
}

/** ffmpeg arguments that make it print the devices it can see. */
export function buildListArgs(platform: NodeJS.Platform): string[] | null {
  switch (platform) {
    case 'win32':
      return ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
    case 'darwin':
      return ['-hide_banner', '-list_devices', 'true', '-f', 'avfoundation', '-i', ''];
    default:
      // PulseAudio is enumerated with pactl, not ffmpeg.
      return null;
  }
}

export interface DeviceEntry {
  name: string;
  /** avfoundation addresses devices by index; dshow and pulse by name. */
  index?: number;
  loopback: boolean;
}

/**
 * Parse `ffmpeg -list_devices true -f dshow -i dummy` output.
 *
 * ffmpeg prints one line per device, quoted, with a trailing "(audio)" or
 * "(video)" marker on recent builds. Older builds print a separate
 * "DirectShow audio devices" header instead, so both forms are handled.
 */
export function parseDshowDevices(stderr: string): DeviceEntry[] {
  const out: DeviceEntry[] = [];
  let inAudioSection = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/DirectShow\s+video\s+devices/i.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (/DirectShow\s+audio\s+devices/i.test(line)) {
      inAudioSection = true;
      continue;
    }
    const match = line.match(/"([^"]+)"/);
    if (!match) continue;
    const name = match[1]!;
    // Skip the alternative-name lines ffmpeg prints under each device.
    if (/Alternative name/i.test(line)) continue;
    const tagged = /\(audio\)/i.test(line);
    const isVideo = /\(video\)/i.test(line);
    if (isVideo) continue;
    if (!tagged && !inAudioSection) continue;
    out.push({ name, loopback: looksLikeLoopback(name) });
  }
  return out;
}

/**
 * Parse `ffmpeg -list_devices true -f avfoundation -i ""` output. Devices are
 * listed as `[AVFoundation indev @ 0x...] [0] Built-in Microphone`, split into
 * a video section and an audio section.
 */
export function parseAvfoundationDevices(stderr: string): DeviceEntry[] {
  const out: DeviceEntry[] = [];
  let inAudioSection = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation\s+video\s+devices/i.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (/AVFoundation\s+audio\s+devices/i.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (!inAudioSection) continue;
    const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (!match) continue;
    const index = Number(match[1]);
    const name = match[2]!;
    out.push({ name, index, loopback: looksLikeLoopback(name) });
  }
  return out;
}

/** Parse `pactl list short sources`: tab separated, index, name, driver, ... */
export function parsePactlSources(stdout: string): DeviceEntry[] {
  const out: DeviceEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const index = Number(parts[0]);
    const name = parts[1]!.trim();
    if (!name) continue;
    out.push({
      name,
      index: Number.isFinite(index) ? index : undefined,
      loopback: name.endsWith('.monitor'),
    });
  }
  return out;
}

/**
 * Pick a device for the requested source kind.
 *
 * For `system` we want a loopback device and there is no sane fallback: a
 * microphone silently standing in for system audio would be a bug you only
 * notice by reading a transcript of the wrong thing.
 */
export function chooseDevice(devices: DeviceEntry[], kind: 'mic' | 'system'): DeviceEntry | null {
  if (kind === 'system') return devices.find((d) => d.loopback) ?? null;
  return devices.find((d) => !d.loopback) ?? devices[0] ?? null;
}

/** The identifier the ffmpeg input string needs for this platform. */
export function deviceAddress(platform: NodeJS.Platform, device: DeviceEntry): string {
  if (platform === 'darwin' && device.index !== undefined) return String(device.index);
  return device.name;
}
