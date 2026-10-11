import * as THREE from 'three';
import type { Palette } from '../formats/palette';
import { CELL_SIZE, TILE_SIZE, type TntMap } from '../formats/tnt';

/*
 * Terrain mesh. Geometry is the height grid (one vertex per 16-unit cell corner). Texturing is done in a
 * shader so even the largest maps (640x640 tiles, 20480 pixels across) need no giant texture:
 *   - an atlas of the map's unique 32x32 tiles, stored as palette indices (one byte per pixel);
 *   - a small texture holding each map tile's tile number;
 *   - the 256-colour palette.
 *
 * TA's tile art is drawn for its tilted view, where something at height h appears h/2 pixels higher on
 * screen (RWE renders with the same 0.5 cabinet factor). So the art pixel for ground point (x, z, h) is
 * (x, z - h/2), and that's what we sample. From the default camera this lines the art up with the hills.
 * Water is drawn at sea level (the tile art already shows it).
 */

const ATLAS_TILES_PER_ROW = 64;

const vertexShader = /* glsl */ `
  attribute vec2 artPos;
  varying vec2 vArt;
  varying vec2 vGround;
  void main() {
    vArt = artPos;
    vGround = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;
  uniform sampler2D tileIndex;   // RG8: tile number = r + g*256
  uniform sampler2D atlas;       // R8: palette indices
  uniform sampler2D palette;     // 256x1 RGBA
  uniform vec2 mapTiles;         // tiles wide, tiles high
  uniform float atlasPerRow;
  uniform sampler2D fog;         // R8 per fog tile: 1 = in sight, 0.5 = explored, lower = never seen
  uniform vec2 fogSize;          // fog grid size in world units (0 = no fog)
  varying vec2 vArt;
  varying vec2 vGround;
  void main() {
    // High ground near the top edge looks up art from above the map: there is none, so draw black.
    if (vArt.y < 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec2 p = clamp(vArt, vec2(0.0), mapTiles * ${TILE_SIZE}.0 - 0.001);
    ivec2 tile = ivec2(floor(p / ${TILE_SIZE}.0));
    vec2 rg = texelFetch(tileIndex, tile, 0).rg * 255.0;
    int t = int(rg.r + 0.5) + int(rg.g + 0.5) * 256;
    int perRow = int(atlasPerRow);
    ivec2 inTile = ivec2(mod(p, ${TILE_SIZE}.0));
    ivec2 texel = ivec2((t - (t / perRow) * perRow) * ${TILE_SIZE}, (t / perRow) * ${TILE_SIZE}) + inTile;
    float idx = texelFetch(atlas, texel, 0).r * 255.0;
    gl_FragColor = texelFetch(palette, ivec2(int(idx + 0.5), 0), 0);
    if (fogSize.x > 0.0) gl_FragColor.rgb *= texture2D(fog, vGround / fogSize).r;
    #include <colorspace_fragment>
  }
`;

export interface Terrain {
  mesh: THREE.Mesh;
  /**
   * Darkens what the player can't see: `brightness` holds one value (0-255) per fog tile of
   * `tileSize` world units, row by row. Pass undefined to turn fog off.
   */
  setFog(brightness: Uint8Array | undefined, columns: number, rows: number, tileSize: number): void;
  dispose(): void;
}

export function createTerrain(tnt: TntMap, palette: Palette): Terrain {
  // --- textures
  const rows = Math.ceil(tnt.tileCount / ATLAS_TILES_PER_ROW);
  const atlasW = ATLAS_TILES_PER_ROW * TILE_SIZE;
  const atlasH = rows * TILE_SIZE;
  const atlasData = new Uint8Array(atlasW * atlasH);
  for (let t = 0; t < tnt.tileCount; t++) {
    const ox = (t % ATLAS_TILES_PER_ROW) * TILE_SIZE;
    const oy = Math.floor(t / ATLAS_TILES_PER_ROW) * TILE_SIZE;
    for (let y = 0; y < TILE_SIZE; y++) {
      const src = t * TILE_SIZE * TILE_SIZE + y * TILE_SIZE;
      atlasData.set(tnt.tiles.subarray(src, src + TILE_SIZE), (oy + y) * atlasW + ox);
    }
  }
  const atlas = dataTexture(atlasData, atlasW, atlasH, THREE.RedFormat);

  const idxData = new Uint8Array(tnt.tilesWide * tnt.tilesHigh * 2);
  for (let i = 0; i < tnt.tileIndices.length; i++) {
    idxData[i * 2] = tnt.tileIndices[i]! & 0xff;
    idxData[i * 2 + 1] = tnt.tileIndices[i]! >> 8;
  }
  const tileIndex = dataTexture(idxData, tnt.tilesWide, tnt.tilesHigh, THREE.RGFormat);
  const paletteTex = dataTexture(new Uint8Array(palette.rgba), 256, 1, THREE.RGBAFormat);
  paletteTex.colorSpace = THREE.SRGBColorSpace;

  // --- geometry: (width) x (height) vertices; the last row/column repeat the edge heights
  const w = tnt.width;
  const h = tnt.height;
  const positions = new Float32Array(w * h * 3);
  const art = new Float32Array(w * h * 2);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      const y = Math.max(tnt.heights[i]!, tnt.seaLevel);
      positions.set([x * CELL_SIZE, y, z * CELL_SIZE], i * 3);
      art.set([x * CELL_SIZE, z * CELL_SIZE - y / 2], i * 2);
    }
  }
  const index = new Uint32Array((w - 1) * (h - 1) * 6);
  let k = 0;
  for (let z = 0; z < h - 1; z++) {
    for (let x = 0; x < w - 1; x++) {
      const a = z * w + x;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      index.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('artPos', new THREE.BufferAttribute(art, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      tileIndex: { value: tileIndex },
      atlas: { value: atlas },
      palette: { value: paletteTex },
      mapTiles: { value: new THREE.Vector2(tnt.tilesWide, tnt.tilesHigh) },
      atlasPerRow: { value: ATLAS_TILES_PER_ROW },
      fog: { value: null as THREE.DataTexture | null },
      fogSize: { value: new THREE.Vector2(0, 0) },
    },
  });
  let fogTex: THREE.DataTexture | undefined;
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'terrain';
  return {
    mesh,
    setFog(brightness, columns, rows, tileSize) {
      if (!brightness) {
        material.uniforms.fogSize!.value.set(0, 0);
        return;
      }
      if (!fogTex || fogTex.image.width !== columns || fogTex.image.height !== rows) {
        fogTex?.dispose();
        fogTex = new THREE.DataTexture(new Uint8Array(columns * rows), columns, rows, THREE.RedFormat, THREE.UnsignedByteType);
        fogTex.magFilter = THREE.LinearFilter;
        fogTex.minFilter = THREE.LinearFilter;
        fogTex.unpackAlignment = 1;
        material.uniforms.fog!.value = fogTex;
      }
      (fogTex.image.data as Uint8Array).set(brightness);
      fogTex.needsUpdate = true;
      material.uniforms.fogSize!.value.set(columns * tileSize, rows * tileSize);
    },
    dispose() {
      fogTex?.dispose();
      geo.dispose();
      material.dispose();
      atlas.dispose();
      tileIndex.dispose();
      paletteTex.dispose();
    },
  };
}

function dataTexture(data: Uint8Array<ArrayBuffer>, w: number, h: number, format: THREE.PixelFormat): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}
