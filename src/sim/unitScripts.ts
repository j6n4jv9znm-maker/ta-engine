import { allPieces, type ModelPiece } from '../formats/3do';
import type { CobScript } from '../formats/cob';
import { CobValue, CobVm, packXZ, toFixed, type CobAxis, type CobHost } from './cob/vm';
import { angleToRadians, PieceAnimator, TICKS_PER_SECOND, wrapAngle } from './pieces';
import type { Rng } from './rng';

/*
 * One unit's scripts: a COB VM wired to that unit's piece animator and state. Simulation-side.
 *
 * Unit conventions follow RWE (src/rwe/sim/cob.cpp): script positions and speeds are 16.16 fixed point,
 * angles are 65536 per turn; x moves and z turns are negated to go from TA's left-handed scripts to our
 * right-handed models.
 *
 * Standard entry points (named in TA's scripts): Create, StartMoving/StopMoving, Activate/Deactivate,
 * AimPrimary/FirePrimary (and Secondary/Tertiary), QueryPrimary/AimFromPrimary, StartBuilding/
 * StopBuilding, QueryNanoPiece, Killed, SetMaxReloadTime, SetSpeed, ...
 */

export type ScriptEvent =
  | { kind: 'explode'; piece: string; type: number }
  | { kind: 'sfx'; piece: string; type: number };

/** EXPLODE flags (from TA's exptype.h, as used by RWE and Scriptor). */
export const ExplodeType = {
  SHATTER: 1,
  EXPLODE_ON_HIT: 2,
  FALL: 4,
  SMOKE: 8,
  FIRE: 16,
  BITMAPONLY: 32,
} as const;

export interface UnitState {
  activated: boolean;
  inBuildStance: boolean;
  yardOpen: boolean;
  buggerOff: boolean;
  armored: boolean;
  busy: boolean;
  /** 0-100 */
  healthPercent: number;
  buildPercentLeft: number;
  standingMoveOrders: number;
  standingFireOrders: number;
}

export class UnitScripts {
  readonly vm: CobVm;
  readonly pieces: PieceAnimator;
  readonly state: UnitState = {
    activated: false,
    inBuildStance: false,
    yardOpen: false,
    buggerOff: false,
    armored: false,
    busy: false,
    healthPercent: 100,
    buildPercentLeft: 0,
    standingMoveOrders: 1,
    standingFireOrders: 2,
  };
  /** Things scripts asked for that the rest of the game reacts to. Drained by the caller each tick. */
  events: ScriptEvent[] = [];
  private tickCount = 0;
  private readonly modelPieces = new Map<string, { piece: ModelPiece; parent?: ModelPiece }>();

  constructor(
    readonly script: CobScript,
    model: ModelPiece,
    private readonly rng: Rng,
  ) {
    this.pieces = new PieceAnimator(allPieces(model).map((p) => p.name));
    const index = (p: ModelPiece, parent?: ModelPiece) => {
      if (!this.modelPieces.has(p.name.toLowerCase())) this.modelPieces.set(p.name.toLowerCase(), { piece: p, parent });
      p.children.forEach((c) => index(c, p));
    };
    index(model);
    this.vm = new CobVm(script, this.makeHost());
  }

  /** Game time in milliseconds, the clock scripts sleep against. */
  get timeMs(): number {
    return Math.floor((this.tickCount * 1000) / TICKS_PER_SECOND);
  }

  /** Advances scripts and piece animation by one 30 Hz tick. */
  tick(): void {
    this.vm.tick(this.timeMs);
    this.pieces.tick();
    this.tickCount++;
  }

  start(name: string, params: number[] = []): void {
    this.vm.start(name, params);
  }

  /** Runs a query script immediately and returns the value it wrote into its first parameter. */
  query(name: string, params: number[] = [0]): number | undefined {
    return this.vm.call(name, params)?.[0];
  }

  pieceName(index: number): string {
    return this.script.pieces[index] ?? `piece${index}`;
  }

  /** A piece's origin in unit space (x, y, z), with every animated offset and turn applied. */
  piecePosition(name: string): [number, number, number] {
    const chain: ModelPiece[] = [];
    for (let e = this.modelPieces.get(name.toLowerCase()); e; e = e.parent ? this.modelPieces.get(e.parent.name.toLowerCase()) : undefined) {
      chain.push(e.piece);
    }
    let p: [number, number, number] = [0, 0, 0];
    // Walk from the piece up to the root: p = T(parentOrigin + offset) * R(rotation) * p.
    for (const piece of chain) {
      const s = this.pieces.get(piece.name);
      const rot = s?.rotation ?? [0, 0, 0];
      p = rotateYXZ(p, angleToRadians(rot[0]), angleToRadians(rot[1]), angleToRadians(rot[2]));
      const off = s?.offset ?? [0, 0, 0];
      p = [p[0] + piece.offset[0] + off[0], p[1] + piece.offset[1] + off[1], p[2] + piece.offset[2] + off[2]];
    }
    return p;
  }

  private makeHost(): CobHost {
    const name = (i: number) => this.pieceName(i);
    const fx = (v: number) => v / 65536;
    const st = this.state;
    return {
      move: (piece, axis, pos, speed) => {
        const target = axis === 0 ? -fx(pos) : fx(pos);
        this.pieces.move(name(piece), axis, target, speed === undefined ? undefined : fx(speed));
      },
      turn: (piece, axis, angle, speed) => {
        const target = axis === 2 ? wrapAngle(-angle) : wrapAngle(angle);
        this.pieces.turn(name(piece), axis, target, speed);
      },
      spin: (piece, axis, speed, accel) => this.pieces.spin(name(piece), axis, speed, accel),
      stopSpin: (piece, axis, decel) => this.pieces.stopSpin(name(piece), axis, decel),
      show: (piece) => this.pieces.setVisible(name(piece), true),
      hide: (piece) => this.pieces.setVisible(name(piece), false),
      explode: (piece, type) => this.events.push({ kind: 'explode', piece: name(piece), type }),
      emitSfx: (piece, type) => this.events.push({ kind: 'sfx', piece: name(piece), type }),
      isMoving: (piece, axis: CobAxis) => this.pieces.isMoving(name(piece), axis),
      isTurning: (piece, axis: CobAxis) => this.pieces.isTurning(name(piece), axis),
      random: (low, high) => this.rng.int(low, high),
      getValue: (id, a1) => {
        switch (id) {
          case CobValue.Activation:
            return st.activated ? 1 : 0;
          case CobValue.StandingMoveOrders:
            return st.standingMoveOrders;
          case CobValue.StandingFireOrders:
            return st.standingFireOrders;
          case CobValue.Health:
            return st.healthPercent;
          case CobValue.InBuildStance:
            return st.inBuildStance ? 1 : 0;
          case CobValue.Busy:
            return st.busy ? 1 : 0;
          case CobValue.YardOpen:
            return st.yardOpen ? 1 : 0;
          case CobValue.BuggerOff:
            return st.buggerOff ? 1 : 0;
          case CobValue.Armored:
            return st.armored ? 1 : 0;
          case CobValue.BuildPercentLeft:
            return st.buildPercentLeft;
          case CobValue.PieceXZ: {
            const [x, , z] = this.piecePosition(name(a1));
            return packXZ(x, z);
          }
          case CobValue.PieceY:
            return toFixed(this.piecePosition(name(a1))[1]);
          default:
            // Values about other units, the map, ids and teams need the full simulation (Phase 5+).
            return 0;
        }
      },
      setValue: (id, value) => {
        switch (id) {
          case CobValue.Activation:
            st.activated = value !== 0;
            break;
          case CobValue.StandingMoveOrders:
            st.standingMoveOrders = value;
            break;
          case CobValue.StandingFireOrders:
            st.standingFireOrders = value;
            break;
          case CobValue.InBuildStance:
            st.inBuildStance = value !== 0;
            break;
          case CobValue.Busy:
            st.busy = value !== 0;
            break;
          case CobValue.YardOpen:
            st.yardOpen = value !== 0;
            break;
          case CobValue.BuggerOff:
            st.buggerOff = value !== 0;
            break;
          case CobValue.Armored:
            st.armored = value !== 0;
            break;
        }
      },
    };
  }
}

/** Applies R = Ry * Rx * Rz (the order RWE uses for pieces) to a point. */
export function rotateYXZ(p: [number, number, number], rx: number, ry: number, rz: number): [number, number, number] {
  let [x, y, z] = p;
  // Rz
  let c = Math.cos(rz);
  let s = Math.sin(rz);
  [x, y] = [x * c - y * s, x * s + y * c];
  // Rx
  c = Math.cos(rx);
  s = Math.sin(rx);
  [y, z] = [y * c - z * s, y * s + z * c];
  // Ry
  c = Math.cos(ry);
  s = Math.sin(ry);
  [x, z] = [x * c + z * s, -x * s + z * c];
  return [x, y, z];
}
