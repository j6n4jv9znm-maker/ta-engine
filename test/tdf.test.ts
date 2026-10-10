import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latin1 } from '../src/formats/hpi';
import { getBlock, getValue, parseTdf, parseTdfWithWarnings, TdfError } from '../src/formats/tdf';
import { openDataDir } from '../src/io/nodeVfs';
import { DATA_DIR, hasGameData } from '../src/testData';
import { loadUnitFbi } from '../src/units';
import type { Vfs } from '../src/vfs';

describe('TDF parser', () => {
  it('parses nested blocks with case-insensitive names', () => {
    const root = parseTdf(`
      [UNITINFO]
      {
        UnitName = ARMCOM ;
        Name=Commander;
        [Sub Block]
        {
          Key=Value with spaces;
        }
      }`);
    const info = getBlock(root, 'unitinfo')!;
    expect(getValue(info, 'UNITNAME')).toBe('ARMCOM');
    expect(getValue(info, 'name')).toBe('Commander');
    expect(getValue(getBlock(info, 'SUB BLOCK')!, 'key')).toBe('Value with spaces');
  });

  it('ignores line and block comments', () => {
    const root = parseTdf(`// header comment
      [A] /* inline */ {
        x=1; // trailing
        /* y=2; */
        z=3;
      }`);
    expect(root).toEqual({ a: { x: '1', z: '3' } });
  });

  it('handles CRLF, empty values, stray semicolons and repeated keys', () => {
    const root = parseTdf('[A]\r\n{\r\n  help=;\r\n  ;\r\n  x=1;\r\n  x=2;\r\n}\r\n');
    expect(root).toEqual({ a: { help: '', x: '2' } });
  });

  it('recovers from a missing semicolon and reports it', () => {
    const { root, warnings } = parseTdfWithWarnings('[A]\n{\n  active=1\n  next=2;\n}\n');
    expect(root).toEqual({ a: { active: '1', next: '2' } });
    expect(warnings).toEqual([{ line: 3, message: 'missing ";" after active' }]);
  });

  it('closes blocks left open at end of file', () => {
    const { root, warnings } = parseTdfWithWarnings('[A]\n{\n  x=1;\n  [B]\n  {\n    y=2;\n');
    expect(root).toEqual({ a: { x: '1', b: { y: '2' } } });
    expect(warnings.length).toBe(2);
  });

  it('keeps Latin-1 characters in values', () => {
    expect(parseTdf('[A]{d=Escorpión;}')).toEqual({ a: { d: 'Escorpión' } });
  });

  it('throws on a block with no body', () => {
    expect(() => parseTdf('[A] x=1;')).toThrow(TdfError);
  });
});

describe.skipIf(!hasGameData())('TDF parser (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
  });
  afterAll(() => close?.());

  it('reads the Arm Commander FBI', async () => {
    const unit = await loadUnitFbi(vfs, 'armcom');
    const info = getBlock(unit!.fbi, 'UNITINFO')!;
    expect(getValue(info, 'UnitName')).toBe('ARMCOM');
    expect(getValue(info, 'Side')).toBe('ARM');
    expect(Number(getValue(info, 'MaxDamage'))).toBeGreaterThan(0);
    expect(getValue(info, 'Builder')).toBe('1');
  });

  it('parses every TDF, FBI, OTA and GUI text file without errors', async () => {
    const files = vfs.list().filter((f) => /\.(tdf|fbi|ota|gui)$/i.test(f.path));
    expect(files.length).toBeGreaterThan(1000);
    let parsed = 0;
    for (const f of files) {
      const t = latin1(await vfs.read(f.path));
      // A few .gui files are binary rather than TDF, and some files are empty.
      if (t.slice(0, 64).includes('\0') || t.trim() === '') continue;
      const { root } = parseTdfWithWarnings(t);
      expect(Object.keys(root).length, f.path).toBeGreaterThan(0);
      parsed++;
    }
    expect(parsed).toBeGreaterThan(1000);
  });

  it('gives every unit a UNITINFO block with a UnitName', async () => {
    const fbis = vfs.listDir('units', '.fbi');
    expect(fbis.length).toBeGreaterThan(100);
    for (const f of fbis) {
      const info = getBlock(parseTdf(latin1(await vfs.read(f.path))), 'UNITINFO');
      expect(info && getValue(info, 'UnitName'), f.path).toBeTruthy();
    }
  });
});
