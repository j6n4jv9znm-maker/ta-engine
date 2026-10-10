import { latin1 } from '../formats/hpi';
import { parseOta, type OtaInfo } from '../formats/ota';
import { parseTdf } from '../formats/tdf';
import { CELL_SIZE, featurePlacements, parseTnt, type TntMap } from '../formats/tnt';
import type { Vfs } from '../vfs';
import type { FeatureDef } from './features';

/*
 * A loaded map: terrain, settings and placed features, independent of any renderer (the simulation will
 * use the same data later). World units are TA pixels with the origin at the map's top-left corner:
 * x grows east, z grows south, y is height (0-255). One height cell is 16 units, one tile 32.
 */

export interface PlacedFeature {
  def: FeatureDef;
  /** Top-left height cell. */
  cellX: number;
  cellZ: number;
  /** Centre of the footprint on the ground, in world units. */
  x: number;
  y: number;
  z: number;
}

export interface GameMap {
  name: string;
  tnt: TntMap;
  ota: OtaInfo | undefined;
  features: PlacedFeature[];
  /** Feature names the map uses that have no definition. */
  unknownFeatures: string[];
  /** Map size in world units. */
  widthUnits: number;
  heightUnits: number;
}

/** Map names (without folder or extension) for every maps/*.tnt. */
export function listMaps(vfs: Vfs): string[] {
  return vfs.listDir('maps', '.tnt').map((f) => f.path.slice(f.path.indexOf('/') + 1, -4));
}

export async function loadGameMap(vfs: Vfs, name: string, featureDefs: Map<string, FeatureDef>): Promise<GameMap> {
  const tnt = parseTnt(await vfs.read(`maps/${name}.tnt`));
  const otaPath = `maps/${name}.ota`;
  const ota = vfs.exists(otaPath) ? parseOta(parseTdf(latin1(await vfs.read(otaPath)))) : undefined;

  const placements = featurePlacements(tnt);
  // Schema 0 can add more features (positions in height cells), as RWE does.
  for (const f of ota?.schemas[0]?.features ?? []) placements.push({ x: f.x, z: f.z, name: f.name });

  const features: PlacedFeature[] = [];
  const unknown = new Set<string>();
  for (const p of placements) {
    const def = featureDefs.get(p.name.toLowerCase());
    if (!def) {
      unknown.add(p.name);
      continue;
    }
    features.push({
      def,
      cellX: p.x,
      cellZ: p.z,
      x: p.x * CELL_SIZE + (def.footprintX * CELL_SIZE) / 2,
      y: midpointHeight(tnt, p.x, p.z),
      z: p.z * CELL_SIZE + (def.footprintZ * CELL_SIZE) / 2,
    });
  }

  return {
    name,
    tnt,
    ota,
    features,
    unknownFeatures: [...unknown],
    widthUnits: tnt.width * CELL_SIZE,
    heightUnits: tnt.height * CELL_SIZE,
  };
}

/** Average of a cell's four corner heights, like RWE's computeMidpointHeight. */
export function midpointHeight(tnt: TntMap, x: number, z: number): number {
  if (x < 0 || z < 0 || x >= tnt.width - 1 || z >= tnt.height - 1) return 0;
  const h = (cx: number, cz: number) => tnt.heights[cz * tnt.width + cx]!;
  return Math.floor((h(x, z) + h(x + 1, z) + h(x, z + 1) + h(x + 1, z + 1)) / 4);
}

/** Ground height at any world position, interpolated across the cell (0 outside the map). */
export function heightAt(tnt: TntMap, x: number, z: number): number {
  const fx = x / CELL_SIZE;
  const fz = z / CELL_SIZE;
  const cx = Math.floor(fx);
  const cz = Math.floor(fz);
  if (cx < 0 || cz < 0 || cx >= tnt.width - 1 || cz >= tnt.height - 1) return 0;
  const tx = fx - cx;
  const tz = fz - cz;
  const h = (ax: number, az: number) => tnt.heights[az * tnt.width + ax]!;
  const top = h(cx, cz) * (1 - tx) + h(cx + 1, cz) * tx;
  const bottom = h(cx, cz + 1) * (1 - tx) + h(cx + 1, cz + 1) * tx;
  return top * (1 - tz) + bottom * tz;
}
