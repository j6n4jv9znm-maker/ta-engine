import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePcx } from '../src/formats/pcx';
import { openDataDir } from '../src/io/nodeVfs';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

/** A 2x1 8-bit PCX: one RLE run of colour 1 over both pixels, palette with colour 1 = (10, 20, 30). */
function tinyPcx(): Uint8Array {
  const header = new Uint8Array(128);
  const v = new DataView(header.buffer);
  header.set([0x0a, 5, 1, 8]);
  v.setUint16(8, 1, true); // xMax
  v.setUint16(10, 0, true); // yMax
  header[65] = 1;
  v.setUint16(66, 2, true);
  const pal = new Uint8Array(768);
  pal.set([10, 20, 30], 3);
  return new Uint8Array([...header, 0xc2, 1, 0x0c, ...pal]);
}

describe('pcx', () => {
  it('decodes run-length 8-bit images through the palette', () => {
    const img = parsePcx(tinyPcx());
    expect([img.width, img.height]).toEqual([2, 1]);
    expect([...img.rgba]).toEqual([10, 20, 30, 255, 10, 20, 30, 255]);
  });

  it('rejects other files', () => {
    expect(() => parsePcx(new Uint8Array(200))).toThrow();
  });
});

describe.skipIf(!hasGameData())('pcx (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
  });
  afterAll(() => close?.());

  it('decodes every unit picture', async () => {
    const files = vfs.listDir('unitpics', '.pcx');
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) {
      const img = parsePcx(await vfs.read(f.path));
      // TA's build pictures are square (96x96 in this data).
      expect(img.width).toBe(img.height);
      expect(img.width).toBeGreaterThanOrEqual(64);
      expect(img.rgba.length).toBe(img.width * img.height * 4);
    }
  });
});
