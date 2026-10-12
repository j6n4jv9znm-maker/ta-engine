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
}

export interface MissionGoals {
  moveTo?: { x: number; z: number; radius: number };
  killAll: boolean;
  killAllOfType?: string;
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
  const goals: MissionGoals = { killAll: num(getValue(h, 'AllUnitsKilled')) !== 0 };
  const move = getValue(h, 'MoveUnitToRadius')?.split(',').map((s) => s.trim());
  if (move && move.length >= 4) goals.moveTo = { x: num(move[1]), z: num(move[2]), radius: Math.max(32, num(move[3])) };
  const ofType = getValue(h, 'AllUnitsKilledOfType');
  if (ofType) goals.killAllOfType = ofType.toUpperCase();

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
    });
  }
  const brief = getValue(h, 'brief');
  return { map, name: getValue(h, 'missionname') ?? map, briefing: brief ? (await readBrief(brief)).trim() : '', units, goals };
}

/** "won", "lost" or undefined (still going), judged from what's left in the game. */
export function missionResult(
  goals: MissionGoals,
  units: Iterable<{ owner: number; dying: unknown; x: number; z: number; def: { unitName: string } }>,
): 'won' | 'lost' | undefined {
  let mine = 0;
  let enemies = 0;
  let enemiesOfType = 0;
  let reached = false;
  for (const u of units) {
    if (u.dying) continue;
    if (u.owner === 0) {
      mine++;
      if (goals.moveTo && Math.hypot(u.x - goals.moveTo.x, u.z - goals.moveTo.z) <= goals.moveTo.radius) reached = true;
    } else {
      enemies++;
      if (goals.killAllOfType && u.def.unitName.toUpperCase() === goals.killAllOfType) enemiesOfType++;
    }
  }
  // Any one goal met wins. (A "kill all of type" goal only counts when no other goal is set, since
  // missions also name types that may never appear.)
  if (mine === 0) return 'lost';
  if (reached) return 'won';
  if (goals.killAll && enemies === 0) return 'won';
  if (goals.killAllOfType && !goals.killAll && !goals.moveTo && enemiesOfType === 0) return 'won';
  if (!goals.killAll && !goals.moveTo && !goals.killAllOfType && enemies === 0) return 'won';
  return undefined;
}
