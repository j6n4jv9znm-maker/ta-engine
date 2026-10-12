import type { GameMap } from '../map/mapData';
import type { Mission } from '../map/mission';
import type { FeatureDef } from '../map/features';
import type { AiPlan, Difficulty } from './ai/aiProfile';
import { SkirmishAi } from './ai/skirmishAi';
import type { BuildMenus } from './buildMenus';
import type { WeaponDef } from './weaponDef';
import { World, type Command, type UnitAssets } from './world';

/*
 * Setting up a skirmish: who plays which side, where they start, and the computer opponent. Shared by
 * the game page, saved-game loading and tests, so a saved game always starts exactly as it did.
 */

export type Side = 'arm' | 'core';

export interface SkirmishSettings {
  map: string;
  side: Side;
  opponent: Difficulty | 'none';
  startWith: 'commander' | 'army';
  /** For a campaign mission: its map name (then `map` is the same and `startWith` is ignored). */
  mission?: string;
}

export interface SkirmishDeps {
  assets: (name: string) => UnitAssets | undefined;
  weapons: Map<string, WeaponDef>;
  featureDefs: Map<string, FeatureDef>;
  menus: BuildMenus;
  aiPlans: Map<Difficulty, AiPlan>;
}

/** The human player is always player 0; the computer is player 1. */
export const HUMAN = 0;

const ARMIES: Record<Side, [string, number][]> = {
  arm: [
    ['ARMPW', 6],
    ['ARMSTUMP', 4],
    ['ARMFLASH', 4],
    ['ARMJETH', 3],
    ['ARMHAM', 3],
    ['ARMROCK', 3],
  ],
  core: [
    ['CORAK', 6],
    ['CORRAID', 4],
    ['CORGATOR', 4],
    ['CORCRASH', 3],
    ['CORTHUD', 3],
    ['CORSTORM', 3],
  ],
};

export interface Skirmish {
  world: World;
  /** Where the human player starts. */
  home: { x: number; z: number };
}

export function createSkirmish(map: GameMap, s: SkirmishSettings, seed: number, deps: SkirmishDeps, mission?: Mission): Skirmish {
  const world = new World(map, { seed, assets: deps.assets, weapons: deps.weapons, featureDefs: deps.featureDefs });
  if (mission) return startMission(world, map, s, deps, mission);
  const starts = map.ota?.schemas[0]?.startPositions.filter((p): p is { x: number; z: number } => !!p) ?? [];
  const home = starts[0] ?? { x: map.widthUnits / 2, z: map.heightUnits / 2 };
  // A map with a single start position still gets an opponent: at the far side of the map from you.
  const theirs = starts[1] ?? farSpot(map, home);
  const other: Side = s.side === 'arm' ? 'core' : 'arm';
  const face = (z: number) => (z < map.heightUnits / 2 ? 0 : 32768);
  const ahead = (z: number) => z + (z < map.heightUnits / 2 ? 120 : -120);
  const commander = (side: Side) => deps.assets(side === 'arm' ? 'armcom' : 'corcom')!;

  world.spawn(commander(s.side), HUMAN, home.x, home.z, face(home.z));
  if (s.startWith === 'army') spawnGroup(world, deps, ARMIES[s.side], HUMAN, home.x, ahead(home.z));
  if (theirs) {
    world.spawn(commander(other), 1, theirs.x, theirs.z, face(theirs.z));
    if (s.startWith === 'army') spawnGroup(world, deps, ARMIES[other], 1, theirs.x, ahead(theirs.z));
  }
  if (s.opponent !== 'none') world.ais.push(new SkirmishAi(1, s.opponent, deps.menus, deps.aiPlans.get(s.opponent), 977));
  return { world, home };
}

/** A campaign mission: the units the mission places, and the computer playing the other side. */
function startMission(world: World, map: GameMap, s: SkirmishSettings, deps: SkirmishDeps, mission: Mission): Skirmish {
  for (const m of mission.units) {
    const a = deps.assets(m.unitName.toLowerCase());
    if (!a) continue;
    const u = world.spawn(a, m.owner, m.x, m.z, Math.round(m.angle) & 0xffff);
    if (u && m.health < 100) u.hp = Math.max(1, (u.def.maxDamage * m.health) / 100);
  }
  if (s.opponent !== 'none') world.ais.push(new SkirmishAi(1, s.opponent, deps.menus, deps.aiPlans.get(s.opponent), 977));
  const mine = mission.units.filter((u) => u.owner === HUMAN);
  const home = mine.length ? { x: mine.reduce((a, u) => a + u.x, 0) / mine.length, z: mine.reduce((a, u) => a + u.z, 0) / mine.length } : { x: map.widthUnits / 2, z: map.heightUnits / 2 };
  return { world, home };
}

function spawnGroup(world: World, deps: SkirmishDeps, list: [string, number][], owner: number, x: number, z: number): void {
  let i = 0;
  for (const [name, count] of list) {
    const a = deps.assets(name.toLowerCase());
    if (!a) continue;
    for (let k = 0; k < count; k++, i++) world.spawn(a, owner, x + ((i % 6) - 2.5) * 48, z + Math.floor(i / 6) * 48);
  }
}

// --- Saved games ------------------------------------------------------------------------
// The simulation is deterministic, so a saved game is just how it started plus every command the
// player gave, with the tick it was given on. Loading replays them.

export interface SavedGame {
  version: 1;
  settings: SkirmishSettings;
  seed: number;
  /** Game time reached, in ticks. */
  tick: number;
  commands: { tick: number; cmd: Command }[];
  savedAt: string;
}

export function saveGame(world: World, settings: SkirmishSettings, seed: number): SavedGame {
  return { version: 1, settings: { ...settings }, seed, tick: world.tickCount, commands: world.commandLog.map((c) => ({ ...c })), savedAt: new Date().toISOString() };
}

/**
 * Runs `world` (fresh from createSkirmish with the save's settings and seed) forward to the save's
 * tick, giving each recorded command at its tick. Works in slices so a page can show progress.
 */
export async function replayGame(world: World, save: SavedGame, onProgress?: (fraction: number) => void, sliceTicks = 900): Promise<void> {
  let next = 0;
  const cmds = save.commands;
  while (world.tickCount < save.tick) {
    const stop = Math.min(save.tick, world.tickCount + sliceTicks);
    while (world.tickCount < stop) {
      while (next < cmds.length && cmds[next]!.tick <= world.tickCount) world.issue(cmds[next++]!.cmd);
      world.tick();
    }
    onProgress?.(world.tickCount / Math.max(1, save.tick));
    await new Promise((r) => setTimeout(r, 0));
  }
  // Commands given after the last tick (none are normally) still apply.
  while (next < cmds.length) world.issue(cmds[next++]!.cmd);
}

/** The point roughly opposite `home` across the map, kept a little in from the edges. */
function farSpot(map: GameMap, home: { x: number; z: number }): { x: number; z: number } {
  const clamp = (v: number, max: number) => Math.min(max - 160, Math.max(160, v));
  return { x: clamp(map.widthUnits - home.x, map.widthUnits), z: clamp(map.heightUnits - home.z, map.heightUnits) };
}
