import type { SimUnit, World } from './world';

/*
 * The orders a campaign mission gives its units ("InitialMission" in the mission file): a
 * comma-separated list run in order, e.g. "w 700,b CORAK,w 300,b CORAK 2" or "wa bob, a ARMCOM".
 * Units can carry a name ("Ident") that other units' orders refer to.
 *   w N          wait N ticks (TA's 30 a second)
 *   wa [NAME]    wait until the unit named NAME (or, with no name, this unit) is attacked or
 *                destroyed, or an enemy comes within its sight: how missions spring ambushes,
 *                counter-attacks and raids part-way through
 *   b NAME [n]   a factory builds n of NAME (1 if not given)
 *   m X Z        move there (the next order waits until it gets there)
 *   p X Z ...    patrol a route through these points (and any patrol orders right after), fighting
 *                what it meets, for ever
 *   a NAME       attack the nearest enemy NAME (the next order waits until it's dead)
 *   g NAME       guard the unit named NAME (or the nearest friendly NAME), for as long as it lives
 *   i NAME       ride in the transport named NAME: the unit arrives only when that transport drops it
 *   u [X Z]      (a transport) drop off a unit it carries there (or where it is); the last drop lets
 *                out the rest. Passengers' waits count from the start of the mission
 *   d            leave the battle: aircraft fly off, anything else blows itself up
 * Other letters in the files (s, o) aren't understood yet and are skipped. Runs inside the
 * simulation tick and only issues ordinary commands, so missions stay deterministic.
 */

type Step = string[];

/** A unit that starts the mission aboard a transport and is placed on the map when it's dropped off. */
export interface Passenger {
  unitName: string;
  owner: number;
  health: number;
  angle: number;
  ident: string;
  /** Its orders after boarding. */
  steps: Step[];
}

interface Script {
  steps: Step[];
  next: number;
  waitUntil: number;
  /** Waiting on "wa": whose attack (an ident, or "" for the unit itself) and its hit points then. */
  waitFor?: { ident: string; hp: number };
  /** Waiting for a move or attack to finish (gives up after a minute so a stuck unit carries on). */
  busySince?: number;
  patrol?: { route: { x: number; z: number }[]; leg: number };
  guard?: string;
}

const CHECK_TICKS = 10;
const GIVE_UP_TICKS = 60 * 30;
const GUARD_DISTANCE = 160;

/** Splits an order string into steps, mending the files' typos ("w11", "m2900", a stray "2854"). */
export function parseOrders(orders: string): Step[] {
  const steps: Step[] = [];
  for (const part of orders.split(',')) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const glued = /^([a-z]+)(\d+)$/i.exec(words[0]!);
    if (glued) words.splice(0, 1, glued[1]!, glued[2]!);
    if (/^\d/.test(words[0]!) && steps.length) steps[steps.length - 1]!.push(...words);
    else steps.push([words[0]!.toLowerCase(), ...words.slice(1)]);
  }
  return steps;
}

/** The transport a unit's orders put it in ("i NAME", after any skipped "s"), if any. */
export function boardsTransport(orders: string): string | undefined {
  const steps = parseOrders(orders).filter((s) => s[0] !== 's');
  return steps[0]?.[0] === 'i' && steps[0][1] ? steps[0][1].toLowerCase() : undefined;
}

/** Whether these orders drop passengers off somewhere. */
export function dropsPassengers(orders: string): boolean {
  return parseOrders(orders).some((s) => s[0] === 'u');
}

export class MissionScripts {
  private readonly scripts = new Map<number, Script>();
  /** Named units (lower-case name to unit ids), and their hit points when named. */
  private readonly named = new Map<string, number[]>();
  private readonly startHp = new Map<number, number>();
  /** Names whose unit has been attacked or has seen the enemy (stays set). */
  private readonly fired = new Set<string>();
  /** Passengers waiting aboard each named transport. */
  private readonly passengers = new Map<string, Passenger[]>();
  /** Things to tell the player ("Reinforcements have arrived"), newest last. */
  readonly messages: { tick: number; owner: number; text: string; x: number; z: number }[] = [];

  add(unitId: number, orders: string, ident = '', hp = 0): void {
    if (ident) {
      const k = ident.toLowerCase();
      this.named.set(k, [...(this.named.get(k) ?? []), unitId]);
      this.startHp.set(unitId, hp);
    }
    const steps = parseOrders(orders);
    if (steps.length) this.scripts.set(unitId, { steps, next: 0, waitUntil: 0 });
  }

  /** A unit that starts aboard transport `transport` (its orders still begin with the "i"). */
  addPassenger(transport: string, p: Omit<Passenger, 'steps'> & { orders: string }): void {
    const steps = parseOrders(p.orders);
    const i = steps.findIndex((s) => s[0] === 'i');
    const list = this.passengers.get(transport) ?? [];
    list.push({ unitName: p.unitName, owner: p.owner, health: p.health, angle: p.angle, ident: p.ident, steps: steps.slice(i + 1) });
    this.passengers.set(transport, list);
  }

  /** How many units are still aboard transports (for tests and the HUD). */
  get waitingPassengers(): number {
    let n = 0;
    for (const l of this.passengers.values()) n += l.length;
    return n;
  }

  update(world: World): void {
    const check = world.tickCount % CHECK_TICKS === 0;
    for (const [id, s] of this.scripts) {
      const u = world.units.get(id);
      if (!u || u.dying) {
        this.scripts.delete(id);
        continue;
      }
      if (!world.isFinished(u) || world.tickCount < s.waitUntil) continue;
      if (s.waitFor) {
        if (!check || !this.triggered(world, u, s.waitFor)) continue;
        s.waitFor = undefined;
      }
      if (s.busySince !== undefined) {
        if (u.tasks.length > 0 && world.tickCount - s.busySince < GIVE_UP_TICKS) continue;
        s.busySince = undefined;
      }
      if (s.patrol) {
        if (u.tasks.length === 0) {
          const p = s.patrol;
          const to = p.route[p.leg % p.route.length]!;
          p.leg++;
          world.issue({ kind: 'move', unitIds: [id], x: to.x, z: to.z, fight: true }, false);
        }
        continue;
      }
      if (s.guard !== undefined) {
        if (!check) continue;
        const t = this.find(world, u, s.guard, true);
        if (!t) {
          s.guard = undefined;
        } else {
          if (u.tasks.length === 0 && Math.hypot(t.x - u.x, t.z - u.z) > GUARD_DISTANCE) {
            world.issue({ kind: 'move', unitIds: [id], x: t.x + ((id % 5) - 2) * 24, z: t.z + 48, fight: true }, false);
          }
          continue;
        }
      }
      this.run(world, u, s);
      if (s.next >= s.steps.length && !s.patrol && s.guard === undefined && !s.waitFor && s.busySince === undefined && world.tickCount >= s.waitUntil) this.scripts.delete(id);
    }
  }

  /** Runs steps until one has to wait. */
  private run(world: World, u: SimUnit, s: Script): void {
    const id = u.id;
    while (s.next < s.steps.length) {
      const [op, ...args] = s.steps[s.next++]!;
      const n = (i: number) => Number.parseFloat(args[i] ?? '');
      switch (op) {
        case 'w':
          s.waitUntil = world.tickCount + Math.max(0, n(0) || 0);
          if (s.waitUntil > world.tickCount) return;
          break;
        case 'wa':
          s.waitFor = { ident: (args[0] ?? '').toLowerCase(), hp: u.hp };
          return;
        case 'b':
          if (u.factory && args[0]) world.issue({ kind: 'factory', unitId: id, unitName: args[0].toUpperCase(), count: Math.max(1, n(1) || 1) }, false);
          break;
        case 'm':
          if (Number.isFinite(n(0)) && Number.isFinite(n(1))) {
            world.issue({ kind: 'move', unitIds: [id], x: n(0), z: n(1) }, false);
            s.busySince = world.tickCount;
            return;
          }
          break;
        case 'p': {
          // This patrol order's points, and those of the patrol orders straight after it.
          const route: { x: number; z: number }[] = [];
          const take = (a: string[]) => {
            for (let i = 0; i + 1 < a.length; i += 2) {
              const x = Number.parseFloat(a[i]!);
              const z = Number.parseFloat(a[i + 1]!);
              if (Number.isFinite(x) && Number.isFinite(z)) route.push({ x, z });
            }
          };
          take(args);
          while (s.steps[s.next]?.[0] === 'p') take(s.steps[s.next++]!.slice(1));
          if (!route.length) break;
          // With one point, back and forth between there and where the unit started.
          if (route.length === 1) route.push({ x: u.x, z: u.z });
          s.patrol = { route, leg: 0 };
          return;
        }
        case 'a': {
          const t = this.find(world, u, args[0] ?? '', false);
          if (t) {
            world.issue({ kind: 'attack', unitIds: [id], targetId: t.id }, false);
            s.busySince = world.tickCount;
            return;
          }
          break;
        }
        case 'g':
          if (args[0]) {
            s.guard = args[0];
            return;
          }
          break;
        case 'u': {
          // With no spot given, right where the transport is.
          const at = Number.isFinite(n(0)) && Number.isFinite(n(1));
          const last = !s.steps.slice(s.next).some((x) => x[0] === 'u');
          this.dropOff(world, u, at ? n(0) : u.x, at ? n(1) : u.z, last);
          break;
        }
        case 'd':
          this.scripts.delete(id);
          if (u.def.canFly) {
            this.dropOff(world, u, u.x, u.z, true);
            world.removeUnit(u);
          } else {
            world.kill(u, 100, true);
          }
          return;
        default:
          break; // "s", "o" and "i" (handled when the mission starts) do nothing here
      }
    }
  }

  /** A unit named `name`, or else the nearest unit of that type (an enemy one, or a friendly one to guard). */
  private find(world: World, u: SimUnit, name: string, friendly: boolean): SimUnit | undefined {
    for (const id of this.named.get(name.toLowerCase()) ?? []) {
      const t = world.units.get(id);
      if (t && !t.dying && t.id !== u.id) return t;
    }
    const type = name.toUpperCase();
    let best: { t: SimUnit; d: number } | undefined;
    for (const o of world.unitsInOrder()) {
      if (o.id === u.id || o.dying || (o.owner === u.owner) !== friendly || o.def.unitName.toUpperCase() !== type) continue;
      const d = Math.hypot(o.x - u.x, o.z - u.z);
      if (!best || d < best.d) best = { t: o, d };
    }
    return best?.t;
  }

  /** Whether a "wa" has gone off. */
  private triggered(world: World, u: SimUnit, w: { ident: string; hp: number }): boolean {
    const ids = w.ident ? this.named.get(w.ident) : undefined;
    if (!ids) return u.hp < w.hp || enemyInSight(world, u);
    if (this.fired.has(w.ident)) return true;
    for (const id of ids) {
      const t = world.units.get(id);
      if (!t || t.dying || t.hp < (this.startHp.get(id) ?? t.hp) || enemyInSight(world, t)) {
        this.fired.add(w.ident);
        return true;
      }
    }
    return false;
  }

  /** A transport lets passengers out at x, z: one, or all that are left on its last drop. */
  private dropOff(world: World, transport: SimUnit, x: number, z: number, all: boolean): void {
    const names = [...this.named].filter(([, ids]) => ids.includes(transport.id)).map(([k]) => k);
    for (const name of names) {
      const list = this.passengers.get(name);
      if (!list?.length) continue;
      const out = all ? list.splice(0) : list.splice(0, 1);
      let arrived = 0;
      for (const p of out) {
        const a = world.assetsOf(p.unitName.toLowerCase());
        const v = a && world.spawn(a, p.owner, x, z, Math.round(p.angle) & 0xffff);
        if (!v) continue;
        if (p.health < 100) v.hp = Math.max(1, (v.def.maxDamage * p.health) / 100);
        // Waits at the start of its orders were counted from the start of the mission, aboard.
        let ride = world.tickCount;
        const steps = p.steps.map((s) => [...s]);
        while (steps[0]?.[0] === 'w' && ride > 0) {
          const left = (Number.parseFloat(steps[0][1] ?? '') || 0) - ride;
          ride -= Number.parseFloat(steps[0][1] ?? '') || 0;
          if (left > 0) steps[0][1] = String(left);
          else steps.shift();
        }
        this.add(v.id, steps.map((s) => s.join(' ')).join(','), p.ident, v.hp);
        arrived++;
      }
      if (arrived && transport.owner === 0) this.messages.push({ tick: world.tickCount, owner: transport.owner, text: 'Reinforcements have arrived', x, z });
    }
  }
}

function enemyInSight(world: World, u: SimUnit): boolean {
  const r = u.def.sightDistance;
  for (const o of world.unitsInOrder()) {
    if (o.owner === u.owner || o.dying) continue;
    if (Math.abs(o.x - u.x) <= r && Math.abs(o.z - u.z) <= r && Math.hypot(o.x - u.x, o.z - u.z) <= r) return true;
  }
  return false;
}
