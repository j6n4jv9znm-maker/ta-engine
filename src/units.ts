import { latin1 } from './formats/hpi';
import { getBlock, getValue, parseTdf, type TdfBlock } from './formats/tdf';
import type { Vfs } from './vfs';

/** Unit definition files live in units/ as one .fbi per unit. */
export function listUnitFiles(vfs: Vfs): string[] {
  return vfs.listDir('units', '.fbi').map((f) => f.path);
}

/**
 * Finds and parses a unit's FBI by name (e.g. "ARMCOM"). Tries units/<name>.fbi first, then any FBI
 * whose UnitName matches. Returns undefined when no unit matches.
 */
export async function loadUnitFbi(vfs: Vfs, unitName: string): Promise<{ path: string; fbi: TdfBlock } | undefined> {
  const direct = `units/${unitName}.fbi`;
  if (vfs.exists(direct)) {
    return { path: vfs.stat(direct)!.path, fbi: parseTdf(latin1(await vfs.read(direct))) };
  }
  const wanted = unitName.toLowerCase();
  for (const path of listUnitFiles(vfs)) {
    const fbi = parseTdf(latin1(await vfs.read(path)));
    const info = getBlock(fbi, 'UNITINFO');
    if (info && getValue(info, 'UnitName')?.toLowerCase() === wanted) return { path, fbi };
  }
  return undefined;
}
