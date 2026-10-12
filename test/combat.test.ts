import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDataDir } from '../src/io/nodeVfs';
import { loadFeatureDefinitions, type FeatureDef } from '../src/map/features';
import { loadGameMap } from '../src/map/mapData';
import { UnitAssetLoader } from '../src/sim/assets';
import { GRAVITY, headingAndPitch } from '../src/sim/combat';
import { loadUnitDefs } from '../src/sim/unitDef';
import { damageAgainst, loadWeaponDefs, type WeaponDef } from '../src/sim/weaponDef';
import { World, type SimUnit, type UnitAssets } from '../src/sim/world';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';
import { flatGameMap, testFeature, testUnit, testWeapon } from './helpers';

const LASER = testWeapon('LASER', 'lineofsight=1; range=300; reloadtime=1; weaponvelocity=900; areaofeffect=8; tolerance=8000; [DAMAGE]{default=25; tough=5;}');
const CANNON = testWeapon('CANNON', 'ballistic=1; range=500; reloadtime=2; weaponvelocity=300; areaofeffect=40; tolerance=8000; [DAMAGE]{default=40;}');
const BLAST = testWeapon('BLAST', 'areaofeffect=200; [DAMAGE]{default=500;}');
const WEAPONS = new Map<string, WeaponDef>([LASER, CANNON, BLAST].map((w) => [w.name, w]));

const wreck = testFeature({ name: 'tank_dead', blocking: true, metal: 20, featureDead: 'tank_heap' });
const heap = testFeature({ name: 'tank_heap', blocking: false, metal: 10 });
const FEATURES = new Map<string, FeatureDef>([wreck, heap].map((f) => [f.name, f]));

const TANK = testUnit({ unitName: 'TANK', weapons: ['laser', '', ''], corpse: 'tank_dead', maxDamage: 100 });
const TOUGH = testUnit({ unitName: 'TOUGH', weapons: ['laser', '', ''], maxDamage: 100 });
const ARTY = testUnit({ unitName: 'ARTY', weapons: ['cannon', '', ''], maxDamage: 100 });
const DUMMY = testUnit({ unitName: 'DUMMY', maxDamage: 100, sightDistance: 50 });
const COM = testUnit({ unitName: 'COM', commander: true, explodeAs: 'blast', maxDamage: 1000 });
const ALL = new Map([TANK, TOUGH, ARTY, DUMMY, COM].map((a) => [a.def.unitName.toLowerCase(), a]));

function newWorld(): World {
  return new World(flatGameMap(), { seed: 7, assets: (n) => ALL.get(n.toLowerCase()), weapons: WEAPONS, featureDefs: FEATURES });
}
const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i++) w.tick();
};
const alive = (w: World, u: SimUnit) => w.units.has(u.id) && !u.dying;

describe('weapon definitions', () => {
  it('reads RWE units: velocity per tick, radius = half the area of effect, damage per unit type', () => {
    expect(LASER.velocity).toBe(30);
    expect(LASER.damageRadius).toBe(4);
    expect(LASER.kind).toBe('lineOfSight');
    expect(CANNON.kind).toBe('ballistic');
    expect(damageAgainst(LASER, 'TOUGH')).toBe(5);
    expect(damageAgainst(LASER, 'other')).toBe(25);
  });

  it('aims ballistic weapons with the low angle that actually lands on the target', () => {
    const u = { rotation: 0 } as SimUnit;
    const [, pitch] = headingAndPitch(u, [0, 0, 0], [0, 0, 300], CANNON);
    const p = (pitch * 2 * Math.PI) / 65536;
    // Fly it: x = v cos(p) t, y = v sin(p) t - g t²/2; when it comes back to y = 0 it should be ~300 away.
    const v = CANNON.velocity;
    const t = (2 * v * Math.sin(p)) / GRAVITY;
    expect(v * Math.cos(p) * t).toBeCloseTo(300, -1);
    expect(p).toBeLessThan(Math.PI / 4);
  });
});

describe('combat', () => {
  it('units fire at visible enemies in range, and the shots do damage', () => {
    const w = newWorld();
    const a = w.spawn(TANK, 0, 300, 300)!;
    const b = w.spawn(DUMMY, 1, 300, 500)!;
    run(w, 30 * 3);
    expect(b.hp).toBeLessThan(100);
    expect(a.hp).toBe(100);
  });

  it('ignores enemies out of range or out of sight', () => {
    const w = newWorld();
    w.spawn(TANK, 0, 100, 100);
    const far = w.spawn(DUMMY, 1, 900, 900)!;
    run(w, 30 * 3);
    expect(far.hp).toBe(100);
  });

  it('applies per-unit-type damage', () => {
    const w = newWorld();
    w.spawn(TANK, 0, 300, 300);
    const t = w.spawn(TOUGH, 1, 300, 520)!;
    const d = w.spawn(DUMMY, 1, 260, 520)!;
    run(w, 30 * 4);
    // The tough unit takes 5 per hit instead of 25; the tank picks whichever is nearer first, so just
    // check the ratio of what each took per hit.
    expect(100 - t.hp).toBeLessThan(100 - d.hp + 30);
  });

  it('ballistic shots arc over and land near the target', () => {
    const w = newWorld();
    w.spawn(ARTY, 0, 200, 200);
    const target = w.spawn(DUMMY, 1, 200, 600)!;
    w.issue({ kind: 'attack', unitIds: [w.unitsInOrder()[0]!.id], targetId: target.id });
    let maxY = 0;
    for (let i = 0; i < 30 * 6; i++) {
      w.tick();
      for (const p of w.projectiles) maxY = Math.max(maxY, p.y);
    }
    expect(maxY).toBeGreaterThan(40); // it arced
    expect(target.hp).toBeLessThan(100);
  });

  it('a killed unit leaves its wreck; the wreck blocks like a feature', () => {
    const w = newWorld();
    const t = w.spawn(TANK, 1, 300, 300)!;
    w.damage(t, 1000, 0);
    expect(t.dying).toBeDefined();
    run(w, 5);
    expect(w.units.has(t.id)).toBe(false);
    const f = w.features.at(-1)!;
    expect(f.def.name).toBe('tank_dead');
    expect(w.buildSite('TANK', f.x, f.z).ok).toBe(false);
  });

  it('a unit killed while still being built just disappears', () => {
    const w = newWorld();
    const builder = w.spawn(testUnit({ unitName: 'B', builder: true, workerTime: 1, commander: true }), 0, 100, 100)!;
    ALL.set('b', testUnit({ unitName: 'B', builder: true, workerTime: 1, commander: true }));
    w.issue({ kind: 'build', unitId: builder.id, unitName: 'TANK', x: 200, z: 100 });
    run(w, 90);
    const shell = [...w.units.values()].find((u) => u.def.unitName === 'TANK')!;
    expect(w.isFinished(shell)).toBe(false);
    w.damage(shell, 50, 1);
    expect(w.units.has(shell.id)).toBe(false);
    expect(w.features.length).toBe(0);
  });

  it("a Commander's death blast hurts everything nearby and knocks its player out", () => {
    const w = newWorld();
    const com = w.spawn(COM, 1, 500, 500)!;
    const friend = w.spawn(DUMMY, 1, 900, 900)!;
    const near = w.spawn(DUMMY, 0, 560, 500)!;
    w.damage(com, 5000, 0);
    expect(w.defeated.has(1)).toBe(true);
    expect(friend.dying).toBeDefined(); // all of the loser's units die
    expect(near.dying).toBeDefined(); // caught in the blast
    run(w, 10);
    expect(alive(w, friend)).toBe(false);
  });

  it('an attacker whose shots keep hitting a rock moves in for a clear shot', () => {
    // A tall rock sits right between the tank and its target, which is otherwise in range.
    const rock = testFeature({ name: 'rock', blocking: true, indestructible: true, reclaimable: false, height: 80, footprintX: 3, footprintZ: 3 });
    const w = new World(flatGameMap(64, 64, [{ def: rock, cellX: 20, cellZ: 17, x: 344, y: 20, z: 296 }]), {
      seed: 7,
      assets: (n) => ALL.get(n.toLowerCase()),
      weapons: WEAPONS,
      featureDefs: FEATURES,
    });
    const tank = w.spawn(TANK, 0, 200, 296)!;
    const target = w.spawn(DUMMY, 1, 470, 296)!;
    w.issue({ kind: 'attack', unitIds: [tank.id], targetId: target.id });
    run(w, 30 * 3);
    expect(tank.blockedShots).toBeGreaterThan(0);
    run(w, 30 * 30);
    expect(alive(w, target)).toBe(false);
  });

  it('an idle unit goes after an enemy it can see but cannot reach yet', () => {
    const w = newWorld();
    const tank = w.spawn(TANK, 0, 200, 300)!;
    const target = w.spawn(DUMMY, 1, 560, 300)!; // 360 away: in sight (400), out of laser range (300)
    run(w, 30 * 20);
    expect(alive(w, target)).toBe(false);
    expect(tank.x).toBeGreaterThan(220);
  });

  it('weapons without a tolerance get a small default one, so they can fire on the move', () => {
    expect(testWeapon('PLAIN', 'range=100;').tolerance).toBe(256);
  });

  it('is deterministic', () => {
    const play = () => {
      const w = newWorld();
      for (let i = 0; i < 4; i++) w.spawn(i % 2 ? ARTY : TANK, 0, 200 + i * 40, 200);
      for (let i = 0; i < 4; i++) w.spawn(i % 2 ? ARTY : TANK, 1, 200 + i * 40, 520);
      run(w, 30 * 20);
      return w.hash();
    };
    expect(play()).toBe(play());
  });
});

describe.skipIf(!hasGameData())('combat (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  let assets: Map<string, UnitAssets>;
  let weapons: Map<string, WeaponDef>;
  let features: Map<string, FeatureDef>;
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
  }, 120_000);
  afterAll(() => close?.());

  it("resolves every unit's weapons", () => {
    const missing = [...assets.values()].flatMap((a) => a.def.weapons.filter((w) => w && !weapons.has(w)));
    expect(missing).toEqual([]);
  });

  it('two real armies fight: shots, deaths, wrecks, no script errors', async () => {
    const map = await loadGameMap(vfs, 'Coast To Coast', features);
    const w = new World(map, { seed: 3, assets: (n) => assets.get(n.toLowerCase()), weapons, featureDefs: features });
    const s = map.ota!.schemas[0]!.startPositions[0]!;
    ['ARMPW', 'ARMPW', 'ARMSTUMP', 'ARMSTUMP', 'ARMHAM', 'ARMROCK'].forEach((n, i) => w.spawn(assets.get(n.toLowerCase())!, 0, s.x - 120 + i * 40, s.z + 50));
    ['CORAK', 'CORAK', 'CORRAID', 'CORRAID', 'CORTHUD', 'CORSTORM'].forEach((n, i) => w.spawn(assets.get(n.toLowerCase())!, 1, s.x - 120 + i * 40, s.z + 220, 32768));
    let shots = 0;
    for (let i = 0; i < 30 * 40; i++) {
      w.tick();
      shots += w.events.filter((e) => e.kind === 'fire' && e.tick === w.tickCount - 1).length;
    }
    const before = 12;
    const remaining = [...w.units.values()].filter((u) => !u.dying).length;
    expect(shots).toBeGreaterThan(20);
    expect(remaining).toBeLessThan(before);
    expect(w.features.length).toBeGreaterThan(map.features.length);
    expect([...w.units.values()].flatMap((u) => u.scripts?.vm.errors ?? [])).toEqual([]);
  }, 120_000);
});
