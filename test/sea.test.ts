import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDataDir } from '../src/io/nodeVfs';
import { loadFeatureDefinitions, type FeatureDef } from '../src/map/features';
import { loadGameMap, type GameMap } from '../src/map/mapData';
import { UnitAssetLoader } from '../src/sim/assets';
import { loadUnitDefs } from '../src/sim/unitDef';
import { loadWeaponDefs, type WeaponDef } from '../src/sim/weaponDef';
import { World, type UnitAssets } from '../src/sim/world';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

describe.skipIf(!hasGameData())('ships (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  const assets = new Map<string, UnitAssets>();
  let weapons: Map<string, WeaponDef>;
  let featureDefs: Map<string, FeatureDef>;
  let map: GameMap;
  /** The middle of a stretch of deep open water. */
  let sea: [number, number];
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
    const defs = await loadUnitDefs(vfs);
    const loader = new UnitAssetLoader(vfs, defs);
    for (const n of ['armsy', 'armpt', 'corpt', 'armroy', 'armsub', 'armcom']) assets.set(n, (await loader.load(n))!);
    weapons = await loadWeaponDefs(vfs);
    featureDefs = await loadFeatureDefinitions(vfs);
    map = await loadGameMap(vfs, 'Anteer Strait', featureDefs);
    const t = map.tnt;
    const deep = (x: number, z: number, r: number) => {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (t.heights[(z + dz) * t.width + x + dx]! > t.seaLevel - 30) return false;
      return true;
    };
    outer: for (let z = 30; z < t.height - 30; z += 2) for (let x = 30; x < t.width - 30; x += 2) if (deep(x, z, 14)) {
      sea = [x * 16, z * 16];
      break outer;
    }
  }, 120_000);
  afterAll(() => close?.());

  const world = () => new World(map, { seed: 5, assets: (n) => assets.get(n.toLowerCase()), weapons, featureDefs });
  const run = (w: World, ticks: number) => {
    for (let i = 0; i < ticks; i++) w.tick();
  };

  it('ships float on the water and sail where they are sent', () => {
    const w = world();
    const pt = w.spawn(assets.get('armpt')!, 0, sea[0], sea[1])!;
    expect(pt.y).toBe(map.tnt.seaLevel);
    w.issue({ kind: 'move', unitIds: [pt.id], x: sea[0] + 120, z: sea[1] + 60 });
    run(w, 30 * 15);
    expect(Math.hypot(pt.x - sea[0] - 120, pt.z - sea[1] - 60)).toBeLessThan(40);
    expect(pt.y).toBe(map.tnt.seaLevel);
  });

  it('two patrol boats fight', () => {
    const w = world();
    const a = w.spawn(assets.get('armpt')!, 0, sea[0] - 80, sea[1])!;
    const b = w.spawn(assets.get('corpt')!, 1, sea[0] + 80, sea[1])!;
    run(w, 30 * 60);
    expect((w.units.has(a.id) && !a.dying) && (w.units.has(b.id) && !b.dying)).toBe(false);
  });

  it("only torpedoes reach a submarine; the submarine's torpedoes sink ships", () => {
    const w = world();
    const sub = w.spawn(assets.get('armsub')!, 0, sea[0] - 100, sea[1])!;
    const roy = w.spawn(assets.get('armroy')!, 1, sea[0] + 100, sea[1])!;
    expect(w.submerged(sub)).toBe(true);
    run(w, 30 * 2);
    // The destroyer's cannon never picks the sub (its depth charges may).
    expect(roy.weapons[0]?.target).toBeUndefined();
    w.issue({ kind: 'attack', unitIds: [sub.id], targetId: roy.id });
    run(w, 30 * 90);
    expect(w.units.has(roy.id) && !roy.dying && w.units.has(sub.id) && !sub.dying).toBe(false);
  });

  it('a shipyard builds a boat that sails out', () => {
    const w = world();
    const sy = w.spawn(assets.get('armsy')!, 0, sea[0], sea[1])!;
    w.issue({ kind: 'factory', unitId: sy.id, unitName: 'ARMPT', count: 1 });
    for (let t = 0; t < 30 * 120; t++) {
      w.players[0]!.produce(200, 20);
      w.tick();
    }
    const pt = [...w.units.values()].find((u) => u.def.unitName === 'ARMPT');
    expect(pt && w.isFinished(pt)).toBe(true);
    expect(Math.hypot(pt!.x - sy.x, pt!.z - sy.z)).toBeGreaterThan(48);
  });
});
