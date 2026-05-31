/**
 * Fetch the speech model ahead of time, so the first real session does not
 * stall for a few minutes while the weights come down.
 *
 *   npm run download-model                    # the default, base.en
 *   EARSHOT_MODEL=small.en npm run download-model
 *
 * This is the only step in the whole project that touches the network, and it
 * happens once.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venvPython =
  process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');

const python = process.env.EARSHOT_PYTHON || venvPython;
const model = process.env.EARSHOT_MODEL || 'base.en';
const modelDir = path.resolve(root, process.env.EARSHOT_MODEL_DIR || 'models');

console.log(`[earshot] downloading faster-whisper model "${model}" into ${modelDir}`);

const code = [
  'from faster_whisper import WhisperModel',
  `WhisperModel(${JSON.stringify(model)}, device="cpu", compute_type="int8")`,
  'print("[earshot] model ready.")',
].join('; ');

const child = spawn(python, ['-c', code], {
  stdio: 'inherit',
  env: { ...process.env, HF_HOME: modelDir },
});

child.on('exit', (exitCode) => process.exit(exitCode ?? 0));
child.on('error', (err) => {
  console.error(`[earshot] could not run Python at ${python}: ${err.message}`);
  console.error('[earshot] create the virtualenv first. See the README, "Setup".');
  process.exit(1);
});
