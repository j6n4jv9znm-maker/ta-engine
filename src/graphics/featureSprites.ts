import * as THREE from 'three';
import { frameToRgba, parseGaf, type GafEntry, type GafFrame } from '../formats/gaf';
import type { Palette } from '../formats/palette';
import { isStanding } from '../map/features';
import type { PlacedFeature } from '../map/mapData';
import type { Vfs } from '../vfs';

/*
 * Draws sprite features (trees, rocks, ...) as textured quads, all in two draw calls: one for shadows
 * and one for the sprites themselves. Every distinct frame used on the map is packed into one atlas.
 *
 * Placement follows RWE (GameScene_util.cpp drawFeature): the frame's origin sits on the feature's
 * position. Features at least STANDING_FEATURE_MIN_HEIGHT tall stand upright, facing the default camera
 * (+z), with sprite pixels stretched 2x vertically to undo TA's half-height view. Shorter features lie
 * flat on the ground. Only frame 0 is drawn; animated features come later.
 */

export interface FeatureSprites {
  group: THREE.Group;
  /** Features whose sprite could not be found. */
  missing: string[];
  dispose(): void;
}

interface Placed {
  frame: GafFrame;
  feature: PlacedFeature;
  shadow: boolean;
}

export async function createFeatureSprites(vfs: Vfs, palette: Palette, features: PlacedFeature[]): Promise<FeatureSprites> {
  const gafs = new Map<string, GafEntry[] | null>();
  const getEntry = async (file: string, seq: string): Promise<GafEntry | undefined> => {
    const key = file.toLowerCase();
    if (!gafs.has(key)) {
      const path = `anims/${file}.gaf`;
      gafs.set(key, vfs.exists(path) ? parseGaf(await vfs.read(path)) : null);
    }
    const lower = seq.toLowerCase();
    return gafs.get(key)?.find((e) => e.name.toLowerCase() === lower);
  };

  const placed: Placed[] = [];
  const missing = new Set<string>();
  for (const f of features) {
    if (f.def.object) continue; // drawn as a 3D model elsewhere
    if (!f.def.fileName || !f.def.seqName) continue;
    const main = (await getEntry(f.def.fileName, f.def.seqName))?.frames[0];
    if (!main) {
      missing.add(f.def.name);
      continue;
    }
    if (f.def.seqNameShadow) {
      const shadow = (await getEntry(f.def.fileName, f.def.seqNameShadow))?.frames[0];
      if (shadow) placed.push({ frame: shadow, feature: f, shadow: true });
    }
    placed.push({ frame: main, feature: f, shadow: false });
  }

  // Pack each distinct frame once (shelf packing, 2048 wide).
  const ATLAS_W = 2048;
  const slots = new Map<GafFrame, { x: number; y: number }>();
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const p of placed) {
    if (slots.has(p.frame)) continue;
    const { width: w, height: h } = p.frame;
    if (cx + w > ATLAS_W) {
      cx = 0;
      cy += rowH + 1;
      rowH = 0;
    }
    slots.set(p.frame, { x: cx, y: cy });
    cx += w + 1;
    rowH = Math.max(rowH, h);
  }
  const atlasH = Math.max(1, cy + rowH);
  const atlas = new Uint8Array(ATLAS_W * atlasH * 4);
  for (const [frame, s] of slots) {
    const rgba = frameToRgba(frame, palette);
    for (let y = 0; y < frame.height; y++) {
      atlas.set(rgba.subarray(y * frame.width * 4, (y + 1) * frame.width * 4), ((s.y + y) * ATLAS_W + s.x) * 4);
    }
  }
  const tex = new THREE.DataTexture(atlas, ATLAS_W, atlasH, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;

  const build = (items: Placed[]) => {
    const pos: number[] = [];
    const uv: number[] = [];
    for (const { frame, feature } of items) {
      const s = slots.get(frame)!;
      const standing = isStanding(feature.def);
      // Sprite pixel (px, py) -> world, relative to the feature position.
      const corner = (px: number, py: number) => {
        const dx = px - frame.x;
        const dy = py - frame.y;
        return standing
          ? [feature.x + dx, feature.y - 2 * dy, feature.z]
          : [feature.x + dx, feature.y + 0.5, feature.z + dy];
      };
      const u0 = s.x / ATLAS_W;
      const u1 = (s.x + frame.width) / ATLAS_W;
      const v0 = s.y / atlasH;
      const v1 = (s.y + frame.height) / atlasH;
      const tl = corner(0, 0);
      const tr = corner(frame.width, 0);
      const bl = corner(0, frame.height);
      const br = corner(frame.width, frame.height);
      pos.push(...tl, ...bl, ...tr, ...tr, ...bl, ...br);
      uv.push(u0, v0, u0, v1, u1, v0, u1, v0, u0, v1, u1, v1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  };

  const spriteGeo = build(placed.filter((p) => !p.shadow));
  const shadowGeo = build(placed.filter((p) => p.shadow));
  const spriteMat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
  const shadowMat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const group = new THREE.Group();
  group.name = 'feature-sprites';
  const shadows = new THREE.Mesh(shadowGeo, shadowMat);
  shadows.renderOrder = 1;
  group.add(shadows, new THREE.Mesh(spriteGeo, spriteMat));

  return {
    group,
    missing: [...missing],
    dispose() {
      spriteGeo.dispose();
      shadowGeo.dispose();
      spriteMat.dispose();
      shadowMat.dispose();
      tex.dispose();
    },
  };
}
