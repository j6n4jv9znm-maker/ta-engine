import { latin1 } from '../formats/hpi';
import { getBlock, getValue, parseTdf, type TdfBlock } from '../formats/tdf';
import type { Vfs } from '../vfs';

/*
 * Weapons (weapons/*.tdf, one block per weapon), in the units RWE uses (LoadingScene_util.cpp
 * parseWeaponDefinition): range in world units, reload and burst intervals in seconds, velocity in
 * world units per tick (weaponvelocity / 30), angles in COB units (65536 per turn), damage per target
 * unit type with a DEFAULT, and damage radius = areaofeffect / 2. Unit death blasts ("explodeas") are
 * weapons too.
 */

/** `dropped`: a bomb, released from an aircraft and falling with the aircraft's speed. */
export type ProjectileKind = 'lineOfSight' | 'ballistic' | 'tracking' | 'dropped';

export interface WeaponDef {
  name: string;
  /** Display name. */
  title: string;
  kind: ProjectileKind;
  range: number;
  reloadSeconds: number;
  burst: number;
  burstIntervalSeconds: number;
  sprayAngle: number;
  tolerance: number;
  pitchTolerance: number;
  /** World units per tick. */
  velocity: number;
  /** Missile turn rate, angle units per tick. */
  turnRate: number;
  /** Lifetime in ticks, if the weapon sets one, and how much it may randomly vary. */
  timerTicks: number | undefined;
  randomDecayTicks: number;
  damageRadius: number;
  /** Lowercase unit name -> damage; "default" for everything else. */
  damage: Map<string, number>;
  commandFire: boolean;
  energyPerShot: number;
  metalPerShot: number;
  groundBounce: boolean;
  /** For drawing. */
  beam: boolean;
  /** Palette index for lasers. */
  color: number;
  renderType: number;
  model: string;
  explosionGaf: string;
  explosionArt: string;
  waterExplosionGaf: string;
  waterExplosionArt: string;
  smokeTrail: boolean;
  toAirWeapon: boolean;
  /** Sound names (sounds/<name>.wav): on firing, on hitting, on hitting water; soundTrigger plays the start sound once per burst. */
  soundStart: string;
  soundHit: string;
  soundWater: string;
  soundTrigger: boolean;
}

export async function loadWeaponDefs(vfs: Vfs): Promise<Map<string, WeaponDef>> {
  const out = new Map<string, WeaponDef>();
  for (const f of vfs.listDir('weapons', '.tdf')) {
    const root = parseTdf(latin1(await vfs.read(f.path)));
    for (const [name, block] of Object.entries(root)) {
      if (typeof block === 'object') out.set(name, parseWeaponDef(name, block));
    }
  }
  return out;
}

export function parseWeaponDef(name: string, b: TdfBlock): WeaponDef {
  const s = (k: string) => getValue(b, k) ?? '';
  const n = (k: string, d = 0) => {
    const v = Number.parseFloat(s(k));
    return Number.isFinite(v) ? v : d;
  };
  const flag = (k: string) => n(k) !== 0;
  const damage = new Map<string, number>();
  const dmg = getBlock(b, 'damage');
  if (dmg) for (const [k, v] of Object.entries(dmg)) if (typeof v === 'string') damage.set(k.toLowerCase(), Number.parseFloat(v) || 0);
  const kind: ProjectileKind = flag('dropped') ? 'dropped' : flag('tracks') ? 'tracking' : flag('lineofsight') ? 'lineOfSight' : flag('ballistic') ? 'ballistic' : 'lineOfSight';
  const timer = n('weapontimer');
  return {
    name,
    title: s('name') || name,
    kind,
    range: n('range'),
    reloadSeconds: n('reloadtime', 1),
    burst: Math.max(1, n('burst', 1)),
    burstIntervalSeconds: n('burstrate'),
    sprayAngle: n('sprayangle'),
    // Unset tolerances default to 256 angle units (about 1.4°), as in RWE. With 0, a weapon that has
    // finished aiming never fires while it or its target is moving (a walking Commander never shoots).
    tolerance: n('tolerance', 256),
    pitchTolerance: n('pitchtolerance', 256),
    velocity: n('weaponvelocity') / 30,
    turnRate: n('turnrate'),
    timerTicks: timer ? Math.round(timer * 30) : undefined,
    randomDecayTicks: Math.round(n('randomdecay') * 30),
    damageRadius: n('areaofeffect') / 2,
    damage,
    commandFire: flag('commandfire'),
    energyPerShot: n('energypershot'),
    metalPerShot: n('metalpershot'),
    groundBounce: flag('groundbounce'),
    beam: flag('beamweapon'),
    color: n('color'),
    renderType: n('rendertype'),
    model: s('model'),
    explosionGaf: s('explosiongaf'),
    explosionArt: s('explosionart'),
    waterExplosionGaf: s('waterexplosiongaf'),
    waterExplosionArt: s('waterexplosionart'),
    smokeTrail: flag('smoketrail'),
    toAirWeapon: flag('toairweapon'),
    soundStart: s('soundstart').toLowerCase(),
    soundHit: s('soundhit').toLowerCase(),
    soundWater: s('soundwater').toLowerCase(),
    soundTrigger: flag('soundtrigger'),
  };
}

/** Damage a weapon does to a unit type (RWE Projectile::getDamage). */
export function damageAgainst(w: WeaponDef, unitName: string): number {
  return w.damage.get(unitName.toLowerCase()) ?? w.damage.get('default') ?? 0;
}
