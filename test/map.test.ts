import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseOta } from '../src/formats/ota';
import { parsePalette, PALETTE_PATH } from '../src/formats/palette';
import { parseTdf } from '../src/formats/tdf';
import { FEATURE_NONE, FEATURE_VOID, featurePlacements, parseTnt } from '../src/formats/tnt';
import { createTerrain } from '../src/graphics/terrain';
import { openDataDir } from '../src/io/nodeVfs';
import { loadFeatureDefinitions, type FeatureDef } from '../src/map/features';
import { heightAt, listMaps, loadGameMap, midpointHeight } from '../src/map/mapData';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

/** Writes a small TNT as documented in src/formats/tnt.ts. Size in cells; one tile per 2x2 cells. */
function buildTnt(opts: { width: number; height: number; heights: number[]; features: number[]; names: string[]; tiles: number }): Uint8Array {
  const { width, height } = opts;
  const tw = width / 2;
  const th = height / 2;
  const header = 64;
  const idxAt = header;
  const attrAt = idxAt + tw * th * 2;
  const tilesAt = attrAt + width * height * 4;
  const namesAt = tilesAt + opts.tiles * 1024;
  const mmAt = namesAt + opts.names.length * 132;
  const mmW = 4;
  const mmH = 3;
  const out = new Uint8Array(mmAt + 8 + mmW * mmH);
  const v = new DataView(out.buffer);
  [0x2000, width, height, idxAt, attrAt, tilesAt, opts.tiles, opts.names.length, namesAt, 5, mmAt].forEach((x, i) =>
    v.setUint32(i * 4, x, true),
  );
  for (let i = 0; i < tw * th; i++) v.setUint16(idxAt + i * 2, i % opts.tiles, true);
  for (let i = 0; i < width * height; i++) {
    out[attrAt + i * 4] = opts.heights[i]!;
    v.setUint16(attrAt + i * 4 + 1, opts.features[i]!, true);
  }
  for (let t = 0; t < opts.tiles; t++) out.fill(t + 1, tilesAt + t * 1024, tilesAt + (t + 1) * 1024);
  opts.names.forEach((n, i) => {
    v.setUint32(namesAt + i * 132, i, true);
    for (let c = 0; c < n.length; c++) out[namesAt + i * 132 + 4 + c] = n.charCodeAt(c);
  });
  v.setUint32(mmAt, mmW, true);
  v.setUint32(mmAt + 4, mmH, true);
  // 3x2 real minimap pixels, padded with 0x64 on the right and bottom.
  out.set([1, 2, 3, 0x64, 4, 5, 6, 0x64, 0x64, 0x64, 0x64, 0x64], mmAt + 8);
  return out;
}

const N = FEATURE_NONE;
const small = buildTnt({
  width: 4,
  height: 4,
  heights: [0, 10, 20, 30, 0, 10, 20, 30, 40, 40, 40, 40, 80, 80, 80, 80],
  features: [0, N, N, N, N, FEATURE_VOID, N, N, N, N, 1, N, N, N, N, N],
  names: ['Tree1', 'Rock2'],
  tiles: 3,
});

describe('TNT map loader', () => {
  it('reads sizes, heights, tiles, features and the minimap', () => {
    const m = parseTnt(small);
    expect([m.width, m.height, m.tilesWide, m.tilesHigh, m.tileCount, m.seaLevel]).toEqual([4, 4, 2, 2, 3, 5]);
    expect(m.heights[3]).toBe(30);
    expect([...m.tileIndices]).toEqual([0, 1, 2, 0]);
    expect(m.tiles[1024]).toBe(2);
    expect(m.featureNames).toEqual(['Tree1', 'Rock2']);
    expect(featurePlacements(m)).toEqual([
      { x: 0, z: 0, name: 'Tree1' },
      { x: 2, z: 2, name: 'Rock2' },
    ]);
    expect(m.minimap).toEqual({ width: 3, height: 2, pixels: Uint8Array.from([1, 2, 3, 4, 5, 6]) });
  });

  it('computes cell midpoint and interpolated heights', () => {
    const m = parseTnt(small);
    expect(midpointHeight(m, 0, 0)).toBe(5);
    expect(heightAt(m, 8, 0)).toBe(5);
    expect(heightAt(m, 16, 24)).toBe(25);
    expect(heightAt(m, -5, 0)).toBe(0);
  });

  it('builds a terrain mesh whose art lookup is shifted up by half the height', () => {
    const raw = new Uint8Array(1024);
    const t = createTerrain(parseTnt(small), parsePalette(raw));
    const pos = t.mesh.geometry.getAttribute('position');
    const art = t.mesh.geometry.getAttribute('artPos');
    expect(pos.count).toBe(16);
    // vertex (x=1, z=2): height 40 -> world (16, 40, 32), art pixel (16, 32 - 20)
    expect([pos.getX(9), pos.getY(9), pos.getZ(9)]).toEqual([16, 40, 32]);
    expect([art.getX(9), art.getY(9)]).toEqual([16, 12]);
    // below sea level (5) the surface sits at sea level
    expect(pos.getY(0)).toBe(5);
    t.dispose();
  });

  it('rejects files that are not maps', () => {
    expect(() => parseTnt(new Uint8Array(64))).toThrow(/not a TA map/);
  });
});

describe('OTA map settings', () => {
  it('reads the header, schema features and start positions', () => {
    const ota = parseOta(
      parseTdf(`[GlobalHeader]{ missionname=Test Map; planet=Moon; minwindspeed=100; maxwindspeed=2000; SCHEMACOUNT=1;
        [Schema 0]{ Type=Network 1; SurfaceMetal=4;
          [features]{ [feature0]{ Featurename=Rock1; XPos=10; ZPos=12; } }
          [specials]{ [special0]{ specialwhat=StartPos2; XPos=500; ZPos=600; }
                      [special1]{ specialwhat=StartPos1; XPos=100; ZPos=200; } } } }`),
    );
    expect(ota.missionName).toBe('Test Map');
    expect(ota.maxWindSpeed).toBe(2000);
    expect(ota.gravity).toBe(112);
    const s = ota.schemas[0]!;
    expect(s.surfaceMetal).toBe(4);
    expect(s.features).toEqual([{ name: 'Rock1', x: 10, z: 12 }]);
    expect(s.startPositions).toEqual([
      { x: 100, z: 200 },
      { x: 500, z: 600 },
    ]);
  });
});

describe.skipIf(!hasGameData())('maps (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  let defs: Map<string, FeatureDef>;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
    defs = await loadFeatureDefinitions(vfs);
  }, 60_000);
  afterAll(() => close?.());

  it('loads every map with its settings, features and start positions', async () => {
    const names = listMaps(vfs);
    expect(names.length).toBeGreaterThan(200);
    let features = 0;
    for (const name of names) {
      const map = await loadGameMap(vfs, name, defs);
      expect(map.unknownFeatures, name).toEqual([]);
      features += map.features.length;
      if (/example/i.test(name)) continue; // the editor's sample map has no start positions
      const starts = map.ota?.schemas[0]?.startPositions.filter(Boolean) ?? [];
      expect(starts.length, name).toBeGreaterThan(0);
      for (const p of starts) {
        expect(p!.x, name).toBeLessThanOrEqual(map.widthUnits);
        expect(p!.z, name).toBeLessThanOrEqual(map.heightUnits);
      }
    }
    expect(features).toBeGreaterThan(50000);
  }, 120_000);

  it('builds terrain for a real map', async () => {
    const pal = parsePalette(await vfs.read(PALETTE_PATH));
    const map = await loadGameMap(vfs, 'The Pass', defs);
    const t = createTerrain(map.tnt, pal);
    expect(t.mesh.geometry.getAttribute('position').count).toBe(map.tnt.width * map.tnt.height);
    t.dispose();
  });
});
