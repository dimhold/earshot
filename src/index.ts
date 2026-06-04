/**
 * earshot entry point.
 *
 *   earshot                        listen to the default microphone
 *   earshot --source system        listen to what the speakers are playing
 *   earshot --source file --file recording.m4a
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { App } from './core/app.js';
import { ConfigError, HELP, parseArgs } from './core/config.js';
import { PROJECT_ROOT } from './core/paths.js';
import { formatDeviceList, listDevices } from './audio/devices.js';
import { CaptureError } from './audio/ffmpegArgs.js';

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    argv: process.argv.slice(2),
    env: process.env,
    platform: process.platform,
  });

  switch (parsed.command) {
    case 'help':
      process.stdout.write(HELP);
      return;
    case 'version':
      process.stdout.write(`earshot ${version()}\n`);
      return;
    case 'list-devices': {
      const devices = await listDevices(parsed.ffmpegPath);
      process.stdout.write(`${formatDeviceList(devices)}\n`);
      return;
    }
    case 'run':
      await new App(parsed.config).run();
      return;
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof CaptureError) {
    process.stderr.write(`earshot: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`earshot: ${(err as Error).message}\n`);
  process.exit(1);
});
