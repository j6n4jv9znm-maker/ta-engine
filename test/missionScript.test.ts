import { describe, expect, it } from 'vitest';
import type { Mission, MissionUnit } from '../src/map/mission';
import { boardsTransport, dropsPassengers, parseOrders } from '../src/sim/missionScript';
import { createSkirmish, type SkirmishDeps } from '../src/sim/skirmish';
import type { UnitAssets, World } from '../src/sim/world';
import { flatGameMap, testUnit } from './helpers';

const ALL = new Map<string, UnitAssets>([
  ['tank', testUnit({ unitName: 'TANK', sightDistance: 200 })],
  ['stump', testUnit({ unitName: 'STUMP', sightDistance: 150 })],
  ['plane', testUnit({ unitName: 'PLANE', canFly: true, maxVelocity: 8 })],
]);
const deps = { assets: (n: string) => ALL.get(n.toLowerCase()), weapons: new Map(), featureDefs: new Map(), menus: undefined, aiPlans: new Map() } as unknown as SkirmishDeps;

function mission(units: Partial<MissionUnit>[]): Mission {
  return {
    map: 'flat',
    name: 'test',
    briefing: '',
    goals: { destroyAll: true },
    units: units.map((u) => ({ unitName: 'TANK', x: 100, z: 100, owner: 1, health: 100, angle: 0, orders: '', ident: '', ...u })),
  };
}
function start(m: Mission): World {
  return createSkirmish(flatGameMap(), { map: 'flat', side: 'arm', opponent: 'none', startWith: 'commander', mission: 'flat' }, 1, deps, m).world;
}
const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i++) w.tick();
};
const of = (w: World, name: string) => [...w.units.values()].filter((u) => u.def.unitName === name);

describe('mission orders', () => {
  it('reads the files\' orders, typos and all', () => {
    expect(parseOrders('w11, m 2690, 2854, wa bob,p 1 2 3 4')).toEqual([['w', '11'], ['m', '2690', '2854'], ['wa', 'bob'], ['p', '1', '2', '3', '4']]);
    expect(boardsTransport('s, i BEN')).toBe('ben');
    expect(dropsPassengers('m 1 2, u 1 2, d')).toBe(true);
  });

  it('an ambush waits until the named lookout is spotted, then moves in', () => {
    const w = start(
      mission([
        { unitName: 'STUMP', ident: 'bob', x: 600, z: 600 },
        { x: 900, z: 900, orders: 'wa bob, m 700 700' },
        { owner: 0, x: 100, z: 100 },
      ]),
    );
    const ambusher = [...w.units.values()].find((u) => u.owner === 1 && u.def.unitName === 'TANK')!;
    const mine = [...w.units.values()].find((u) => u.owner === 0)!;
    const x0 = ambusher.x;
    run(w, 60);
    expect(ambusher.x).toBe(x0);
    // Walk into the lookout's sight: the ambush is sprung.
    w.issue({ kind: 'move', unitIds: [mine.id], x: 520, z: 520 });
    run(w, 600);
    expect(Math.hypot(ambusher.x - 700, ambusher.z - 700)).toBeLessThan(150);
  });

  it('moves one leg at a time, and patrols a route', () => {
    const w = start(mission([{ x: 100, z: 100, orders: 'm 400 100, m 400 400' }, { x: 100, z: 800, orders: 'p 300 800 300 600' }, { owner: 0, x: 900, z: 100 }]));
    const [mover, patroller] = of(w, 'TANK').filter((u) => u.owner === 1);
    run(w, 20);
    expect(mover!.order ?? mover!.tasks[0]).toMatchObject({ x: 400, z: 100 });
    run(w, 600);
    expect(Math.hypot(mover!.x - 400, mover!.z - 400)).toBeLessThan(40);
    expect(patroller!.tasks.length + (patroller!.x !== 100 ? 1 : 0)).toBeGreaterThan(0);
  });

  it('reinforcements arrive when their transport drops them off, and it leaves', () => {
    const w = start(
      mission([
        { owner: 0, x: 100, z: 100 },
        { owner: 0, unitName: 'PLANE', ident: 'fred', x: 100, z: 900, orders: 'm 500 500, u 500 500, m 100 100, d' },
        { owner: 0, x: 120, z: 900, orders: 'i fred, m 600 600' },
        { owner: 0, x: 140, z: 900, orders: 'i fred' },
      ]),
    );
    expect(of(w, 'TANK').length).toBe(1);
    expect(w.missionScripts.waitingPassengers).toBe(2);
    run(w, 30 * 30);
    expect(of(w, 'TANK').length).toBe(3);
    expect(w.missionScripts.messages[0]?.text).toBe('Reinforcements have arrived');
    run(w, 30 * 30);
    expect(of(w, 'PLANE').length).toBe(0);
  });
});
