import type { ModelPiece } from '../formats/3do';
import type { CobScript } from '../formats/cob';
import { CELL_SIZE } from '../formats/tnt';
import type { ModelPiece as Piece } from '../formats/3do';
import type { FeatureDef } from '../map/features';
import { explode, makeWeaponSlots, updateProjectiles, updateWeapons, type CombatEvent, type Projectile, type WeaponSlot } from './combat';
import { Visibility, RADAR, SEEN } from './visibility';
import type { WeaponDef } from './weaponDef';
import type { GameMap } from '../map/mapData';
import { PlayerEconomy } from './economy';
import { Occupancy, yardCellPassable } from './occupancy';
import { findPath } from './pathfinding';
import { ANGLE_FULL_TURN, angleToRadians, TICKS_PER_SECOND, turnTowards, wrapAngle } from './pieces';
import { Rng } from './rng';
import { SimTerrain } from './terrain';
import type { MovementClass, UnitDef } from './unitDef';
import { rotateYXZ, UnitScripts } from './unitScripts';

/*
 * The simulation: a fixed 30 Hz, deterministic loop. Everything that changes the game goes through
 * `issue()` and takes effect at the start of the next tick, so the same commands on the same ticks always
 * give the same result. The renderer reads the world but never writes to it.
 *
 * Ground movement follows RWE (src/rwe/sim/UnitBehaviorService*.cpp):
 *   - steering picks a heading towards the next waypoint and a target speed: full speed scaled by how
 *     well the unit faces the waypoint (squared when within its turning circle), or 0 once within
 *     braking distance of the final waypoint;
 *   - the unit turns by at most turnRate per tick, speeds up by acceleration or slows by brakeRate,
 *     and goes half speed when under water;
 *   - a move that would hit another unit, a building, a blocking feature, too steep a slope or wrong
 *     water depth is refused; then it tries moving along just one axis;
 *   - waypoints count as reached within 16 units (8 for the last one); when stuck, it asks for a new
 *     path, at most once a second.
 *
 * Economy and construction also follow RWE (GameSimulation::updateResources, UnitBehaviorService
 * buildUnit/deployBuildArm/handleBuild): see economy.ts for metal and energy. A builder walks into
 * range, starts the new unit, runs its StartBuilding script and, once the script says it's in its
 * build stance, adds workerTime/30 of work per tick, paying cost * work / buildTime as it goes; the new
 * unit's hit points grow with progress. Factories open (Activate), build at the piece their
 * QueryBuildInfo script names, and send each finished unit out to their rally point.
 */

export type Task =
  | { kind: 'move'; x: number; z: number; started?: boolean }
  | { kind: 'build'; unitName: string; x: number; z: number; targetId?: number; started?: boolean; waited?: number }
  | { kind: 'assist'; unitId: number; started?: boolean; waited?: number }
  | { kind: 'reclaim'; featureId: number; progress: number; started?: boolean; waited?: number }
  | { kind: 'attack'; targetId: number; started?: boolean };

export type Command =
  | { kind: 'move'; unitIds: number[]; x: number; z: number; queue?: boolean }
  | { kind: 'stop'; unitIds: number[] }
  | { kind: 'build'; unitId: number; unitName: string; x: number; z: number; queue?: boolean }
  | { kind: 'assist'; unitIds: number[]; targetId: number; queue?: boolean }
  | { kind: 'reclaim'; unitIds: number[]; featureId: number; queue?: boolean }
  /** Factory queue: add `count` (negative removes). */
  | { kind: 'factory'; unitId: number; unitName: string; count: number }
  | { kind: 'rally'; unitId: number; x: number; z: number }
  | { kind: 'activate'; unitIds: number[]; on: boolean }
  | { kind: 'attack'; unitIds: number[]; targetId: number; queue?: boolean };

export interface SimFeature {
  readonly id: number;
  readonly def: FeatureDef;
  readonly cellX: number;
  readonly cellZ: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  alive: boolean;
}

interface FactoryState {
  queue: { unitName: string; count: number }[];
  /** The unit currently being built inside, if any. */
  currentId: number | undefined;
  /** A finished unit still driving out; the next one waits (up to a few seconds) until the pad is clear. */
  leavingId: number | undefined;
  leavingSince: number;
  /** How many units this factory has sent out, to spread them in front of it. */
  released: number;
  phase: 'idle' | 'opening' | 'building';
  waited: number;
}

export interface SimUnit {
  readonly id: number;
  readonly def: UnitDef;
  readonly owner: number;
  x: number;
  y: number;
  z: number;
  /** Heading in angle units (65536 per turn); 0 faces +z (south), like RWE. */
  rotation: number;
  /** Current speed, world units per tick. */
  speed: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  prevRotation: number;
  /** Top-left height cell of the footprint the unit occupies. */
  cellX: number;
  cellZ: number;
  hp: number;
  /** Work done so far; the unit is finished when this reaches def.buildTime. */
  buildProgress: number;
  /** What the unit has been told to do, first task first. */
  tasks: Task[];
  /** Where the unit is currently driving to (set by tasks), with its path. */
  order: { x: number; z: number } | undefined;
  path: { waypoints: [number, number][]; index: number; createdTick: number; complete: boolean } | undefined;
  /** New paths asked for without getting anywhere; the move is dropped after too many. */
  repathAttempts: number;
  lastPlanX: number;
  lastPlanZ: number;
  inCollision: boolean;
  /** True when the last refused move was blocked by a unit that is itself on the move (a queue). */
  blockedByMover: boolean;
  scripts: UnitScripts | undefined;
  /** Whether the unit's script has been told it is moving (StartMoving/StopMoving). */
  scriptMoving: boolean;
  /** For powered machines: whether they got their energy last second. */
  powered: boolean;
  factory: FactoryState | undefined;
  /** Where finished units from this factory drive to. */
  rally: [number, number] | undefined;
  /** What the unit is spraying its nano-lathe at this tick (for drawing), if anything. */
  nanoTarget: { x: number; y: number; z: number } | undefined;
  /** The piece the spray comes from (its QueryNanoPiece answer), looked up the first time it builds. */
  nanoPiece: string | null | undefined;
  /** Whether the yard (if any) was open last time we updated its passable cells. */
  yardOpen: boolean;
  /** The factory a newly built unit is driving out of; its walls don't block it until it's out. */
  exitFactory: number | undefined;
  /** Model height, for hit boxes and aiming. */
  readonly height: number;
  weapons: (WeaponSlot | undefined)[];
  /** Set once the unit has been destroyed; it plays its Killed script, then leaves a wreck and goes. */
  dying: { since: number; severity: number; thread: import('./cob/vm').CobThread | undefined } | undefined;
  /** Cached answers to piece queries (QueryPrimary, AimFromPrimary, QueryNanoPiece...). */
  pieceQueries: Map<string, string | undefined>;
}

export interface UnitAssets {
  def: UnitDef;
  model: ModelPiece | undefined;
  script: CobScript | undefined;
}

export interface WorldOptions {
  seed: number;
  /** Look up a unit type's definition, model and script (all buildable types must be preloaded). */
  assets: (unitName: string) => UnitAssets | undefined;
  players?: number;
  /** Lowercase weapon name -> definition. */
  weapons?: Map<string, WeaponDef>;
  /** Lowercase feature name -> definition, for wrecks. */
  featureDefs?: Map<string, FeatureDef>;
}

const WAYPOINT_RADIUS = 16;
const FINAL_RADIUS = 8;
const REPATH_INTERVAL = TICKS_PER_SECOND;
const MAX_REPATHS = 10;
/** Wind generators make full power at this wind speed (RWE MaxUtilizableWindSpeed). */
const MAX_USEFUL_WIND = 5000;
/** How long to wait for a build script to report its stance before working anyway. */
const STANCE_TIMEOUT = 2 * TICKS_PER_SECOND;
/** How long a builder waits for a blocked building site before giving up. */
const SITE_TIMEOUT = 10 * TICKS_PER_SECOND;

export class World {
  readonly terrain: SimTerrain;
  readonly occupancy: Occupancy;
  readonly units = new Map<number, SimUnit>();
  readonly features: SimFeature[] = [];
  readonly players: PlayerEconomy[] = [];
  /** Metal value per height cell (what extractors dig up). */
  readonly metal: Float32Array;
  readonly rng: Rng;
  readonly weaponDefs: Map<string, WeaponDef>;
  readonly featureDefs: Map<string, FeatureDef>;
  projectiles: Projectile[] = [];
  /** Recent things the renderer may want to show (explosions, shots, deaths); kept for a few seconds. */
  events: CombatEvent[] = [];
  readonly visibility: Visibility;
  /** Players knocked out (their Commander died). */
  readonly defeated = new Set<number>();
  tickCount = 0;
  windSpeed = 0;
  private nextProjectileId = 1;
  private orderCache: SimUnit[] | undefined;
  private nextWindChange = 0;
  private nextId = 1;
  private queue: Command[] = [];
  private readonly pathGrids = new Map<string, { version: number; grid: Uint8Array }>();
  private readonly assetsFor: (unitName: string) => UnitAssets | undefined;

  constructor(
    readonly map: GameMap,
    options: WorldOptions | number,
  ) {
    const opts: WorldOptions = typeof options === 'number' ? { seed: options, assets: () => undefined } : options;
    this.assetsFor = opts.assets;
    this.terrain = new SimTerrain(map.tnt);
    this.occupancy = new Occupancy(map.tnt.width, map.tnt.height);
    this.rng = new Rng(opts.seed);
    this.weaponDefs = opts.weapons ?? new Map();
    this.featureDefs = opts.featureDefs ?? new Map();
    this.visibility = new Visibility(map.widthUnits, map.heightUnits, opts.players ?? 2);
    const schema = map.ota?.schemas[0];
    for (let p = 0; p < (opts.players ?? 2); p++) {
      this.players.push(new PlayerEconomy(schema?.humanMetal ?? 1000, schema?.humanEnergy ?? 1000));
    }

    // Metal: every cell gets the map's surface metal; metal patches (indestructible, non-blocking
    // features with metal) set their footprint's value, as in RWE's addFeature.
    this.metal = new Float32Array(map.tnt.width * map.tnt.height).fill(schema?.surfaceMetal ?? 3);
    map.features.forEach((f, i) => {
      const feature: SimFeature = { id: i, def: f.def, cellX: f.cellX, cellZ: f.cellZ, x: f.x, y: f.y, z: f.z, alive: true };
      this.features.push(feature);
      if (f.def.blocking) this.occupancy.setFeature(f.cellX, f.cellZ, f.def.footprintX, f.def.footprintZ, i);
      if (!f.def.blocking && f.def.indestructible && f.def.metal) {
        for (let dz = 0; dz < f.def.footprintZ; dz++) {
          for (let dx = 0; dx < f.def.footprintX; dx++) {
            const cx = f.cellX + dx;
            const cz = f.cellZ + dz;
            if (cx < map.tnt.width && cz < map.tnt.height) this.metal[cz * map.tnt.width + cx] = f.def.metal;
          }
        }
      }
    });
  }

  /** Queues a command for the next tick. */
  issue(cmd: Command): void {
    this.queue.push(cmd);
  }

  isFinished(u: SimUnit): boolean {
    return u.buildProgress >= u.def.buildTime;
  }

  /** 0..1 */
  buildFraction(u: SimUnit): number {
    return Math.min(1, u.buildProgress / u.def.buildTime);
  }

  // --- placing units ----------------------------------------------------------------

  /**
   * Places a finished unit at the free spot nearest (x, z) where it fits. Returns undefined if there is
   * none within a few hundred units. Placement happens immediately (used when setting up a game).
   */
  spawn(assets: UnitAssets, owner: number, x: number, z: number, rotation = 0): SimUnit | undefined {
    const { def } = assets;
    const [cx0, cz0] = this.terrain.footprintCell(x, z, def.footprintX, def.footprintZ);
    for (let r = 0; r < 24; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = cx0 + dx;
          const cz = cz0 + dz;
          if (!this.canPlace(def, cx, cz)) continue;
          const u = this.create(assets, owner, cx, cz, rotation, true);
          return u;
        }
      }
    }
    return undefined;
  }

  /** Whether a unit of this type could stand (or be built) with its footprint's top-left at (cx, cz). */
  canPlace(def: UnitDef, cx: number, cz: number, ignore = 0): boolean {
    return this.terrain.fits(def.ownMovement, cx, cz) && !this.occupancy.blocked(cx, cz, def.footprintX, def.footprintZ, ignore);
  }

  /** Whether `unitName` can be built centred on (x, z), and the footprint cell it would use. */
  buildSite(unitName: string, x: number, z: number, builderId = 0): { ok: boolean; cellX: number; cellZ: number; x: number; z: number } {
    const def = this.assetsFor(unitName)?.def;
    if (!def) return { ok: false, cellX: 0, cellZ: 0, x, z };
    const [cx, cz] = this.terrain.footprintCell(x, z, def.footprintX, def.footprintZ);
    const [sx, sz] = this.terrain.cellCenter(cx, cz, def.footprintX, def.footprintZ);
    return { ok: this.canPlace(def, cx, cz, builderId), cellX: cx, cellZ: cz, x: sx, z: sz };
  }

  /** The nearest spot to (x, z) where `unitName` could be built, searching outwards up to `maxCells`. */
  findSiteNear(unitName: string, x: number, z: number, maxCells = 30): { x: number; z: number } | undefined {
    const def = this.assetsFor(unitName)?.def;
    if (!def) return undefined;
    const [cx0, cz0] = this.terrain.footprintCell(x, z, def.footprintX, def.footprintZ);
    for (let r = 0; r <= maxCells; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (!this.canPlace(def, cx0 + dx, cz0 + dz)) continue;
          const [sx, sz] = this.terrain.cellCenter(cx0 + dx, cz0 + dz, def.footprintX, def.footprintZ);
          return { x: sx, z: sz };
        }
      }
    }
    return undefined;
  }

  private create(assets: UnitAssets, owner: number, cx: number, cz: number, rotation: number, finished: boolean): SimUnit {
    const { def } = assets;
    const id = this.nextId++;
    const [x, z] = this.terrain.cellCenter(cx, cz, def.footprintX, def.footprintZ);
    const y = this.groundY(def, x, z);
    const scripts =
      assets.script && assets.model ? new UnitScripts(assets.script, assets.model, new Rng(this.rng.nextU32())) : undefined;
    const isFactory = def.builder && def.bmCode === 0;
    const unit: SimUnit = {
      id,
      def,
      owner,
      x,
      y,
      z,
      rotation,
      speed: 0,
      prevX: x,
      prevY: y,
      prevZ: z,
      prevRotation: rotation,
      cellX: cx,
      cellZ: cz,
      hp: finished ? def.maxDamage : 1,
      buildProgress: finished ? def.buildTime : 0,
      tasks: [],
      order: undefined,
      path: undefined,
      repathAttempts: 0,
      lastPlanX: x,
      lastPlanZ: z,
      inCollision: false,
      blockedByMover: false,
      scripts,
      scriptMoving: false,
      powered: true,
      factory: isFactory ? { queue: [], currentId: undefined, leavingId: undefined, leavingSince: 0, released: 0, phase: 'idle', waited: 0 } : undefined,
      rally: undefined,
      nanoTarget: undefined,
      nanoPiece: undefined,
      yardOpen: false,
      exitFactory: undefined,
      height: modelHeight(assets.model),
      weapons: [],
      dying: undefined,
      pieceQueries: new Map(),
    };
    unit.weapons = makeWeaponSlots(this, unit);
    this.units.set(id, unit);
    this.orderCache = undefined;
    this.occupy(unit);
    scripts?.start('Create');
    if (finished) this.onFinished(unit);
    return unit;
  }

  private occupy(u: SimUnit): void {
    const { def } = u;
    if (def.bmCode === 0) {
      const open = u.scripts?.state.yardOpen ?? false;
      u.yardOpen = open;
      this.occupancy.setBuilding(u.cellX, u.cellZ, def.footprintX, def.footprintZ, u.id, (dx, dz) =>
        yardCellPassable(def.yardMap[dz * def.footprintX + dx], open),
      );
    } else {
      this.occupancy.setUnit(u.cellX, u.cellZ, def.footprintX, def.footprintZ, u.id);
    }
  }

  private onFinished(u: SimUnit): void {
    u.hp = u.def.maxDamage;
    if (u.def.activateWhenBuilt) this.setActive(u, true);
  }

  private setActive(u: SimUnit, on: boolean): void {
    if (!u.scripts) return;
    if (u.scripts.state.activated === on) return;
    u.scripts.state.activated = on;
    u.scripts.start(on ? 'Activate' : 'Deactivate');
  }

  // --- the tick --------------------------------------------------------------------

  /** Advances the game by one tick. */
  tick(): void {
    const cmds = this.queue;
    this.queue = [];
    for (const c of cmds) this.apply(c);

    if (this.tickCount % TICKS_PER_SECOND === 0) this.updateEconomy();
    this.updateWind();
    if (this.tickCount % 15 === 0) this.updateVisibility();

    for (const u of this.unitsInOrder()) {
      u.prevX = u.x;
      u.prevY = u.y;
      u.prevZ = u.z;
      u.prevRotation = u.rotation;
      if (u.dying) this.updateDying(u);
      else this.updateUnit(u);
    }
    updateProjectiles(this);
    // Pass script events (pieces blown off) on to the renderer.
    for (const u of this.unitsInOrder()) {
      if (!u.scripts || u.scripts.events.length === 0) continue;
      for (const e of u.scripts.events) {
        if (e.kind === 'explode') this.events.push({ tick: this.tickCount, kind: 'debris', unitId: u.id, piece: e.piece, flags: e.type });
      }
      u.scripts.events = [];
    }
    this.events = this.events.filter((e) => this.tickCount - e.tick < 3 * TICKS_PER_SECOND);
    this.tickCount++;
  }

  /** Units sorted by id (the order everything is processed in), cached until the set changes. */
  unitsInOrder(): SimUnit[] {
    this.orderCache ??= [...this.units.values()].sort((a, b) => a.id - b.id);
    return this.orderCache;
  }

  private apply(c: Command): void {
    switch (c.kind) {
      case 'stop':
        for (const u of this.ownUnits(c.unitIds)) {
          this.abortTasks(u);
          if (u.factory) {
            u.factory.queue = [];
          }
        }
        return;
      case 'move': {
        const movers = this.ownUnits(c.unitIds).filter((u) => this.canWalk(u));
        // Factories take a move order as their rally point.
        for (const f of this.ownUnits(c.unitIds)) if (f.factory) f.rally = [c.x, c.z];
        // Keep the group's shape, squeezed so it doesn't sprawl.
        const cx = movers.reduce((s, u) => s + u.x, 0) / Math.max(1, movers.length);
        const cz = movers.reduce((s, u) => s + u.z, 0) / Math.max(1, movers.length);
        const maxR = movers.reduce((m, u) => Math.max(m, Math.hypot(u.x - cx, u.z - cz)), 0);
        const allowed = 24 * Math.sqrt(movers.length);
        const k = maxR > allowed ? allowed / maxR : 1;
        for (const u of movers) {
          const x = clamp(c.x + (u.x - cx) * k, 0, this.map.widthUnits);
          const z = clamp(c.z + (u.z - cz) * k, 0, this.map.heightUnits);
          this.giveTask(u, { kind: 'move', x, z }, c.queue);
        }
        return;
      }
      case 'build': {
        const u = this.units.get(c.unitId);
        if (!u || !u.def.builder || !this.isFinished(u) || u.factory) return;
        const site = this.buildSite(c.unitName, c.x, c.z);
        this.giveTask(u, { kind: 'build', unitName: c.unitName, x: site.x, z: site.z }, c.queue);
        return;
      }
      case 'assist':
        for (const u of this.ownUnits(c.unitIds)) {
          if (u.def.builder && !u.factory && c.targetId !== u.id) this.giveTask(u, { kind: 'assist', unitId: c.targetId }, c.queue);
        }
        return;
      case 'reclaim':
        for (const u of this.ownUnits(c.unitIds)) {
          if (u.def.builder && !u.factory) this.giveTask(u, { kind: 'reclaim', featureId: c.featureId, progress: 0 }, c.queue);
        }
        return;
      case 'factory': {
        const f = this.units.get(c.unitId)?.factory;
        if (!f) return;
        const last = f.queue[f.queue.length - 1];
        if (c.count > 0) {
          if (last && last.unitName === c.unitName) last.count += c.count;
          else f.queue.push({ unitName: c.unitName, count: c.count });
        } else {
          // Remove from the back of the queue first.
          let remove = -c.count;
          for (let i = f.queue.length - 1; i >= 0 && remove > 0; i--) {
            const e = f.queue[i]!;
            if (e.unitName !== c.unitName) continue;
            const take = Math.min(remove, e.count);
            e.count -= take;
            remove -= take;
          }
          f.queue = f.queue.filter((e) => e.count > 0);
        }
        return;
      }
      case 'rally': {
        const u = this.units.get(c.unitId);
        if (u?.factory) u.rally = [c.x, c.z];
        return;
      }
      case 'activate':
        for (const u of this.ownUnits(c.unitIds)) if (u.def.onOffable) this.setActive(u, c.on);
        return;
      case 'attack':
        for (const u of this.ownUnits(c.unitIds)) {
          if (u.weapons.some((w) => w && !w.def.commandFire) && c.targetId !== u.id) this.giveTask(u, { kind: 'attack', targetId: c.targetId }, c.queue);
        }
        return;
    }
  }

  private ownUnits(ids: number[]): SimUnit[] {
    return ids.map((id) => this.units.get(id)).filter((u): u is SimUnit => !!u && this.isFinished(u) && !u.dying);
  }

  private canWalk(u: SimUnit): boolean {
    return u.def.canMove && u.def.maxVelocity > 0 && u.def.bmCode !== 0;
  }

  private giveTask(u: SimUnit, task: Task, queue = false): void {
    if (!queue) this.abortTasks(u);
    u.tasks.push(task);
  }

  private abortTasks(u: SimUnit): void {
    const t = u.tasks[0];
    if (t && t.kind !== 'move' && t.started) u.scripts?.start('StopBuilding');
    u.tasks = [];
    u.order = undefined;
    u.path = undefined;
    u.nanoTarget = undefined;
  }

  private finishTask(u: SimUnit): void {
    const t = u.tasks.shift();
    if (t && t.kind !== 'move' && t.started) u.scripts?.start('StopBuilding');
    u.order = undefined;
    u.path = undefined;
    u.nanoTarget = undefined;
  }

  private updateUnit(u: SimUnit): void {
    u.nanoTarget = undefined;
    if (this.isFinished(u)) {
      if (u.factory) this.updateFactory(u);
      else this.runTask(u);
      const t = u.tasks[0];
      updateWeapons(this, u, t?.kind === 'attack' ? t.targetId : undefined);
    }
    if (u.def.bmCode === 0 && u.scripts && u.scripts.state.yardOpen !== u.yardOpen) this.occupy(u);

    let targetAngle = u.rotation;
    let targetSpeed = 0;
    if (u.order && this.canWalk(u)) {
      const steer = this.followOrder(u, u.order);
      if (steer) [targetAngle, targetSpeed] = steer;
    }

    // Steering: turn, then speed up or brake (RWE updateUnitRotation / computeNewGroundUnitSpeed).
    if (this.canWalk(u)) {
      u.rotation = turnTowards(u.rotation, targetAngle, u.def.turnRate);
      let speed = u.speed;
      if (targetSpeed > speed) speed = Math.min(targetSpeed, speed + u.def.acceleration);
      else speed = Math.max(targetSpeed, speed - u.def.brakeRate);
      const maxSpeed = u.y < this.terrain.seaLevel ? u.def.maxVelocity / 2 : u.def.maxVelocity;
      u.speed = clamp(speed, 0, maxSpeed);
      this.moveUnit(u);
    }

    // Tell the unit's script when it starts and stops moving, so it plays its walk animation.
    const moving = u.speed > 0;
    if (u.scripts && moving !== u.scriptMoving) {
      u.scriptMoving = moving;
      u.scripts.start(moving ? 'StartMoving' : 'StopMoving');
    }
    u.scripts?.tick();
  }

  // --- tasks -------------------------------------------------------------------------

  private runTask(u: SimUnit): void {
    const t = u.tasks[0];
    if (!t) return;
    switch (t.kind) {
      case 'move':
        if (!t.started) {
          t.started = true;
          this.driveTo(u, t.x, t.z);
        } else if (!u.order) {
          this.finishTask(u);
        }
        return;
      case 'build':
        this.runBuild(u, t);
        return;
      case 'assist': {
        const target = this.units.get(t.unitId);
        if (!target || this.isFinished(target)) return this.finishTask(u);
        this.workOn(u, t, target);
        return;
      }
      case 'reclaim':
        this.runReclaim(u, t);
        return;
      case 'attack': {
        const target = this.units.get(t.targetId);
        if (!target || target.dying) return this.finishTask(u);
        // Close in until the shortest-ranged weapon reaches, then hold position and shoot.
        const range = Math.min(...u.weapons.filter((w): w is WeaponSlot => !!w && !w.def.commandFire).map((w) => w.def.range));
        if (Math.hypot(target.x - u.x, target.z - u.z) > range * 0.9) this.driveTo(u, target.x, target.z);
        else {
          u.order = undefined;
          u.path = undefined;
        }
        return;
      }
    }
  }

  private driveTo(u: SimUnit, x: number, z: number): void {
    if (!this.canWalk(u)) return;
    if (u.order && u.order.x === x && u.order.z === z) return;
    u.order = { x, z };
    u.path = undefined;
    u.repathAttempts = 0;
    u.lastPlanX = u.x;
    u.lastPlanZ = u.z;
  }

  /** Gets within reach of (x, z) (plus `radius`); returns true once there (and stops driving). */
  private reach(u: SimUnit, x: number, z: number, radius: number): boolean {
    const d = Math.hypot(x - u.x, z - u.z) - radius;
    if (d <= u.def.buildDistance) {
      u.order = undefined;
      u.path = undefined;
      return true;
    }
    if (!this.canWalk(u)) return false;
    this.driveTo(u, x, z);
    return false;
  }

  private runBuild(u: SimUnit, t: Extract<Task, { kind: 'build' }>): void {
    const assets = this.assetsFor(t.unitName);
    if (!assets) return this.finishTask(u);
    const def = assets.def;
    if (t.targetId !== undefined) {
      const target = this.units.get(t.targetId);
      if (!target || this.isFinished(target)) return this.finishTask(u);
      this.workOn(u, t, target);
      return;
    }
    const radius = (Math.max(def.footprintX, def.footprintZ) * CELL_SIZE) / 2;
    if (!this.reach(u, t.x, t.z, radius)) return;
    const [cx, cz] = this.terrain.footprintCell(t.x, t.z, def.footprintX, def.footprintZ);
    if (!this.canPlace(def, cx, cz)) {
      // Something is in the way. If it's us, step aside; otherwise wait a while.
      if (this.occupancy.firstUnit(cx, cz, def.footprintX, def.footprintZ) === u.id && !this.occupancy.staticBlocked(cx, cz, def.footprintX, def.footprintZ)) {
        const away = Math.atan2(u.x - t.x, u.z - t.z);
        const dist = radius + Math.max(u.def.footprintX, u.def.footprintZ) * CELL_SIZE;
        this.driveTo(u, t.x + Math.sin(away) * dist, t.z + Math.cos(away) * dist);
        return;
      }
      t.waited = (t.waited ?? 0) + 1;
      if (t.waited > SITE_TIMEOUT || this.occupancy.staticBlocked(cx, cz, def.footprintX, def.footprintZ) || !this.terrain.fits(def.ownMovement, cx, cz)) {
        this.finishTask(u);
      }
      return;
    }
    const target = this.create(assets, u.owner, cx, cz, 0, false);
    t.targetId = target.id;
    this.workOn(u, t, target);
  }

  /**
   * Builds (or helps build) `target`: starts the build script aimed at it, waits for the build stance,
   * then adds work each tick while the player can pay for it.
   */
  private workOn(u: SimUnit, t: { started?: boolean; waited?: number }, target: SimUnit): void {
    const radius = (Math.max(target.def.footprintX, target.def.footprintZ) * CELL_SIZE) / 2;
    if (!this.reach(u, target.x, target.z, radius)) return;
    if (!t.started) {
      t.started = true;
      t.waited = 0;
      u.scripts?.start('StartBuilding', this.aimAt(u, target.x, target.y, target.z));
    }
    if (!(u.scripts?.state.inBuildStance ?? true) && (t.waited ?? 0) < STANCE_TIMEOUT) {
      t.waited = (t.waited ?? 0) + 1;
      return;
    }
    if (this.addWork(u, target)) this.finishTask(u);
  }

  /** One tick of building: pays and adds progress. Returns true when the target is finished. */
  private addWork(builder: SimUnit, target: SimUnit): boolean {
    const work = Math.min(builder.def.workerTime / TICKS_PER_SECOND, target.def.buildTime - target.buildProgress);
    const share = work / target.def.buildTime;
    const paid = this.players[builder.owner]?.trySpend(target.def.buildCostEnergy * share, target.def.buildCostMetal * share);
    if (!paid) return false;
    this.spray(builder, target.x, target.y + 8, target.z);
    target.buildProgress += work;
    target.hp = Math.max(1, Math.min(target.def.maxDamage, (target.buildProgress / target.def.buildTime) * target.def.maxDamage));
    if (this.isFinished(target)) {
      target.buildProgress = target.def.buildTime;
      this.onFinished(target);
      return true;
    }
    return false;
  }

  /**
   * Reclaiming a feature takes (metal + energy) work units, done at the builder's workerTime, then gives
   * the feature's metal and energy to the player. This is our approximation: RWE doesn't reclaim yet,
   * and TA hands the resources out gradually.
   */
  private runReclaim(u: SimUnit, t: Extract<Task, { kind: 'reclaim' }>): void {
    const f = this.features[t.featureId];
    if (!f || !f.alive || !f.def.reclaimable) return this.finishTask(u);
    const radius = (Math.max(f.def.footprintX, f.def.footprintZ) * CELL_SIZE) / 2;
    if (!this.reach(u, f.x, f.z, radius)) return;
    if (!t.started) {
      t.started = true;
      t.waited = 0;
      u.scripts?.start('StartBuilding', this.aimAt(u, f.x, f.y, f.z));
    }
    if (!(u.scripts?.state.inBuildStance ?? true) && (t.waited ?? 0) < STANCE_TIMEOUT) {
      t.waited = (t.waited ?? 0) + 1;
      return;
    }
    this.spray(u, f.x, f.y + 8, f.z);
    t.progress += u.def.workerTime / TICKS_PER_SECOND;
    if (t.progress >= Math.max(1, f.def.metal + f.def.energy)) {
      this.players[u.owner]?.produce(f.def.energy, f.def.metal);
      this.removeFeature(f);
      this.finishTask(u);
    }
  }

  private spray(u: SimUnit, x: number, y: number, z: number): void {
    u.nanoTarget = { x, y, z };
    if (u.nanoPiece === undefined) {
      const idx = u.scripts?.query('QueryNanoPiece');
      u.nanoPiece = idx !== undefined && u.scripts ? u.scripts.pieceName(idx) : null;
    }
  }

  removeFeature(f: SimFeature): void {
    if (!f.alive) return;
    f.alive = false;
    if (f.def.blocking) this.occupancy.clearFeature(f.cellX, f.cellZ, f.def.footprintX, f.def.footprintZ, f.id);
  }

  /** StartBuilding parameters: heading relative to the unit, and pitch, in COB angles. */
  private aimAt(u: SimUnit, x: number, y: number, z: number): [number, number] {
    const heading = wrapAngle(toRotation(x - u.x, z - u.z) - u.rotation);
    const pitch = wrapAngle(Math.round((Math.atan2(y - u.y, Math.hypot(x - u.x, z - u.z)) * ANGLE_FULL_TURN) / (2 * Math.PI)));
    return [toSigned(heading), toSigned(pitch)];
  }

  // --- factories --------------------------------------------------------------------

  private updateFactory(u: SimUnit): void {
    const f = u.factory!;
    // Let the last unit drive clear of the pad before closing up or starting the next one.
    if (f.leavingId !== undefined) {
      const leaving = this.units.get(f.leavingId);
      if (leaving && leaving.exitFactory === u.id && this.tickCount - f.leavingSince < 5 * TICKS_PER_SECOND) return;
      f.leavingId = undefined;
    }
    const entry = f.queue[0];
    if (!entry) {
      if (f.currentId !== undefined) this.cancelInFactory(u);
      if (f.phase !== 'idle') {
        u.scripts?.start('StopBuilding');
        this.setActive(u, false);
        f.phase = 'idle';
      }
      return;
    }
    if (f.phase === 'idle') {
      this.setActive(u, true);
      f.phase = 'opening';
      f.waited = 0;
    }
    if (f.phase === 'opening') {
      // Wait for the factory's script to open up (it sets INBUILDSTANCE), or carry on after a while.
      if (!(u.scripts?.state.inBuildStance ?? true) && f.waited++ < STANCE_TIMEOUT) return;
      f.phase = 'building';
    }
    const assets = this.assetsFor(entry.unitName);
    if (!assets) {
      f.queue.shift();
      return;
    }
    let target = f.currentId !== undefined ? this.units.get(f.currentId) : undefined;
    if (!target) {
      const [px, py, pz, rot] = this.buildSpot(u);
      const [cx, cz] = this.terrain.footprintCell(px, pz, assets.def.footprintX, assets.def.footprintZ);
      target = this.create(assets, u.owner, cx, cz, rot, false);
      target.x = px;
      target.y = py;
      target.z = pz;
      target.prevX = px;
      target.prevY = py;
      target.prevZ = pz;
      f.currentId = target.id;
      u.scripts?.start('StartBuilding');
    } else {
      // Keep the unit on the build pad while it's being made.
      const [px, py, pz, rot] = this.buildSpot(u);
      target.x = px;
      target.y = py;
      target.z = pz;
      target.rotation = rot;
    }
    if (this.addWork(u, target)) {
      this.release(u, target);
      f.leavingId = target.id;
      f.leavingSince = this.tickCount;
      f.currentId = undefined;
      entry.count--;
      if (entry.count <= 0) f.queue.shift();
      u.scripts?.start('StopBuilding');
      if (f.queue.length === 0) {
        this.setActive(u, false);
        f.phase = 'idle';
      } else {
        u.scripts?.start('StartBuilding');
      }
    }
  }

  /** Where a factory builds: the piece its QueryBuildInfo script names, else its centre. */
  private buildSpot(u: SimUnit): [number, number, number, number] {
    const pieceIndex = u.scripts?.query('QueryBuildInfo');
    if (u.scripts && pieceIndex !== undefined) {
      const [lx, ly, lz] = u.scripts.piecePosition(u.scripts.pieceName(pieceIndex));
      const [wx, , wz] = rotateYXZ([lx, ly, lz], 0, angleToRadians(u.rotation), 0);
      return [u.x + wx, Math.max(u.y + ly, this.groundY(u.def, u.x + wx, u.z + wz)), u.z + wz, u.rotation];
    }
    return [u.x, u.y, u.z, u.rotation];
  }

  /**
   * A finished unit leaves the factory: straight out the front (its factory's walls don't block it on the
   * way), then on to the rally point if one is set. RWE gives it a "bugger off" order instead.
   */
  private release(factory: SimUnit, unit: SimUnit): void {
    const [fx, fz] = toDirection(factory.rotation);
    const out = (Math.max(factory.def.footprintX, factory.def.footprintZ) * CELL_SIZE) / 2 + Math.max(unit.def.footprintX, unit.def.footprintZ) * CELL_SIZE;
    const ex = factory.x + fx * out;
    const ez = factory.z + fz * out;
    // Re-snap the unit's occupied cells to where it actually is now.
    this.occupancy.clearUnit(unit.cellX, unit.cellZ, unit.def.footprintX, unit.def.footprintZ, unit.id);
    [unit.cellX, unit.cellZ] = this.terrain.footprintCell(unit.x, unit.z, unit.def.footprintX, unit.def.footprintZ);
    this.occupancy.setUnit(unit.cellX, unit.cellZ, unit.def.footprintX, unit.def.footprintZ, unit.id);
    if (!this.canWalk(unit)) return;
    unit.exitFactory = factory.id;
    unit.rotation = factory.rotation;
    // Drive straight to the exit without path planning (the planner can't see a way out of the walls).
    unit.tasks.push({ kind: 'move', x: ex, z: ez, started: true });
    unit.order = { x: ex, z: ez };
    unit.path = { waypoints: [[ex, ez]], index: 0, createdTick: this.tickCount, complete: true };
    if (factory.rally) {
      unit.tasks.push({ kind: 'move', x: factory.rally[0], z: factory.rally[1] });
    } else {
      // No rally point: park in rows in front, so the doorway stays clear for the next one.
      const n = factory.factory!.released++;
      const side = ((n % 5) - 2) * 32;
      const ahead = 40 + Math.floor(n / 5) * 32;
      unit.tasks.push({ kind: 'move', x: ex + fx * ahead + fz * side, z: ez + fz * ahead - fx * side });
    }
  }

  private cancelInFactory(u: SimUnit): void {
    const f = u.factory!;
    const t = f.currentId !== undefined ? this.units.get(f.currentId) : undefined;
    if (t && !this.isFinished(t)) this.removeUnit(t);
    f.currentId = undefined;
  }

  removeUnit(u: SimUnit): void {
    if (u.def.bmCode === 0) this.occupancy.clearBuilding(u.cellX, u.cellZ, u.def.footprintX, u.def.footprintZ, u.id);
    else this.occupancy.clearUnit(u.cellX, u.cellZ, u.def.footprintX, u.def.footprintZ, u.id);
    this.units.delete(u.id);
    this.orderCache = undefined;
  }

  // --- combat ------------------------------------------------------------------------

  /** Whether `player` can see (or has on radar) unit `u`. A player always sees its own units. */
  canSee(player: number, u: SimUnit): boolean {
    return u.owner === player || (this.visibility.at(player, u.x, u.z) & (SEEN | RADAR)) !== 0;
  }

  /** Answers a piece query script once per unit (they always name the same piece). */
  queryPiece(u: SimUnit, script: string): string | undefined {
    if (!u.pieceQueries.has(script)) {
      const idx = u.scripts?.vm.hasFunction(script) ? u.scripts.query(script) : undefined;
      u.pieceQueries.set(script, idx !== undefined && u.scripts ? u.scripts.pieceName(idx) : undefined);
    }
    return u.pieceQueries.get(script);
  }

  /** A piece's position in the world right now (or the unit's middle when there's no such piece). */
  piecePositionWorld(u: SimUnit, piece: string | undefined): [number, number, number] {
    if (!piece || !u.scripts) return [u.x, u.y + u.height / 2, u.z];
    const [lx, ly, lz] = u.scripts.piecePosition(piece);
    const [wx, wy, wz] = rotateYXZ([lx, ly, lz], 0, angleToRadians(u.rotation), 0);
    return [u.x + wx, u.y + wy, u.z + wz];
  }

  spawnProjectile(owner: number, w: WeaponDef, from: [number, number, number], dir: [number, number, number], distance: number, targetUnit: number | undefined): void {
    let dieTick: number | undefined;
    if (w.timerTicks !== undefined) {
      dieTick = this.tickCount + w.timerTicks - Math.floor(w.randomDecayTicks / 2) + this.rng.int(0, w.randomDecayTicks);
    } else if (w.kind === 'lineOfSight') {
      dieTick = this.tickCount + Math.floor(distance / Math.max(0.01, w.velocity)) + 1;
    }
    this.projectiles.push({
      id: this.nextProjectileId++,
      owner,
      weapon: w,
      x: from[0],
      y: from[1],
      z: from[2],
      prevX: from[0],
      prevY: from[1],
      prevZ: from[2],
      vx: dir[0] * w.velocity,
      vy: dir[1] * w.velocity,
      vz: dir[2] * w.velocity,
      dieTick,
      targetUnit,
      originX: from[0],
      originY: from[1],
      originZ: from[2],
      dead: false,
    });
  }

  /** Applies damage; a unit at zero hit points dies (quietly if it was still being built, as in RWE). */
  damage(u: SimUnit, amount: number, _attacker: number): void {
    if (u.dying || amount <= 0) return;
    u.hp -= amount;
    if (u.hp > 0) return;
    if (!this.isFinished(u)) {
      this.removeUnit(u);
      return;
    }
    this.kill(u, Math.min(100, Math.round((amount / u.def.maxDamage) * 100)));
  }

  /**
   * Starts a unit's death: its Killed(severity, corpsetype) script runs (pieces fly off via explode),
   * its death blast ("explodeas") goes off, and when the script is done the unit is replaced by its wreck.
   * A Commander's death knocks its player out: all their units die too, as in RWE.
   */
  kill(u: SimUnit, severity: number): void {
    if (u.dying) return;
    this.abortTasks(u);
    if (u.factory) {
      this.cancelInFactory(u);
      u.factory.queue = [];
    }
    u.speed = 0;
    u.dying = { since: this.tickCount, severity, thread: u.scripts?.vm.start('Killed', [severity, 0]) };
    this.events.push({ tick: this.tickCount, kind: 'death', unitId: u.id, unitName: u.def.unitName, x: u.x, y: u.y, z: u.z });
    const blast = this.weaponDefs.get(u.def.explodeAs);
    if (blast) explode(this, blast, u.owner, u.x, u.y + u.height / 2, u.z, u.y < this.terrain.seaLevel);
    if (u.def.commander && !this.defeated.has(u.owner)) {
      this.defeated.add(u.owner);
      for (const o of this.unitsInOrder()) if (o.owner === u.owner && o !== u && !o.dying) this.isFinished(o) ? this.kill(o, 100) : this.removeUnit(o);
    }
  }

  private updateDying(u: SimUnit): void {
    u.scripts?.tick();
    const d = u.dying!;
    const t = d.thread;
    const done = !t || t.killed || t.state.kind === 'finished' || this.tickCount - d.since > 3 * TICKS_PER_SECOND;
    if (!done) return;
    // corpsetype: 1 = wreck, 2 = heap (the wreck's "featuredead"), 3 = nothing.
    const corpseType = (t && t.state.kind === 'finished' ? t.returnLocals[1] : undefined) || 1;
    this.removeUnit(u);
    let wreck = u.def.corpse ? this.featureDefs.get(u.def.corpse.toLowerCase()) : undefined;
    if (corpseType === 2) wreck = wreck?.featureDead ? this.featureDefs.get(wreck.featureDead.toLowerCase()) : undefined;
    if (corpseType >= 3) wreck = undefined;
    if (wreck) this.addFeature(wreck, u.x, u.z);
  }

  /** Places a feature (a wreck or heap) centred near (x, z). Returns it, or undefined if blocked. */
  addFeature(def: FeatureDef, x: number, z: number): SimFeature | undefined {
    const [cx, cz] = this.terrain.footprintCell(x, z, def.footprintX, def.footprintZ);
    if (def.blocking && this.occupancy.staticBlocked(cx, cz, def.footprintX, def.footprintZ)) return undefined;
    const [fx, fz] = this.terrain.cellCenter(cx, cz, def.footprintX, def.footprintZ);
    const f: SimFeature = { id: this.features.length, def, cellX: cx, cellZ: cz, x: fx, y: this.terrain.heightAt(fx, fz), z: fz, alive: true };
    this.features.push(f);
    if (def.blocking) this.occupancy.setFeature(cx, cz, def.footprintX, def.footprintZ, f.id);
    return f;
  }

  private updateVisibility(): void {
    for (let p = 0; p < this.players.length; p++) {
      const viewers = this.unitsInOrder()
        .filter((u) => u.owner === p && this.isFinished(u) && !u.dying)
        .map((u) => ({ x: u.x, z: u.z, sight: u.def.sightDistance, radar: u.scripts?.state.activated || !u.def.onOffable ? u.def.radarDistance : 0 }));
      this.visibility.refresh(p, viewers);
    }
  }

  // --- economy ----------------------------------------------------------------------

  private updateWind(): void {
    if (this.tickCount < this.nextWindChange) return;
    // A new wind speed every 5-14 seconds, uniform between the map's limits (RWE updateWind).
    this.nextWindChange = this.tickCount + this.rng.int(5, 14) * TICKS_PER_SECOND;
    const o = this.map.ota;
    this.windSpeed = this.rng.int(o?.minWindSpeed ?? 0, o?.maxWindSpeed ?? 0);
  }

  /** Once a second: storage, settlement, then this second's production and running costs. */
  private updateEconomy(): void {
    const maxMetal = this.players.map(() => 0);
    const maxEnergy = this.players.map(() => 0);
    const ordered = [...this.units.values()].sort((a, b) => a.id - b.id);
    for (const u of ordered) {
      if (!this.isFinished(u) || !this.players[u.owner]) continue;
      if (u.def.commander) {
        maxMetal[u.owner]! += this.players[u.owner]!.startingMetal;
        maxEnergy[u.owner]! += this.players[u.owner]!.startingEnergy;
      } else {
        maxMetal[u.owner]! += u.def.metalStorage;
        maxEnergy[u.owner]! += u.def.energyStorage;
      }
    }
    this.players.forEach((p, i) => p.settle(maxMetal[i]!, maxEnergy[i]!));

    const windFactor = Math.min(1, this.windSpeed / MAX_USEFUL_WIND);
    for (const u of ordered) {
      const p = this.players[u.owner];
      if (!p || !this.isFinished(u)) continue;
      const d = u.def;
      p.produce(d.energyMake, d.metalMake);
      if (!u.scripts?.state.activated) continue;
      if (d.windGenerator) p.produce(d.windGenerator * windFactor, 0);
      // Tidal power isn't in RWE yet; we use the map's tidal strength per generator.
      if (d.tidalGenerator) p.produce(this.map.ota?.tidalStrength ?? 0, 0);
      if (u.powered) {
        if (d.extractsMetal) p.produce(0, this.metalUnder(u) * d.extractsMetal);
        if (d.makesMetal) p.produce(0, d.makesMetal);
      }
      // Negative running costs are production (TA's solar collectors have negative energyuse).
      p.produce(-Math.min(0, d.energyUse), -Math.min(0, d.metalUse));
      u.powered = p.trySpend(Math.max(0, d.energyUse), Math.max(0, d.metalUse));
    }
  }

  /** Total metal value under a unit's footprint. */
  metalUnder(u: SimUnit): number {
    let sum = 0;
    for (let dz = 0; dz < u.def.footprintZ; dz++) {
      for (let dx = 0; dx < u.def.footprintX; dx++) {
        const x = u.cellX + dx;
        const z = u.cellZ + dz;
        if (x >= 0 && z >= 0 && x < this.terrain.width && z < this.terrain.height) sum += this.metal[z * this.terrain.width + x]!;
      }
    }
    return sum;
  }

  // --- movement (Phase 5) ------------------------------------------------------------

  /** Path following; returns [heading, speed] to steer towards, or undefined when the move is done. */
  private followOrder(u: SimUnit, order: { x: number; z: number }): [number, number] | undefined {
    const now = this.tickCount;
    const needPath =
      !u.path ||
      (u.inCollision && now - u.path.createdTick >= REPATH_INTERVAL) ||
      (u.path.index >= u.path.waypoints.length && !u.path.complete && now - u.path.createdTick >= REPATH_INTERVAL);
    if (needPath) {
      // Only count re-plans when the unit has barely moved since the last one. Waiting in line behind a
      // moving unit counts much less (two units can block each other forever, so it still counts a bit).
      const moved = Math.hypot(u.x - u.lastPlanX, u.z - u.lastPlanZ) > 2 * WAYPOINT_RADIUS;
      if (moved) u.repathAttempts = 0;
      else if (u.path) u.repathAttempts += u.blockedByMover ? 1 / 4 : 1;
      if (u.repathAttempts > MAX_REPATHS) {
        this.stopDriving(u); // can't get there; give up rather than jitter forever
        return undefined;
      }
      u.lastPlanX = u.x;
      u.lastPlanZ = u.z;
      u.path = this.planPath(u, order.x, order.z, u.inCollision);
    }
    const path = u.path!;
    if (path.index >= path.waypoints.length) {
      if (path.complete) this.stopDriving(u);
      return path.complete ? undefined : [u.rotation, 0];
    }

    const [wx, wz] = path.waypoints[path.index]!;
    const dist = Math.hypot(wx - u.x, wz - u.z);
    const last = path.index === path.waypoints.length - 1;
    if (last) {
      if (dist < FINAL_RADIUS) {
        path.index++;
        if (path.complete) this.stopDriving(u);
        return undefined;
      }
      return this.arrive(u, wx, wz, dist);
    }
    if (dist < WAYPOINT_RADIUS) {
      path.index++;
      return this.followOrder(u, order);
    }
    return this.seek(u, wx, wz, dist);
  }

  /** Ends the current drive. A plain move task then counts as done; other tasks decide for themselves. */
  private stopDriving(u: SimUnit): void {
    u.order = undefined;
    const t = u.tasks[0];
    if (t && t.kind !== 'move' && u.repathAttempts > MAX_REPATHS) {
      // Couldn't get to the job at all.
      this.finishTask(u);
    }
  }

  private seek(u: SimUnit, wx: number, wz: number, dist: number): [number, number] {
    const heading = toRotation(wx - u.x, wz - u.z);
    const [fx, fz] = toDirection(u.rotation);
    let factor = Math.max(0, dist > 0 ? (fx * (wx - u.x) + fz * (wz - u.z)) / dist : 0);
    if (dist <= turnRadius(u.def)) factor *= factor; // discourage orbiting the waypoint
    return [heading, u.def.maxVelocity * factor];
  }

  private arrive(u: SimUnit, wx: number, wz: number, dist: number): [number, number] {
    const braking = (u.speed * u.speed) / (2 * Math.max(1e-6, u.def.brakeRate));
    if (dist > braking) return this.seek(u, wx, wz, dist);
    return [toRotation(wx - u.x, wz - u.z), 0];
  }

  /**
   * Plans a path. When the unit is stuck against others, units standing still nearby count as
   * obstacles too, so it routes around a parked group instead of pushing into it.
   */
  private planPath(u: SimUnit, tx: number, tz: number, avoidIdle = false): SimUnit['path'] {
    const mc = u.def.movementClass;
    const base = this.pathGrid(mc);
    const w = this.terrain.width;
    let grid = base;
    if (avoidIdle) {
      grid = base.slice();
      const R = 12 * 16;
      for (const o of this.units.values()) {
        if (o.id === u.id || o.order || o.def.bmCode === 0 || Math.abs(o.x - u.x) > R || Math.abs(o.z - u.z) > R) continue;
        // Block every top-left cell from which our footprint would overlap theirs.
        for (let z = o.cellZ - mc.footprintZ + 1; z < o.cellZ + o.def.footprintZ; z++) {
          for (let x = o.cellX - mc.footprintX + 1; x < o.cellX + o.def.footprintX; x++) {
            if (x >= 0 && z >= 0 && x < w && z < this.terrain.height) grid[z * w + x] = 0;
          }
        }
      }
    }
    const start = this.terrain.footprintCell(u.x, u.z, mc.footprintX, mc.footprintZ);
    const goal = this.terrain.footprintCell(tx, tz, mc.footprintX, mc.footprintZ);
    const clampCell = (c: [number, number]): [number, number] => [clamp(c[0], 0, w - 1), clamp(c[1], 0, this.terrain.height - 1)];
    const result = findPath({
      width: w,
      height: this.terrain.height,
      passable: (x, z) => grid[z * w + x] === 1,
      start: clampCell(start),
      goal: clampCell(goal),
    });
    const waypoints = result.waypoints.map(([cx, cz]) => this.terrain.cellCenter(cx, cz, mc.footprintX, mc.footprintZ));
    // Finish on the exact spot that was clicked when we can reach it.
    if (result.complete && waypoints.length > 0) waypoints[waypoints.length - 1] = [tx, tz];
    if (result.complete && waypoints.length === 0) waypoints.push([tx, tz]);
    return { waypoints, index: 0, createdTick: this.tickCount, complete: result.complete };
  }

  /** Walkable cells for a movement class, minus blocking features and solid building cells. */
  private pathGrid(mc: MovementClass): Uint8Array {
    const key = `${mc.name}|${mc.footprintX}|${mc.footprintZ}`;
    const cached = this.pathGrids.get(key);
    if (cached && cached.version === this.occupancy.version) return cached.grid;
    const walk = this.terrain.walkableGrid(mc);
    const w = this.terrain.width;
    const grid = new Uint8Array(walk.length);
    for (let i = 0; i < grid.length; i++) {
      if (!walk[i]) continue;
      const x = i % w;
      const z = (i - x) / w;
      grid[i] = this.occupancy.staticBlocked(x, z, mc.footprintX, mc.footprintZ) ? 0 : 1;
    }
    this.pathGrids.set(key, { version: this.occupancy.version, grid });
    return grid;
  }

  private moveUnit(u: SimUnit): void {
    u.inCollision = false;
    u.blockedByMover = false;
    if (u.speed <= 0) return;
    const [dx, dz] = toDirection(u.rotation);
    if (this.tryMove(u, u.x + dx * u.speed, u.z + dz * u.speed)) return;
    u.inCollision = true;
    // Try sliding along one axis, the major one second (as RWE does).
    const alongX: [number, number] = [u.x + dx * u.speed, u.z];
    const alongZ: [number, number] = [u.x, u.z + dz * u.speed];
    const [first, second] = dx > dz ? [alongZ, alongX] : [alongX, alongZ];
    if (!this.tryMove(u, first[0], first[1])) this.tryMove(u, second[0], second[1]);
  }

  private tryMove(u: SimUnit, x: number, z: number): boolean {
    const { def } = u;
    const [cx, cz] = this.terrain.footprintCell(x, z, def.footprintX, def.footprintZ);
    if (cx !== u.cellX || cz !== u.cellZ) {
      if (this.occupancy.blocked(cx, cz, def.footprintX, def.footprintZ, u.id, u.exitFactory ?? 0)) {
        const other = this.occupancy.firstUnit(cx, cz, def.footprintX, def.footprintZ, u.id);
        if (other !== 0 && this.units.get(other)?.order) u.blockedByMover = true;
        return false;
      }
      if (!this.terrain.fits(def.movementClass, cx, cz)) return false;
      this.occupancy.clearUnit(u.cellX, u.cellZ, def.footprintX, def.footprintZ, u.id);
      this.occupancy.setUnit(cx, cz, def.footprintX, def.footprintZ, u.id);
      u.cellX = cx;
      u.cellZ = cz;
      if (u.exitFactory !== undefined && !this.overlapsBuilding(u, u.exitFactory)) u.exitFactory = undefined;
    }
    u.x = x;
    u.z = z;
    u.y = this.groundY(def, x, z);
    return true;
  }

  private overlapsBuilding(u: SimUnit, buildingId: number): boolean {
    for (let dz = 0; dz < u.def.footprintZ; dz++) {
      for (let dx = 0; dx < u.def.footprintX; dx++) {
        const x = u.cellX + dx;
        const z = u.cellZ + dz;
        if (x >= 0 && z >= 0 && x < this.terrain.width && z < this.terrain.height && this.occupancy.buildings[z * this.terrain.width + x] === buildingId) return true;
      }
    }
    return false;
  }

  private groundY(def: UnitDef, x: number, z: number): number {
    const ground = this.terrain.heightAt(x, z);
    return def.floater || def.canHover ? Math.max(ground, this.terrain.seaLevel) : ground;
  }

  /** A short fingerprint of the game state, for checking determinism. */
  hash(): string {
    let h = 2166136261;
    const mix = (v: number) => {
      h ^= Math.round(v * 1000) | 0;
      h = Math.imul(h, 16777619);
    };
    for (const u of [...this.units.values()].sort((a, b) => a.id - b.id)) {
      mix(u.id);
      mix(u.x);
      mix(u.z);
      mix(u.rotation);
      mix(u.speed);
      mix(u.buildProgress);
    }
    for (const p of this.players) {
      mix(p.metal);
      mix(p.energy);
    }
    for (const p of this.projectiles) {
      mix(p.x);
      mix(p.y);
      mix(p.z);
    }
    mix(this.features.filter((f) => f.alive).length);
    mix(this.tickCount);
    return (h >>> 0).toString(16);
  }
}

/** Unit heading for a direction (x, z): 0 is +z, like RWE's atan2(x, z). */
export function toRotation(x: number, z: number): number {
  return wrapAngle(Math.round((Math.atan2(x, z) * ANGLE_FULL_TURN) / (2 * Math.PI)));
}

export function toDirection(rotation: number): [number, number] {
  const r = angleToRadians(rotation);
  return [Math.sin(r), Math.cos(r)];
}

/** Radius of the circle a unit drives at full speed and full turn (RWE getTurnRadius). */
function turnRadius(def: UnitDef): number {
  const radiansPerTick = angleToRadians(def.turnRate);
  return radiansPerTick > 0 ? def.maxVelocity / radiansPerTick : 0;
}

/** The highest point of a model in its rest pose, used as the unit's height (RWE findHighestVertex). */
function modelHeight(model: Piece | undefined): number {
  if (!model) return 16;
  let top = 0;
  const walk = (p: Piece, oy: number) => {
    const y0 = oy + p.offset[1];
    for (let i = 1; i < p.vertices.length; i += 3) top = Math.max(top, y0 + p.vertices[i]!);
    p.children.forEach((c) => walk(c, y0));
  };
  walk(model, 0);
  return Math.max(4, top);
}

function toSigned(a: number): number {
  return a >= ANGLE_FULL_TURN / 2 ? a - ANGLE_FULL_TURN : a;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

