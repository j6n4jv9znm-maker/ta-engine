import * as THREE from 'three';
import type { Palette } from '../formats/palette';
import { angleToRadians, ANGLE_FULL_TURN } from '../sim/pieces';
import type { SimUnit, UnitAssets, World } from '../sim/world';
import { applyPose } from './pose';
import type { TextureLibrary } from './textures';
import { createUnitModel, type UnitModel } from './threeModel';

/*
 * Draws the simulation's units. Read-only on the simulation: each frame it copies positions (blended
 * between the last two ticks for smooth motion), headings and piece poses onto Three.js objects.
 * One template model is built per unit type and team colour; each unit gets a clone that shares its
 * geometry and materials but has its own pieces to pose.
 *
 * Units still being built are drawn as a green wireframe (TA's nano-lathe look), and every builder at
 * work gets a green spray line from its nano piece (the simulation asks its QueryNanoPiece script) to the job.
 */

interface Drawn {
  /** Carries the unit's position and heading; the model's root piece inside it is posed by scripts. */
  holder: THREE.Group;
  /** Last tick the viewer could see this unit. */
  seenTick: number;
  model: UnitModel;
  ring: THREE.Mesh;
  /** Whether the model currently wears the under-construction material. */
  nano: boolean;
  /** Pieces blown off (drawn as debris instead). */
  blown: Set<string>;
}

const MAX_SPRAYS = 256;
/** How long (ticks) an enemy stays drawn after leaving sight; covers the gap between line-of-sight updates. */
const SIGHT_GRACE_TICKS = 20;

export class UnitRenderer {
  readonly group = new THREE.Group();
  private readonly templates = new Map<string, UnitModel>();
  private readonly drawn = new Map<number, Drawn>();
  private readonly ringGeo = new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2);
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0x55ff55, depthTest: false, transparent: true, opacity: 0.9 });
  private readonly nanoMat = new THREE.MeshBasicMaterial({ color: 0x66ff66, wireframe: true, transparent: true, opacity: 0.55 });
  private readonly sprayPositions = new Float32Array(MAX_SPRAYS * 6);
  private readonly sprayGeo = new THREE.BufferGeometry();
  private readonly sprayMat = new THREE.LineBasicMaterial({ color: 0x77ff77, transparent: true, opacity: 0.8 });
  private readonly sprays: THREE.LineSegments;

  constructor(
    private readonly lib: TextureLibrary,
    private readonly palette: Palette,
    private readonly assetsFor: (unit: SimUnit) => UnitAssets | undefined,
    private readonly teamOf: (owner: number) => number,
  ) {
    this.group.name = 'units';
    this.sprayGeo.setAttribute('position', new THREE.BufferAttribute(this.sprayPositions, 3));
    this.sprays = new THREE.LineSegments(this.sprayGeo, this.sprayMat);
    this.sprays.frustumCulled = false;
    this.group.add(this.sprays);
  }

  /** Syncs drawn units with the world. `alpha` (0-1) is how far we are between the last tick and the next. */
  /** The live mesh of one piece of a drawn unit (for blowing it off when the unit dies). */
  pieceMesh(unitId: number, piece: string): THREE.Mesh | undefined {
    const g = this.drawn.get(unitId)?.model.pieces.get(piece.toLowerCase());
    return g?.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh && c.visible);
  }

  /** Stops drawing a piece on a unit (it flew off as debris). */
  markBlown(unitId: number, piece: string): void {
    this.drawn.get(unitId)?.blown.add(piece.toLowerCase());
  }

  /** Units of other players are only drawn while `viewer` can see them. */
  viewer: number | undefined;

  update(world: World, alpha: number, selected: ReadonlySet<number>): void {
    for (const [id, d] of this.drawn) {
      if (!world.units.has(id)) {
        this.group.remove(d.holder, d.ring);
        this.drawn.delete(id);
      }
    }
    for (const u of world.units.values()) {
      let d = this.drawn.get(u.id);
      if (!d) {
        const made = this.create(u);
        if (!made) continue;
        d = made;
        this.drawn.set(u.id, d);
        this.group.add(d.holder, d.ring);
      }
      // Line of sight is only recomputed a couple of times a second, so a fast enemy can briefly drive
      // into ground that hasn't been marked as seen yet. Keep showing a unit for a moment after it was
      // last in sight, so it doesn't flicker in and out.
      const inSight = this.viewer === undefined || u.owner === this.viewer || (world.visibility.at(this.viewer, u.x, u.z) & 1) !== 0;
      if (inSight) d.seenTick = world.tickCount;
      const visible = inSight || world.tickCount - d.seenTick <= SIGHT_GRACE_TICKS;
      d.holder.visible = visible;
      if (!visible) {
        d.ring.visible = false;
        continue;
      }
      const x = u.prevX + (u.x - u.prevX) * alpha;
      const y = u.prevY + (u.y - u.prevY) * alpha;
      const z = u.prevZ + (u.z - u.prevZ) * alpha;
      d.holder.position.set(x, y, z);
      d.holder.rotation.y = angleToRadians(lerpAngle(u.prevRotation, u.rotation, alpha));
      if (u.scripts) applyPose(d.model, u.scripts.pieces, d.blown);
      const building = !world.isFinished(u);
      if (building !== d.nano) this.setNano(d, building);
      d.ring.visible = selected.has(u.id);
      if (d.ring.visible) d.ring.position.set(x, y + 1, z);
    }
    this.updateSprays(world);
  }

  private setNano(d: Drawn, on: boolean): void {
    d.nano = on;
    d.model.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (on) {
        o.userData.material ??= o.material;
        o.material = this.nanoMat;
      } else if (o.userData.material) {
        o.material = o.userData.material as THREE.Material | THREE.Material[];
      }
    });
  }

  /** Green spray lines from each working builder's nano piece to what it is working on. */
  private updateSprays(world: World): void {
    let n = 0;
    const from = new THREE.Vector3();
    for (const u of world.units.values()) {
      if (!u.nanoTarget || n >= MAX_SPRAYS) continue;
      const d = this.drawn.get(u.id);
      if (!d) continue;
      const piece = u.nanoPiece ? d.model.pieces.get(u.nanoPiece.toLowerCase()) : undefined;
      if (piece) {
        d.holder.updateWorldMatrix(true, true);
        piece.getWorldPosition(from);
      } else {
        from.set(u.x, u.y + 16, u.z);
      }
      // A little jitter at the far end makes the spray shimmer.
      const t = u.nanoTarget;
      const j = () => (Math.random() - 0.5) * 10;
      this.sprayPositions.set([from.x, from.y, from.z, t.x + j(), t.y + j() * 0.5, t.z + j()], n * 6);
      n++;
    }
    this.sprayGeo.setDrawRange(0, n * 2);
    (this.sprayGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.sprays.visible = n > 0;
  }

  private create(u: SimUnit): Drawn | undefined {
    const assets = this.assetsFor(u);
    if (!assets?.model) return undefined;
    const team = this.teamOf(u.owner);
    const key = `${u.def.unitName}#${team}`;
    let template = this.templates.get(key);
    if (!template) {
      template = createUnitModel(assets.model, this.lib, this.palette, team);
      this.templates.set(key, template);
    }
    const ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    const r = (Math.max(u.def.footprintX, u.def.footprintZ) * 16) / 2 + 4;
    ring.scale.set(r, 1, r);
    ring.renderOrder = 2;
    const model = cloneModel(template);
    const holder = new THREE.Group();
    holder.add(model.root);
    return { holder, model, ring, nano: false, blown: new Set(), seenTick: -Infinity };
  }

  dispose(): void {
    this.templates.forEach((t) => t.dispose());
    this.templates.clear();
    this.drawn.clear();
    this.group.clear();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.nanoMat.dispose();
    this.sprayGeo.dispose();
    this.sprayMat.dispose();
  }
}

/** A copy of a model that shares geometry and materials but can be posed on its own. */
function cloneModel(template: UnitModel): UnitModel {
  const root = template.root.clone(true);
  const pieces = new Map<string, THREE.Group>();
  root.traverse((o) => {
    if (o instanceof THREE.Group && o.userData.rest && !pieces.has(o.name.toLowerCase())) pieces.set(o.name.toLowerCase(), o);
  });
  return {
    root,
    pieces,
    missingTextures: template.missingTextures,
    setTeam: () => {},
    dispose: () => {},
  };
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % ANGLE_FULL_TURN;
  if (d > ANGLE_FULL_TURN / 2) d -= ANGLE_FULL_TURN;
  if (d < -ANGLE_FULL_TURN / 2) d += ANGLE_FULL_TURN;
  return a + d * t;
}
