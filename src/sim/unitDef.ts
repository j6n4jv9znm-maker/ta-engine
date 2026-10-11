import { latin1 } from '../formats/hpi';
import { getBlock, getValue, parseTdf, type TdfBlock } from '../formats/tdf';
import type { Vfs } from '../vfs';

/*
 * Unit definitions (units/*.fbi) and movement classes (gamedata/moveinfo.tdf), reduced to what the
 * simulation needs so far. Units are in TA's own per-tick units, as RWE uses them (LoadingScene_util.cpp):
 * maxVelocity, acceleration and brakeRate in world units per tick, turnRate in angle units per tick
 * (65536 per full turn).
 */

export interface MovementClass {
  name: string;
  footprintX: number;
  footprintZ: number;
  minWaterDepth: number;
  maxWaterDepth: number;
  maxSlope: number;
  maxWaterSlope: number;
}

export interface UnitDef {
  unitName: string;
  name: string;
  description: string;
  side: string;
  objectName: string;
  footprintX: number;
  footprintZ: number;
  maxVelocity: number;
  acceleration: number;
  brakeRate: number;
  turnRate: number;
  canMove: boolean;
  canFly: boolean;
  canHover: boolean;
  floater: boolean;
  /** 1 for mobile units, 0 for buildings. */
  bmCode: number;
  maxDamage: number;
  // --- economy and construction (per second unless noted; costs in metal/energy, build time in work units)
  builder: boolean;
  /** Work done per second when building; per tick it is workerTime / 30, as in RWE. */
  workerTime: number;
  buildTime: number;
  buildCostMetal: number;
  buildCostEnergy: number;
  /** How close (world units) a builder must be to work on something. */
  buildDistance: number;
  energyMake: number;
  metalMake: number;
  energyUse: number;
  metalUse: number;
  /** Metal made per second while active and powered (metal makers). */
  makesMetal: number;
  /** Multiplier on the metal under the footprint (metal extractors). */
  extractsMetal: number;
  /** Energy per second at full wind. */
  windGenerator: number;
  tidalGenerator: number;
  energyStorage: number;
  metalStorage: number;
  commander: boolean;
  activateWhenBuilt: boolean;
  onOffable: boolean;
  /** Footprint cells, row by row (TA yardmap letters), or empty when the whole footprint is solid. */
  yardMap: string;
  corpse: string;
  /** The class used for pathfinding; units without one use their own footprint and limits. */
  movementClass: MovementClass;
  /** The unit's own limits, used for collision checks (TA ignores the movement class there, per RWE). */
  ownMovement: MovementClass;
}

export async function loadMovementClasses(vfs: Vfs): Promise<Map<string, MovementClass>> {
  const out = new Map<string, MovementClass>();
  const path = 'gamedata/moveinfo.tdf';
  if (!vfs.exists(path)) return out;
  const root = parseTdf(latin1(await vfs.read(path)));
  for (const block of Object.values(root)) {
    if (typeof block !== 'object') continue;
    const mc = movementFrom(block, getValue(block, 'name') ?? '');
    out.set(mc.name.toLowerCase(), mc);
  }
  return out;
}

/** Movement limits from a TDF block. Defaults follow RWE (io/moveinfotdf/io.cpp). */
function movementFrom(b: TdfBlock, name: string): MovementClass {
  const n = (k: string, d: number) => num(getValue(b, k), d);
  const maxSlope = n('maxslope', 255);
  return {
    name,
    footprintX: n('footprintx', 1),
    footprintZ: n('footprintz', 1),
    minWaterDepth: n('minwaterdepth', 0),
    maxWaterDepth: n('maxwaterdepth', 255),
    maxSlope,
    maxWaterSlope: n('maxwaterslope', maxSlope),
  };
}

export function parseUnitDef(fbi: TdfBlock, movementClasses: Map<string, MovementClass>): UnitDef | undefined {
  const info = getBlock(fbi, 'UNITINFO');
  if (!info) return undefined;
  const s = (k: string) => getValue(info, k) ?? '';
  const n = (k: string, d = 0) => num(getValue(info, k), d);
  const own = movementFrom(info, s('UnitName'));
  const mcName = s('movementclass').toLowerCase();
  return {
    unitName: s('UnitName'),
    name: s('Name'),
    description: s('Description'),
    side: s('Side'),
    objectName: s('Objectname'),
    footprintX: own.footprintX,
    footprintZ: own.footprintZ,
    maxVelocity: n('maxvelocity'),
    acceleration: n('acceleration'),
    brakeRate: n('brakerate'),
    turnRate: n('turnrate'),
    canMove: n('canmove') !== 0,
    canFly: n('canfly') !== 0,
    canHover: n('canhover') !== 0,
    floater: n('floater') !== 0,
    bmCode: n('bmcode'),
    maxDamage: n('maxdamage', 1),
    builder: n('builder') !== 0,
    workerTime: n('workertime'),
    buildTime: Math.max(1, n('buildtime', 1)),
    buildCostMetal: n('buildcostmetal'),
    buildCostEnergy: n('buildcostenergy'),
    buildDistance: n('builddistance', 64),
    energyMake: n('energymake'),
    metalMake: n('metalmake'),
    energyUse: n('energyuse'),
    metalUse: n('metaluse'),
    makesMetal: n('makesmetal'),
    extractsMetal: n('extractsmetal'),
    windGenerator: n('windgenerator'),
    tidalGenerator: n('tidalgenerator'),
    energyStorage: n('energystorage'),
    metalStorage: n('metalstorage'),
    commander: n('commander') !== 0,
    activateWhenBuilt: n('activatewhenbuilt') !== 0,
    onOffable: n('onoffable') !== 0,
    yardMap: s('yardmap').replace(/\s+/g, ''),
    corpse: s('corpse'),
    movementClass: movementClasses.get(mcName) ?? own,
    ownMovement: own,
  };
}

export async function loadUnitDefs(vfs: Vfs): Promise<Map<string, UnitDef>> {
  const classes = await loadMovementClasses(vfs);
  const out = new Map<string, UnitDef>();
  for (const f of vfs.listDir('units', '.fbi')) {
    const def = parseUnitDef(parseTdf(latin1(await vfs.read(f.path))), classes);
    if (def?.unitName) out.set(def.unitName.toLowerCase(), def);
  }
  return out;
}

function num(v: string | undefined, d: number): number {
  const x = Number.parseFloat(v ?? '');
  return Number.isFinite(x) ? x : d;
}
