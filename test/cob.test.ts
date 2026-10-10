import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse3do, type ModelPiece } from '../src/formats/3do';
import { parseCob, type CobScript } from '../src/formats/cob';
import { latin1 } from '../src/formats/hpi';
import { getBlock, getValue, parseTdf } from '../src/formats/tdf';
import { openDataDir } from '../src/io/nodeVfs';
import { Op } from '../src/sim/cob/opcodes';
import { cobAtan, CobVm, packXZ, unpackXZ, type CobHost } from '../src/sim/cob/vm';
import { PieceAnimator, turnTowards, wrapAngle } from '../src/sim/pieces';
import { Rng } from '../src/sim/rng';
import { UnitScripts } from '../src/sim/unitScripts';
import { DATA_DIR, hasGameData } from '../src/testData';
import { listUnitFiles } from '../src/units';
import type { Vfs } from '../src/vfs';

/** Assembles a script from named functions written as opcode/operand words. */
function assemble(fns: Record<string, number[]>, pieces: string[] = ['base', 'arm'], staticCount = 2): CobScript {
  const code: number[] = [];
  const functions = Object.entries(fns).map(([name, words]) => {
    const address = code.length;
    code.push(...words.map((w) => w >>> 0));
    return { name, address };
  });
  return { code: Uint32Array.from(code), functions, pieces, staticCount };
}

/** Writes a COB file in the documented layout, to test the reader. */
function buildCobFile(s: CobScript): Uint8Array {
  const out: number[] = new Array(44).fill(0);
  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const set32 = (at: number, v: number) => out.splice(at, 4, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const codeAt = out.length;
  s.code.forEach(u32);
  const addrAt = out.length;
  s.functions.forEach((f) => u32(f.address));
  const nameOffsetsAt = out.length;
  s.functions.forEach(() => u32(0));
  const pieceOffsetsAt = out.length;
  s.pieces.forEach(() => u32(0));
  const str = (x: string) => {
    const at = out.length;
    for (const c of x) out.push(c.charCodeAt(0));
    out.push(0);
    return at;
  };
  s.functions.forEach((f, i) => set32(nameOffsetsAt + i * 4, str(f.name)));
  s.pieces.forEach((p, i) => set32(pieceOffsetsAt + i * 4, str(p)));
  [4, s.functions.length, s.pieces.length, s.code.length, s.staticCount, 0, addrAt, nameOffsetsAt, pieceOffsetsAt, codeAt, 0].forEach((v, i) =>
    set32(i * 4, v),
  );
  return Uint8Array.from(out);
}

/** A host backed by a real PieceAnimator, recording what scripts ask for. */
function testHost(pieces: string[]) {
  const anim = new PieceAnimator(pieces);
  const log: string[] = [];
  const rng = new Rng(42);
  const host: CobHost = {
    move: (p, a, pos, speed) => anim.move(pieces[p]!, a, pos / 65536, speed === undefined ? undefined : speed / 65536),
    turn: (p, a, angle, speed) => anim.turn(pieces[p]!, a, angle, speed),
    spin: (p, a, s, acc) => anim.spin(pieces[p]!, a, s, acc),
    stopSpin: (p, a, d) => anim.stopSpin(pieces[p]!, a, d),
    show: (p) => anim.setVisible(pieces[p]!, true),
    hide: (p) => anim.setVisible(pieces[p]!, false),
    explode: (p, type) => log.push(`explode ${pieces[p]} ${type}`),
    emitSfx: (p, type) => log.push(`sfx ${pieces[p]} ${type}`),
    isMoving: (p, a) => anim.isMoving(pieces[p]!, a),
    isTurning: (p, a) => anim.isTurning(pieces[p]!, a),
    getValue: (id) => id * 10,
    setValue: (id, v) => log.push(`set ${id}=${v}`),
    random: (lo, hi) => rng.int(lo, hi),
  };
  return { anim, log, host };
}

const PUSH = Op.PUSH_CONSTANT;
const RET0 = [PUSH, 0, Op.RETURN];

describe('COB file reader', () => {
  it('reads code, function names, addresses and pieces', () => {
    const s = assemble({ Create: [PUSH, 7, Op.POP_STACK, ...RET0], Other: RET0 }, ['base', 'turret'], 3);
    const parsed = parseCob(buildCobFile(s));
    expect(parsed.functions).toEqual([
      { name: 'Create', address: 0 },
      { name: 'Other', address: 6 },
    ]);
    expect(parsed.pieces).toEqual(['base', 'turret']);
    expect(parsed.staticCount).toBe(3);
    expect([...parsed.code]).toEqual([...s.code]);
  });
});

describe('COB virtual machine', () => {
  it('does integer arithmetic, comparisons and statics', () => {
    const s = assemble({
      Main: [
        PUSH, 7, PUSH, 3, Op.SUB, // 4
        PUSH, -6, Op.MUL, // -24
        PUSH, 5, Op.DIV, // -4 (truncates toward zero)
        Op.POP_STATIC, 0,
        PUSH, 2, PUSH, 3, Op.SET_LESS, Op.POP_STATIC, 1, // 1
        ...RET0,
      ],
    });
    const vm = new CobVm(s, testHost(s.pieces).host);
    vm.start('Main');
    vm.tick(0);
    expect(vm.statics).toEqual([-4, 1]);
  });

  it('passes parameters as locals and returns query results through them', () => {
    // QueryPrimary(piecenum) { piecenum = 1; }
    const s = assemble({ QueryPrimary: [Op.CREATE_LOCAL_VAR, PUSH, 1, Op.POP_LOCAL_VAR, 0, ...RET0] });
    const vm = new CobVm(s, testHost(s.pieces).host);
    expect(vm.call('QueryPrimary', [0])?.[0]).toBe(1);
    expect(vm.call('Missing')).toBeUndefined();
  });

  it('calls scripts and continues after they return', () => {
    // Main { call Add(2, 5)... } where Add stores a+b in static 0; params pop in RWE's order
    const s = assemble({
      Main: [PUSH, 2, PUSH, 5, Op.CALL_SCRIPT, 1, 2, PUSH, 1, Op.POP_STATIC, 1, ...RET0],
      Add: [Op.CREATE_LOCAL_VAR, Op.CREATE_LOCAL_VAR, Op.PUSH_LOCAL_VAR, 0, Op.PUSH_LOCAL_VAR, 1, Op.ADD, Op.POP_STATIC, 0, ...RET0],
    });
    const vm = new CobVm(s, testHost(s.pieces).host);
    vm.start('Main');
    vm.tick(0);
    expect(vm.statics).toEqual([7, 1]);
  });

  it('sleeps in game milliseconds', () => {
    const s = assemble({ Main: [PUSH, 100, Op.SLEEP, PUSH, 1, Op.POP_STATIC, 0, ...RET0] });
    const vm = new CobVm(s, testHost(s.pieces).host);
    vm.start('Main');
    vm.tick(0);
    vm.tick(66);
    expect(vm.statics[0]).toBe(0);
    vm.tick(100);
    expect(vm.statics[0]).toBe(1);
  });

  it('starts threads that inherit the signal mask, and signals kill them', () => {
    const loop = [PUSH, 100, Op.SLEEP, Op.PUSH_STATIC, 0, PUSH, 1, Op.ADD, Op.POP_STATIC, 0, Op.JUMP];
    const s = assemble({
      Main: [PUSH, 2, Op.SET_SIGNAL_MASK, Op.START_SCRIPT, 1, 0, ...RET0],
      Loop: [], // filled below: an endless counter that sleeps 100ms per step
      Stop: [PUSH, 2, Op.SIGNAL, ...RET0],
    });
    const loopAt = s.functions[1]!.address;
    const code = [...s.code.slice(0, loopAt), ...loop, loopAt, ...s.code.slice(loopAt)];
    const stopAt = loopAt + loop.length + 1;
    const script: CobScript = { ...s, code: Uint32Array.from(code.map((w) => w >>> 0)), functions: [s.functions[0]!, { name: 'Loop', address: loopAt }, { name: 'Stop', address: stopAt }] };
    const vm = new CobVm(script, testHost(s.pieces).host);
    vm.start('Main');
    for (let t = 0; t <= 300; t += 33) vm.tick(t);
    const counted = vm.statics[0]!;
    expect(counted).toBeGreaterThanOrEqual(2);
    expect(vm.threads.find((t) => t.name === 'Loop')?.signalMask).toBe(2);
    vm.start('Stop');
    for (let t = 333; t <= 800; t += 33) vm.tick(t);
    expect(vm.statics[0]).toBe(counted);
  });

  it('turns pieces and waits for the turn to finish', () => {
    // turn arm to y-axis <90> speed <90> (per second), wait, then set static 0
    const s = assemble({
      Main: [PUSH, 16384, PUSH, 16384, Op.TURN, 1, 1, Op.WAIT_FOR_TURN, 1, 1, PUSH, 1, Op.POP_STATIC, 0, ...RET0],
    });
    const { anim, host } = testHost(s.pieces);
    const vm = new CobVm(s, host);
    vm.start('Main');
    let ticks = 0;
    for (; ticks < 60 && vm.statics[0] === 0; ticks++) {
      vm.tick(Math.floor((ticks * 1000) / 30));
      anim.tick();
    }
    expect(anim.get('arm')!.rotation[1]).toBe(16384);
    expect(ticks).toBeGreaterThanOrEqual(30); // one second at 30 ticks per second
    expect(ticks).toBeLessThanOrEqual(32);
  });

  it('hides, shows, explodes and sets values through the host', () => {
    const s = assemble({ Main: [Op.HIDE, 1, PUSH, 32, Op.EXPLODE, 0, PUSH, 5, PUSH, 1, Op.SET_VALUE, PUSH, 4, Op.GET_VALUE, Op.POP_STATIC, 0, ...RET0] });
    const { anim, log, host } = testHost(s.pieces);
    const vm = new CobVm(s, host);
    vm.start('Main');
    vm.tick(0);
    expect(anim.get('arm')!.visible).toBe(false);
    expect(log).toEqual(['explode base 32', 'set 5=1']);
    expect(vm.statics[0]).toBe(40);
  });

  it('stops runaway loops without hanging and reports them', () => {
    const s = assemble({ Main: [Op.JUMP, 0] });
    const vm = new CobVm(s, testHost(s.pieces).host);
    vm.start('Main');
    vm.tick(0);
    expect(vm.errors[0]).toMatch(/runaway/);
  });

  it('packs coordinates and computes atan like RWE', () => {
    expect(unpackXZ(packXZ(12, 34))).toEqual([12, 34]);
    expect(cobAtan(65536, 0)).toBe(16384); // 90 degrees
  });
});

describe('piece animation', () => {
  it('turns the short way round', () => {
    expect(turnTowards(1000, 64536, 500)).toBe(500);
    expect(turnTowards(0, 100, 500)).toBe(100);
    expect(wrapAngle(-1)).toBe(65535);
  });

  it('moves at a speed per second and spins with acceleration per tick', () => {
    const a = new PieceAnimator(['p']);
    a.move('p', 1, 10, 30); // 30 units/s -> 1 unit per tick
    a.tick();
    expect(a.get('p')!.offset[1]).toBeCloseTo(1);
    for (let i = 0; i < 20; i++) a.tick();
    expect(a.get('p')!.offset[1]).toBe(10);
    expect(a.isMoving('p', 1)).toBe(false);
    a.spin('p', 1, 3000, 100);
    a.tick();
    a.tick();
    expect(a.get('p')!.rotation[1]).toBeCloseTo((100 + 200) / 30);
    a.stopSpin('p', 1, 0);
    expect(a.isTurning('p', 1)).toBe(false);
  });
});

describe.skipIf(!hasGameData())('unit scripts (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  const load = async (unit: string): Promise<{ cob: CobScript; model: ModelPiece }> => {
    const info = getBlock(parseTdf(latin1(await vfs.read(`units/${unit}.fbi`))), 'UNITINFO')!;
    return {
      cob: parseCob(await vfs.read(`scripts/${unit}.cob`)),
      model: parse3do(await vfs.read(`objects3d/${getValue(info, 'Objectname')}.3do`)),
    };
  };
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
  });
  afterAll(() => close?.());

  it('runs the Arm Commander: Create hides the flashes, walking moves the legs, firing shows the flash', async () => {
    const { cob, model } = await load('ARMCOM');
    const u = new UnitScripts(cob, model, new Rng(1));
    u.start('Create');
    u.tick();
    expect(u.pieces.get('lfirept')!.visible).toBe(false);
    expect(u.pieces.get('nanospray')!.visible).toBe(false);
    u.start('StartMoving');
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      u.tick();
      seen.add(Math.round(u.pieces.get('lthigh')!.rotation[0]));
    }
    expect(seen.size).toBeGreaterThan(10);
    u.start('StopMoving');
    u.start('FirePrimary');
    u.tick();
    expect(u.pieces.get('lfirept')!.visible).toBe(true);
    for (let i = 0; i < 5; i++) u.tick();
    expect(u.pieces.get('lfirept')!.visible).toBe(false);
    expect(u.query('QueryPrimary')).toBe(cob.pieces.indexOf('lfirept'));
    expect(u.vm.errors).toEqual([]);
  });

  it('runs every unit script through create, move, aim, fire, build and death without errors', async () => {
    let checked = 0;
    for (const path of listUnitFiles(vfs)) {
      const unit = path.slice(path.lastIndexOf('/') + 1, -4);
      if (!vfs.exists(`scripts/${unit}.cob`)) continue;
      const { cob, model } = await load(unit);
      const u = new UnitScripts(cob, model, new Rng(7));
      const run = (n: number) => {
        for (let i = 0; i < n; i++) u.tick();
      };
      u.start('Create');
      run(30);
      u.start('StartMoving');
      u.start('Activate');
      run(60);
      u.start('AimPrimary', [8000, 2000]);
      run(30);
      u.start('FirePrimary');
      u.query('QueryPrimary');
      u.start('StopMoving');
      u.start('StartBuilding', [0, 0]);
      run(30);
      u.start('StopBuilding');
      u.start('Deactivate');
      u.start('Killed', [50, 0]);
      run(60);
      expect(u.vm.errors, unit).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(250);
  }, 120_000);
});
