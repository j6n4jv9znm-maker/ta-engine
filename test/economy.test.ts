import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TntMap } from '../src/formats/tnt';
import { parseTdf } from '../src/formats/tdf';
import { openDataDir } from '../src/io/nodeVfs';
import { loadFeatureDefinitions, type FeatureDef } from '../src/map/features';
import { loadGameMap, type GameMap } from '../src/map/mapData';
import { UnitAssetLoader } from '../src/sim/assets';
import { loadBuildMenus } from '../src/sim/buildMenus';
import { PlayerEconomy } from '../src/sim/economy';
import { yardCellPassable } from '../src/sim/occupancy';
import { loadUnitDefs, type MovementClass, type UnitDef } from '../src/sim/unitDef';
import { World, type UnitAssets } from '../src/sim/world';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

const ground: MovementClass = { name: 'G', footprintX: 2, footprintZ: 2, minWaterDepth: 0, maxWaterDepth: 50, maxSlope: 20, maxWaterSlope: 20 };

function def(over: Partial<UnitDef>): UnitAssets {
  const d: UnitDef = {
    unitName: 'X',
    name: 'X',
    description: '',
    side: 'ARM',
    objectName: '',
    footprintX: 2,
    footprintZ: 2,
    maxVelocity: 2,
    acceleration: 0.2,
    brakeRate: 0.3,
    turnRate: 2000,
    canMove: true,
    canFly: false,
    cruiseAlt: 100,
    hoverAttack: false,
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
    soundCategory: '',
    movementClass: ground,
    ownMovement: ground,
    ...over,
  };
  return { def: d, model: undefined, script: undefined };
}

const COMMANDER = def({ unitName: 'COM', builder: true, workerTime: 300, commander: true, energyMake: 25, metalMake: 1 });
const SOLAR = def({ unitName: 'SOLAR', bmCode: 0, canMove: false, maxVelocity: 0, buildTime: 300, buildCostMetal: 30, buildCostEnergy: 60, energyMake: 20, energyStorage: 50, footprintX: 3, footprintZ: 3, ownMovement: { ...ground, footprintX: 3, footprintZ: 3 } });
const LAB = def({ unitName: 'LAB', bmCode: 0, canMove: false, maxVelocity: 0, builder: true, workerTime: 150, buildTime: 150, buildCostMetal: 20, buildCostEnergy: 20, footprintX: 4, footprintZ: 4, yardMap: 'occo'.repeat(4), ownMovement: { ...ground, footprintX: 4, footprintZ: 4 } });
const TANK = def({ unitName: 'TANK', buildTime: 150, buildCostMetal: 15, buildCostEnergy: 15 });
const ALL = new Map([COMMANDER, SOLAR, LAB, TANK].map((a) => [a.def.unitName.toLowerCase(), a]));

const rock: FeatureDef = {
  name: 'rock', world: '', description: 'Rock', category: '', footprintX: 2, footprintZ: 2, height: 8, fileName: '', seqName: '', seqNameShadow: '', object: '',
  animTrans: false, shadTrans: false, blocking: true, indestructible: false, reclaimable: true, metal: 40, energy: 0, featureDead: '', damage: 100,
};

function flatMap(w = 64, h = 64): GameMap {
  const tnt: TntMap = {
    width: w, height: h, seaLevel: 0, heights: new Uint8Array(w * h).fill(20), features: new Uint16Array(w * h).fill(0xffff), featureNames: [],
    tilesWide: w / 2, tilesHigh: h / 2, tileIndices: new Uint16Array((w / 2) * (h / 2)), tiles: new Uint8Array(1024), tileCount: 1,
    minimap: { width: 1, height: 1, pixels: new Uint8Array(1) },
  };
  return {
    name: 'flat', tnt, ota: undefined, unknownFeatures: [], widthUnits: w * 16, heightUnits: h * 16,
    features: [{ def: rock, cellX: 40, cellZ: 10, x: 40 * 16 + 16, y: 20, z: 10 * 16 + 16 }],
  };
}

function newWorld(): World {
  return new World(flatMap(), { seed: 1, assets: (n) => ALL.get(n.toLowerCase()) });
}
const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i++) w.tick();
};

describe('economy', () => {
  it('settles once a second and stalls spending when a stock runs out', () => {
    const p = new PlayerEconomy(100, 100);
    expect(p.trySpend(50, 150)).toBe(true);
    p.settle(100, 100);
    expect(p.metal).toBe(-50); // overspent; next second is stalled
    expect(p.energy).toBe(50);
    expect(p.metalStalled).toBe(false);
    p.settle(100, 100);
    expect(p.metalStalled).toBe(true);
    expect(p.trySpend(1, 1)).toBe(false);
    expect(p.trySpend(1, 0)).toBe(true); // energy-only work still goes ahead
    p.produce(0, 200);
    p.settle(1000, 1000);
    expect(p.metal).toBe(150);
    expect(p.metalStalled).toBe(false);
  });

  it('caps stock at storage', () => {
    const p = new PlayerEconomy(1000, 1000);
    p.produce(5000, 5000);
    p.settle(1200, 1100);
    expect([p.metal, p.energy]).toEqual([1200, 1100]);
  });

  it('reads yard maps like RWE: c opens with the yard, o never, y always', () => {
    expect(yardCellPassable('c', true)).toBe(true);
    expect(yardCellPassable('c', false)).toBe(false);
    expect(yardCellPassable('o', true)).toBe(false);
    expect(yardCellPassable('y', false)).toBe(true);
    expect(yardCellPassable('O', false)).toBe(true);
  });
});

describe('building', () => {
  it('a builder walks over, builds a building over time, and pays for it', () => {
    const w = newWorld();
    const com = w.spawn(COMMANDER, 0, 200, 200)!;
    const site = w.findSiteNear('SOLAR', 450, 200)!;
    w.issue({ kind: 'build', unitId: com.id, unitName: 'SOLAR', x: site.x, z: site.z });
    run(w, 30 * 10);
    const solar = [...w.units.values()].find((u) => u.def.unitName === 'SOLAR')!;
    expect(solar).toBeDefined();
    expect(w.isFinished(solar)).toBe(true);
    expect(solar.hp).toBe(solar.def.maxDamage);
    expect(com.tasks).toEqual([]);
    // Started with 1000 of each; paid 30 metal and 60 energy; made 25 E and 1 M a second, plus solar.
    const p = w.players[0]!;
    expect(p.metal).toBeGreaterThan(1000 - 30 - 1);
    expect(p.metal).toBeLessThan(1000);
    // Storage: the Commander's 1000 plus the solar's 50.
    expect(p.maxEnergy).toBe(1050);
  });

  it('does no work while stalled on metal', () => {
    const w = newWorld();
    w.players[0]!.metal = 0;
    w.players[0]!.maxMetal = 0;
    const com = w.spawn({ ...COMMANDER, def: { ...COMMANDER.def, metalMake: 0 } }, 0, 200, 200)!;
    const site = w.findSiteNear('SOLAR', 280, 200)!;
    w.issue({ kind: 'build', unitId: com.id, unitName: 'SOLAR', x: site.x, z: site.z });
    run(w, 30 * 5);
    const solar = [...w.units.values()].find((u) => u.def.unitName === 'SOLAR');
    expect(solar && w.buildFraction(solar)).toBeLessThan(0.25);
  });

  it('refuses to build on a blocking rock', () => {
    const w = newWorld();
    expect(w.buildSite('SOLAR', 40 * 16 + 16, 10 * 16 + 16).ok).toBe(false);
    expect(w.buildSite('SOLAR', 300, 300).ok).toBe(true);
  });

  it('factories build their queue and send each unit out', () => {
    const w = newWorld();
    w.spawn(COMMANDER, 0, 100, 100); // without a Commander there is no storage, so nothing to spend
    const lab = w.spawn(LAB, 0, 500, 500)!;
    w.issue({ kind: 'factory', unitId: lab.id, unitName: 'TANK', count: 3 });
    run(w, 30 * 15);
    const tanks = [...w.units.values()].filter((u) => u.def.unitName === 'TANK');
    expect(tanks.length).toBe(3);
    for (const t of tanks) {
      expect(w.isFinished(t)).toBe(true);
      expect(t.exitFactory).toBeUndefined();
      expect(Math.hypot(t.x - lab.x, t.z - lab.z)).toBeGreaterThan(32);
    }
    expect(lab.factory!.queue).toEqual([]);
  });

  it('reclaims a rock for its metal', () => {
    const w = newWorld();
    const com = w.spawn(COMMANDER, 0, 500, 200)!;
    w.players[0]!.metal = 500;
    w.issue({ kind: 'reclaim', unitIds: [com.id], featureId: 0 });
    run(w, 30 * 8);
    expect(w.features[0]!.alive).toBe(false);
    expect(w.buildSite('SOLAR', 40 * 16 + 16, 10 * 16 + 16).ok).toBe(true);
    // 40 metal from the rock arrived at a settlement (on top of the Commander's 1/s).
    expect(w.players[0]!.metal).toBeGreaterThan(540);
  });

  it('is deterministic', () => {
    const play = () => {
      const w = newWorld();
      const com = w.spawn(COMMANDER, 0, 200, 200)!;
      const lab = w.spawn(LAB, 0, 600, 600)!;
      w.issue({ kind: 'build', unitId: com.id, unitName: 'SOLAR', x: 400, z: 200 });
      w.issue({ kind: 'factory', unitId: lab.id, unitName: 'TANK', count: 2 });
      run(w, 30 * 20);
      return w.hash();
    };
    expect(play()).toBe(play());
  });
});

describe('TDF duplicate blocks', () => {
  it('keeps repeated gadget numbers when asked', () => {
    const text = '[G1]{name=A;} [G1]{name=B;}';
    expect(Object.keys(parseTdf(text))).toEqual(['g1']);
    expect(Object.keys(parseTdf(text, { keepDuplicateBlocks: true }))).toEqual(['g1', 'g1#2']);
  });
});

describe.skipIf(!hasGameData())('building (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  let assets: Map<string, UnitAssets>;
  let defs: Map<string, UnitDef>;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
    defs = await loadUnitDefs(vfs);
    const loader = new UnitAssetLoader(vfs, defs);
    assets = new Map();
    for (const k of defs.keys()) {
      const a = await loader.load(k);
      if (a) assets.set(k, a);
    }
  }, 120_000);
  afterAll(() => close?.());

  it('reads build menus, including units added by the expansions', async () => {
    const menus = await loadBuildMenus(vfs, new Set(defs.keys()));
    const flat = (n: string) => (menus.get(n) ?? []).flat();
    expect(flat('armcom')).toEqual(expect.arrayContaining(['ARMSOLAR', 'ARMMEX', 'ARMLAB', 'ARMVP']));
    expect(flat('armlab')).toEqual(expect.arrayContaining(['ARMCK', 'ARMPW', 'ARMHAM', 'ARMWAR']));
    expect(flat('corcom')).toEqual(expect.arrayContaining(['CORSOLAR', 'CORMEX', 'CORLAB']));
  });

  it('starts with a Commander and builds a base and an army on The Pass', async () => {
    const map = await loadGameMap(vfs, 'The Pass', await loadFeatureDefinitions(vfs));
    const w = new World(map, { seed: 1, assets: (n) => assets.get(n.toLowerCase()) });
    const s = map.ota!.schemas[0]!.startPositions[0]!;
    const com = w.spawn(assets.get('armcom')!, 0, s.x, s.z)!;
    const patch = w.features
      .filter((f) => f.def.metal && !f.def.blocking && f.def.indestructible)
      .sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z))[0]!;
    for (const [name, x, z] of [
      ['ARMSOLAR', s.x + 100, s.z + 40],
      ['ARMMEX', patch.x, patch.z],
      ['ARMLAB', s.x + 200, s.z + 150],
    ] as const) {
      const site = w.findSiteNear(name, x, z)!;
      w.issue({ kind: 'build', unitId: com.id, unitName: name, x: site.x, z: site.z, queue: true });
    }
    run(w, 30 * 90);
    const lab = [...w.units.values()].find((u) => u.def.unitName === 'ARMLAB')!;
    expect(w.isFinished(lab)).toBe(true);
    const mex = [...w.units.values()].find((u) => u.def.unitName === 'ARMMEX')!;
    expect(mex.scripts?.state.activated).toBe(true);
    expect(w.players[0]!.lastMetalIn).toBeGreaterThan(2.5); // Commander 1 + extractor on the patch
    w.issue({ kind: 'factory', unitId: lab.id, unitName: 'ARMPW', count: 3 });
    run(w, 30 * 90);
    const pws = [...w.units.values()].filter((u) => u.def.unitName === 'ARMPW');
    expect(pws.length).toBe(3);
    for (const p of pws) {
      expect(w.isFinished(p)).toBe(true);
      expect(p.exitFactory).toBeUndefined();
    }
    expect([...w.units.values()].flatMap((u) => u.scripts?.vm.errors ?? [])).toEqual([]);
  }, 120_000);
});
