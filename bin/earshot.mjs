#!/usr/bin/env node
/**
 * Installed entry point. Runs the compiled build, and says what to do when
 * there is not one yet.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const compiled = path.join(here, '..', 'dist', 'index.js');

if (!existsSync(compiled)) {
  process.stderr.write(
    'earshot has not been built yet. Run `npm run build`, or use `npm start -- <options>` during development.\n',
  );
  process.exit(1);
}

await import(pathToFileURL(compiled).href);
