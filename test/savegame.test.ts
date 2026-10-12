import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDataDir } from '../src/io/nodeVfs';
import { loadFeatureDefinitions } from '../src/map/features';
import { loadGameMap } from '../src/map/mapData';
import { loadAiProfile } from '../src/sim/ai/aiProfile';
import { UnitAssetLoader } from '../src/sim/assets';
import { loadBuildMenus } from '../src/sim/buildMenus';
import { createSkirmish, HUMAN, replayGame, saveGame, type SavedGame, type SkirmishDeps, type SkirmishSettings } from '../src/sim/skirmish';
import { loadUnitDefs } from '../src/sim/unitDef';
import { loadWeaponDefs } from '../src/sim/weaponDef';
import type { UnitAssets, World } from '../src/sim/world';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

/** Everything about the game state that a player could notice. */
function snapshot(w: World): string {
  const units = [...w.units.values()].map((u) => [u.id, u.owner, u.def.unitName, u.x.toFixed(3), u.z.toFixed(3), u.hp.toFixed(3), u.buildProgress.toFixed(3), u.tasks.length]);
  const players = w.players.map((p) => JSON.stringify(p.stats()));
  return JSON.stringify({ tick: w.tickCount, units, players, features: w.features.filter((f) => f.alive).length });
}

describe.skipIf(!hasGameData())('saved games (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  let deps: SkirmishDeps;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
    const defs = await loadUnitDefs(vfs);
    const loader = new UnitAssetLoader(vfs, defs);
    const assets = new Map<string, UnitAssets>();
    for (const k of defs.keys()) {
      const a = await loader.load(k);
      if (a) assets.set(k, a);
    }
    deps = {
      assets: (n) => assets.get(n.toLowerCase()),
      weapons: await loadWeaponDefs(vfs),
      featureDefs: await loadFeatureDefinitions(vfs),
      menus: await loadBuildMenus(vfs, new Set(defs.keys())),
      aiPlans: await loadAiProfile(vfs),
    };
  }, 120_000);
  afterAll(() => close?.());

  it('loading a save replays the game to exactly the same state', async () => {
    const settings: SkirmishSettings = { map: 'Ashap Plateau', side: 'core', opponent: 'medium', startWith: 'commander' };
    const map = await loadGameMap(vfs, settings.map, deps.featureDefs);
    const { world, home } = createSkirmish(map, settings, 42, deps);
    const com = [...world.units.values()].find((u) => u.owner === HUMAN)!;
    for (let t = 0; t < 30 * 60 * 4; t++) {
      // The player gives a few orders along the way.
      if (t === 30) world.issue({ kind: 'build', unitId: com.id, unitName: 'CORSOLAR', x: home.x + 100, z: home.z + 60 });
      if (t === 900) world.issue({ kind: 'build', unitId: com.id, unitName: 'CORLAB', x: home.x - 120, z: home.z + 150, queue: true });
      if (t === 2500) world.issue({ kind: 'move', unitIds: [com.id], x: home.x, z: home.z + 300, queue: true });
      world.tick();
    }
    const save: SavedGame = JSON.parse(JSON.stringify(saveGame(world, settings, 42)));
    expect(save.commands.length).toBe(3);
    // Both sides have built things by now, so there is real state to compare.
    expect([...world.units.values()].filter((u) => u.owner === HUMAN).length).toBeGreaterThan(2);
    expect([...world.units.values()].filter((u) => u.owner === 1).length).toBeGreaterThan(5);

    const loaded = createSkirmish(map, save.settings, save.seed, deps).world;
    let progress = 0;
    await replayGame(loaded, save, (f) => (progress = f));
    expect(progress).toBe(1);
    expect(snapshot(loaded)).toBe(snapshot(world));
    // And the two games keep going identically afterwards.
    for (let t = 0; t < 30 * 60; t++) {
      world.tick();
      loaded.tick();
    }
    expect(snapshot(loaded)).toBe(snapshot(world));
    expect(loaded.commandLog.length).toBe(3);
  }, 300_000);
});
