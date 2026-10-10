import type { CobScript } from '../../formats/cob';
import { Op } from './opcodes';

/*
 * COB virtual machine: runs one unit's compiled script as a set of cooperative threads.
 * Instruction semantics follow RWE (src/rwe/cob/CobExecutionContext.cpp, CobEnvironment.cpp,
 * src/rwe/sim/cob.cpp). Values are 32-bit signed integers.
 *
 * Each simulation tick (`tick(timeMs)`): sleeping threads whose time has come and blocked threads whose
 * piece has finished moving/turning become ready, then every ready thread runs until it sleeps, blocks
 * or finishes. Threads started during the tick run in the same tick. A thread inherits the signal mask
 * of the thread that started it; `signal` kills every thread whose mask shares a bit with the signal.
 *
 * The VM knows nothing about pieces or the world. It talks to its unit through `CobHost`.
 */

export type CobAxis = 0 | 1 | 2;

export interface CobHost {
  move(piece: number, axis: CobAxis, position: number, speed?: number): void;
  turn(piece: number, axis: CobAxis, angle: number, speed?: number): void;
  spin(piece: number, axis: CobAxis, speed: number, accel: number): void;
  stopSpin(piece: number, axis: CobAxis, decel: number): void;
  show(piece: number): void;
  hide(piece: number): void;
  explode(piece: number, type: number): void;
  emitSfx(piece: number, type: number): void;
  isMoving(piece: number, axis: CobAxis): boolean;
  isTurning(piece: number, axis: CobAxis): boolean;
  /** Unit values the VM can't compute itself (see CobValue). */
  getValue(id: number, a1: number, a2: number, a3: number, a4: number): number;
  setValue(id: number, value: number): void;
  /** Integer in [low, high]; must come from the simulation's seeded RNG. */
  random(low: number, high: number): number;
}

/** Unit value ids for get/set (per RWE's CobValueId). */
export const CobValue = {
  Activation: 1,
  StandingMoveOrders: 2,
  StandingFireOrders: 3,
  Health: 4,
  InBuildStance: 5,
  Busy: 6,
  PieceXZ: 7,
  PieceY: 8,
  UnitXZ: 9,
  UnitY: 10,
  UnitHeight: 11,
  XZAtan: 12,
  XZHypot: 13,
  Atan: 14,
  Hypot: 15,
  GroundHeight: 16,
  BuildPercentLeft: 17,
  YardOpen: 18,
  BuggerOff: 19,
  Armored: 20,
  VeteranLevel: 32,
  UnitIsOnThisComp: 68,
  MinId: 69,
  MaxId: 70,
  MyId: 71,
  UnitTeam: 72,
  UnitBuildPercentLeft: 73,
  UnitAllied: 74,
} as const;

interface Frame {
  pc: number;
  locals: number[];
  localCount: number;
}

type ThreadState =
  | { kind: 'ready' }
  | { kind: 'sleeping'; wakeAt: number }
  | { kind: 'blocked'; turn: boolean; piece: number; axis: CobAxis }
  | { kind: 'finished' };

export interface CobThread {
  readonly id: number;
  readonly name: string;
  signalMask: number;
  stack: number[];
  frames: Frame[];
  state: ThreadState;
  /** Locals of the outermost function when it returned: how query scripts hand back results. */
  returnLocals: number[];
  returnValue: number;
  killed: boolean;
}

export class CobError extends Error {}

/** Instructions one thread may run in one go before we assume it's stuck in a loop and stop it. */
const MAX_STEPS = 200_000;

export class CobVm {
  readonly statics: number[];
  threads: CobThread[] = [];
  /** Problems seen while running (bad opcodes, runaway loops). Each kills only the offending thread. */
  readonly errors: string[] = [];
  private nextId = 1;
  private now = 0;
  private readonly byName = new Map<string, number>();

  constructor(
    readonly script: CobScript,
    private readonly host: CobHost,
  ) {
    this.statics = new Array<number>(script.staticCount).fill(0);
    script.functions.forEach((f, i) => {
      if (!this.byName.has(f.name.toLowerCase())) this.byName.set(f.name.toLowerCase(), i);
    });
  }

  hasFunction(name: string): boolean {
    return this.byName.has(name.toLowerCase());
  }

  /** Starts `name` as a new thread that runs on the next tick. Unknown names are ignored, as in TA. */
  start(name: string, params: number[] = [], signalMask = 0): CobThread | undefined {
    const index = this.byName.get(name.toLowerCase());
    return index === undefined ? undefined : this.startIndex(index, params, signalMask);
  }

  /**
   * Runs `name` to completion right now and returns its locals (query scripts such as QueryPrimary
   * write their answer into a parameter). If the script sleeps or blocks, it is abandoned there.
   */
  call(name: string, params: number[] = []): number[] | undefined {
    const index = this.byName.get(name.toLowerCase());
    if (index === undefined) return undefined;
    const t = this.newThread(index, params, 0);
    this.run(t);
    return t.state.kind === 'finished' ? t.returnLocals : t.frames[0]?.locals;
  }

  /** Runs one simulation tick. `timeMs` is the game time in milliseconds. */
  tick(timeMs: number): void {
    this.now = timeMs;
    this.threads = this.threads.filter((t) => t.state.kind !== 'finished' && !t.killed);
    for (const t of this.threads) {
      const s = t.state;
      if (s.kind === 'sleeping' && timeMs >= s.wakeAt) t.state = { kind: 'ready' };
      else if (s.kind === 'blocked') {
        const busy = s.turn ? this.host.isTurning(s.piece, s.axis) : this.host.isMoving(s.piece, s.axis);
        if (!busy) t.state = { kind: 'ready' };
      }
    }
    // New threads are appended while we iterate, so they also get to run this tick.
    for (let i = 0; i < this.threads.length; i++) {
      const t = this.threads[i]!;
      if (t.state.kind === 'ready' && !t.killed) this.run(t);
    }
  }

  /** Kills every thread whose signal mask shares a bit with `signal`. */
  signal(signal: number): void {
    for (const t of this.threads) {
      if ((t.signalMask & signal) !== 0) t.killed = true;
    }
  }

  private startIndex(index: number, params: number[], signalMask: number): CobThread {
    const t = this.newThread(index, params, signalMask);
    this.threads.push(t);
    return t;
  }

  private newThread(index: number, params: number[], signalMask: number): CobThread {
    const f = this.script.functions[index]!;
    return {
      id: this.nextId++,
      name: f.name,
      signalMask: signalMask >>> 0,
      stack: [],
      frames: [{ pc: f.address, locals: params.map((p) => p | 0), localCount: 0 }],
      state: { kind: 'ready' },
      returnLocals: [],
      returnValue: 0,
      killed: false,
    };
  }

  private run(t: CobThread): void {
    try {
      this.execute(t);
    } catch (e) {
      this.errors.push(`${t.name}: ${e instanceof Error ? e.message : String(e)}`);
      t.state = { kind: 'finished' };
    }
  }

  private execute(t: CobThread): void {
    const code = this.script.code;
    const host = this.host;
    const stack = t.stack;
    const pop = () => (stack.length ? stack.pop()! : 0); // malformed scripts pop empty stacks (RWE #56)
    const push = (v: number) => stack.push(v | 0);

    for (let steps = 0; ; steps++) {
      if (steps > MAX_STEPS) throw new CobError(`runaway thread (over ${MAX_STEPS} instructions without waiting)`);
      const frame = t.frames[t.frames.length - 1];
      if (!frame) {
        t.state = { kind: 'finished' };
        return;
      }
      const next = () => {
        if (frame.pc >= code.length) throw new CobError('ran off the end of the code');
        return code[frame.pc++]!;
      };
      const axis = (): CobAxis => {
        const a = next();
        if (a > 2) throw new CobError(`invalid axis ${a}`);
        return a as CobAxis;
      };
      const op = next();
      switch (op) {
        // --- piece commands
        case Op.MOVE: {
          const piece = next();
          const ax = axis();
          const pos = pop();
          host.move(piece, ax, pos, pop());
          break;
        }
        case Op.MOVE_NOW: {
          const piece = next();
          const ax = axis();
          host.move(piece, ax, pop());
          break;
        }
        case Op.TURN: {
          const piece = next();
          const ax = axis();
          const angle = pop();
          host.turn(piece, ax, angle, pop());
          break;
        }
        case Op.TURN_NOW: {
          const piece = next();
          const ax = axis();
          host.turn(piece, ax, pop());
          break;
        }
        case Op.SPIN: {
          const piece = next();
          const ax = axis();
          const speed = pop();
          host.spin(piece, ax, speed, pop());
          break;
        }
        case Op.STOP_SPIN: {
          const piece = next();
          const ax = axis();
          host.stopSpin(piece, ax, pop());
          break;
        }
        case Op.SHOW:
          host.show(next());
          break;
        case Op.HIDE:
          host.hide(next());
          break;
        case Op.CACHE:
        case Op.DONT_CACHE:
        case Op.SHADE:
        case Op.DONT_SHADE:
          next(); // rendering hints with no effect here
          break;
        case Op.EMIT_SFX: {
          const piece = next();
          host.emitSfx(piece, pop());
          break;
        }
        case Op.EXPLODE: {
          const piece = next();
          host.explode(piece, pop());
          break;
        }
        case Op.ATTACH_UNIT:
          pop();
          pop();
          break;
        case Op.DROP_UNIT:
          pop();
          break;

        // --- waiting
        case Op.WAIT_FOR_MOVE:
        case Op.WAIT_FOR_TURN: {
          const piece = next();
          const ax = axis();
          // Like RWE, always yield; the thread is re-checked at the start of the next tick.
          t.state = { kind: 'blocked', turn: op === Op.WAIT_FOR_TURN, piece, axis: ax };
          return;
        }
        case Op.SLEEP:
          t.state = { kind: 'sleeping', wakeAt: this.now + (pop() >>> 0) };
          return;

        // --- stack and variables
        case Op.PUSH_CONSTANT:
          push(next());
          break;
        case Op.PUSH_LOCAL_VAR: {
          const i = next();
          push(frame.locals[i] ?? 0);
          break;
        }
        case Op.POP_LOCAL_VAR: {
          const i = next();
          frame.locals[i] = pop();
          break;
        }
        case Op.CREATE_LOCAL_VAR:
          // Parameters arrive as the first locals; only add a slot once we've used those up.
          if (frame.localCount === frame.locals.length) frame.locals.push(0);
          frame.localCount++;
          break;
        case Op.PUSH_STATIC: {
          const i = next();
          push(this.statics[i] ?? 0);
          break;
        }
        case Op.POP_STATIC: {
          const i = next();
          const v = pop();
          if (i < this.statics.length) this.statics[i] = v;
          break;
        }
        case Op.POP_STACK:
          pop();
          break;

        // --- arithmetic and logic
        case Op.ADD: {
          const b = pop();
          push(pop() + b);
          break;
        }
        case Op.SUB: {
          const b = pop();
          push(pop() - b);
          break;
        }
        case Op.MUL: {
          const b = pop();
          push(Math.imul(pop(), b));
          break;
        }
        case Op.DIV: {
          const b = pop();
          const a = pop();
          push(b === 0 ? 0 : Math.trunc(a / b));
          break;
        }
        case Op.BITWISE_AND: {
          const b = pop();
          push(pop() & b);
          break;
        }
        case Op.BITWISE_OR: {
          const b = pop();
          push(pop() | b);
          break;
        }
        case Op.BITWISE_XOR: {
          const b = pop();
          push(pop() ^ b);
          break;
        }
        case Op.BITWISE_NOT:
          push(~pop());
          break;
        case Op.SET_LESS:
        case Op.SET_LESS_OR_EQUAL:
        case Op.SET_GREATER:
        case Op.SET_GREATER_OR_EQUAL:
        case Op.SET_EQUAL:
        case Op.SET_NOT_EQUAL:
        case Op.LOGICAL_AND:
        case Op.LOGICAL_OR:
        case Op.LOGICAL_XOR: {
          const b = pop();
          const a = pop();
          push(compare(op, a, b) ? 1 : 0);
          break;
        }
        case Op.LOGICAL_NOT:
          push(pop() ? 0 : 1);
          break;
        case Op.RAND: {
          const high = pop();
          const low = pop();
          push(host.random(low, high));
          break;
        }
        case Op.GET_VALUE:
          push(this.getValue(pop(), 0, 0, 0, 0));
          break;
        case Op.GET_VALUE_WITH_ARGS: {
          const a4 = pop();
          const a3 = pop();
          const a2 = pop();
          const a1 = pop();
          push(this.getValue(pop(), a1, a2, a3, a4));
          break;
        }
        case Op.SET_VALUE: {
          const v = pop();
          host.setValue(pop(), v);
          break;
        }

        // --- control flow
        case Op.JUMP:
          frame.pc = next();
          break;
        case Op.JUMP_IF_ZERO: {
          const target = next();
          if (pop() === 0) frame.pc = target;
          break;
        }
        case Op.CALL_SCRIPT: {
          const index = next();
          const count = next();
          const params: number[] = [];
          for (let i = 0; i < count; i++) params.push(pop());
          const f = this.script.functions[index];
          if (!f) throw new CobError(`call to missing script ${index}`);
          t.frames.push({ pc: f.address, locals: params, localCount: 0 });
          if (t.frames.length > 256) throw new CobError('call stack too deep');
          break;
        }
        case Op.START_SCRIPT: {
          const index = next();
          const count = next();
          const params: number[] = [];
          for (let i = 0; i < count; i++) params.push(pop());
          if (!this.script.functions[index]) throw new CobError(`start of missing script ${index}`);
          this.startIndex(index, params, t.signalMask);
          break;
        }
        case Op.RETURN: {
          t.returnValue = pop();
          t.returnLocals = frame.locals;
          t.frames.pop();
          break;
        }
        case Op.SIGNAL:
          this.signal(pop() >>> 0);
          if (t.killed) {
            t.state = { kind: 'finished' };
            return;
          }
          break;
        case Op.SET_SIGNAL_MASK:
          t.signalMask = pop() >>> 0;
          break;

        default:
          throw new CobError(`unknown opcode 0x${op.toString(16)} at ${frame.pc - 1}`);
      }
    }
  }

  private getValue(id: number, a1: number, a2: number, a3: number, a4: number): number {
    switch (id) {
      case CobValue.XZHypot: {
        const [x, z] = unpackXZ(a1);
        return toFixed(Math.hypot(x, z));
      }
      case CobValue.Atan:
        return cobAtan(a1, a2);
      case CobValue.Hypot:
        return toFixed(Math.hypot(a1 / 65536, a2 / 65536));
      case CobValue.UnitIsOnThisComp:
        return 1;
      default:
        return this.host.getValue(id, a1, a2, a3, a4) | 0;
    }
  }
}

function compare(op: number, a: number, b: number): boolean {
  switch (op) {
    case Op.SET_LESS:
      return a < b;
    case Op.SET_LESS_OR_EQUAL:
      return a <= b;
    case Op.SET_GREATER:
      return a > b;
    case Op.SET_GREATER_OR_EQUAL:
      return a >= b;
    case Op.SET_EQUAL:
      return a === b;
    case Op.SET_NOT_EQUAL:
      return a !== b;
    case Op.LOGICAL_AND:
      return a !== 0 && b !== 0;
    case Op.LOGICAL_OR:
      return a !== 0 || b !== 0;
    default:
      return (a !== 0) !== (b !== 0); // LOGICAL_XOR
  }
}

/** World units to 16.16 fixed point. */
export function toFixed(v: number): number {
  return Math.trunc(v * 65536) | 0;
}

/** Packs whole-unit x and z into one value, x in the high 16 bits (RWE cobPackCoords). */
export function packXZ(x: number, z: number): number {
  return (((Math.trunc(x) & 0xffff) << 16) | (Math.trunc(z) & 0xffff)) | 0;
}

/** Inverse of packXZ. RWE treats both halves as unsigned. */
export function unpackXZ(v: number): [number, number] {
  return [(v >>> 16) & 0xffff, v & 0xffff];
}

/** atan2 of two fixed-point values as a COB angle (0-65535). */
export function cobAtan(a: number, b: number): number {
  const rad = Math.atan2(a / 65536, b / 65536);
  return Math.round(rad * (32768 / Math.PI)) & 0xffff;
}
