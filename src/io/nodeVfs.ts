import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isArchiveName, Vfs } from '../vfs';
import { NodeFileSource } from './nodeSource';

/** Opens every archive in a folder (Node only) and layers them in TA's load order. */
export async function openDataDir(dir: string): Promise<{ vfs: Vfs; close: () => Promise<void> }> {
  const names = readdirSync(dir).filter(isArchiveName);
  if (names.length === 0) throw new Error(`No TA archives (*.hpi, *.ufo, *.ccx, *.gpf, *.gp3) found in ${dir}`);
  const sources = await Promise.all(names.map((n) => NodeFileSource.open(join(dir, n))));
  try {
    const vfs = await Vfs.fromSources(sources);
    return { vfs, close: async () => void (await Promise.all(sources.map((s) => s.close()))) };
  } catch (e) {
    await Promise.all(sources.map((s) => s.close()));
    throw e;
  }
}
