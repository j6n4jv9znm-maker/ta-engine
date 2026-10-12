import { getBlock, getValue, parseTdf, type TdfBlock } from '../formats/tdf';
import { latin1 } from '../formats/hpi';
import type { UnitDef } from '../sim/unitDef';
import type { World } from '../sim/world';
import type { Vfs } from '../vfs';

/*
 * Game sounds, played from the original sounds/*.wav files. Renderer side: it only reads sim events
 * and unit state. Unit replies (select, ok, arrived, build, underattack...) come from
 * gamedata/SOUND.TDF, keyed by each unit's SoundCategory; weapons name their own sounds.
 * Sounds near the middle of the view play loudest, panned left or right by where they are on screen.
 */

export type UnitSoundKey = 'select1' | 'ok1' | 'arrived1' | 'cant1' | 'build' | 'underattack' | 'unitcomplete' | 'activate' | 'deactivate';

export interface Listener {
  /** The point the view looks at, and how far the view reaches sideways and up/down on the ground (world units). */
  x: number;
  z: number;
  halfWidth: number;
  halfDepth: number;
}

const MAX_VOICES = 24;
const SAME_SOUND_GAP_MS = 70;
const UNDER_ATTACK_GAP_MS = 12000;

export class GameAudio {
  volume = 0.7;
  muted = false;
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private readonly buffers = new Map<string, Promise<AudioBuffer | undefined>>();
  private readonly lastPlayed = new Map<string, number>();
  private voices = 0;
  private lastTick = 0;
  private readonly hp = new Map<number, number>();
  private underAttackAt = -Infinity;

  constructor(
    private readonly vfs: Vfs,
    private readonly table: TdfBlock,
  ) {}

  static async load(vfs: Vfs): Promise<GameAudio> {
    const table = vfs.exists('gamedata/sound.tdf') ? parseTdf(latin1(await vfs.read('gamedata/sound.tdf'))) : {};
    return new GameAudio(vfs, table as TdfBlock);
  }

  /** Browsers only allow sound after the player has clicked or pressed a key; call from such an event. */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Forget per-game state (call when a new game starts). */
  reset(tick = 0): void {
    this.lastTick = tick;
    this.hp.clear();
    this.underAttackAt = -Infinity;
  }

  /** The name of a unit's reply sound, from SOUND.TDF. */
  unitSoundName(def: UnitDef, key: UnitSoundKey): string | undefined {
    const block = def.soundCategory ? getBlock(this.table, def.soundCategory) : undefined;
    const v = block ? getValue(block, key) : undefined;
    return v ? v.toLowerCase() : undefined;
  }

  /** A unit's reply, played at full volume (it answers the player). */
  unitSound(def: UnitDef, key: UnitSoundKey): void {
    const name = this.unitSoundName(def, key);
    if (name) this.play(name);
  }

  /** Plays sounds/<name>.wav; with a position, quieter and panned by distance from the listener. */
  play(name: string, at?: { x: number; z: number; listener: Listener }): void {
    if (this.muted || !this.ctx || !this.master || !name) return;
    let gain = 1;
    let pan = 0;
    if (at) {
      const dx = at.x - at.listener.x;
      const dz = at.z - at.listener.z;
      // As in TA, only what happens on (or just off) the screen is heard: fighting elsewhere stays quiet.
      const ex = Math.abs(dx) / (at.listener.halfWidth * 1.1);
      const ez = Math.abs(dz) / (at.listener.halfDepth * 1.1);
      const edge = Math.max(ex, ez);
      if (edge > 1) return;
      gain = 1 - Math.max(0, edge - 0.6) * 1.5;
      pan = Math.max(-1, Math.min(1, dx / (at.listener.halfWidth * 1.5)));
    }
    const now = performance.now();
    if (now - (this.lastPlayed.get(name) ?? -Infinity) < SAME_SOUND_GAP_MS) return;
    if (this.voices >= MAX_VOICES) return;
    this.lastPlayed.set(name, now);
    const ctx = this.ctx;
    const master = this.master;
    void this.buffer(name).then((buf) => {
      if (!buf || this.voices >= MAX_VOICES) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = gain * this.volume;
      let node: AudioNode = g;
      if (pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        g.connect(p);
        node = p;
      }
      src.connect(g);
      node.connect(master);
      this.voices++;
      src.onended = () => this.voices--;
      src.start();
    });
  }

  /** Plays the sounds for everything that happened in the sim since the last call. */
  update(world: World, viewer: number, listener: Listener): void {
    if (!this.ctx || this.muted) {
      this.lastTick = world.tickCount;
      return;
    }
    const seen = (x: number, z: number) => (world.visibility.at(viewer, x, z) & 1) !== 0;
    for (const e of world.events) {
      if (e.tick <= this.lastTick) continue;
      if (e.kind === 'fire') {
        const w = world.weaponDefs.get(e.weapon);
        const u = world.units.get(e.unitId);
        if (!w?.soundStart || (w.soundTrigger && !e.first)) continue;
        if (u?.owner === viewer || seen(e.x, e.z)) this.play(w.soundStart, { x: e.x, z: e.z, listener });
      } else if (e.kind === 'explosion') {
        if (e.sound && seen(e.x, e.z)) this.play(e.sound, { x: e.x, z: e.z, listener });
      } else if (e.kind === 'complete') {
        const u = world.units.get(e.unitId);
        if (u && e.owner === viewer && e.tick > 0) {
          const name = this.unitSoundName(u.def, 'unitcomplete');
          if (name) this.play(name, { x: u.x, z: u.z, listener });
        }
      }
    }
    // "Under attack": one of our units lost health, at most every few seconds.
    const now = performance.now();
    for (const u of world.units.values()) {
      if (u.owner !== viewer) continue;
      const before = this.hp.get(u.id);
      this.hp.set(u.id, u.hp);
      if (before !== undefined && u.hp < before - 0.5 && now - this.underAttackAt > UNDER_ATTACK_GAP_MS && u.buildProgress >= u.def.buildTime) {
        this.underAttackAt = now;
        this.unitSound(u.def, 'underattack');
      }
    }
    for (const id of this.hp.keys()) if (!world.units.has(id)) this.hp.delete(id);
    this.lastTick = world.tickCount;
  }

  private buffer(name: string): Promise<AudioBuffer | undefined> {
    let p = this.buffers.get(name);
    if (!p) {
      const path = `sounds/${name}.wav`;
      p = this.vfs.exists(path)
        ? this.vfs
            .read(path)
            .then((bytes) => this.ctx!.decodeAudioData(bytes.slice().buffer))
            .catch(() => undefined)
        : Promise.resolve(undefined);
      this.buffers.set(name, p);
    }
    return p;
  }
}
