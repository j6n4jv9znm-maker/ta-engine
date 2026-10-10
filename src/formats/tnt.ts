import { latin1 } from './hpi';

/*
 * TNT: TA's map file (maps/<name>.tnt). Layout per the community docs and RWE (src/rwe/io/tnt),
 * little-endian. The header is 64 bytes:
 *
 *   version u32 (0x2000), width u32, height u32         width/height in 16-pixel "height cells"
 *   tileIndicesOffset u32   (width/2)*(height/2) u16 tile numbers, one per 32x32-pixel tile
 *   attributesOffset u32    width*height cells of 4 bytes: height u8, feature u16, pad u8
 *   tileGraphicsOffset u32, tileCount u32   tileCount raw 32x32 palette-indexed tiles
 *   featureCount u32, featureNamesOffset u32   featureCount × (index u32, name char[128])
 *   seaLevel u32, minimapOffset u32              minimap: width u32, height u32, pixels
 *
 * A cell's feature value is an index into the feature-name list, or one of the special values below.
 * The minimap is padded with index 0x64 on the right and bottom; we trim that like RWE does.
 */

const TNT_VERSION = 0x2000;
export const FEATURE_NONE = 0xffff;
export const FEATURE_UNKNOWN = 0xfffe;
export const FEATURE_VOID = 0xfffc;
const MINIMAP_VOID = 0x64;
export const TILE_SIZE = 32;
export const CELL_SIZE = 16;

export class TntError extends Error {}

export interface TntMap {
  /** Size in 16-pixel height cells. */
  width: number;
  height: number;
  seaLevel: number;
  /** width*height cell heights (0-255), row-major from the top-left. */
  heights: Uint8Array;
  /** width*height feature values per cell: an index into featureNames or a FEATURE_* constant. */
  features: Uint16Array;
  featureNames: string[];
  /** Size in 32-pixel tiles: (width/2) x (height/2). */
  tilesWide: number;
  tilesHigh: number;
  /** tilesWide*tilesHigh tile numbers into `tiles`. */
  tileIndices: Uint16Array;
  /** tileCount 32x32 palette-indexed tiles, stored back to back (1024 bytes each). */
  tiles: Uint8Array;
  tileCount: number;
  minimap: { width: number; height: number; pixels: Uint8Array };
}

export function parseTnt(bytes: Uint8Array): TntMap {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (at: number, len: number) => {
    if (at < 0 || at + len > bytes.length) throw new TntError(`read of ${len} bytes at ${at} out of range`);
  };
  check(0, 64);
  const u32 = (at: number) => v.getUint32(at, true);
  if (u32(0) !== TNT_VERSION) throw new TntError(`not a TA map (version 0x${u32(0).toString(16)})`);

  const width = u32(4);
  const height = u32(8);
  const tileIndicesOffset = u32(12);
  const attributesOffset = u32(16);
  const tileGraphicsOffset = u32(20);
  const tileCount = u32(24);
  const featureCount = u32(28);
  const featureNamesOffset = u32(32);
  const seaLevel = u32(36);
  const minimapOffset = u32(40);

  const tilesWide = width >> 1;
  const tilesHigh = height >> 1;
  check(tileIndicesOffset, tilesWide * tilesHigh * 2);
  const tileIndices = new Uint16Array(tilesWide * tilesHigh);
  for (let i = 0; i < tileIndices.length; i++) {
    const t = v.getUint16(tileIndicesOffset + i * 2, true);
    if (t >= tileCount) throw new TntError(`tile ${i} refers to tile ${t}, but there are only ${tileCount}`);
    tileIndices[i] = t;
  }

  const cells = width * height;
  check(attributesOffset, cells * 4);
  const heights = new Uint8Array(cells);
  const features = new Uint16Array(cells);
  for (let i = 0; i < cells; i++) {
    heights[i] = bytes[attributesOffset + i * 4]!;
    features[i] = v.getUint16(attributesOffset + i * 4 + 1, true);
  }

  check(tileGraphicsOffset, tileCount * TILE_SIZE * TILE_SIZE);
  const tiles = bytes.slice(tileGraphicsOffset, tileGraphicsOffset + tileCount * TILE_SIZE * TILE_SIZE);

  check(featureNamesOffset, featureCount * 132);
  const featureNames: string[] = [];
  for (let i = 0; i < featureCount; i++) {
    const at = featureNamesOffset + i * 132 + 4;
    let end = at;
    while (end < at + 128 && bytes[end] !== 0) end++;
    featureNames.push(latin1(bytes.subarray(at, end)));
  }

  check(minimapOffset, 8);
  const mmW = u32(minimapOffset);
  const mmH = u32(minimapOffset + 4);
  check(minimapOffset + 8, mmW * mmH);
  const raw = bytes.subarray(minimapOffset + 8, minimapOffset + 8 + mmW * mmH);
  let w = mmW;
  let h = mmH;
  while (w > 0 && raw[w - 1] === MINIMAP_VOID) w--;
  while (h > 0 && raw[(h - 1) * mmW] === MINIMAP_VOID) h--;
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) pixels.set(raw.subarray(y * mmW, y * mmW + w), y * w);

  return {
    width,
    height,
    seaLevel,
    heights,
    features,
    featureNames,
    tilesWide,
    tilesHigh,
    tileIndices,
    tiles,
    tileCount,
    minimap: { width: w, height: h, pixels },
  };
}

/** Feature placements: one per cell whose feature value names a feature (not none/void/unknown). */
export function featurePlacements(map: TntMap): { x: number; z: number; name: string }[] {
  const out: { x: number; z: number; name: string }[] = [];
  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      const f = map.features[z * map.width + x]!;
      const name = map.featureNames[f];
      if (f < FEATURE_VOID && name !== undefined) out.push({ x, z, name });
    }
  }
  return out;
}
