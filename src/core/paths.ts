/**
 * Locating the project root.
 *
 * The Python sidecar, the model cache and the default transcript directory all
 * live relative to the repository root. Resolving that by walking up to the
 * nearest package.json keeps the paths correct whether the code runs from
 * `src/` under tsx or from `dist/` after `npm run build`.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
