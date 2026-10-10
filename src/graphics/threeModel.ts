import * as THREE from 'three';
import type { ModelPiece } from '../formats/3do';
import type { Palette } from '../formats/palette';
import { buildPieceGeometry } from './pieceGeometry';
import { findTexture, type TextureLibrary } from './textures';

/*
 * Builds a Three.js object tree for a 3DO model. Each piece becomes a THREE.Group named after the piece
 * and positioned at its offset from the parent, so later phases (unit scripts) can move, turn, show and
 * hide pieces by name. Rendering only: nothing here touches simulation state.
 */

export interface UnitModel {
  root: THREE.Group;
  /** Lowercased piece name -> its group. */
  pieces: Map<string, THREE.Group>;
  /** Swap team colour (0-9) without rebuilding geometry. */
  setTeam(team: number): void;
  dispose(): void;
  /** Texture names the model asks for but the library doesn't have. */
  missingTextures: string[];
}

export function createUnitModel(root: ModelPiece, lib: TextureLibrary, palette: Palette, team = 0): UnitModel {
  const textureCache = new Map<string, THREE.DataTexture>();
  const materials = new Map<string, THREE.MeshLambertMaterial>();
  const missing = new Set<string>();
  const colorMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  const geometries: THREE.BufferGeometry[] = [];

  const textureFor = (name: string, t: number): THREE.DataTexture | undefined => {
    const isTeam = lib.teamTextures.has(name);
    const key = isTeam ? `${name}#${t}` : name;
    let tex = textureCache.get(key);
    if (!tex) {
      const img = findTexture(lib, name, t);
      if (!img) return undefined;
      tex = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      textureCache.set(key, tex);
    }
    return tex;
  };

  const materialFor = (name: string): THREE.Material => {
    let m = materials.get(name);
    if (!m) {
      const map = textureFor(name, team);
      if (!map) {
        missing.add(name);
        return colorMaterial;
      }
      m = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5 });
      materials.set(name, m);
    }
    return m;
  };

  const pieces = new Map<string, THREE.Group>();
  const build = (piece: ModelPiece): THREE.Group => {
    const g = new THREE.Group();
    g.name = piece.name;
    g.position.set(...piece.offset);
    g.userData.rest = [...piece.offset];
    // A few models repeat a piece name; lookups get the first one.
    if (!pieces.has(piece.name.toLowerCase())) pieces.set(piece.name.toLowerCase(), g);

    const geo = buildPieceGeometry(piece, palette);
    if (geo.positions.length > 0) {
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(geo.positions, 3));
      bg.setAttribute('uv', new THREE.BufferAttribute(geo.uvs, 2));
      bg.setAttribute('color', new THREE.BufferAttribute(geo.colors, 3));
      bg.computeVertexNormals();
      const mats: THREE.Material[] = [];
      geo.groups.forEach((grp, i) => {
        bg.addGroup(grp.start, grp.count, i);
        mats.push(grp.texture === null ? colorMaterial : materialFor(grp.texture));
      });
      geometries.push(bg);
      const mesh = new THREE.Mesh(bg, mats);
      mesh.name = `${piece.name}:mesh`;
      g.add(mesh);
    }
    for (const c of piece.children) g.add(build(c));
    return g;
  };

  const rootGroup = build(root);

  return {
    root: rootGroup,
    pieces,
    missingTextures: [...missing],
    setTeam(t: number) {
      for (const [name, m] of materials) {
        if (lib.teamTextures.has(name)) {
          m.map = textureFor(name, t) ?? m.map;
          m.needsUpdate = true;
        }
      }
    },
    dispose() {
      geometries.forEach((g) => g.dispose());
      textureCache.forEach((t) => t.dispose());
      materials.forEach((m) => m.dispose());
      colorMaterial.dispose();
    },
  };
}
