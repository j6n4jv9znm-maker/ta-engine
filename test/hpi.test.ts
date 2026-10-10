import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decompressLz77, HpiArchive, HpiError, latin1, transformKey } from '../src/formats/hpi';
import { MemorySource } from '../src/io/byteSource';
import { NodeFileSource } from '../src/io/nodeSource';
import { dataPath, hasGameData } from '../src/testData';
import { buildHpi, lz77LiteralsOnly } from './hpiBuilder';

const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('LZ77', () => {
  it('decodes literals', () => {
    expect(latin1(decompressLz77(lz77LiteralsOnly(text('hello world')), 11))).toBe('hello world');
  });

  it('decodes a back-reference into the window', () => {
    // Literals "abc" land at window positions 1..3. Then copy 6 bytes from window offset 1: "abcabc".
    const packed = (1 << 4) | (6 - 2);
    // Tag bits (low first): literal, literal, literal, match, end marker.
    const input = Uint8Array.from([0b11000, 97, 98, 99, packed & 0xff, packed >> 8, 0, 0]);
    expect(latin1(decompressLz77(input, 9))).toBe('abcabcabc');
  });

  it('rejects truncated input', () => {
    expect(() => decompressLz77(Uint8Array.from([0, 97]), 5)).toThrow(HpiError);
  });
});

describe('HPI reader (synthetic archives)', () => {
  const big = new Uint8Array(150_000).map((_, i) => (i * 7) & 0xff); // spans 3 chunks
  const archive = buildHpi([
    { path: 'readme.txt', data: text('stored plainly'), compression: 0 },
    { path: 'units/ARMCOM.FBI', data: text('[UNITINFO]{UnitName=ARMCOM;}'), compression: 1 },
    { path: 'units/deep/nested/file.bin', data: big, compression: 2, encryptChunks: true },
    { path: 'units/lz.bin', data: big, compression: 1, encryptChunks: true },
  ]);

  it('derives the XOR key like RWE', () => {
    expect(transformKey(0)).toBe(0);
    expect(transformKey(0x7d)).toBe(((0x7d << 2) | (0x7d >> 6)) & 0xff);
  });

  it('reads the directory tree', async () => {
    const hpi = await HpiArchive.open(new MemorySource('test.hpi', archive));
    expect(hpi.files().map((f) => f.path).sort()).toEqual(
      ['readme.txt', 'units/ARMCOM.FBI', 'units/deep/nested/file.bin', 'units/lz.bin'].sort(),
    );
    expect(hpi.find('UNITS/armcom.fbi')?.kind).toBe('file');
    expect(hpi.find('units/deep')?.kind).toBe('dir');
    expect(hpi.find('units/missing.fbi')).toBeUndefined();
  });

  it('extracts stored, LZ77 and zlib files, including multi-chunk and obfuscated chunks', async () => {
    const hpi = await HpiArchive.open(new MemorySource('test.hpi', archive));
    const get = async (p: string) => {
      const e = hpi.find(p);
      if (e?.kind !== 'file') throw new Error(p);
      return hpi.extract(e);
    };
    expect(latin1(await get('readme.txt'))).toBe('stored plainly');
    expect(latin1(await get('units/ARMCOM.FBI'))).toBe('[UNITINFO]{UnitName=ARMCOM;}');
    expect(await get('units/deep/nested/file.bin')).toEqual(big);
    expect(await get('units/lz.bin')).toEqual(big);
  });

  it('works with an unobfuscated archive (key 0)', async () => {
    const plain = buildHpi([{ path: 'a.txt', data: text('hi'), compression: 2 }], 0);
    const hpi = await HpiArchive.open(new MemorySource('plain.hpi', plain));
    const f = hpi.find('a.txt');
    expect(f?.kind === 'file' && latin1(await hpi.extract(f))).toBe('hi');
  });

  it('rejects files that are not HPI archives', async () => {
    await expect(HpiArchive.open(new MemorySource('x', new Uint8Array(64)))).rejects.toThrow(/not an HPI/);
  });

  it('detects a corrupted chunk via its checksum', async () => {
    const good = await HpiArchive.open(new MemorySource('test.hpi', archive));
    const entry = good.find('units/lz.bin');
    if (entry?.kind !== 'file') throw new Error('missing');
    // Flip a byte inside the first chunk's payload (after the 3-entry size table and 19-byte header).
    const bad = archive.slice();
    bad[entry.dataOffset + 3 * 4 + 19 + 100]! ^= 0xff;
    const hpi = await HpiArchive.open(new MemorySource('bad.hpi', bad));
    const f = hpi.find('units/lz.bin');
    if (f?.kind !== 'file') throw new Error('missing');
    await expect(hpi.extract(f)).rejects.toThrow(/checksum/);
  });
});

describe.skipIf(!hasGameData())('HPI reader (your game files)', () => {
  let src: NodeFileSource;
  let hpi: HpiArchive;
  beforeAll(async () => {
    src = await NodeFileSource.open(dataPath('totala1.hpi'));
    hpi = await HpiArchive.open(src);
  });
  afterAll(() => src?.close());

  it('lists totala1.hpi with the expected top-level folders', () => {
    const top = hpi.root.entries.map((e) => e.name.toLowerCase());
    for (const d of ['units', 'weapons', 'palettes', 'objects3d', 'scripts', 'anims']) expect(top).toContain(d);
    expect(hpi.files().length).toBeGreaterThan(1000);
  });

  it('extracts the Arm Commander FBI as readable text (LZ77)', async () => {
    const f = hpi.find('units/ARMCOM.FBI');
    if (f?.kind !== 'file') throw new Error('ARMCOM.FBI missing');
    expect(f.compression).toBe('lz77');
    const t = latin1(await hpi.extract(f));
    expect(t).toMatch(/\[UNITINFO\]/i);
    expect(t).toMatch(/UnitName=ARMCOM;/);
  });

  it('extracts every file in a zlib archive (rev31.gp3) with valid checksums', async () => {
    const s = await NodeFileSource.open(dataPath('rev31.gp3'));
    try {
      const gp3 = await HpiArchive.open(s);
      let bytes = 0;
      for (const f of gp3.files()) {
        const data = await gp3.extract(f);
        expect(data.length).toBe(f.size);
        bytes += data.length;
      }
      expect(bytes).toBeGreaterThan(1_000_000);
    } finally {
      await s.close();
    }
  });
});
