import * as THREE from 'three';
import { frameToRgba, parseGaf, type GafFrame } from '../formats/gaf';
import type { Palette } from '../formats/palette';
import type { World } from '../sim/world';
import type { Vfs } from '../vfs';
import type { UnitRenderer } from './unitRenderer';

/*
 * Draws combat: shots in flight, explosions (the weapon's own GAF animation, e.g. fx.gaf "explode3"),
 * and pieces blown off dying units. Everything here is a visual effect read from the simulation's
 * projectiles and events; nothing is written back. Debris uses Math.random because it is cosmetic.
 */

const MAX_SHOT_SEGMENTS = 2048;
const EXPLOSION_FPS = 15;

interface Anim {
  frames: { tex: THREE.Texture; w: number; h: number }[];
}

interface LiveExplosion {
  sprite: THREE.Sprite;
  anim: Anim;
  start: number;
}

interface Debris {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

/** TA's explode flags. */
const BITMAPONLY = 32;
const FALL = 4;

export class CombatRenderer {
  readonly group = new THREE.Group();
  private readonly shotPos = new Float32Array(MAX_SHOT_SEGMENTS * 6);
  private readonly shotCol = new Float32Array(MAX_SHOT_SEGMENTS * 6);
  private readonly shotGeo = new THREE.BufferGeometry();
  private readonly shots: THREE.LineSegments;
  private readonly anims = new Map<string, Promise<Anim | undefined>>();
  private readonly loaded = new Map<string, Anim | undefined>();
  private gafs = new Map<string, Promise<ReturnType<typeof parseGaf> | undefined>>();
  private explosions: LiveExplosion[] = [];
  private debris: Debris[] = [];
  private lastTick = -1;

  constructor(
    private readonly vfs: Vfs,
    private readonly palette: Palette,
  ) {
    this.group.name = 'combat';
    this.shotGeo.setAttribute('position', new THREE.BufferAttribute(this.shotPos, 3));
    this.shotGeo.setAttribute('color', new THREE.BufferAttribute(this.shotCol, 3));
    this.shots = new THREE.LineSegments(this.shotGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    this.shots.frustumCulled = false;
    this.group.add(this.shots);
    // Preload the common explosion sheet.
    void this.anim('fx', 'explode1');
  }

  update(world: World, alpha: number, dt: number, units: UnitRenderer, viewer: number): void {
    this.drawShots(world, alpha, viewer);
    for (const e of world.events) {
      if (e.tick <= this.lastTick) continue;
      if (e.kind === 'explosion' && world.visibility.at(viewer, e.x, e.z) & 1) this.spawnExplosion(e.gaf || 'fx', e.art || 'explode3', e.x, e.y, e.z);
      if (e.kind === 'debris' && !(e.flags & BITMAPONLY)) this.spawnDebris(units, e.unitId, e.piece, e.flags);
    }
    this.lastTick = world.tickCount - 1;
    this.animate(dt);
  }

  private drawShots(world: World, alpha: number, viewer: number): void {
    let n = 0;
    for (const p of world.projectiles) {
      if (n >= MAX_SHOT_SEGMENTS) break;
      if (!(world.visibility.at(viewer, p.x, p.z) & 1) && p.owner !== viewer) continue;
      const x = p.prevX + (p.x - p.prevX) * alpha;
      const y = p.prevY + (p.y - p.prevY) * alpha;
      const z = p.prevZ + (p.z - p.prevZ) * alpha;
      const w = p.weapon;
      let tail: [number, number, number];
      let rgb: [number, number, number];
      if (w.beam || (w.kind === 'lineOfSight' && w.renderType === 0)) {
        // Lasers: a long bright streak in the weapon's palette colour.
        const len = Math.min(Math.hypot(x - p.originX, y - p.originY, z - p.originZ), 60);
        const sp = Math.hypot(p.vx, p.vy, p.vz) || 1;
        tail = [x - (p.vx / sp) * len, y - (p.vy / sp) * len, z - (p.vz / sp) * len];
        const c = this.palette.color(w.color || 251);
        rgb = [c.r / 255, c.g / 255, c.b / 255];
      } else {
        // Shells, bullets and missiles: a short streak behind them.
        tail = [x - p.vx * 1.5, y - p.vy * 1.5, z - p.vz * 1.5];
        rgb = w.kind === 'tracking' ? [1, 0.85, 0.6] : [1, 0.95, 0.5];
      }
      this.shotPos.set([tail[0], tail[1], tail[2], x, y, z], n * 6);
      this.shotCol.set([rgb[0] * 0.6, rgb[1] * 0.6, rgb[2] * 0.6, rgb[0], rgb[1], rgb[2]], n * 6);
      n++;
    }
    this.shotGeo.setDrawRange(0, n * 2);
    (this.shotGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.shotGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  private spawnExplosion(gaf: string, art: string, x: number, y: number, z: number): void {
    const key = `${gaf}/${art}`.toLowerCase();
    const ready = this.loaded.get(key);
    const make = (anim: Anim | undefined) => {
      if (!anim || anim.frames.length === 0) return;
      const mat = new THREE.SpriteMaterial({ map: anim.frames[0]!.tex, transparent: true, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(x, y + anim.frames[0]!.h / 2, z);
      sprite.scale.set(anim.frames[0]!.w, anim.frames[0]!.h, 1);
      sprite.renderOrder = 5;
      this.group.add(sprite);
      this.explosions.push({ sprite, anim, start: performance.now() });
    };
    if (ready !== undefined || this.loaded.has(key)) make(ready);
    else void this.anim(gaf, art).then(make);
  }

  private spawnDebris(units: UnitRenderer, unitId: number, piece: string, flags: number): void {
    const src = units.pieceMesh(unitId, piece);
    if (!src) return;
    units.markBlown(unitId, piece);
    const copy = new THREE.Mesh(src.geometry, src.material);
    src.updateWorldMatrix(true, false);
    src.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
    this.group.add(copy);
    const fall = (flags & FALL) !== 0;
    const speed = fall ? 15 : 70;
    this.debris.push({
      obj: copy,
      vel: new THREE.Vector3((Math.random() - 0.5) * speed, fall ? 10 : 50 + Math.random() * 50, (Math.random() - 0.5) * speed),
      spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4),
      life: 2.5,
    });
  }

  private animate(dt: number): void {
    const now = performance.now();
    this.explosions = this.explosions.filter((e) => {
      const i = Math.floor(((now - e.start) / 1000) * EXPLOSION_FPS);
      const f = e.anim.frames[i];
      if (!f) {
        this.group.remove(e.sprite);
        e.sprite.material.dispose();
        return false;
      }
      e.sprite.material.map = f.tex;
      e.sprite.scale.set(f.w, f.h, 1);
      return true;
    });
    for (const d of this.debris) {
      d.vel.y -= 150 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotation.x += d.spin.x * dt;
      d.obj.rotation.y += d.spin.y * dt;
      d.obj.rotation.z += d.spin.z * dt;
      d.life -= dt;
    }
    this.debris = this.debris.filter((d) => {
      if (d.life > 0) return true;
      this.group.remove(d.obj);
      return false;
    });
  }

  /** Loads a GAF animation's frames as textures (cached). */
  private anim(gaf: string, art: string): Promise<Anim | undefined> {
    const key = `${gaf}/${art}`.toLowerCase();
    let p = this.anims.get(key);
    if (!p) {
      p = (async () => {
        const g = gaf.toLowerCase();
        let entries = this.gafs.get(g);
        if (!entries) {
          const path = `anims/${gaf}.gaf`;
          entries = this.vfs.exists(path) ? this.vfs.read(path).then(parseGaf) : Promise.resolve(undefined);
          this.gafs.set(g, entries);
        }
        const entry = (await entries)?.find((e) => e.name.toLowerCase() === art.toLowerCase());
        const anim: Anim | undefined = entry ? { frames: entry.frames.map((f) => this.texture(f)) } : undefined;
        this.loaded.set(key, anim);
        return anim;
      })();
      this.anims.set(key, p);
    }
    return p;
  }

  private texture(f: GafFrame): { tex: THREE.Texture; w: number; h: number } {
    const tex = new THREE.DataTexture(frameToRgba(f, this.palette), f.width, f.height, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return { tex, w: Math.max(1, f.width), h: Math.max(1, f.height) };
  }

  dispose(): void {
    this.shotGeo.dispose();
    (this.shots.material as THREE.Material).dispose();
    this.group.clear();
  }
}
