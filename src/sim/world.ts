import type { ModelPiece } from '../formats/3do';
import type { CobScript } from '../formats/cob';
import type { GameMap } from '../map/mapData';
import { Occupancy } from './occupancy';
import { findPath } from './pathfinding';
import { ANGLE_FULL_TURN, angleToRadians, TICKS_PER_SECOND, turnTowards, wrapAngle } from './pieces';
import { Rng } from './rng';
import { SimTerrain } from './terrain';
import type { MovementClass, UnitDef } from './unitDef';
import { UnitScripts } from './unitScripts';

/*
 * The simulation: a fixed 30 Hz, deterministic loop. Everything that changes the game goes through
 * `issue()` and takes effect at the start of the next tick, so the same commands on the same ticks always
 * give the same result. The renderer reads units (position, rotation, previous-tick values for smooth
 * drawing, and piece state from their scripts) but never writes to them.
 *
 * Ground movement follows RWE (src/rwe/sim/UnitBehaviorService*.cpp):
 *   - steering picks a heading towards the next waypoint and a target speed: full speed scaled by how
 *     well the unit faces the waypoint (squared when within its turning circle), or 0 once within
 *     braking distance of the final waypoint;
 *   - the unit turns by at most turnRate per tick, speeds up by acceleration or slows by brakeRate,
 *     and goes half speed when under water;
 *   - a move that would hit another unit, a blocking feature, too steep a slope or wrong water depth is
 *     refused; then it tries moving along just one axis;
 *   - waypoints count as reached within 16 units (8 for the last one); when stuck, it asks for a new
 *     path, at most once a second.
 */

export type UnitOrder = { kind: 'move'; x: number; z: number };

export type Command =
  | { kind: 'move'; unitIds: number[]; x: number; z: number }
  | { kind: 'stop'; unitIds: number[] };

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
  order: UnitOrder | undefined;
  path: { waypoints: [number, number][]; index: number; createdTick: number; complete: boolean } | undefined;
  /** New paths asked for without getting closer to the goal; the order is dropped after too many. */
  repathAttempts: number;
  /** Where the unit was when it last planned a path, to tell real progress from being stuck. */
  lastPlanX: number;
  lastPlanZ: number;
  inCollision: boolean;
  /** True when the last refused move was blocked by a unit that is itself on the move (a queue). */
  blockedByMover: boolean;
  scripts: UnitScripts | undefined;
  /** Whether the unit's script has been told it is moving (StartMoving/StopMoving). */
  scriptMoving: boolean;
}

export interface UnitAssets {
  def: UnitDef;
  model: ModelPiece | undefined;
  script: CobScript | undefined;
}

const WAYPOINT_RADIUS = 16;
const FINAL_RADIUS = 8;
const REPATH_INTERVAL = TICKS_PER_SECOND;
const MAX_REPATHS = 10;

export class World {
  readonly terrain: SimTerrain;
  readonly occupancy: Occupancy;
  readonly units = new Map<number, SimUnit>();
  readonly rng: Rng;
  tickCount = 0;
  private nextId = 1;
  private queue: Command[] = [];
  private readonly pathGrids = new Map<string, Uint8Array>();

  constructor(
    readonly map: GameMap,
    seed: number,
  ) {
    this.terrain = new SimTerrain(map.tnt);
    this.occupancy = new Occupancy(map.tnt.width, map.tnt.height);
    this.rng = new Rng(seed);
    for (const f of map.features) {
      if (f.def.blocking) this.occupancy.setFeature(f.cellX, f.cellZ, f.def.footprintX, f.def.footprintZ);
    }
  }

  /** Queues a command for the next tick. */
  issue(cmd: Command): void {
    this.queue.push(cmd);
  }

  /**
   * Places a unit at the free spot nearest (x, z) where it fits. Returns undefined if there is none
   * within a few hundred units. Placement happens immediately (used when setting up a game).
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
          if (!this.terrain.fits(def.ownMovement, cx, cz)) continue;
          if (this.occupancy.blocked(cx, cz, def.footprintX, def.footprintZ)) continue;
          return this.place(assets, owner, cx, cz, rotation);
        }
      }
    }
    return undefined;
  }

  private place(assets: UnitAssets, owner: number, cx: number, cz: number, rotation: number): SimUnit {
    const { def } = assets;
    const id = this.nextId++;
    const [x, z] = this.terrain.cellCenter(cx, cz, def.footprintX, def.footprintZ);
    const y = this.groundY(def, x, z);
    const scripts =
      assets.script && assets.model ? new UnitScripts(assets.script, assets.model, new Rng(this.rng.nextU32())) : undefined;
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
      order: undefined,
      path: undefined,
      repathAttempts: 0,
      lastPlanX: x,
      lastPlanZ: z,
      inCollision: false,
      blockedByMover: false,
      scripts,
      scriptMoving: false,
    };
    this.occupancy.setUnit(cx, cz, def.footprintX, def.footprintZ, id);
    this.units.set(id, unit);
    scripts?.start('Create');
    return unit;
  }

  /** Advances the game by one tick. */
  tick(): void {
    const cmds = this.queue;
    this.queue = [];
    for (const c of cmds) this.apply(c);

    const ordered = [...this.units.values()].sort((a, b) => a.id - b.id);
    for (const u of ordered) {
      u.prevX = u.x;
      u.prevY = u.y;
      u.prevZ = u.z;
      u.prevRotation = u.rotation;
      this.updateUnit(u);
    }
    this.tickCount++;
  }

  private apply(c: Command): void {
    const units = c.unitIds.map((id) => this.units.get(id)).filter((u): u is SimUnit => !!u && u.def.canMove && u.def.maxVelocity > 0);
    if (c.kind === 'stop') {
      for (const u of units) this.clearOrder(u);
      return;
    }
    // Keep the group's shape, squeezed so it doesn't sprawl: each unit aims for the target plus its
    // offset from the group's centre, scaled down to fit a circle that grows with the group's size.
    const cx = units.reduce((s, u) => s + u.x, 0) / Math.max(1, units.length);
    const cz = units.reduce((s, u) => s + u.z, 0) / Math.max(1, units.length);
    const maxR = units.reduce((m, u) => Math.max(m, Math.hypot(u.x - cx, u.z - cz)), 0);
    const allowed = 24 * Math.sqrt(units.length);
    const k = maxR > allowed ? allowed / maxR : 1;
    for (const u of units) {
      const tx = clamp(c.x + (u.x - cx) * k, 0, this.map.widthUnits);
      const tz = clamp(c.z + (u.z - cz) * k, 0, this.map.heightUnits);
      u.order = { kind: 'move', x: tx, z: tz };
      u.path = undefined;
      u.repathAttempts = 0;
    }
  }

  private clearOrder(u: SimUnit): void {
    u.order = undefined;
    u.path = undefined;
  }

  private updateUnit(u: SimUnit): void {
    let targetAngle = u.rotation;
    let targetSpeed = 0;

    if (u.order?.kind === 'move') {
      const steer = this.followOrder(u, u.order);
      if (steer) [targetAngle, targetSpeed] = steer;
    }

    // Steering: turn, then speed up or brake (RWE updateUnitRotation / computeNewGroundUnitSpeed).
    u.rotation = turnTowards(u.rotation, targetAngle, u.def.turnRate);
    let speed = u.speed;
    if (targetSpeed > speed) speed = Math.min(targetSpeed, speed + u.def.acceleration);
    else speed = Math.max(targetSpeed, speed - u.def.brakeRate);
    const maxSpeed = u.y < this.terrain.seaLevel ? u.def.maxVelocity / 2 : u.def.maxVelocity;
    u.speed = clamp(speed, 0, maxSpeed);

    this.moveUnit(u);

    // Tell the unit's script when it starts and stops moving, so it plays its walk animation.
    const moving = u.speed > 0;
    if (u.scripts && moving !== u.scriptMoving) {
      u.scriptMoving = moving;
      u.scripts.start(moving ? 'StartMoving' : 'StopMoving');
    }
    u.scripts?.tick();
  }

  /** Path following; returns [heading, speed] to steer towards, or undefined when the order is done. */
  private followOrder(u: SimUnit, order: UnitOrder): [number, number] | undefined {
    const now = this.tickCount;
    const needPath =
      !u.path ||
      (u.inCollision && now - u.path.createdTick >= REPATH_INTERVAL) ||
      (u.path.index >= u.path.waypoints.length && !u.path.complete && now - u.path.createdTick >= REPATH_INTERVAL);
    if (needPath) {
      // Only count re-plans when the unit has barely moved since the last one: being jostled while
      // still getting somewhere (even around a detour) is fine.
      // Waiting in line behind a moving unit counts much less (two units can block each other forever,
      // so it still counts a little).
      const moved = Math.hypot(u.x - u.lastPlanX, u.z - u.lastPlanZ) > 2 * WAYPOINT_RADIUS;
      if (moved) u.repathAttempts = 0;
      else if (u.path) u.repathAttempts += u.blockedByMover ? 1 / 4 : 1;
      if (u.repathAttempts > MAX_REPATHS) {
        this.clearOrder(u); // can't get there; give up rather than jitter forever
        return undefined;
      }
      u.lastPlanX = u.x;
      u.lastPlanZ = u.z;
      u.path = this.planPath(u, order.x, order.z, u.inCollision);
    }
    const path = u.path!;
    if (path.index >= path.waypoints.length) {
      if (path.complete) this.clearOrder(u);
      return path.complete ? undefined : [u.rotation, 0];
    }

    const [wx, wz] = path.waypoints[path.index]!;
    const dist = Math.hypot(wx - u.x, wz - u.z);
    const last = path.index === path.waypoints.length - 1;
    if (last) {
      if (dist < FINAL_RADIUS) {
        path.index++;
        if (path.complete) this.clearOrder(u);
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
        if (o.id === u.id || o.order || Math.abs(o.x - u.x) > R || Math.abs(o.z - u.z) > R) continue;
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

  /** Walkable cells for a movement class, minus blocking features. Units are left to collisions. */
  private pathGrid(mc: MovementClass): Uint8Array {
    const key = `${mc.name}|${mc.footprintX}|${mc.footprintZ}`;
    let g = this.pathGrids.get(key);
    if (!g) {
      const walk = this.terrain.walkableGrid(mc);
      const w = this.terrain.width;
      g = new Uint8Array(walk.length);
      for (let i = 0; i < g.length; i++) {
        if (!walk[i]) continue;
        const x = i % w;
        const z = (i - x) / w;
        g[i] = this.occupancy.featureBlocked(x, z, mc.footprintX, mc.footprintZ) ? 0 : 1;
      }
      this.pathGrids.set(key, g);
    }
    return g;
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
      if (this.occupancy.blocked(cx, cz, def.footprintX, def.footprintZ, u.id)) {
        const other = this.occupancy.firstUnit(cx, cz, def.footprintX, def.footprintZ, u.id);
        if (other !== 0 && this.units.get(other)?.order) u.blockedByMover = true;
        return false;
      }
      if (!this.terrain.fits(def.movementClass, cx, cz)) return false;
      this.occupancy.clearUnit(u.cellX, u.cellZ, def.footprintX, def.footprintZ, u.id);
      this.occupancy.setUnit(cx, cz, def.footprintX, def.footprintZ, u.id);
      u.cellX = cx;
      u.cellZ = cz;
    }
    u.x = x;
    u.z = z;
    u.y = this.groundY(def, x, z);
    return true;
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
    }
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

