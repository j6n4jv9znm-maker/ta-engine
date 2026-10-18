import { latin1 } from '../formats/hpi';
import { getBlock, getValue, parseTdf, type TdfBlock } from '../formats/tdf';
import type { Vfs } from '../vfs';

/*
 * The original campaign missions. A campaign file (camps/<name>.tdf) lists missions in order, each a
 * map whose .ota adds placed units (per difficulty schema) and goals in its [GlobalHeader]:
 *   MoveUnitToRadius=ANYTYPE, x, z, r;   get a unit of yours there
 *   AllUnitsKilled=1;                    destroy every enemy unit
 *   AllUnitsKilledOfType=ARMGATE;        destroy every enemy unit of that type
 * TA counts the human as Player=1 in mission files; other numbers are the computer.
 * Briefings are camps/briefs/<brief>.txt.
 */

export interface CampaignMission {
  /** Map name (the .ota/.tnt without extension). */
  map: string;
  name: string;
}

export interface Campaign {
  name: string;
  side: 'arm' | 'core';
  missions: CampaignMission[];
}

export interface MissionUnit {
  unitName: string;
  x: number;
  z: number;
  /** 0 for the human player, 1 for the computer. */
  owner: number;
  health: number;
  /** TA angle units. */
  angle: number;
  /** Its starting orders ("InitialMission"), run by sim/missionScript.ts. */
  orders: string;
}

/**
 * A mission's goals, read as TA's mission files use them (our reading: the win and lose keys appear
 * together, e.g. mission 1 "guard the Galactic Gate" wins on MoveUnitToRadius and loses on
 * AllUnitsKilledOfType=ARMGATE).
 *   Win:  MoveUnitToRadius, DestroyAllUnits, KillUnitType=TYPE, n, CaptureUnitType (we have no capture,
 *         so destroying it counts), BuildUnitType, VictoryTimerRunsOut (seconds).
 *   Lose: AllUnitsKilled (all yours gone), AllUnitsKilledOfType (all of yours of that type gone).
 */
export interface MissionGoals {
  moveTo?: { x: number; z: number; radius: number };
  /** Win by destroying every enemy unit. */
  destroyAll: boolean;
  /** Win by destroying this many enemy units of a type. */
  killType?: { type: string; count: number };
  /** Win by destroying (in TA: capturing) every enemy unit of this type. */
  captureType?: string;
  /** Win by building one of these. */
  buildType?: string;
  /** Win by holding out this many seconds. */
  timer?: number;
  /** Lose when you have none of this type left (it's something you must protect). */
  protectType?: string;
}

export interface Mission {
  map: string;
  name: string;
  briefing: string;
  units: MissionUnit[];
  goals: MissionGoals;
}

/** The campaigns in camps/*.tdf (Arm and Core, plus any add-on campaigns), in a stable order. */
export async function loadCampaigns(vfs: Vfs): Promise<Campaign[]> {
  const out: Campaign[] = [];
  for (const f of vfs.listDir('camps', '.tdf')) {
    const root = parseTdf(latin1(await vfs.read(f.path)));
    const side = (getValue(getBlock(root, 'HEADER') ?? {}, 'campaignside') ?? '').toLowerCase();
    if (side !== 'arm' && side !== 'core') continue;
    const missions: CampaignMission[] = [];
    for (let i = 0; ; i++) {
      const m = getBlock(root, `MISSION${i}`);
      if (!m) break;
      const file = getValue(m, 'missionfile') ?? '';
      const map = file.replace(/\.ota$/i, '');
      if (map && vfs.exists(`maps/${map}.ota`) && vfs.exists(`maps/${map}.tnt`)) missions.push({ map, name: getValue(m, 'missionname') ?? map });
    }
    if (missions.length) out.push({ name: f.path.slice(f.path.indexOf('/') + 1, -4).trim(), side, missions });
  }
  // The original two campaigns first.
  const rank = (c: Campaign) => (/^(arm|core) campaign$/i.test(c.name) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export async function loadMission(vfs: Vfs, map: string): Promise<Mission> {
  const root = parseTdf(latin1(await vfs.read(`maps/${map}.ota`)));
  return parseMission(map, root, async (brief) => {
    const path = `camps/briefs/${brief}.txt`;
    return vfs.exists(path) ? latin1(await vfs.read(path)) : '';
  });
}

export async function parseMission(map: string, root: TdfBlock, readBrief: (name: string) => Promise<string>): Promise<Mission> {
  const h = getBlock(root, 'GlobalHeader') ?? {};
  const num = (v: string | undefined) => Number.parseFloat(v ?? '') || 0;
  const goals: MissionGoals = { destroyAll: num(getValue(h, 'DestroyAllUnits')) !== 0 };
  const move = getValue(h, 'MoveUnitToRadius')?.split(',').map((s) => s.trim());
  if (move && move.length >= 4) goals.moveTo = { x: num(move[1]), z: num(move[2]), radius: Math.max(32, num(move[3])) };
  const kill = getValue(h, 'KillUnitType')?.split(',').map((s) => s.trim());
  if (kill?.[0]) goals.killType = { type: kill[0].toUpperCase(), count: Math.max(1, num(kill[1])) };
  const word = (k: string) => getValue(h, k)?.split(',')[0]?.trim().toUpperCase() || undefined;
  goals.captureType = word('CaptureUnitType');
  goals.buildType = word('BuildUnitType');
  goals.protectType = word('AllUnitsKilledOfType');
  if (num(getValue(h, 'VictoryTimerRunsOut')) > 0) goals.timer = num(getValue(h, 'VictoryTimerRunsOut'));
  // A mission with no goal we understand is won by destroying the enemy.
  if (!goals.moveTo && !goals.killType && !goals.captureType && !goals.buildType && !goals.timer) goals.destroyAll = true;

  // Units from the first (easiest) schema.
  const schema = getBlock(h, 'Schema 0') ?? {};
  const unitsBlock = getBlock(schema, 'units') ?? {};
  const units: MissionUnit[] = [];
  for (const b of Object.values(unitsBlock)) {
    if (typeof b !== 'object') continue;
    const name = getValue(b, 'Unitname');
    if (!name) continue;
    units.push({
      unitName: name.toUpperCase(),
      x: num(getValue(b, 'XPos')),
      z: num(getValue(b, 'ZPos')),
      owner: num(getValue(b, 'Player')) === 1 ? 0 : 1,
      health: num(getValue(b, 'HealthPercentage') ?? '100') || 100,
      angle: num(getValue(b, 'Angle')),
      orders: getValue(b, 'InitialMission') ?? '',
    });
  }
  const brief = getValue(h, 'brief');
  return { map, name: getValue(h, 'missionname') ?? map, briefing: brief ? (await readBrief(brief)).trim() : '', units, goals };
}

/** What happened so far that the goals need to know: enemy kills by type, and the game time. */
export interface MissionProgress {
  seconds: number;
  /** Enemy units destroyed, by unit name. */
  enemyKills: Map<string, number>;
  /** Unit names the player had at the start (so building one doesn't count as "built"). */
  startTypes: Set<string>;
}

/** "won", "lost" or undefined (still going). */
export function missionResult(
  goals: MissionGoals,
  units: Iterable<{ owner: number; dying: unknown; x: number; z: number; def: { unitName: string; bmCode?: number } }>,
  progress: MissionProgress = { seconds: 0, enemyKills: new Map(), startTypes: new Set() },
): 'won' | 'lost' | undefined {
  let mine = 0;
  let enemies = 0;
  let protectedLeft = 0;
  let captureLeft = 0;
  let built = false;
  let reached = false;
  for (const u of units) {
    if (u.dying) continue;
    const name = u.def.unitName.toUpperCase();
    if (u.owner === 0) {
      mine++;
      if (goals.protectType && name === goals.protectType) protectedLeft++;
      if (goals.buildType && name === goals.buildType && !progress.startTypes.has(name)) built = true;
      // Only a unit that can move counts as reaching the spot (mission 1's gate already stands on it).
      if (goals.moveTo && u.def.bmCode !== 0 && Math.hypot(u.x - goals.moveTo.x, u.z - goals.moveTo.z) <= goals.moveTo.radius) reached = true;
    } else {
      enemies++;
      if (goals.captureType && name === goals.captureType) captureLeft++;
    }
  }
  if (mine === 0) return 'lost';
  if (goals.protectType && protectedLeft === 0 && progress.startTypes.has(goals.protectType)) return 'lost';
  if (reached || built) return 'won';
  if (goals.destroyAll && enemies === 0) return 'won';
  if (goals.killType && (progress.enemyKills.get(goals.killType.type) ?? 0) >= goals.killType.count) return 'won';
  if (goals.captureType && captureLeft === 0 && (progress.enemyKills.get(goals.captureType) ?? 0) > 0) return 'won';
  if (goals.timer && progress.seconds >= goals.timer) return 'won';
  return undefined;
}
