import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SampleAligner } from '../src/audio/audioSource.js';
import {
  CaptureError,
  buildCaptureArgs,
  buildListArgs,
  chooseDevice,
  deviceAddress,
  looksLikeLoopback,
  parseAvfoundationDevices,
  parseDshowDevices,
  parsePactlSources,
  PULSE_DEFAULT_MIC,
  PULSE_DEFAULT_MONITOR,
} from '../src/audio/ffmpegArgs.js';
import { stripWavHeader } from '../src/audio/pcmFileSource.js';

const SAMPLE_RATE = 16000;

describe('SampleAligner', () => {
  it('passes even-length chunks straight through', () => {
    const aligner = new SampleAligner();
    const chunk = Buffer.from([1, 2, 3, 4]);
    assert.deepEqual(aligner.push(chunk), chunk);
    assert.equal(aligner.pending, 0);
  });

  it('holds back a split sample and reunites it with the next chunk', () => {
    const aligner = new SampleAligner();
    const first = aligner.push(Buffer.from([1, 2, 3]));
    assert.deepEqual(first, Buffer.from([1, 2]));
    assert.equal(aligner.pending, 1);

    const second = aligner.push(Buffer.from([4, 5]));
    assert.deepEqual(second, Buffer.from([3, 4]));
    assert.equal(aligner.pending, 1);
  });

  it('never loses a byte across a stream of odd chunks', () => {
    const aligner = new SampleAligner();
    const source = Buffer.from(Array.from({ length: 101 }, (_, i) => i % 256));
    const out: Buffer[] = [];
    for (let i = 0; i < source.length; i += 3) {
      out.push(aligner.push(source.subarray(i, Math.min(i + 3, source.length))));
    }
    const joined = Buffer.concat(out);
    assert.equal(joined.length % 2, 0);
    assert.deepEqual(joined, source.subarray(0, joined.length));
  });
});

describe('buildCaptureArgs', () => {
  const base = { sampleRate: SAMPLE_RATE } as const;

  it('always ends with 16 kHz mono signed 16-bit on stdout', () => {
    const args = buildCaptureArgs({ ...base, platform: 'linux', kind: 'mic' });
    assert.deepEqual(args.slice(-7), ['-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
  });

  it('uses DirectShow on Windows and quotes the device into the input string', () => {
    const args = buildCaptureArgs({
      ...base,
      platform: 'win32',
      kind: 'mic',
      device: 'Microphone (Realtek Audio)',
    });
    assert.ok(args.includes('dshow'));
    assert.ok(args.includes('audio=Microphone (Realtek Audio)'));
    assert.ok(args.includes('-audio_buffer_size'));
  });

  it('uses AVFoundation on macOS with an audio-only input', () => {
    const args = buildCaptureArgs({ ...base, platform: 'darwin', kind: 'system', device: '2' });
    assert.ok(args.includes('avfoundation'));
    assert.ok(args.includes(':2'));
  });

  it('uses the PulseAudio monitor for system audio on Linux', () => {
    const args = buildCaptureArgs({ ...base, platform: 'linux', kind: 'system' });
    assert.ok(args.includes('pulse'));
    assert.ok(args.includes(PULSE_DEFAULT_MONITOR));
  });

  it('uses the PulseAudio default source for the microphone on Linux', () => {
    const args = buildCaptureArgs({ ...base, platform: 'linux', kind: 'mic' });
    assert.ok(args.includes(PULSE_DEFAULT_MIC));
  });

  it('refuses to guess a device on Windows and macOS', () => {
    assert.throws(
      () => buildCaptureArgs({ ...base, platform: 'win32', kind: 'system' }),
      CaptureError,
    );
    assert.throws(
      () => buildCaptureArgs({ ...base, platform: 'darwin', kind: 'mic' }),
      /--list-devices/,
    );
  });

  it('decodes a file on any platform', () => {
    const args = buildCaptureArgs({ ...base, platform: 'win32', kind: 'file', file: 'talk.m4a' });
    assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2), ['-i', 'talk.m4a']);
    assert.ok(!args.includes('dshow'));
  });

  it('needs a path for a file source', () => {
    assert.throws(() => buildCaptureArgs({ ...base, platform: 'linux', kind: 'file' }), CaptureError);
  });
});

describe('buildListArgs', () => {
  it('asks ffmpeg on Windows and macOS, and nobody on Linux', () => {
    assert.ok(buildListArgs('win32')?.includes('dshow'));
    assert.ok(buildListArgs('darwin')?.includes('avfoundation'));
    assert.equal(buildListArgs('linux'), null);
  });
});

describe('device listings', () => {
  it('parses DirectShow output and skips video and alternative names', () => {
    const stderr = [
      '[dshow @ 0000] "Integrated Camera" (video)',
      '[dshow @ 0000]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2"',
      '[dshow @ 0000] "Microphone (Realtek(R) Audio)" (audio)',
      '[dshow @ 0000]   Alternative name "@device_cm_{33D9A762}"',
      '[dshow @ 0000] "CABLE Output (VB-Audio Virtual Cable)" (audio)',
    ].join('\n');

    const devices = parseDshowDevices(stderr);
    assert.deepEqual(
      devices.map((d) => d.name),
      ['Microphone (Realtek(R) Audio)', 'CABLE Output (VB-Audio Virtual Cable)'],
    );
    assert.equal(devices[0]!.loopback, false);
    assert.equal(devices[1]!.loopback, true);
  });

  it('parses the older DirectShow output that uses section headers', () => {
    const stderr = [
      '[dshow @ 0000] DirectShow video devices',
      '[dshow @ 0000]  "Integrated Camera"',
      '[dshow @ 0000] DirectShow audio devices',
      '[dshow @ 0000]  "Stereo Mix (Realtek Audio)"',
    ].join('\n');
    const devices = parseDshowDevices(stderr);
    assert.equal(devices.length, 1);
    assert.equal(devices[0]!.loopback, true);
  });

  it('parses AVFoundation output with indices', () => {
    const stderr = [
      '[AVFoundation indev @ 0x7f] AVFoundation video devices:',
      '[AVFoundation indev @ 0x7f] [0] FaceTime HD Camera',
      '[AVFoundation indev @ 0x7f] AVFoundation audio devices:',
      '[AVFoundation indev @ 0x7f] [0] MacBook Pro Microphone',
      '[AVFoundation indev @ 0x7f] [1] BlackHole 2ch',
    ].join('\n');

    const devices = parseAvfoundationDevices(stderr);
    assert.equal(devices.length, 2);
    assert.deepEqual(devices[1], { name: 'BlackHole 2ch', index: 1, loopback: true });
  });

  it('parses pactl short sources and marks monitors as loopback', () => {
    const stdout = [
      '0\talsa_output.pci-0000_00_1f.3.analog-stereo.monitor\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED',
      '1\talsa_input.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts16le 2ch 48000Hz\tSUSPENDED',
    ].join('\n');
    const devices = parsePactlSources(stdout);
    assert.equal(devices.length, 2);
    assert.equal(devices[0]!.loopback, true);
    assert.equal(devices[1]!.loopback, false);
  });
});

describe('chooseDevice', () => {
  const devices = [
    { name: 'Microphone (Realtek)', loopback: false },
    { name: 'CABLE Output', loopback: true },
  ];

  it('picks a real input for the microphone', () => {
    assert.equal(chooseDevice(devices, 'mic')?.name, 'Microphone (Realtek)');
  });

  it('picks a loopback device for system audio', () => {
    assert.equal(chooseDevice(devices, 'system')?.name, 'CABLE Output');
  });

  it('returns null rather than recording the wrong thing', () => {
    assert.equal(chooseDevice([devices[0]!], 'system'), null);
  });

  it('addresses macOS devices by index and everything else by name', () => {
    assert.equal(deviceAddress('darwin', { name: 'BlackHole 2ch', index: 1, loopback: true }), '1');
    assert.equal(deviceAddress('win32', { name: 'CABLE Output', loopback: true }), 'CABLE Output');
  });
});

describe('looksLikeLoopback', () => {
  it('recognises the usual virtual devices', () => {
    for (const name of [
      'Stereo Mix (Realtek)',
      'CABLE Output (VB-Audio Virtual Cable)',
      'BlackHole 2ch',
      'Soundflower (2ch)',
      'Monitor of Built-in Audio',
    ]) {
      assert.equal(looksLikeLoopback(name), true, name);
    }
  });

  it('leaves ordinary microphones alone', () => {
    assert.equal(looksLikeLoopback('Microphone (Realtek(R) Audio)'), false);
    assert.equal(looksLikeLoopback('MacBook Pro Microphone'), false);
  });
});

describe('stripWavHeader', () => {
  it('leaves raw PCM untouched', () => {
    const raw = Buffer.from([1, 2, 3, 4]);
    assert.deepEqual(stripWavHeader(raw), raw);
  });

  it('finds the data chunk past fmt and LIST chunks', () => {
    const payload = Buffer.from([9, 9, 8, 8]);
    const fmt = Buffer.alloc(16);
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      uint32(4 + 8 + fmt.length + 8 + payload.length),
      Buffer.from('WAVE'),
      Buffer.from('fmt '),
      uint32(fmt.length),
      fmt,
      Buffer.from('data'),
      uint32(payload.length),
      payload,
    ]);
    assert.deepEqual(stripWavHeader(wav), payload);
  });
});

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}
