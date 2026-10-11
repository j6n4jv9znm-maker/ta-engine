import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDataDir } from '../src/io/nodeVfs';
import { loadFeatureDefinitions, type FeatureDef } from '../src/map/features';
import { loadGameMap } from '../src/map/mapData';
import { limitOf, loadAiProfile, parseAiProfile, profileKeys, weightOf, type AiPlan, type Difficulty } from '../src/sim/ai/aiProfile';
import { SkirmishAi } from '../src/sim/ai/skirmishAi';
import { UnitAssetLoader } from '../src/sim/assets';
import { loadBuildMenus, type BuildMenus } from '../src/sim/buildMenus';
import { loadUnitDefs } from '../src/sim/unitDef';
import { loadWeaponDefs, type WeaponDef } from '../src/sim/weaponDef';
import { World, type UnitAssets } from '../src/sim/world';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

describe('AI profiles', () => {
  const plans = parseAiProfile(`// comment
plan easy
Weight ARM 0.2
Weight PLANT 2
Limit constr 3
Limit ARMBULL 20
plan hard
Weight ARMBULL 3`);

  it('reads weights and limits per difficulty', () => {
    expect([...plans.keys()]).toEqual(['easy', 'hard']);
    const easy = plans.get('easy')!;
    expect(easy.weights.get('ARM')).toBe(0.2);
    expect(easy.limits.get('CONSTR')).toBe(3);
  });

  it('matches units by name, tedclass and category words', () => {
    const easy = plans.get('easy')!;
    const keys = profileKeys('armlab', 'PLANT', ['ARM', 'PLANT', 'LEVEL1']);
    expect(weightOf(easy, keys)).toBeCloseTo(0.2 * 2 * 2);
    expect(limitOf(easy, profileKeys('armbull', 'TANK', ['ARM']))).toBe(20);
    expect(limitOf(easy, profileKeys('armpw', 'KBOT', ['ARM']))).toBe(Infinity);
  });
});

describe.skipIf(!hasGameData())('skirmish AI (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  let assets: Map<string, UnitAssets>;
  let weapons: Map<string, WeaponDef>;
  let features: Map<string, FeatureDef>;
  let menus: BuildMenus;
  let plans: Map<Difficulty, AiPlan>;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
    const defs = await loadUnitDefs(vfs);
    const loader = new UnitAssetLoader(vfs, defs);
    assets = new Map();
    for (const k of defs.keys()) {
      const a = await loader.load(k);
      if (a) assets.set(k, a);
    }
    weapons = await loadWeaponDefs(vfs);
    features = await loadFeatureDefinitions(vfs);
    menus = await loadBuildMenus(vfs, new Set(defs.keys()));
    plans = await loadAiProfile(vfs);
  }, 120_000);
  afterAll(() => close?.());

  it("reads TA's own AI profile for all three difficulties", () => {
    expect([...plans.keys()].sort()).toEqual(['easy', 'hard', 'medium']);
  });

  it('plays a whole game against another AI on Ashap Plateau, to victory', async () => {
    const map = await loadGameMap(vfs, 'Ashap Plateau', features);
    const w = new World(map, { seed: 11, assets: (n) => assets.get(n.toLowerCase()), weapons, featureDefs: features });
    const st = map.ota!.schemas[0]!.startPositions;
    w.spawn(assets.get('armcom')!, 0, st[0]!.x, st[0]!.z);
    w.spawn(assets.get('corcom')!, 1, st[1]!.x, st[1]!.z);
    w.ais.push(new SkirmishAi(0, 'medium', menus, plans.get('medium'), 1), new SkirmishAi(1, 'medium', menus, plans.get('medium'), 2));
    let builtFactory = false;
    for (let t = 0; t < 30 * 60 * 30 && w.defeated.size === 0; t++) {
      w.tick();
      if (!builtFactory) builtFactory = [...w.units.values()].some((u) => u.factory && w.isFinished(u));
    }
    expect(builtFactory).toBe(true);
    expect(w.defeated.size).toBe(1);
    expect([...w.units.values()].flatMap((u) => u.scripts?.vm.errors ?? [])).toEqual([]);
  }, 300_000);
});
