import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeRow, frameToRgba, parseGaf } from '../src/formats/gaf';
import { parsePalette, PALETTE_PATH, type Palette } from '../src/formats/palette';
import { loadTextureLibrary, LOGOS_PATH, TEAM_COLOR_COUNT } from '../src/graphics/textures';
import { openDataDir } from '../src/io/nodeVfs';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

/** A greyscale test palette: index i is (i, i, i). */
function greyPalette(): Palette {
  const raw = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) raw.set([i, i, i, 0], i * 4);
  return parsePalette(raw);
}

/** Builds a GAF with one entry. Frames are either raw pixels or a list of raw-pixel layers. */
function buildGaf(name: string, frames: { w: number; h: number; x: number; y: number; t: number; layers: { w: number; h: number; x: number; y: number; px: number[]; rle?: number[][] }[] }[]): Uint8Array {
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const set32 = (at: number, v: number) => out.splice(at, 4, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);

  u32(0x00010100);
  u32(1);
  u32(0);
  u32(16); // entry offset
  u16(frames.length);
  u16(1);
  u32(0);
  for (let i = 0; i < 32; i++) u8(i < name.length ? name.charCodeAt(i) : 0);
  const frameTable = out.length;
  for (let i = 0; i < frames.length; i++) {
    u32(0);
    u32(0);
  }

  const header = (w: number, h: number, x: number, y: number, t: number, compressed: number, subs: number) => {
    const at = out.length;
    u16(w);
    u16(h);
    u16(x & 0xffff);
    u16(y & 0xffff);
    u8(t);
    u8(compressed);
    u16(subs);
    u32(0);
    u32(0); // data offset, patched
    u32(0);
    return at;
  };
  const pixels = (at: number, l: { px: number[]; rle?: number[][] }) => {
    set32(at + 16, out.length);
    if (l.rle) for (const row of l.rle) (u16(row.length), out.push(...row));
    else out.push(...l.px);
  };

  frames.forEach((f, fi) => {
    if (f.layers.length === 1 && f.layers[0]!.x === f.x && f.layers[0]!.y === f.y && f.layers[0]!.w === f.w) {
      const l = f.layers[0]!;
      const at = header(f.w, f.h, f.x, f.y, f.t, l.rle ? 1 : 0, 0);
      set32(frameTable + fi * 8, at);
      pixels(at, l);
    } else {
      const at = header(f.w, f.h, f.x, f.y, f.t, 0, f.layers.length);
      set32(frameTable + fi * 8, at);
      const table = out.length;
      set32(at + 16, table);
      for (let i = 0; i < f.layers.length; i++) u32(0);
      f.layers.forEach((l, li) => {
        const sub = header(l.w, l.h, l.x, l.y, f.t, l.rle ? 1 : 0, 0);
        set32(table + li * 4, sub);
        pixels(sub, l);
      });
    }
  });
  return Uint8Array.from(out);
}

describe('GAF decoder', () => {
  const pal = greyPalette();

  it('decodes the three run types in a compressed row', () => {
    const out = new Uint8Array(8).fill(9);
    // skip 2 (mask 0b101), repeat 7 three times (mask (2<<2)|2), copy [1,2] (mask (1<<2)), then end
    decodeRow(Uint8Array.from([0b101, (2 << 2) | 2, 7, 1 << 2, 1, 2]), out, 9);
    expect([...out]).toEqual([9, 9, 7, 7, 7, 1, 2, 9]);
  });

  it('reads a raw frame and maps the transparency index to alpha 0', () => {
    const gaf = buildGaf('box', [{ w: 2, h: 2, x: 0, y: 0, t: 0, layers: [{ w: 2, h: 2, x: 0, y: 0, px: [10, 0, 0, 20] }] }]);
    const [entry] = parseGaf(gaf);
    expect(entry!.name).toBe('box');
    const rgba = frameToRgba(entry!.frames[0]!, pal);
    expect([...rgba]).toEqual([10, 10, 10, 255, 0, 0, 0, 0, 0, 0, 0, 0, 20, 20, 20, 255]);
  });

  it('reads a compressed frame', () => {
    const gaf = buildGaf('rle', [
      { w: 3, h: 1, x: 0, y: 0, t: 5, layers: [{ w: 3, h: 1, x: 0, y: 0, px: [], rle: [[0b11, (2 << 2) | 0, 40, 41, 42]] }] },
    ]);
    const frame = parseGaf(gaf)[0]!.frames[0]!;
    expect([...frame.layers[0]!.pixels]).toEqual([5, 40, 41]);
  });

  it('composites subframe layers using their origin offsets', () => {
    // 3x1 frame with origin x=1. Layer A covers all of it; layer B (origin 0) lands at x=1 and overrides.
    const gaf = buildGaf('layers', [
      {
        w: 3, h: 1, x: 1, y: 0, t: 0,
        layers: [
          { w: 3, h: 1, x: 1, y: 0, px: [1, 2, 3] },
          { w: 1, h: 1, x: 0, y: 0, px: [99] },
        ],
      },
    ]);
    const frame = parseGaf(gaf)[0]!.frames[0]!;
    expect(frame.layers.length).toBe(2);
    const rgba = frameToRgba(frame, pal);
    expect([rgba[0], rgba[4], rgba[8]]).toEqual([1, 99, 3]);
  });

  it('rejects files that are not GAF', () => {
    expect(() => parseGaf(new Uint8Array(32))).toThrow(/not a GAF/);
  });
});

describe.skipIf(!hasGameData())('GAF decoder (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  let pal: Palette;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
    pal = parsePalette(await vfs.read(PALETTE_PATH));
  });
  afterAll(() => close?.());

  it('decodes every frame of every GAF', async () => {
    // These two are internal lookup tables with a different header, not graphics.
    const notGraphics = new Set(['anims/terrain.gaf', 'anims/vismasks.gaf']);
    const files = vfs.list().filter((f) => /\.gaf$/i.test(f.path) && !notGraphics.has(f.path.toLowerCase()));
    expect(files.length).toBeGreaterThan(300);
    let frames = 0;
    for (const f of files) {
      for (const e of parseGaf(await vfs.read(f.path))) {
        for (const fr of e.frames) {
          expect(frameToRgba(fr, pal).length).toBe(fr.width * fr.height * 4);
          frames++;
        }
      }
    }
    expect(frames).toBeGreaterThan(10000);
  }, 60_000); // reads every GAF in every archive; slow when other tests run alongside

  it('loads model textures and 10 team colours for each logo texture', async () => {
    const lib = await loadTextureLibrary(vfs, pal);
    expect(lib.textures.size).toBeGreaterThan(300);
    expect(vfs.exists(LOGOS_PATH)).toBe(true);
    expect(lib.teamTextures.size).toBeGreaterThan(5);
    // Nearly every LOGOS entry has one frame per team colour (a couple, like onoff01, are 2-frame toggles).
    const full = [...lib.teamTextures.values()].filter((frames) => frames.length === TEAM_COLOR_COUNT);
    expect(full.length).toBeGreaterThanOrEqual(lib.teamTextures.size - 2);
    // Team colours actually differ.
    const md = lib.teamTextures.get('colorsmd')!;
    expect(new Set(md.map((t) => t.rgba.slice(0, 3).join())).size).toBeGreaterThan(5);
  });
});
