/*
 * Animated state of a unit's model pieces, driven by unit scripts. Simulation-side and deterministic:
 * it advances only in fixed ticks and never touches the renderer (which reads it to pose the model).
 *
 * Semantics follow RWE (src/rwe/sim/UnitMesh.cpp, UnitState.cpp):
 *   - moves: offset on one axis towards a target at a speed in world units per second;
 *   - turns: angle on one axis towards a target, the short way round, at a speed in angle units per
 *     second (65536 angle units = one full turn);
 *   - spins: a turn without a target; the speed ramps up by `acceleration` per tick (instantly when 0);
 *     stop-spin ramps down by `deceleration` per tick (instantly when 0). A spin and a turn share the
 *     same per-axis slot, so starting one replaces the other.
 *   - show/hide toggles visibility.
 *
 * Axis conventions are converted from TA's left-handed scripts like RWE does: x moves and z turns are
 * negated (see UnitScripts).
 */

export const ANGLE_FULL_TURN = 65536;
export const TICKS_PER_SECOND = 30;

export type Axis = 0 | 1 | 2;

interface MoveOp {
  target: number;
  speed: number;
}

type TurnOp =
  | { kind: 'turn'; target: number; speed: number }
  | { kind: 'spin'; current: number; target: number; accel: number }
  | { kind: 'stop'; current: number; decel: number };

export class PieceState {
  /** Offset from the piece's rest position, world units. */
  readonly offset: [number, number, number] = [0, 0, 0];
  /** Rotation per axis in angle units, kept in [0, 65536). */
  readonly rotation: [number, number, number] = [0, 0, 0];
  visible = true;
  readonly moves: (MoveOp | undefined)[] = [undefined, undefined, undefined];
  readonly turns: (TurnOp | undefined)[] = [undefined, undefined, undefined];

  constructor(readonly name: string) {}

  update(dt: number): void {
    for (let a = 0; a < 3; a++) {
      const m = this.moves[a];
      if (m) {
        const remaining = m.target - this.offset[a]!;
        const step = m.speed * dt;
        if (Math.abs(remaining) <= step) {
          this.offset[a] = m.target;
          this.moves[a] = undefined;
        } else {
          this.offset[a]! += step * Math.sign(remaining);
        }
      }
      const t = this.turns[a];
      if (!t) continue;
      if (t.kind === 'turn') {
        this.rotation[a] = turnTowards(this.rotation[a]!, t.target, t.speed * dt);
        if (this.rotation[a] === t.target) this.turns[a] = undefined;
      } else if (t.kind === 'spin') {
        const remaining = t.target - t.current;
        if (Math.abs(remaining) <= t.accel) t.current = t.target;
        else t.current += t.accel * Math.sign(remaining);
        this.rotation[a] = wrapAngle(this.rotation[a]! + t.current * dt);
      } else {
        if (Math.abs(t.current) <= t.decel) {
          this.turns[a] = undefined;
          continue;
        }
        t.current -= t.decel * Math.sign(t.current);
        this.rotation[a] = wrapAngle(this.rotation[a]! + t.current * dt);
      }
    }
  }
}

export class PieceAnimator {
  readonly pieces: PieceState[];
  private readonly byName = new Map<string, PieceState>();

  constructor(pieceNames: string[]) {
    this.pieces = pieceNames.map((n) => new PieceState(n));
    for (const p of this.pieces) if (!this.byName.has(p.name.toLowerCase())) this.byName.set(p.name.toLowerCase(), p);
  }

  get(name: string): PieceState | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /** Advances every piece by one simulation tick. */
  tick(): void {
    const dt = 1 / TICKS_PER_SECOND;
    for (const p of this.pieces) p.update(dt);
  }

  move(name: string, axis: Axis, target: number, speed?: number): void {
    const p = this.get(name);
    if (!p) return;
    if (speed === undefined) {
      p.offset[axis] = target;
      p.moves[axis] = undefined;
    } else {
      p.moves[axis] = { target, speed: Math.abs(speed) };
    }
  }

  turn(name: string, axis: Axis, target: number, speed?: number): void {
    const p = this.get(name);
    if (!p) return;
    const t = wrapAngle(target);
    if (speed === undefined) {
      p.rotation[axis] = t;
      p.turns[axis] = undefined;
    } else {
      p.turns[axis] = { kind: 'turn', target: t, speed: Math.abs(speed) };
    }
  }

  spin(name: string, axis: Axis, speed: number, accel: number): void {
    const p = this.get(name);
    if (!p) return;
    p.turns[axis] = { kind: 'spin', current: accel === 0 ? speed : 0, target: speed, accel: Math.abs(accel) };
  }

  stopSpin(name: string, axis: Axis, decel: number): void {
    const p = this.get(name);
    const op = p?.turns[axis];
    if (!p || op?.kind !== 'spin') return;
    p.turns[axis] = decel === 0 ? undefined : { kind: 'stop', current: op.current, decel: Math.abs(decel) };
  }

  setVisible(name: string, visible: boolean): void {
    const p = this.get(name);
    if (p) p.visible = visible;
  }

  isMoving(name: string, axis: Axis): boolean {
    return this.get(name)?.moves[axis] !== undefined;
  }

  isTurning(name: string, axis: Axis): boolean {
    return this.get(name)?.turns[axis] !== undefined;
  }
}

export function wrapAngle(a: number): number {
  const r = a % ANGLE_FULL_TURN;
  return r < 0 ? r + ANGLE_FULL_TURN : r;
}

/** Moves `current` towards `target` by at most `maxStep`, going the short way round. */
export function turnTowards(current: number, target: number, maxStep: number): number {
  let delta = wrapAngle(target - current);
  if (delta > ANGLE_FULL_TURN / 2) delta -= ANGLE_FULL_TURN;
  if (Math.abs(delta) <= maxStep) return target;
  return wrapAngle(current + maxStep * Math.sign(delta));
}

export function angleToRadians(a: number): number {
  return (a * Math.PI) / (ANGLE_FULL_TURN / 2);
}
