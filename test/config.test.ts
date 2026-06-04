import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ConfigError,
  DEFAULT_PORT,
  defaultPythonPath,
  parseArgs,
  timestampSlug,
  type Command,
} from '../src/core/config.js';

const ROOT = path.resolve('/tmp/earshot-root');
const NOW = new Date(2026, 7, 16, 14, 31, 7);

function parse(argv: string[], env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'linux'): Command {
  return parseArgs({ argv, env, platform, root: ROOT, now: NOW });
}

function run(argv: string[], env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'linux') {
  const parsed = parse(argv, env, platform);
  assert.equal(parsed.command, 'run');
  return (parsed as Extract<Command, { command: 'run' }>).config;
}

describe('timestampSlug', () => {
  it('is filesystem safe and sorts chronologically', () => {
    assert.equal(timestampSlug(NOW), '2026-08-16_14-31-07');
  });
});

describe('defaultPythonPath', () => {
  it('points at the venv layout for the platform', () => {
    assert.equal(defaultPythonPath('/r', 'win32'), path.join('/r', '.venv', 'Scripts', 'python.exe'));
    assert.equal(defaultPythonPath('/r', 'darwin'), path.join('/r', '.venv', 'bin', 'python'));
  });
});

describe('parseArgs', () => {
  it('defaults to the microphone with the live view on', () => {
    const cfg = run([]);
    assert.equal(cfg.source.kind, 'mic');
    assert.equal(cfg.source.device, null);
    assert.equal(cfg.view.enabled, true);
    assert.equal(cfg.view.host, '127.0.0.1');
    assert.equal(cfg.view.port, DEFAULT_PORT);
    assert.equal(cfg.stt.model, 'base.en');
    assert.equal(cfg.sampleRate, 16000);
  });

  it('names the transcript after the session start time', () => {
    const cfg = run([]);
    assert.equal(cfg.output.textPath, path.resolve(ROOT, 'transcripts', '2026-08-16_14-31-07.txt'));
    assert.equal(cfg.output.jsonlPath, null);
  });

  it('derives the jsonl path from the text path when the flag has no value', () => {
    const cfg = run(['--out', 'notes.txt', '--jsonl']);
    assert.equal(cfg.output.jsonlPath, path.resolve(ROOT, 'notes.jsonl'));
  });

  it('accepts an explicit jsonl path', () => {
    const cfg = run(['--jsonl', 'out/lines.jsonl']);
    assert.equal(cfg.output.jsonlPath, path.resolve(ROOT, 'out/lines.jsonl'));
  });

  it('reads --flag=value as well as --flag value', () => {
    assert.equal(run(['--model=small.en']).stt.model, 'small.en');
    assert.equal(run(['--model', 'small.en']).stt.model, 'small.en');
  });

  it('lets flags beat environment variables', () => {
    const env = { EARSHOT_MODEL: 'tiny.en', EARSHOT_PORT: '9000' };
    const cfg = run(['--model', 'medium.en'], env);
    assert.equal(cfg.stt.model, 'medium.en');
    assert.equal(cfg.view.port, 9000);
  });

  it('turns the live view off', () => {
    assert.equal(run(['--no-view']).view.enabled, false);
  });

  it('handles help, version and device listing before anything else', () => {
    assert.equal(parse(['--help']).command, 'help');
    assert.equal(parse(['-h', '--source', 'system']).command, 'help');
    assert.equal(parse(['--version']).command, 'version');
    const listed = parse(['--list-devices', '--ffmpeg', '/opt/ffmpeg']);
    assert.deepEqual(listed, { command: 'list-devices', ffmpegPath: '/opt/ffmpeg' });
  });

  it('requires a path for a file source', () => {
    assert.throws(() => parse(['--source', 'file']), ConfigError);
    assert.equal(run(['--source', 'file', '--file', 'a.wav']).source.file, 'a.wav');
  });

  it('rejects --file without a file source, so nobody records the wrong thing', () => {
    assert.throws(() => parse(['--file', 'a.wav']), ConfigError);
  });

  it('rejects an unknown source', () => {
    assert.throws(() => parse(['--source', 'speakers']), /must be mic, system or file/);
  });

  it('rejects unknown options and bare arguments', () => {
    assert.throws(() => parse(['--loud']), /unknown option/);
    assert.throws(() => parse(['recording.wav']), /unexpected argument/);
  });

  it('rejects a flag with a missing value', () => {
    assert.throws(() => parse(['--model']), /needs a value/);
    assert.throws(() => parse(['--model', '--quiet']), /needs a value/);
  });

  it('validates numbers', () => {
    assert.throws(() => parse(['--port', 'soon']), /expects a number/);
    assert.throws(() => parse(['--port', '70000']), /between 0 and 65535/);
    assert.throws(() => parse(['--min-utterance', '5000', '--max-utterance', '1000']), ConfigError);
  });

  it('resolves the sidecar and model paths against the project root', () => {
    const cfg = run([], {}, 'win32');
    assert.equal(cfg.stt.serverScript, path.join(ROOT, 'python', 'stt_server.py'));
    assert.equal(cfg.stt.modelDir, path.resolve(ROOT, 'models'));
    assert.equal(cfg.stt.pythonPath, path.join(ROOT, '.venv', 'Scripts', 'python.exe'));
  });
});
