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
 */

interface Drawn {
  model: UnitModel;
  ring: THREE.Mesh;
}

export class UnitRenderer {
  readonly group = new THREE.Group();
  private readonly templates = new Map<string, UnitModel>();
  private readonly drawn = new Map<number, Drawn>();
  private readonly ringGeo = new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2);
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: 0x55ff55, depthTest: false, transparent: true, opacity: 0.9 });

  constructor(
    private readonly lib: TextureLibrary,
    private readonly palette: Palette,
    private readonly assetsFor: (unit: SimUnit) => UnitAssets | undefined,
    private readonly teamOf: (owner: number) => number,
  ) {
    this.group.name = 'units';
  }

  /** Syncs drawn units with the world. `alpha` (0-1) is how far we are between the last tick and the next. */
  update(world: World, alpha: number, selected: ReadonlySet<number>): void {
    for (const [id, d] of this.drawn) {
      if (!world.units.has(id)) {
        this.group.remove(d.model.root, d.ring);
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
        this.group.add(d.model.root, d.ring);
      }
      const x = u.prevX + (u.x - u.prevX) * alpha;
      const y = u.prevY + (u.y - u.prevY) * alpha;
      const z = u.prevZ + (u.z - u.prevZ) * alpha;
      d.model.root.position.set(x, y, z);
      d.model.root.rotation.y = angleToRadians(lerpAngle(u.prevRotation, u.rotation, alpha));
      if (u.scripts) applyPose(d.model, u.scripts.pieces);
      d.ring.visible = selected.has(u.id);
      if (d.ring.visible) d.ring.position.set(x, y + 1, z);
    }
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
    return { model: cloneModel(template), ring };
  }

  dispose(): void {
    this.templates.forEach((t) => t.dispose());
    this.templates.clear();
    this.drawn.clear();
    this.group.clear();
    this.ringGeo.dispose();
    this.ringMat.dispose();
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
