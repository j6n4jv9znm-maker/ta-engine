import type { BuildMenus } from '../buildMenus';
import { TICKS_PER_SECOND } from '../pieces';
import { Rng } from '../rng';
import type { MovementClass, UnitDef } from '../unitDef';
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
 *      profile for this difficulty (ai/DEFAULT.TXT). With room for a second factory it adds an aircraft
 *      plant, and on maps with water near its base a shipyard.
 *   3. Defence: if enemies come near the base, everything idle goes after them.
 *   4. Attack: once enough idle combat units have gathered, they go in a wave towards the nearest enemy
 *      it knows about (seen units, or the other start positions). Waves grow over time. Planes go in
 *      their own smaller groups straight at what they know of, and ships hunt along the water.
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
  /** Where the other players started (the AI knows, as TA's does), for when it hasn't seen them yet. */
  private enemyStarts: { x: number; z: number }[] = [];
  /** The pickiest ground movement among the units it builds, used to keep a way out of the base open. */
  private armyMovement: MovementClass | undefined;
  /** Building jobs handed out but not yet started, so two builders don't pick the same spot. */
  private claimed = new Map<number, { x: number; z: number; tick: number }>();
  private hasWater: boolean | undefined;

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
    if (!this.base && commander) {
      this.base = { x: commander.x, z: commander.z };
      this.enemyStarts = world
        .unitsInOrder()
        .filter((u) => u.owner !== this.player && u.def.commander)
        .map((u) => ({ x: u.x, z: u.z }));
      this.armyMovement = this.pickiestMovement(world, commander, this.base, this.enemyStarts[0]);
    }
    if (!this.base) return;
    for (const [id, c] of this.claimed) if (world.tickCount - c.tick > 60 * TICKS_PER_SECOND || !world.units.has(id)) this.claimed.delete(id);

    const builders = finished.filter((u) => u.def.builder && u.def.bmCode !== 0 && this.menus.has(u.def.unitName.toLowerCase()));
    const factories = finished.filter((u) => u.factory);
    const fighters = finished.filter((u) => isCombat(u.def) && !u.def.commander);
    const army = fighters.filter((u) => isLandCombat(u.def));

    this.defend(world, fighters, commander);
    for (const b of builders) if (b.tasks.length === 0) this.useBuilder(world, b, mine, factories);
    for (const f of factories) this.useFactory(world, f, mine);
    this.attackWave(world, army);
    this.airRaids(world, fighters.filter((u) => isAirCombat(u.def)));
    this.seaHunt(world, fighters.filter((u) => isSeaCombat(u.def)));
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
      // The Commander only claims nearby metal; construction units range further.
      const spot = this.freeMetalSpot(world, b, mex, b.def.commander ? 900 : 2500);
      if (spot) {
        this.issue(world, { kind: 'build', unitId: b.id, unitName: mex.unitName, x: spot.x, z: spot.z });
        this.claimed.set(b.id, { ...spot, tick: world.tickCount });
        return;
      }
    }
    // Factories.
    // Land factories first; then (above easy) an aircraft plant, and a shipyard if there's water near
    // the base. These come on top of the land factories so the main army doesn't shrink.
    const kinds = factories.map((f) => factoryKind(world, f.def, this.menus));
    const land = kinds.filter((k) => k === 'land').length;
    const wants: FactoryKind[] =
      land < this.tuning.factories ? ['land'] : this.difficulty === 'easy' ? [] : [...(!kinds.includes('sea') && this.waterNearBase(world) ? (['sea'] as const) : []), ...(!kinds.includes('air') ? (['air'] as const) : [])];
    // (With a steady metal income it starts one even when the stock is spent, or a busy hard AI never would.)
    if (wants.length && (s.metal.stock > 150 || s.metal.income > 8) && count((d) => factoryKind(world, d, this.menus) !== undefined) <= factories.length) {
      for (const want of wants) {
        const plant = this.weighted(options.filter((d) => factoryKind(world, d, this.menus) === want && this.allowed(d, mine)));
        if (plant && this.buildNear(world, b, plant, want === 'sea' ? 0 : 3)) return;
      }
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
    // Clear wrecks near home for their metal (and so they don't clog the way out).
    if (!b.def.commander) {
      const wreck = world.features
        .filter((f) => f.alive && f.def.reclaimable && f.def.metal > 0 && f.id >= world.map.features.length)
        .filter((f) => Math.hypot(f.x - this.base!.x, f.z - this.base!.z) < BASE_RADIUS * 2)
        .sort((a, c) => Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z))[0];
      if (wreck) {
        this.issue(world, { kind: 'reclaim', unitIds: [b.id], featureId: wreck.id });
        return;
      }
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

  private freeMetalSpot(world: World, b: SimUnit, mex: UnitDef, maxDistance: number): { x: number; z: number } | undefined {
    const spots = world.features
      .filter((f) => f.alive && f.def.metal > 0 && !f.def.blocking && f.def.indestructible)
      .map((f) => ({ x: f.x, z: f.z, base: Math.hypot(f.x - this.base!.x, f.z - this.base!.z), d: Math.hypot(f.x - this.base!.x, f.z - this.base!.z) + Math.hypot(f.x - b.x, f.z - b.z) / 2 }))
      .sort((p, q) => p.d - q.d || p.x - q.x || p.z - q.z);
    for (const s of spots) {
      if (s.base > maxDistance) continue;
      if ([...this.claimed.values()].some((c) => Math.hypot(c.x - s.x, c.z - s.z) < 32)) continue;
      const site = world.buildSite(mex.unitName, s.x, s.z);
      if (site.ok) return { x: site.x, z: site.z };
    }
    return undefined;
  }

  /**
   * Orders a building on a free spot near the base, leaving room around it so units can get through.
   * Tries rings of candidate spots outwards from the base (starting at a random angle so the base
   * doesn't grow in one line), easing the margin if the base is cramped.
   */
  private buildNear(world: World, b: SimUnit, d: UnitDef, margin = 2): boolean {
    const base = this.base!;
    const start = this.rng.int(0, 359);
    let pathChecks = 0;
    for (const m of [margin, 1, 0]) {
      for (let dist = 96; dist <= BASE_RADIUS; dist += 48) {
        const steps = Math.max(8, Math.round((2 * Math.PI * dist) / 64));
        for (let i = 0; i < steps; i++) {
          const angle = ((start + (i * 360) / steps) * Math.PI) / 180;
          const site = world.buildSite(d.unitName, base.x + Math.sin(angle) * dist, base.z + Math.cos(angle) * dist);
          if (!site.ok || !world.hasRoomAround(d, site.cellX, site.cellZ, m)) continue;
          if ([...this.claimed.values()].some((c) => Math.hypot(c.x - site.x, c.z - site.z) < (d.footprintX + m) * 16)) continue;
          // Never wall the army in: there must still be a way from the base to the enemy.
          const enemy = this.enemyStarts[0];
          if (enemy && this.armyMovement) {
            if (++pathChecks > 6) return false; // cramped base: try again next time rather than stall the game
            if (!world.pathSurvives(this.armyMovement, base, enemy, d, site.cellX, site.cellZ, 1)) continue;
          }
          // Don't build on metal patches: they're for extractors.
          if (d.extractsMetal === 0 && world.features.some((f) => f.alive && f.def.metal > 0 && !f.def.blocking && Math.hypot(f.x - site.x, f.z - site.z) < 48)) continue;
          this.issue(world, { kind: 'build', unitId: b.id, unitName: d.unitName, x: site.x, z: site.z });
          this.claimed.set(b.id, { x: site.x, z: site.z, tick: world.tickCount });
          return true;
        }
      }
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
      choice = this.cheapest(options.filter((d) => d.builder && d.bmCode !== 0 && isLandUnit(d) && this.allowed(d, mine)));
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
    // Keep the current attack going: units that have arrived or lost their target pick the nearest
    // enemy they can see, or head on to the next place enemies might be.
    if (this.attack) {
      const ids = [...this.attack.ids].filter((id) => world.units.has(id) && !world.units.get(id)!.dying);
      this.attack.ids = new Set(ids);
      if (ids.length === 0) this.attack = undefined;
      const seen = world.unitsInOrder().filter((e) => e.owner !== this.player && !e.dying && world.canSee(this.player, e));
      for (const id of ids) {
        const u = world.units.get(id)!;
        if (u.tasks.length > 0) continue;
        const target = nearest(seen, u, 900);
        if (target) this.issue(world, { kind: 'attack', unitIds: [u.id], targetId: target.id });
        else {
          const next = this.attackTarget(world, u);
          if (next) this.issue(world, { kind: 'move', unitIds: [u.id], x: next.x, z: next.z });
        }
      }
    }
    // Launch the next wave once enough fighters are waiting at home; they join any attack in progress.
    const idle = army.filter((u) => u.tasks.length === 0 && !this.attack?.ids.has(u.id));
    const size = Math.min(this.tuning.maxWave, this.tuning.firstWave + this.wave * this.tuning.waveGrowth);
    if (idle.length < size) return;
    const target = this.attackTarget(world, idle[0]!);
    if (!target) return;
    this.wave++;
    if (!this.attack) this.attack = { ...target, ids: new Set() };
    for (const u of idle) this.attack.ids.add(u.id);
    this.issue(world, { kind: 'move', unitIds: idle.map((u) => u.id), x: target.x, z: target.z });
  }

  /**
   * Planes: once a few are waiting, send them at the nearest enemy we can see (bombers need an attack
   * order to drop), else towards where the enemy started.
   */
  private airRaids(world: World, planes: SimUnit[]): void {
    const idle = planes.filter((u) => u.tasks.length === 0);
    if (idle.length < Math.max(3, Math.floor(this.tuning.firstWave / 2))) return;
    const seen = world.unitsInOrder().filter((e) => e.owner !== this.player && !e.dying && world.canSee(this.player, e));
    for (const u of idle) {
      const target = nearest(seen.filter((e) => e.def.bmCode === 0), u) ?? nearest(seen, u);
      if (target) this.issue(world, { kind: 'attack', unitIds: [u.id], targetId: target.id });
      else {
        const next = this.attackTarget(world, u);
        if (next) this.issue(world, { kind: 'move', unitIds: [u.id], x: next.x, z: next.z });
      }
    }
  }

  /** Ships go after enemies they can see near the water, else sail towards the enemy's side. */
  private seaHunt(world: World, ships: SimUnit[]): void {
    const idle = ships.filter((u) => u.tasks.length === 0);
    if (idle.length < 2) return;
    const seen = world.unitsInOrder().filter((e) => e.owner !== this.player && !e.dying && world.canSee(this.player, e));
    for (const u of idle) {
      const target = nearest(seen, u, 1500);
      if (target) this.issue(world, { kind: 'attack', unitIds: [u.id], targetId: target.id });
      else {
        const next = this.attackTarget(world, u);
        // The path planner takes them to the water nearest that point.
        if (next) this.issue(world, { kind: 'move', unitIds: [u.id], x: next.x, z: next.z });
      }
    }
  }

  /** Whether there's open water within building distance of the base. */
  private waterNearBase(world: World): boolean {
    if (this.hasWater === undefined) {
      const t = world.terrain;
      const base = this.base!;
      let wet = 0;
      for (let dz = -BASE_RADIUS; dz <= BASE_RADIUS; dz += 32)
        for (let dx = -BASE_RADIUS; dx <= BASE_RADIUS; dx += 32) if (t.heightAt(base.x + dx, base.z + dz) < t.seaLevel - 20) wet++;
      this.hasWater = wet > 40;
    }
    return this.hasWater;
  }

  /** The nearest enemy we know of: a seen unit (buildings first), else another start position. */
  private attackTarget(world: World, from: SimUnit): { x: number; z: number } | undefined {
    const seen = world.unitsInOrder().filter((e) => e.owner !== this.player && !e.dying && world.canSee(this.player, e));
    const building = nearest(seen.filter((e) => e.def.bmCode === 0), from) ?? nearest(seen, from);
    if (building) return { x: building.x, z: building.z };
    // Head for where the enemy started; once that's been looked at and found empty, try the other
    // start positions on the map.
    const starts = (world.map.ota?.schemas[0]?.startPositions ?? []).filter((p): p is { x: number; z: number } => !!p);
    const candidates = [...this.enemyStarts, ...starts.filter((p) => Math.hypot(p.x - this.base!.x, p.z - this.base!.z) > 300)];
    const unseen = candidates.filter((p) => !(world.visibility.at(this.player, p.x, p.z) & 1));
    return unseen[0] ?? candidates[0];
  }

  // --- helpers ---------------------------------------------------------------------------

  /**
   * The strictest movement class (lowest slope limit, then biggest footprint) among buildable fighters
   * that can actually get from the base to the enemy on this map.
   */
  private pickiestMovement(world: World, commander: SimUnit, from: { x: number; z: number }, to: { x: number; z: number } | undefined): MovementClass {
    const seen = new Set<string>();
    const queue = [commander.def.unitName.toLowerCase()];
    const classes: MovementClass[] = [commander.def.movementClass];
    while (queue.length) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      for (const n of (this.menus.get(name) ?? []).flat()) {
        const d = world.assetsOf(n)?.def;
        if (!d) continue;
        if (isLandCombat(d)) classes.push(d.movementClass);
        if (d.builder && seen.size < 12) queue.push(n.toLowerCase());
      }
    }
    const sorted = classes.sort((a, b) => a.maxSlope - b.maxSlope || b.footprintX - a.footprintX || a.name.localeCompare(b.name));
    return (to && sorted.find((mc) => world.pathSurvives(mc, from, to))) || commander.def.movementClass;
  }

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
    world.issue(c, false);
  }
}

const isShip = (d: UnitDef) => !d.canFly && (d.movementClass.minWaterDepth > 0 || d.ownMovement.minWaterDepth > 0);
const isLandUnit = (d: UnitDef) => !d.canFly && !isShip(d);
const armed = (d: UnitDef) => d.bmCode !== 0 && !d.builder && d.maxVelocity > 0 && d.weapons.some((w) => w !== '');

/** A mobile ground unit with a weapon it fires on its own. */
export function isLandCombat(d: UnitDef): boolean {
  return armed(d) && isLandUnit(d);
}
export function isAirCombat(d: UnitDef): boolean {
  return armed(d) && d.canFly;
}
export function isSeaCombat(d: UnitDef): boolean {
  return armed(d) && isShip(d);
}
/** Any armed mobile unit: land, air or sea. */
export function isCombat(d: UnitDef): boolean {
  return armed(d);
}

type FactoryKind = 'land' | 'air' | 'sea';

/** What a factory mostly makes: ground units, aircraft or ships (undefined if it isn't a factory). */
function factoryKind(world: World, d: UnitDef, menus: BuildMenus): FactoryKind | undefined {
  if (!d.builder || d.bmCode !== 0) return undefined;
  const products = (menus.get(d.unitName.toLowerCase())?.flat() ?? []).map((n) => world.assetsOf(n)?.def).filter((x): x is UnitDef => !!x);
  if (products.length === 0) return undefined;
  const air = products.filter((p) => p.canFly).length;
  const sea = products.filter(isShip).length;
  const land = products.length - air - sea;
  // A factory that itself floats is a shipyard (or a seaplane platform, which we leave out).
  if (d.ownMovement.minWaterDepth > 0) return sea * 2 > products.length ? 'sea' : undefined;
  if (land * 2 > products.length) return 'land';
  if (air * 2 > products.length) return 'air';
  return undefined;
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
