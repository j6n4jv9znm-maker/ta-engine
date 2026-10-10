import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Absolute path to the local, gitignored game data folder. */
export const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

/** True when data/ contains at least one original archive. Tests that need real files use this to skip. */
export function hasGameData(): boolean {
  if (!existsSync(DATA_DIR)) return false;
  return readdirSync(DATA_DIR).some((f) => /\.(hpi|ufo|ccx|gp3)$/i.test(f));
}

export function dataPath(name: string): string {
  return join(DATA_DIR, name);
}
