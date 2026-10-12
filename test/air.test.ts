import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDataDir } from '../src/io/nodeVfs';
import { loadFeatureDefinitions, type FeatureDef } from '../src/map/features';
import { UnitAssetLoader } from '../src/sim/assets';
import { loadUnitDefs } from '../src/sim/unitDef';
import { loadWeaponDefs, type WeaponDef } from '../src/sim/weaponDef';
import { World, type UnitAssets } from '../src/sim/world';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';
import { flatGameMap } from './helpers';

describe.skipIf(!hasGameData())('aircraft (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  const assets = new Map<string, UnitAssets>();
  let weapons: Map<string, WeaponDef>;
  let featureDefs: Map<string, FeatureDef>;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
    const defs = await loadUnitDefs(vfs);
    const loader = new UnitAssetLoader(vfs, defs);
    for (const n of ['armham', 'armfig', 'armthund', 'armbrawl', 'armca', 'armap', 'armpw', 'corak', 'corveng', 'corshad']) assets.set(n, (await loader.load(n))!);
    weapons = await loadWeaponDefs(vfs);
    featureDefs = await loadFeatureDefinitions(vfs);
  }, 120_000);
  afterAll(() => close?.());

  const world = () => new World(flatGameMap(128, 128), { seed: 3, assets: (n) => assets.get(n.toLowerCase()), weapons, featureDefs });
  const run = (w: World, ticks: number) => {
    for (let i = 0; i < ticks; i++) w.tick();
  };

  it('a plane takes off, flies over the ground at cruise height, and lands when idle', () => {
    const w = world();
    const fig = w.spawn(assets.get('armfig')!, 0, 200, 200)!;
    w.issue({ kind: 'move', unitIds: [fig.id], x: 1600, z: 1400 });
    run(w, 30 * 2);
    expect(fig.y - 20).toBeGreaterThan(fig.def.cruiseAlt * 0.5);
    run(w, 30 * 20);
    expect(Math.hypot(fig.x - 1600, fig.z - 1400)).toBeLessThan(20);
    run(w, 30 * 10);
    expect(fig.y).toBeLessThan(25); // landed (the flat map's ground is at 20)
  });

  it('cannons cannot shoot planes; fighters can', () => {
    const w = world();
    const bomber = w.spawn(assets.get('corshad')!, 1, 600, 600)!;
    w.issue({ kind: 'move', unitIds: [bomber.id], x: 1900, z: 640 });
    const pw = w.spawn(assets.get('armham')!, 0, 600, 700)!; // a plasma cannon
    run(w, 30 * 5);
    expect(w.airborne(bomber)).toBe(true);
    expect(bomber.hp).toBe(bomber.def.maxDamage);
    expect(pw.weapons.every((s) => !s || s.target === undefined)).toBe(true);
    const fig = w.spawn(assets.get('armfig')!, 0, 300, 600)!;
    w.issue({ kind: 'attack', unitIds: [fig.id], targetId: bomber.id });
    for (let t = 0; t < 30 * 30; t++) {
      // Keep the bomber flying back and forth so it stays in the air.
      if (t % 150 === 0) w.issue({ kind: 'move', unitIds: [bomber.id], x: t % 300 ? 600 : 1900, z: 640 });
      w.tick();
    }
    expect(w.units.has(bomber.id) && !bomber.dying).toBe(false);
  });

  it('a gunship and a fighter can both attack a ground unit', () => {
    const w = world();
    const target = w.spawn(assets.get('corak')!, 1, 1000, 1000)!;
    const brawl = w.spawn(assets.get('armbrawl')!, 0, 400, 400)!;
    const fig = w.spawn(assets.get('armfig')!, 0, 400, 600)!;
    w.issue({ kind: 'attack', unitIds: [brawl.id, fig.id], targetId: target.id });
    run(w, 30 * 30);
    expect(w.units.has(target.id) && !target.dying).toBe(false);
  });

  it('a bomber makes passes over a ground target and destroys it', () => {
    const w = world();
    const target = w.spawn(assets.get('corak')!, 1, 1000, 1000)!;
    const thund = w.spawn(assets.get('armthund')!, 0, 200, 200)!;
    w.issue({ kind: 'attack', unitIds: [thund.id], targetId: target.id });
    run(w, 30 * 40);
    expect(w.units.has(target.id) && !target.dying).toBe(false);
  });

  it('an aircraft plant builds a plane that flies out to the rally point', () => {
    const w = world();
    const ap = w.spawn(assets.get('armap')!, 0, 800, 800)!;
    w.issue({ kind: 'rally', unitId: ap.id, x: 1200, z: 400 });
    w.issue({ kind: 'factory', unitId: ap.id, unitName: 'ARMFIG', count: 1 });
    for (let t = 0; t < 30 * 150; t++) {
      w.players[0]!.produce(200, 20); // a rich economy, so the build doesn't stall
      w.tick();
    }
    const fig = [...w.units.values()].find((u) => u.def.unitName === 'ARMFIG');
    expect(fig).toBeDefined();
    expect(Math.hypot(fig!.x - 1200, fig!.z - 400)).toBeLessThan(40);
  });
});
