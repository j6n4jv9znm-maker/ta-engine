import type { CobThread } from './cob/vm';
import { ANGLE_FULL_TURN, angleToRadians, TICKS_PER_SECOND, wrapAngle } from './pieces';
import { rotateYXZ } from './unitScripts';
import type { WeaponDef } from './weaponDef';
import { damageAgainst } from './weaponDef';
import type { SimUnit, World } from './world';
import { toDirection, toRotation } from './world';

/*
 * Weapons, projectiles and damage, following RWE (src/rwe/sim/UnitBehaviorService.cpp updateWeapon,
 * tryFireWeapon; GameSimulation.cpp updateProjectiles, checkProjectileCollision, applyDamageInRadius):
 *
 *   - an idle weapon picks the nearest enemy in range that its owner can see (or has on radar);
 *   - it runs the unit's Aim<Primary|Secondary|Tertiary>(heading, pitch) script; when that returns TRUE
 *     and the target hasn't moved out of the weapon's tolerance, and the weapon has reloaded, it fires:
 *     the projectile starts at the piece Query<...> names, the Fire<...> script runs, and a burst of
 *     `burst` shots follows `burstrate` seconds apart;
 *   - projectiles fly for real: straight (line of sight, lasers), ballistic (gravity 112 / 30² per tick²,
 *     aimed with the low firing angle), or tracking (turning towards the target each tick). They hit the
 *     ground, water, or the first enemy unit, building or blocking feature whose box they enter, so
 *     misses are possible;
 *   - an impact damages everything within the weapon's radius, scaled down linearly with distance from
 *     the unit's box, using the weapon's damage for that unit type ("default" otherwise), times the
 *     unit's damagemodifier while it's armored.
 */

export type WeaponIndex = 0 | 1 | 2;
const SCRIPT_SUFFIX = ['Primary', 'Secondary', 'Tertiary'] as const;
/** Gravity in world units per tick², as RWE uses for ballistic weapons. */
export const GRAVITY = 112 / (30 * 30);

export interface WeaponSlot {
  def: WeaponDef;
  /** Tick at which the weapon has reloaded. */
  readyTick: number;
  target: number | undefined;
  /** Forced target from an attack order (overrides auto-targeting). */
  aim: { thread: CobThread; heading: number; pitch: number } | undefined;
  burst: { fired: number; nextTick: number; heading: number; pitch: number; target: [number, number, number] } | undefined;
  /** Piece projectiles start from (cached from Query<...>). */
  firePiece: string | undefined;
}

export interface Projectile {
  id: number;
  owner: number;
  weapon: WeaponDef;
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  vx: number;
  vy: number;
  vz: number;
  dieTick: number | undefined;
  targetUnit: number | undefined;
  /** The unit that fired it, if it was aiming at a unit (to tell it when its shots are blocked). */
  shooter?: number;
  /** Where the shot started, for drawing beams. */
  originX: number;
  originY: number;
  originZ: number;
  dead: boolean;
}

export type CombatEvent =
  | { tick: number; kind: 'explosion'; x: number; y: number; z: number; gaf: string; art: string; radius: number; sound: string }
  /** `first` is the first shot of a burst. */
  | { tick: number; kind: 'fire'; unitId: number; weapon: string; x: number; y: number; z: number; first: boolean }
  /** A unit finished being built. */
  | { tick: number; kind: 'complete'; unitId: number; owner: number }
  | { tick: number; kind: 'death'; unitId: number; unitName: string; x: number; y: number; z: number }
  /** A unit script blew a piece off (explode); `flags` are TA's explode types (SHATTER, FALL, ...). */
  | { tick: number; kind: 'debris'; unitId: number; piece: string; flags: number };

/** How far (world units) a straight shot may dip into the ground before it counts as hitting it. */
const GROUND_SKIM = 6;

export function makeWeaponSlots(world: World, u: SimUnit): (WeaponSlot | undefined)[] {
  return u.def.weapons.map((name) => {
    const def = name ? world.weaponDefs.get(name) : undefined;
    return def ? { def, readyTick: 0, target: undefined, aim: undefined, burst: undefined, firePiece: undefined } : undefined;
  });
}

/** Runs one unit's weapons for a tick. `forcedTarget` comes from an attack order. */
export function updateWeapons(world: World, u: SimUnit, forcedTarget: number | undefined): void {
  u.weapons.forEach((slot, i) => {
    if (slot) updateWeapon(world, u, slot, i as WeaponIndex, forcedTarget);
  });
}

function updateWeapon(world: World, u: SimUnit, slot: WeaponSlot, index: WeaponIndex, forced: number | undefined): void {
  const w = slot.def;
  if (slot.burst) {
    tryFire(world, u, slot, index);
    return;
  }

  // Pick (or keep) a target.
  if (forced !== undefined && (!w.commandFire || w.kind === 'dropped')) slot.target = forced;
  let target = slot.target !== undefined ? world.units.get(slot.target) : undefined;
  // A target given by an attack order is kept even when out of this unit's own sight (a bomber can't
  // see far below it); others must be in sight.
  const ordered = forced !== undefined && target?.id === forced;
  if (!target || target.dying || !inRange(u, target, w.range) || (!ordered && !world.canSee(u.owner, target)) || !canHit(world, w, target)) {
    slot.target = undefined;
    slot.aim = undefined;
    target = undefined;
    // Look for a new target a few times a second, spread across units, rather than every tick.
    if (!w.commandFire && (world.tickCount + u.id) % 6 === 0) target = acquire(world, u, w);
    if (!target) return;
    slot.target = target.id;
  }
  if (w.kind === 'dropped') return dropBomb(world, u, slot, target);

  const to = aimPoint(target);
  if (!slot.aim) {
    const from = world.piecePositionWorld(u, world.queryPiece(u, `AimFrom${SCRIPT_SUFFIX[index]}`));
    const [heading, pitch] = headingAndPitch(u, from, to, w);
    const thread = u.scripts?.vm.start(`Aim${SCRIPT_SUFFIX[index]}`, [toCob(heading), toCob(pitch)]);
    if (thread) {
      slot.aim = { thread, heading, pitch };
    } else if (world.tickCount >= slot.readyTick) {
      // No aiming script: fire straight away.
      slot.burst = { fired: 0, nextTick: world.tickCount, heading, pitch, target: to };
      tryFire(world, u, slot, index);
    }
    return;
  }

  const t = slot.aim.thread;
  if (t.killed) {
    slot.aim = undefined; // another aim call cancelled this one; try again next tick
    return;
  }
  if (t.state.kind !== 'finished') return;
  const last = slot.aim;
  slot.aim = undefined;
  if (!t.returnValue) return;
  const from = world.piecePositionWorld(u, world.queryPiece(u, `AimFrom${SCRIPT_SUFFIX[index]}`));
  const [heading, pitch] = headingAndPitch(u, from, to, w);
  if (angleDiff(heading, last.heading) <= w.tolerance && angleDiff(pitch, last.pitch) <= Math.max(w.pitchTolerance, w.tolerance) && world.tickCount >= slot.readyTick) {
    slot.burst = { fired: 0, nextTick: world.tickCount, heading, pitch, target: to };
    tryFire(world, u, slot, index);
  }
}

function tryFire(world: World, u: SimUnit, slot: WeaponSlot, index: WeaponIndex): void {
  const b = slot.burst!;
  const w = slot.def;
  if (world.tickCount < b.nextTick) return;
  if (b.fired === 0 && (w.energyPerShot || w.metalPerShot)) {
    if (!world.players[u.owner]?.trySpend(w.energyPerShot, w.metalPerShot)) {
      slot.burst = undefined;
      return;
    }
  }
  slot.firePiece ??= world.queryPiece(u, `Query${SCRIPT_SUFFIX[index]}`) ?? '';
  const [fx, fy, fz] = world.piecePositionWorld(u, slot.firePiece || undefined);
  // Track a moving target between shots of a burst.
  const target = slot.target !== undefined ? world.units.get(slot.target) : undefined;
  const to = target ? aimPoint(target) : b.target;

  let dir: [number, number, number];
  if (w.kind === 'ballistic') {
    const [heading, pitch] = headingAndPitch(u, [fx, fy, fz], to, w);
    const yaw = angleToRadians(wrapAngle(heading + u.rotation));
    const p = angleToRadians(pitch);
    dir = [Math.sin(yaw) * Math.cos(p), Math.sin(p), Math.cos(yaw) * Math.cos(p)];
  } else {
    dir = normalize([to[0] - fx, to[1] - fy, to[2] - fz]);
  }
  if (w.sprayAngle) {
    const a = angleToRadians(world.rng.int(-w.sprayAngle, w.sprayAngle));
    const [rx, ry, rz] = rotateYXZ(dir, 0, a, 0);
    dir = [rx, ry, rz];
  }
  const distance = Math.hypot(to[0] - fx, to[1] - fy, to[2] - fz);
  world.spawnProjectile(u.owner, w, [fx, fy, fz], dir, distance, target?.id, u.id);
  world.events.push({ tick: world.tickCount, kind: 'fire', unitId: u.id, weapon: w.name, x: fx, y: fy, z: fz, first: b.fired === 0 });

  if (b.fired === 0) {
    u.scripts?.start(`Fire${SCRIPT_SUFFIX[index]}`);
    slot.readyTick = world.tickCount + Math.max(1, Math.round(w.reloadSeconds * TICKS_PER_SECOND));
  }
  b.fired++;
  b.nextTick = world.tickCount + Math.round(w.burstIntervalSeconds * TICKS_PER_SECOND);
  if (b.fired >= w.burst) slot.burst = undefined;
}

/** The nearest visible enemy in range (ties broken by id, so the choice is deterministic). */
/**
 * What a weapon may aim at: anti-air weapons only aircraft in flight; cannons and bombs only things on
 * the ground (their shells can't catch a plane); lasers, guns and missiles both.
 */
function canHit(world: World, w: WeaponDef, t: SimUnit): boolean {
  if (w.waterWeapon) return world.inWater(t);
  if (world.submerged(t)) return false;
  const air = world.airborne(t);
  if (w.toAirWeapon) return air;
  return !air || (w.kind !== 'ballistic' && w.kind !== 'dropped');
}

/**
 * Bombs: released when one dropped now would land on the target, falling with the plane's speed.
 */
function dropBomb(world: World, u: SimUnit, slot: WeaponSlot, target: SimUnit): void {
  if (world.tickCount < slot.readyTick) return;
  const w = slot.def;
  const height = Math.max(0, u.y - target.y);
  const fall = Math.sqrt((2 * height) / GRAVITY);
  const [fx, fz] = toDirection(u.rotation);
  const landX = u.x + fx * u.speed * fall;
  const landZ = u.z + fz * u.speed * fall;
  if (Math.hypot(landX - target.x, landZ - target.z) > Math.max(24, w.damageRadius)) return;
  world.spawnProjectile(u.owner, w, [u.x, u.y - 4, u.z], [fx, 0, fz], 0, target.id, u.id);
  const bomb = world.projectiles[world.projectiles.length - 1]!;
  bomb.vx = fx * u.speed;
  bomb.vy = 0;
  bomb.vz = fz * u.speed;
  bomb.dieTick = undefined;
  world.events.push({ tick: world.tickCount, kind: 'fire', unitId: u.id, weapon: w.name, x: u.x, y: u.y, z: u.z, first: true });
  slot.readyTick = world.tickCount + Math.max(1, Math.round(w.reloadSeconds * TICKS_PER_SECOND));
}

function acquire(world: World, u: SimUnit, w: WeaponDef): SimUnit | undefined {
  const range = w.range;
  let best: SimUnit | undefined;
  let bestD = Infinity;
  for (const o of world.unitsInOrder()) {
    if (o.owner === u.owner || o.dying || !world.canSee(u.owner, o) || !canHit(world, w, o)) continue;
    const d = Math.hypot(o.x - u.x, o.z - u.z);
    if (d <= range && d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

function inRange(u: SimUnit, t: SimUnit, range: number): boolean {
  return Math.hypot(t.x - u.x, t.z - u.z) <= range;
}

/** Where to aim at a unit: the middle of its height. */
export function aimPoint(t: SimUnit): [number, number, number] {
  return [t.x, t.y + t.height / 2, t.z];
}

/**
 * Heading (relative to the unit) and pitch to hit `to` from `from`, in angle units. Straight weapons aim
 * straight at it; ballistic ones use the low firing angle for their speed and gravity (RWE
 * computeBallisticHeadingAndPitch), or 45 degrees when out of reach.
 */
export function headingAndPitch(u: SimUnit, from: [number, number, number], to: [number, number, number], w: WeaponDef): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const flat = Math.hypot(dx, dz);
  const heading = wrapAngle((flat > 0 ? toRotation(dx, dz) : u.rotation) - u.rotation);
  if (w.kind !== 'ballistic') return [heading, radiansToAngle(Math.atan2(dy, flat))];
  const v = w.velocity;
  const g = GRAVITY;
  const under = v ** 4 - g * (g * flat * flat + 2 * v * v * dy);
  if (under < 0 || flat === 0) return [heading, ANGLE_FULL_TURN / 8];
  return [heading, radiansToAngle(Math.atan((v * v - Math.sqrt(under)) / (g * flat)))];
}

/** Advances every projectile one tick. */
/** Aircraft in flight this tick, for projectile hits (refreshed by updateProjectiles). */
let airborneUnits: SimUnit[] = [];

export function updateProjectiles(world: World): void {
  airborneUnits = world.projectiles.length ? world.unitsInOrder().filter((u) => world.airborne(u)) : [];
  for (const p of world.projectiles) {
    if (p.dead) continue;
    if (p.dieTick !== undefined && world.tickCount >= p.dieTick) {
      p.dead = true;
      continue;
    }
    if (p.weapon.kind === 'ballistic' || p.weapon.kind === 'dropped') p.vy -= GRAVITY;
    else if (p.weapon.kind === 'tracking' && p.targetUnit !== undefined) {
      const t = world.units.get(p.targetUnit);
      if (!t || t.dying) p.targetUnit = undefined;
      else turnTowards(p, aimPoint(t), angleToRadians(p.weapon.turnRate));
    }
    p.prevX = p.x;
    p.prevY = p.y;
    p.prevZ = p.z;
    p.x += p.vx;
    p.y += p.vy;
    p.z += p.vz;
    collide(world, p);
  }
  world.projectiles = world.projectiles.filter((p) => !p.dead);
}

function collide(world: World, p: Projectile): void {
  const { terrain } = world;
  if (p.x < 0 || p.z < 0 || p.x >= world.map.widthUnits || p.z >= world.map.heightUnits) {
    p.dead = true;
    return;
  }
  const ground = terrain.heightAt(p.x, p.z);
  if (ground < terrain.seaLevel && p.y <= terrain.seaLevel && !p.weapon.waterWeapon) return impact(world, p, true);
  // Straight shots skim small bumps instead of stopping in the dirt just in front of the target.
  const skim = p.weapon.kind === 'ballistic' ? 0 : GROUND_SKIM;
  if (p.y <= ground - skim) {
    if (p.weapon.groundBounce) {
      p.vy = 0;
      p.y = p.prevY;
      return;
    }
    return impact(world, p, false);
  }
  // Shots that can hit aircraft hit those they pass close to (aircraft aren't on the ground grid).
  if (p.weapon.kind !== 'ballistic' && p.weapon.kind !== 'dropped') {
    for (const u of airborneUnits) {
      if (u.owner === p.owner || u.dying) continue;
      const reach = Math.max(u.def.footprintX, u.def.footprintZ) * 8 + 4;
      if (Math.abs(u.x - p.x) < reach && Math.abs(u.z - p.z) < reach && Math.abs(u.y + u.height / 2 - p.y) < reach) return impact(world, p, false);
    }
  }
  const cx = Math.floor(p.x / 16);
  const cz = Math.floor(p.z / 16);
  const i = cz * terrain.width + cx;
  const hitUnit = (id: number) => {
    const u = id ? world.units.get(id) : undefined;
    return !!u && u.owner !== p.owner && p.y >= u.y && p.y <= u.y + u.height;
  };
  if (hitUnit(world.occupancy.mobile[i]!) || (!world.occupancy.passable[i] && hitUnit(world.occupancy.buildings[i]!))) return impact(world, p, false);
  const fid = world.occupancy.features[i]!;
  if (fid) {
    const f = world.features[fid - 1];
    if (f && f.alive && p.y <= f.y + Math.max(8, f.def.height)) return impact(world, p, false);
  }
}

function impact(world: World, p: Projectile, water: boolean): void {
  p.dead = true;
  noteBlocked(world, p);
  explode(world, p.weapon, p.owner, p.x, p.y, p.z, water);
}

/** An explosion of `w` at a point: area damage plus an event for the renderer. */
export function explode(world: World, w: WeaponDef, owner: number, x: number, y: number, z: number, water = false): void {
  world.events.push({
    tick: world.tickCount,
    kind: 'explosion',
    x,
    y,
    z,
    gaf: water && w.waterExplosionGaf ? w.waterExplosionGaf : w.explosionGaf,
    art: water && w.waterExplosionArt ? w.waterExplosionArt : w.explosionArt,
    radius: w.damageRadius,
    sound: water && w.soundWater ? w.soundWater : w.soundHit,
  });
  const r = Math.max(1, w.damageRadius);
  for (const u of world.unitsInOrder()) {
    if (u.dying) continue;
    // Distance from the point to the unit's box (footprint by height), as in RWE.
    const hx = (u.def.footprintX * 16) / 2;
    const hz = (u.def.footprintZ * 16) / 2;
    const dx = Math.max(0, Math.abs(x - u.x) - hx);
    const dz = Math.max(0, Math.abs(z - u.z) - hz);
    const dy = y < u.y ? u.y - y : y > u.y + u.height ? y - (u.y + u.height) : 0;
    const d = Math.hypot(dx, dy, dz);
    if (d > r) continue;
    let dmg = damageAgainst(w, u.def.unitName) * Math.min(1, Math.max(0, 1 - d / r));
    if (u.scripts?.state.armored) dmg *= u.def.damageModifier;
    // Cheats: +doubleshot / +halfshot change the attacking player's damage.
    if (world.cheat(owner, 'doubleshot')) dmg *= 2;
    if (world.cheat(owner, 'halfshot')) dmg /= 2;
    world.damage(u, dmg, owner);
  }
}

function turnTowards(p: Projectile, to: [number, number, number], maxRadians: number): void {
  const speed = Math.hypot(p.vx, p.vy, p.vz);
  if (speed === 0) return;
  const cur = [p.vx / speed, p.vy / speed, p.vz / speed] as const;
  const want = normalize([to[0] - p.x, to[1] - p.y, to[2] - p.z]);
  const dot = Math.max(-1, Math.min(1, cur[0] * want[0] + cur[1] * want[1] + cur[2] * want[2]));
  const angle = Math.acos(dot);
  if (angle <= maxRadians || angle === 0) {
    [p.vx, p.vy, p.vz] = [want[0] * speed, want[1] * speed, want[2] * speed];
    return;
  }
  const t = maxRadians / angle;
  const mixed = normalize([cur[0] + (want[0] - cur[0]) * t, cur[1] + (want[1] - cur[1]) * t, cur[2] + (want[2] - cur[2]) * t]);
  [p.vx, p.vy, p.vz] = [mixed[0] * speed, mixed[1] * speed, mixed[2] * speed];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function radiansToAngle(r: number): number {
  return wrapAngle(Math.round((r * ANGLE_FULL_TURN) / (2 * Math.PI)));
}

/** Smallest difference between two angles, in angle units. */
function angleDiff(a: number, b: number): number {
  const d = wrapAngle(a - b);
  return Math.min(d, ANGLE_FULL_TURN - d);
}

/** Angle units to the signed COB value scripts expect. */
function toCob(a: number): number {
  return a >= ANGLE_FULL_TURN / 2 ? a - ANGLE_FULL_TURN : a;
}

/**
 * Tells the shooter whether its shot reached what it was aiming at, or was stopped well short of it
 * by a rock, tree or hill (so an attacking unit knows to move for a clearer shot).
 */
function noteBlocked(world: World, p: Projectile): void {
  const shooter = p.shooter !== undefined ? world.units.get(p.shooter) : undefined;
  const target = p.targetUnit !== undefined ? world.units.get(p.targetUnit) : undefined;
  if (!shooter || !target) return;
  const toTarget = Math.hypot(target.x - p.originX, target.z - p.originZ);
  const travelled = Math.hypot(p.x - p.originX, p.z - p.originZ);
  const miss = Math.hypot(target.x - p.x, target.z - p.z);
  if (travelled < toTarget * 0.8 && miss > Math.max(48, p.weapon.damageRadius * 1.5)) shooter.blockedShots++;
  else shooter.blockedShots = 0;
}
