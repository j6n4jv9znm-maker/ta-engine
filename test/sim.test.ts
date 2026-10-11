import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TntMap } from '../src/formats/tnt';
import { openDataDir } from '../src/io/nodeVfs';
import { loadFeatureDefinitions } from '../src/map/features';
import { loadGameMap, type GameMap } from '../src/map/mapData';
import { UnitAssetLoader } from '../src/sim/assets';
import { findPath, octile } from '../src/sim/pathfinding';
import { SimTerrain } from '../src/sim/terrain';
import { loadUnitDefs, type MovementClass, type UnitDef } from '../src/sim/unitDef';
import { toDirection, toRotation, World, type UnitAssets } from '../src/sim/world';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

/** A flat test map, `w` x `h` height cells, with optional per-cell heights. */
function flatMap(w: number, h: number, heightAt: (x: number, z: number) => number = () => 20, seaLevel = 0): GameMap {
  const heights = new Uint8Array(w * h);
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) heights[z * w + x] = heightAt(x, z);
  const tnt: TntMap = {
    width: w,
    height: h,
    seaLevel,
    heights,
    features: new Uint16Array(w * h).fill(0xffff),
    featureNames: [],
    tilesWide: w / 2,
    tilesHigh: h / 2,
    tileIndices: new Uint16Array((w / 2) * (h / 2)),
    tiles: new Uint8Array(1024),
    tileCount: 1,
    minimap: { width: 1, height: 1, pixels: new Uint8Array(1) },
  };
  return { name: 'test', tnt, ota: undefined, features: [], unknownFeatures: [], widthUnits: w * 16, heightUnits: h * 16 };
}

const tank: MovementClass = { name: 'TEST', footprintX: 2, footprintZ: 2, minWaterDepth: 0, maxWaterDepth: 10, maxSlope: 10, maxWaterSlope: 10 };
function unitDef(over: Partial<UnitDef> = {}): UnitAssets {
  const def: UnitDef = {
    unitName: 'TESTTANK',
    name: 'Test Tank',
    description: '',
    side: 'ARM',
    objectName: '',
    footprintX: 2,
    footprintZ: 2,
    maxVelocity: 2,
    acceleration: 0.1,
    brakeRate: 0.2,
    turnRate: 900,
    canMove: true,
    canFly: false,
    canHover: false,
    floater: false,
    bmCode: 1,
    maxDamage: 100,
    builder: false,
    workerTime: 0,
    buildTime: 100,
    buildCostMetal: 10,
    buildCostEnergy: 10,
    buildDistance: 64,
    energyMake: 0,
    metalMake: 0,
    energyUse: 0,
    metalUse: 0,
    makesMetal: 0,
    extractsMetal: 0,
    windGenerator: 0,
    tidalGenerator: 0,
    energyStorage: 0,
    metalStorage: 0,
    commander: false,
    activateWhenBuilt: false,
    onOffable: false,
    yardMap: '',
    corpse: '',
    weapons: ['', '', ''],
    explodeAs: '',
    selfDestructAs: '',
    sightDistance: 300,
    radarDistance: 0,
    damageModifier: 1,
    categories: [],
    tedClass: '',
    movementClass: tank,
    ownMovement: tank,
    ...over,
  };
  return { def, model: undefined, script: undefined };
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) world.tick();
}

describe('pathfinding', () => {
  it('uses octile distances', () => {
    expect(octile(0, 0, 3, 1)).toBe(34);
  });

  it('finds a way around a wall and merges straight runs', () => {
    // 10x10 grid with a wall at x=5 except a gap at z=8.
    const wall = (x: number, z: number) => !(x === 5 && z !== 8);
    const r = findPath({ width: 10, height: 10, passable: wall, start: [1, 1], goal: [8, 1] });
    expect(r.complete).toBe(true);
    expect(r.waypoints.at(-1)).toEqual([8, 1]);
    expect(r.waypoints.some(([, z]) => z >= 7)).toBe(true); // detoured down to the gap
    expect(r.waypoints.length).toBeLessThan(8);
  });

  it('returns a partial path to the closest reachable cell when the goal is cut off', () => {
    const r = findPath({ width: 10, height: 10, passable: (x) => x !== 5, start: [1, 1], goal: [8, 1] });
    expect(r.complete).toBe(false);
    expect(r.waypoints.at(-1)).toEqual([4, 1]);
  });

  it('does not cut corners', () => {
    // Only diagonal neighbours open between (0,0) and (1,1): no path.
    const open = new Set(['0,0', '1,1']);
    const r = findPath({ width: 2, height: 2, passable: (x, z) => open.has(`${x},${z}`), start: [0, 0], goal: [1, 1] });
    expect(r.complete).toBe(false);
  });
});

describe('terrain rules', () => {
  it('blocks steep slopes and deep water per footprint', () => {
    const map = flatMap(16, 16, (x) => (x >= 8 ? 60 : 20), 30);
    const t = new SimTerrain(map.tnt);
    expect(t.slope(7, 3)).toBe(40);
    // Left side is under 10 deep water (sea 30, ground 20) and flat: fits.
    expect(t.fits(tank, 2, 2)).toBe(true);
    // Straddling the cliff: too steep.
    expect(t.fits(tank, 6, 2)).toBe(false);
    // Deeper water than allowed.
    expect(t.fits({ ...tank, maxWaterDepth: 5 }, 2, 2)).toBe(false);
  });

  it('converts headings like RWE: 0 faces +z', () => {
    expect(toRotation(0, 1)).toBe(0);
    expect(toRotation(1, 0)).toBe(16384);
    const [x, z] = toDirection(16384);
    expect(x).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
  });
});

describe('world simulation', () => {
  it('moves a unit to the clicked spot, accelerating and turning on the way', () => {
    const w = new World(flatMap(64, 64), 1);
    const u = w.spawn(unitDef(), 0, 100, 100)!;
    w.issue({ kind: 'move', unitIds: [u.id], x: 700, z: 400 });
    w.tick();
    expect(u.speed).toBeLessThanOrEqual(0.1); // accelerates gradually
    run(w, 30 * 30);
    expect(Math.hypot(u.x - 700, u.z - 400)).toBeLessThan(10);
    expect(u.order).toBeUndefined();
    expect(u.speed).toBe(0);
  });

  it('routes around a cliff instead of through it', () => {
    // A ridge across the middle with a gap near the bottom.
    const map = flatMap(64, 64, (x, z) => (x >= 30 && x <= 33 && z < 50 ? 120 : 20));
    const w = new World(map, 1);
    const u = w.spawn(unitDef(), 0, 200, 100)!;
    w.issue({ kind: 'move', unitIds: [u.id], x: 800, z: 100 });
    w.tick(); // orders take effect on the next tick
    let minZ = Infinity;
    let maxZ = 0;
    for (let i = 0; i < 30 * 60 && u.order; i++) {
      w.tick();
      if (u.x > 470 && u.x < 550) {
        minZ = Math.min(minZ, u.z);
        maxZ = Math.max(maxZ, u.z);
      }
    }
    expect(Math.hypot(u.x - 800, u.z - 100)).toBeLessThan(10);
    expect(minZ).toBeGreaterThan(50 * 16 - 16); // crossed through the gap
  });

  it('keeps units from overlapping and stops on command', () => {
    const w = new World(flatMap(64, 64), 1);
    const ids = [0, 1, 2, 3, 4, 5].map((i) => w.spawn(unitDef(), 0, 100 + i * 40, 100)!.id);
    w.issue({ kind: 'move', unitIds: ids, x: 500, z: 600 });
    run(w, 60);
    const occupied = new Set<string>();
    for (const u of w.units.values()) {
      for (let dz = 0; dz < 2; dz++) {
        for (let dx = 0; dx < 2; dx++) {
          const k = `${u.cellX + dx},${u.cellZ + dz}`;
          expect(occupied.has(k)).toBe(false);
          occupied.add(k);
        }
      }
    }
    w.issue({ kind: 'stop', unitIds: ids });
    run(w, 60);
    for (const u of w.units.values()) {
      expect(u.order).toBeUndefined();
      expect(u.speed).toBe(0);
    }
  });

  it('is deterministic: same seed and commands give the same game', () => {
    const play = () => {
      const w = new World(flatMap(64, 64, (x, z) => 20 + ((x * 7 + z * 3) % 5)), 99);
      const ids = [0, 1, 2, 3].map((i) => w.spawn(unitDef(), 0, 100 + i * 40, 100)!.id);
      w.issue({ kind: 'move', unitIds: ids, x: 800, z: 800 });
      run(w, 200);
      w.issue({ kind: 'move', unitIds: ids.slice(0, 2), x: 100, z: 900 });
      run(w, 300);
      return w.hash();
    };
    expect(play()).toBe(play());
  });
});

describe.skipIf(!hasGameData())('world simulation (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  let loader: UnitAssetLoader;
  let map: GameMap;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
    loader = new UnitAssetLoader(vfs, await loadUnitDefs(vfs));
    map = await loadGameMap(vfs, 'The Pass', await loadFeatureDefinitions(vfs));
  }, 60_000);
  afterAll(() => close?.());

  it('marches a mixed army the whole length of The Pass without anyone getting stuck', async () => {
    const [a, b] = map.ota!.schemas[0]!.startPositions;
    const w = new World(map, 1);
    const types = ['ARMCOM', 'ARMSTUMP', 'ARMPW', 'ARMFLASH', 'ARMJETH', 'ARMBULL', 'ARMHAM', 'ARMWAR'];
    const ids: number[] = [];
    for (let i = 0; i < 24; i++) ids.push(w.spawn((await loader.load(types[i % types.length]!))!, 0, a!.x, a!.z)!.id);
    w.issue({ kind: 'move', unitIds: ids, x: b!.x, z: b!.z });
    run(w, 30 * 300);
    const units = [...w.units.values()];
    const arrived = units.filter((u) => Math.hypot(u.x - b!.x, u.z - b!.z) < 200);
    expect(arrived.length).toBe(24);
    expect(units.flatMap((u) => u.scripts?.vm.errors ?? [])).toEqual([]);
  }, 120_000);
});
