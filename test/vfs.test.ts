import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latin1 } from '../src/formats/hpi';
import { MemorySource } from '../src/io/byteSource';
import { openDataDir } from '../src/io/nodeVfs';
import { DATA_DIR, hasGameData } from '../src/testData';
import { archiveLoadOrder, Vfs } from '../src/vfs';
import { buildHpi } from './hpiBuilder';

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('archive load order', () => {
  it('orders by extension priority, then name', () => {
    expect(
      archiveLoadOrder(['rev31.gp3', 'totala2.hpi', 'ccdata.ccx', 'Example.ufo', 'totala1.hpi', 'readme.md', 'x.gpf']),
    ).toEqual(['totala1.hpi', 'totala2.hpi', 'Example.ufo', 'ccdata.ccx', 'x.gpf', 'rev31.gp3']);
  });
});

describe('VFS layering (synthetic archives)', () => {
  const base = buildHpi([
    { path: 'units/ARMCOM.FBI', data: text('base'), compression: 0 },
    { path: 'units/ONLYBASE.FBI', data: text('base only'), compression: 2 },
  ]);
  const patch = buildHpi([{ path: 'UNITS/armcom.fbi', data: text('patched'), compression: 1 }]);

  it('lets the higher-priority archive win, case-insensitively, regardless of argument order', async () => {
    const vfs = await Vfs.fromSources([new MemorySource('patch.gp3', patch), new MemorySource('base.hpi', base)]);
    expect(vfs.archives.map((a) => a.name)).toEqual(['base.hpi', 'patch.gp3']);
    expect(latin1(await vfs.read('units/ARMCOM.FBI'))).toBe('patched');
    expect(vfs.stat('Units\\ArmCom.fbi')?.overrides).toEqual(['base.hpi']);
    expect(latin1(await vfs.read('units/onlybase.fbi'))).toBe('base only');
    expect(vfs.listDir('units', '.fbi').length).toBe(2);
    await expect(vfs.read('units/nope.fbi')).rejects.toThrow(/not found/);
  });
});

describe.skipIf(!hasGameData())('VFS (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
  });
  afterAll(() => close?.());

  it('mounts the 3.1 patch last so it overrides the base game', () => {
    const names = vfs.archives.map((a) => a.name.toLowerCase());
    if (names.includes('rev31.gp3')) {
      expect(names[names.length - 1]).toBe('rev31.gp3');
      expect(vfs.stat('units/ARMCOM.FBI')?.archive.name.toLowerCase()).toBe('rev31.gp3');
    }
    expect(names.indexOf('totala1.hpi')).toBeLessThan(names.length - 1);
  });

  it('finds core game files', () => {
    for (const p of ['palettes/PALETTE.PAL', 'units/ARMCOM.FBI', 'units/CORCOM.FBI']) expect(vfs.exists(p), p).toBe(true);
  });
});
