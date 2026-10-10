import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePalette, PALETTE_PATH } from '../src/formats/palette';
import { openDataDir } from '../src/io/nodeVfs';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

describe('palette', () => {
  it('reads 256 RGB entries and makes them opaque', () => {
    const raw = new Uint8Array(1024);
    raw.set([10, 20, 30, 0], 5 * 4);
    const pal = parsePalette(raw);
    expect(pal.color(5)).toEqual({ r: 10, g: 20, b: 30, a: 255 });
    expect(pal.hex(5)).toBe('#0a141e');
  });

  it('rejects a short file', () => {
    expect(() => parsePalette(new Uint8Array(100))).toThrow();
  });
});

describe.skipIf(!hasGameData())('palette (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
  });
  afterAll(() => close?.());

  it('loads PALETTE.PAL with black at 0 and white at 255', async () => {
    const pal = parsePalette(await vfs.read(PALETTE_PATH));
    expect(pal.hex(0)).toBe('#000000');
    expect(pal.hex(255)).toBe('#ffffff');
    // A real palette has many distinct colours.
    expect(new Set(Array.from({ length: 256 }, (_, i) => pal.hex(i))).size).toBeGreaterThan(200);
  });
});
