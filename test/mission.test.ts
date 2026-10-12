import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDataDir } from '../src/io/nodeVfs';
import { loadCampaigns, loadMission, missionResult } from '../src/map/mission';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

describe('mission goals', () => {
  const u = (owner: number, x = 0, z = 0, unitName = 'X') => ({ owner, dying: undefined, x, z, def: { unitName } });
  it('wins by reaching the spot or wiping out the enemy, loses with nothing left', () => {
    const goals = { moveTo: { x: 100, z: 100, radius: 64 }, killAll: true };
    expect(missionResult(goals, [u(0), u(1)])).toBeUndefined();
    expect(missionResult(goals, [u(0, 90, 110), u(1)])).toBe('won');
    expect(missionResult(goals, [u(0)])).toBe('won');
    expect(missionResult(goals, [u(1)])).toBe('lost');
  });
});

describe.skipIf(!hasGameData())('campaign missions (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
  });
  afterAll(() => close?.());

  it('lists the Arm and Core campaigns in order', async () => {
    const camps = await loadCampaigns(vfs);
    const arm = camps.find((c) => c.name === 'Arm Campaign')!;
    expect(arm.side).toBe('arm');
    expect(arm.missions[0]).toEqual({ map: 'AC01', name: '1: A Hero Returns' });
    expect(arm.missions.length).toBeGreaterThan(20);
    expect(camps.find((c) => c.name === 'Core Campaign')?.side).toBe('core');
  });

  it('reads the first mission: units for both sides, goals and briefing', async () => {
    const m = await loadMission(vfs, 'AC01');
    expect(m.goals.moveTo).toEqual({ x: 992, z: 656, radius: 64 });
    expect(m.goals.killAll).toBe(true);
    expect(m.units.find((x) => x.unitName === 'ARMFAV')?.owner).toBe(0);
    expect(m.units.find((x) => x.unitName === 'CORAK')?.owner).toBe(1);
    expect(m.briefing.length).toBeGreaterThan(50);
  });
});
