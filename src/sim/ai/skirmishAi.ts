import type { BuildMenus } from '../buildMenus';
import { TICKS_PER_SECOND } from '../pieces';
import { Rng } from '../rng';
import type { UnitDef } from '../unitDef';
import type { Command, SimUnit, World } from '../world';
import { limitOf, profileKeys, weightOf, type AiPlan, type Difficulty } from './aiProfile';

/*
 * A simple rule-based skirmish opponent. It plays through the same commands a human does (it never
 * touches the simulation directly), and runs inside the simulation's tick, so games stay deterministic.
 * Every couple of seconds it:
 *
 *   1. Economy: sends idle builders to put metal extractors on the nearest free metal patches, power
 *      (solar or wind, whichever this map favours) when energy runs short, and storage when full.
 *   2. Production: builds a Kbot Lab or Vehicle Plant (and more later), and keeps every factory busy:
 *      a few construction units, then combat units picked at random, weighted and capped by TA's own AI
 *      profile for this difficulty (ai/DEFAULT.TXT). Factories that make aircraft or ships are skipped
 *      until those movement types exist.
 *   3. Defence: if enemies come near the base, everything idle goes after them.
 *   4. Attack: once enough idle combat units have gathered, they go in a wave towards the nearest enemy
 *      it knows about (seen units, or the other start positions). Waves grow over time.
 *
 * Difficulty changes how often it thinks, how big waves are, how many builders it keeps, and which
 * profile plan it follows.
 */

interface Tuning {
  thinkSeconds: number;
  firstWave: number;
  waveGrowth: number;
  maxWave: number;
  constructors: number;
  factories: number;
}

const TUNING: Record<Difficulty, Tuning> = {
  easy: { thinkSeconds: 4, firstWave: 5, waveGrowth: 1, maxWave: 10, constructors: 2, factories: 1 },
  medium: { thinkSeconds: 2, firstWave: 8, waveGrowth: 2, maxWave: 20, constructors: 3, factories: 2 },
  hard: { thinkSeconds: 1, firstWave: 10, waveGrowth: 3, maxWave: 30, constructors: 5, factories: 3 },
};

/** How far from the base centre the AI builds and defends. */
const BASE_RADIUS = 700;

export class SkirmishAi {
  private readonly rng: Rng;
  private readonly tuning: Tuning;
  private wave = 0;
  /** Where the current wave is heading, and which units are in it. */
  private attack: { x: number; z: number; ids: Set<number> } | undefined;
  private base: { x: number; z: number } | undefined;
  /** Building jobs handed out but not yet started, so two builders don't pick the same spot. */
  private claimed = new Map<number, { x: number; z: number; tick: number }>();

  constructor(
    readonly player: number,
    readonly difficulty: Difficulty,
    private readonly menus: BuildMenus,
    private readonly plan: AiPlan | undefined,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.tuning = TUNING[difficulty];
  }

  /** Called every tick by the world; thinks every few seconds. */
  update(world: World): void {
    if (world.defeated.has(this.player)) return;
    const every = Math.round(this.tuning.thinkSeconds * TICKS_PER_SECOND);
    if ((world.tickCount + this.player * 7) % every !== 0) return;
    this.think(world);
  }

  private think(world: World): void {
    const mine = world.unitsInOrder().filter((u) => u.owner === this.player && !u.dying);
    const finished = mine.filter((u) => world.isFinished(u));
    const commander = finished.find((u) => u.def.commander);
    this.base ??= commander ? { x: commander.x, z: commander.z } : undefined;
    if (!this.base) return;
    for (const [id, c] of this.claimed) if (world.tickCount - c.tick > 60 * TICKS_PER_SECOND || !world.units.has(id)) this.claimed.delete(id);

    const builders = finished.filter((u) => u.def.builder && u.def.bmCode !== 0 && this.menus.has(u.def.unitName.toLowerCase()));
    const factories = finished.filter((u) => u.factory);
    const army = finished.filter((u) => isCombat(u.def) && !u.def.commander);

    this.defend(world, army, commander);
    for (const b of builders) if (b.tasks.length === 0) this.useBuilder(world, b, mine, factories);
    for (const f of factories) this.useFactory(world, f, mine);
    this.attackWave(world, army);
  }

  // --- economy and base building ---------------------------------------------------------

  private useBuilder(world: World, b: SimUnit, mine: SimUnit[], factories: SimUnit[]): void {
    const options = (this.menus.get(b.def.unitName.toLowerCase()) ?? []).flat().map((n) => world.assetsOf(n)?.def).filter((d): d is UnitDef => !!d);
    const p = world.players[this.player]!;
    const s = p.stats();
    const count = (pred: (d: UnitDef) => boolean) => mine.filter((u) => pred(u.def)).length;
    const pick = (pred: (d: UnitDef) => boolean) => this.cheapest(options.filter((d) => pred(d) && this.allowed(d, mine)));

    // Power first if it's running short.
    const lowEnergy = s.energy.stock < s.energy.storage * 0.25 || s.energy.income < s.metal.income * 8;
    if (lowEnergy) {
      const gen = this.bestGenerator(world, options.filter((d) => this.allowed(d, mine)));
      if (gen && this.buildNear(world, b, gen)) return;
    }
    // Metal extractors on free patches.
    const mex = pick((d) => d.extractsMetal > 0 && d.bmCode === 0 && d.ownMovement.minWaterDepth === 0);
    if (mex) {
      const spot = this.freeMetalSpot(world, b, mex);
      if (spot) {
        this.issue(world, { kind: 'build', unitId: b.id, unitName: mex.unitName, x: spot.x, z: spot.z });
        this.claimed.set(b.id, { ...spot, tick: world.tickCount });
        return;
      }
    }
    // Factories.
    if (factories.length < this.tuning.factories && s.metal.stock > 150) {
      const plant = this.weighted(options.filter((d) => isUsableFactory(world, d, this.menus) && this.allowed(d, mine)));
      if (plant && count((d) => isUsableFactory(world, d, this.menus)) <= factories.length && this.buildNear(world, b, plant, 3)) return;
    }
    // Storage when full.
    if (s.metal.stock > s.metal.storage * 0.9) {
      const store = pick((d) => d.metalStorage > 0 && d.bmCode === 0 && d.ownMovement.minWaterDepth === 0);
      if (store && count((d) => d.metalStorage > 0 && !d.commander) < 3 && this.buildNear(world, b, store)) return;
    }
    if (s.energy.stock > s.energy.storage * 0.95 && s.metal.stock < s.metal.storage * 0.3) {
      const maker = pick((d) => d.makesMetal > 0 && d.bmCode === 0 && d.ownMovement.minWaterDepth === 0);
      if (maker && this.buildNear(world, b, maker)) return;
    }
    // More power keeps factories running.
    if (s.energy.income < 40 + factories.length * 40) {
      const gen = this.bestGenerator(world, options.filter((d) => this.allowed(d, mine)));
      if (gen && this.buildNear(world, b, gen)) return;
    }
    // Otherwise help a factory finish what it's making.
    const busy = factories.find((f) => f.factory?.currentId !== undefined);
    if (busy && !b.def.commander) this.issue(world, { kind: 'assist', unitIds: [b.id], targetId: busy.factory!.currentId! });
  }

  /** Solar or wind, whichever gives more energy per metal on this map. */
  private bestGenerator(world: World, options: UnitDef[]): UnitDef | undefined {
    const o = world.map.ota;
    const avgWind = ((o?.minWindSpeed ?? 0) + (o?.maxWindSpeed ?? 0)) / 2;
    const score = (d: UnitDef) => {
      const out = d.energyMake + Math.max(0, -d.energyUse) + d.windGenerator * Math.min(1, avgWind / 5000);
      return out / Math.max(1, d.buildCostMetal);
    };
    return options
      .filter((d) => d.bmCode === 0 && d.ownMovement.minWaterDepth === 0 && d.extractsMetal === 0 && score(d) > 0 && !d.builder)
      .sort((a, b) => score(b) - score(a) || a.unitName.localeCompare(b.unitName))[0];
  }

  private freeMetalSpot(world: World, b: SimUnit, mex: UnitDef): { x: number; z: number } | undefined {
    const spots = world.features
      .filter((f) => f.alive && f.def.metal > 0 && !f.def.blocking && f.def.indestructible)
      .map((f) => ({ x: f.x, z: f.z, d: Math.hypot(f.x - this.base!.x, f.z - this.base!.z) + Math.hypot(f.x - b.x, f.z - b.z) / 2 }))
      .sort((p, q) => p.d - q.d || p.x - q.x || p.z - q.z);
    for (const s of spots) {
      if (s.d > 4000) break;
      if ([...this.claimed.values()].some((c) => Math.hypot(c.x - s.x, c.z - s.z) < 32)) continue;
      const site = world.buildSite(mex.unitName, s.x, s.z);
      if (site.ok) return { x: site.x, z: site.z };
    }
    return undefined;
  }

  /** Orders a building on a free spot near the base, leaving room around it so units can get through. */
  private buildNear(world: World, b: SimUnit, d: UnitDef, margin = 2): boolean {
    const base = this.base!;
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = this.rng.int(0, 359) * (Math.PI / 180);
      const dist = 80 + this.rng.int(0, BASE_RADIUS - 200);
      const x = base.x + Math.sin(angle) * dist;
      const z = base.z + Math.cos(angle) * dist;
      const site = world.buildSite(d.unitName, x, z);
      if (!site.ok || !world.hasRoomAround(d, site.cellX, site.cellZ, margin)) continue;
      if ([...this.claimed.values()].some((c) => Math.hypot(c.x - site.x, c.z - site.z) < (d.footprintX + margin) * 16)) continue;
      this.issue(world, { kind: 'build', unitId: b.id, unitName: d.unitName, x: site.x, z: site.z });
      this.claimed.set(b.id, { x: site.x, z: site.z, tick: world.tickCount });
      return true;
    }
    return false;
  }

  // --- production -----------------------------------------------------------------------

  private useFactory(world: World, f: SimUnit, mine: SimUnit[]): void {
    if (!f.factory || f.factory.queue.length > 0) return;
    const options = (this.menus.get(f.def.unitName.toLowerCase()) ?? []).flat().map((n) => world.assetsOf(n)?.def).filter((d): d is UnitDef => !!d);
    const builders = mine.filter((u) => u.def.builder && u.def.bmCode !== 0 && !u.def.commander).length;
    let choice: UnitDef | undefined;
    if (builders < this.tuning.constructors) {
      choice = this.cheapest(options.filter((d) => d.builder && d.bmCode !== 0 && !d.canFly && this.allowed(d, mine)));
    }
    choice ??= this.weighted(options.filter((d) => isCombat(d) && this.allowed(d, mine)));
    if (!choice) return;
    this.issue(world, { kind: 'factory', unitId: f.id, unitName: choice.unitName, count: 1 });
    // Gather the army in front of the base, towards the middle of the map.
    if (!f.rally) {
      const mx = world.map.widthUnits / 2;
      const mz = world.map.heightUnits / 2;
      const d = Math.hypot(mx - this.base!.x, mz - this.base!.z) || 1;
      this.issue(world, { kind: 'rally', unitId: f.id, x: this.base!.x + ((mx - this.base!.x) / d) * 300, z: this.base!.z + ((mz - this.base!.z) / d) * 300 });
    }
  }

  // --- fighting --------------------------------------------------------------------------

  /** If enemies are inside the base, send every idle fighter (and the Commander, if close) at them. */
  private defend(world: World, army: SimUnit[], commander: SimUnit | undefined): void {
    const base = this.base!;
    const intruders = world
      .unitsInOrder()
      .filter((e) => e.owner !== this.player && !e.dying && world.canSee(this.player, e) && Math.hypot(e.x - base.x, e.z - base.z) < BASE_RADIUS);
    if (intruders.length === 0) return;
    const defenders = army.filter((u) => !this.attack?.ids.has(u.id) && (u.tasks.length === 0 || u.tasks[0]!.kind === 'move'));
    if (commander && commander.tasks.length === 0) defenders.push(commander);
    for (const d of defenders) {
      const target = nearest(intruders, d);
      if (target) this.issue(world, { kind: 'attack', unitIds: [d.id], targetId: target.id });
    }
  }

  private attackWave(world: World, army: SimUnit[]): void {
    // Keep an attack going: re-target units that have arrived or lost their target.
    if (this.attack) {
      const ids = [...this.attack.ids].filter((id) => world.units.has(id) && !world.units.get(id)!.dying);
      this.attack.ids = new Set(ids);
      if (ids.length < 2) {
        this.attack = undefined;
      } else {
        const units = ids.map((id) => world.units.get(id)!);
        const seen = world.unitsInOrder().filter((e) => e.owner !== this.player && !e.dying && world.canSee(this.player, e));
        for (const u of units) {
          if (u.tasks.length > 0) continue;
          const target = nearest(seen, u, 900);
          if (target) this.issue(world, { kind: 'attack', unitIds: [u.id], targetId: target.id });
          else {
            const next = this.attackTarget(world, u);
            if (next) this.issue(world, { kind: 'move', unitIds: [u.id], x: next.x, z: next.z });
          }
        }
        return;
      }
    }
    const idle = army.filter((u) => u.tasks.length === 0);
    const size = Math.min(this.tuning.maxWave, this.tuning.firstWave + this.wave * this.tuning.waveGrowth);
    if (idle.length < size) return;
    const target = this.attackTarget(world, idle[0]!);
    if (!target) return;
    this.wave++;
    this.attack = { ...target, ids: new Set(idle.map((u) => u.id)) };
    this.issue(world, { kind: 'move', unitIds: idle.map((u) => u.id), x: target.x, z: target.z });
  }

  /** The nearest enemy we know of: a seen unit (buildings first), else another start position. */
  private attackTarget(world: World, from: SimUnit): { x: number; z: number } | undefined {
    const seen = world.unitsInOrder().filter((e) => e.owner !== this.player && !e.dying && world.canSee(this.player, e));
    const building = nearest(seen.filter((e) => e.def.bmCode === 0), from) ?? nearest(seen, from);
    if (building) return { x: building.x, z: building.z };
    const starts = (world.map.ota?.schemas[0]?.startPositions ?? []).filter((p): p is { x: number; z: number } => !!p);
    const others = starts.filter((p) => Math.hypot(p.x - this.base!.x, p.z - this.base!.z) > 300);
    // Visit start positions we haven't looked at yet, nearest first.
    const unexplored = others.filter((p) => !(world.visibility.at(this.player, p.x, p.z) & 4));
    const list = unexplored.length ? unexplored : others;
    return list.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))[0];
  }

  // --- helpers ---------------------------------------------------------------------------

  private allowed(d: UnitDef, mine: SimUnit[]): boolean {
    const keys = profileKeys(d.unitName, d.tedClass, d.categories);
    const limit = limitOf(this.plan, keys);
    if (limit <= 0) return false;
    if (limit === Infinity) return true;
    const have = mine.filter((u) => u.def.unitName === d.unitName).length;
    return have < limit;
  }

  private cheapest(options: UnitDef[]): UnitDef | undefined {
    return [...options].sort((a, b) => a.buildCostMetal - b.buildCostMetal || a.unitName.localeCompare(b.unitName))[0];
  }

  private weighted(options: UnitDef[]): UnitDef | undefined {
    const sorted = [...options].sort((a, b) => a.unitName.localeCompare(b.unitName));
    const weights = sorted.map((d) => Math.max(0, weightOf(this.plan, profileKeys(d.unitName, d.tedClass, d.categories))));
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) return undefined;
    let r = (this.rng.nextU32() / 0x100000000) * total;
    for (let i = 0; i < sorted.length; i++) {
      r -= weights[i]!;
      if (r < 0) return sorted[i];
    }
    return sorted[sorted.length - 1];
  }

  private issue(world: World, c: Command): void {
    world.issue(c);
  }
}

/** A mobile ground unit with a weapon it fires on its own. */
export function isCombat(d: UnitDef): boolean {
  return d.bmCode !== 0 && !d.builder && !d.canFly && d.maxVelocity > 0 && d.movementClass.minWaterDepth === 0 && d.weapons.some((w) => w !== '');
}

/** A factory on land whose products are mostly ground units (aircraft and ships come later). */
function isUsableFactory(world: World, d: UnitDef, menus: BuildMenus): boolean {
  if (!d.builder || d.bmCode !== 0 || d.ownMovement.minWaterDepth > 0) return false;
  const products = (menus.get(d.unitName.toLowerCase())?.flat() ?? []).map((n) => world.assetsOf(n)?.def).filter((x): x is UnitDef => !!x);
  if (products.length === 0) return false;
  const ground = products.filter((p) => !p.canFly && p.ownMovement.minWaterDepth === 0 && p.movementClass.minWaterDepth === 0);
  return ground.length * 2 > products.length;
}

function nearest(list: SimUnit[], from: SimUnit, maxDistance = Infinity): SimUnit | undefined {
  let best: SimUnit | undefined;
  let bestD = maxDistance;
  for (const e of list) {
    const d = Math.hypot(e.x - from.x, e.z - from.z);
    if (d < bestD) {
      best = e;
      bestD = d;
    }
  }
  return best;
}
