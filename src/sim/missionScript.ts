import type { World } from './world';

/*
 * The orders a campaign mission gives its units at the start ("InitialMission" in the mission file):
 * a comma-separated list run in order, e.g. "w 700,b CORAK,w 300,b CORAK 2" or "p 253 601".
 *   w N          wait N ticks (TA's 30 a second)
 *   b NAME [n]   a factory builds n of NAME (1 if not given)
 *   m X Z        move there
 *   p X Z        patrol between where the unit started and there, fighting what it meets, for ever
 *   a NAME       attack the nearest enemy NAME
 * Other letters in the files (s, o, i, d, ...) aren't understood yet and are skipped. Runs inside the
 * simulation tick and only issues ordinary commands, so missions stay deterministic.
 */

interface Script {
  steps: string[][];
  next: number;
  waitUntil: number;
  patrol?: { x: number; z: number; hx: number; hz: number };
}

export class MissionScripts {
  private readonly scripts = new Map<number, Script>();

  add(unitId: number, orders: string): void {
    const steps = orders
      .split(',')
      .map((s) => s.trim().split(/\s+/).filter(Boolean))
      .filter((s) => s.length > 0);
    if (steps.length) this.scripts.set(unitId, { steps, next: 0, waitUntil: 0 });
  }

  update(world: World): void {
    for (const [id, s] of this.scripts) {
      const u = world.units.get(id);
      if (!u || u.dying) {
        this.scripts.delete(id);
        continue;
      }
      if (!world.isFinished(u) || world.tickCount < s.waitUntil) continue;
      if (s.patrol) {
        // Back and forth for as long as the unit lives.
        if (u.tasks.length === 0) {
          const p = s.patrol;
          world.issue({ kind: 'move', unitIds: [id], x: p.x, z: p.z, fight: true }, false);
          world.issue({ kind: 'move', unitIds: [id], x: p.hx, z: p.hz, fight: true, queue: true }, false);
        }
        continue;
      }
      while (s.next < s.steps.length && world.tickCount >= s.waitUntil && !s.patrol) {
        const [op, ...args] = s.steps[s.next++]!;
        const n = (i: number) => Number.parseFloat(args[i] ?? '');
        switch (op!.toLowerCase()) {
          case 'w':
            s.waitUntil = world.tickCount + Math.max(0, n(0) || 0);
            break;
          case 'b':
            if (u.factory && args[0]) world.issue({ kind: 'factory', unitId: id, unitName: args[0].toUpperCase(), count: Math.max(1, n(1) || 1) }, false);
            break;
          case 'm':
            if (Number.isFinite(n(0)) && Number.isFinite(n(1))) world.issue({ kind: 'move', unitIds: [id], x: n(0), z: n(1) }, false);
            break;
          case 'p':
            if (Number.isFinite(n(0)) && Number.isFinite(n(1))) s.patrol = { x: n(0), z: n(1), hx: u.x, hz: u.z };
            break;
          case 'a': {
            const type = (args[0] ?? '').toUpperCase();
            let best: { id: number; d: number } | undefined;
            for (const o of world.unitsInOrder()) {
              if (o.owner === u.owner || o.dying || o.def.unitName.toUpperCase() !== type) continue;
              const d = Math.hypot(o.x - u.x, o.z - u.z);
              if (!best || d < best.d) best = { id: o.id, d };
            }
            if (best) world.issue({ kind: 'attack', unitIds: [id], targetId: best.id }, false);
            break;
          }
          default:
            break; // not understood yet
        }
      }
      if (s.next >= s.steps.length && !s.patrol && world.tickCount >= s.waitUntil) this.scripts.delete(id);
    }
  }
}
