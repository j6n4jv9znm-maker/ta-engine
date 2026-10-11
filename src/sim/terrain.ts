import { CELL_SIZE, type TntMap } from '../formats/tnt';
import type { MovementClass } from './unitDef';

/*
 * Terrain rules for movement, following RWE (src/rwe/sim/movement.cpp):
 *   - a cell's slope is the height difference across its four corners;
 *   - a unit fits at a cell if, over its whole footprint, no slope exceeds its limit (the water limit
 *     applies when any corner is under water) and the water depth stays within its min/max.
 * Grids are indexed by height cell, with a footprint's top-left cell as the unit's grid position.
 */

export class SimTerrain {
  readonly width: number;
  readonly height: number;
  readonly seaLevel: number;
  private readonly walkable = new Map<string, Uint8Array>();

  constructor(readonly tnt: TntMap) {
    this.width = tnt.width;
    this.height = tnt.height;
    this.seaLevel = tnt.seaLevel;
  }

  h(x: number, z: number): number {
    return this.tnt.heights[z * this.width + x]!;
  }

  slope(x: number, z: number): number {
    const a = this.h(x, z);
    const b = this.h(x + 1, z);
    const c = this.h(x, z + 1);
    const d = this.h(x + 1, z + 1);
    return Math.max(a, b, c, d) - Math.min(a, b, c, d);
  }

  waterDepth(x: number, z: number): number {
    const h = this.h(x, z);
    return h < this.seaLevel ? this.seaLevel - h : 0;
  }

  /** Whether a unit with movement limits `mc` fits with its footprint's top-left at cell (x, z). */
  fits(mc: MovementClass, x: number, z: number): boolean {
    if (x < 0 || z < 0 || x + mc.footprintX >= this.width || z + mc.footprintZ >= this.height) return false;
    let underWater = false;
    for (let dz = 0; dz <= mc.footprintZ && !underWater; dz++) {
      for (let dx = 0; dx <= mc.footprintX; dx++) {
        if (this.h(x + dx, z + dz) < this.seaLevel) {
          underWater = true;
          break;
        }
      }
    }
    const maxSlope = underWater ? mc.maxWaterSlope : mc.maxSlope;
    for (let dz = 0; dz < mc.footprintZ; dz++) {
      for (let dx = 0; dx < mc.footprintX; dx++) {
        if (this.slope(x + dx, z + dz) > maxSlope) return false;
        const depth = this.waterDepth(x + dx, z + dz);
        if (depth < mc.minWaterDepth || depth > mc.maxWaterDepth) return false;
      }
    }
    return true;
  }

  /** Precomputed `fits` for every cell, cached per movement class (RWE's walkable grids). */
  walkableGrid(mc: MovementClass): Uint8Array {
    const key = `${mc.name}|${mc.footprintX}|${mc.footprintZ}|${mc.minWaterDepth}|${mc.maxWaterDepth}|${mc.maxSlope}|${mc.maxWaterSlope}`;
    let g = this.walkable.get(key);
    if (!g) {
      g = new Uint8Array(this.width * this.height);
      for (let z = 0; z < this.height; z++) for (let x = 0; x < this.width; x++) g[z * this.width + x] = this.fits(mc, x, z) ? 1 : 0;
      this.walkable.set(key, g);
    }
    return g;
  }

  /** Ground height at a world position, interpolated within the cell. */
  heightAt(x: number, z: number): number {
    const fx = x / CELL_SIZE;
    const fz = z / CELL_SIZE;
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    if (cx < 0 || cz < 0 || cx >= this.width - 1 || cz >= this.height - 1) return 0;
    const tx = fx - cx;
    const tz = fz - cz;
    const top = this.h(cx, cz) * (1 - tx) + this.h(cx + 1, cz) * tx;
    const bottom = this.h(cx, cz + 1) * (1 - tx) + this.h(cx + 1, cz + 1) * tx;
    return top * (1 - tz) + bottom * tz;
  }

  /** Top-left cell of a footprint centred on a world position (rounded to the nearest cell, like RWE). */
  footprintCell(x: number, z: number, footprintX: number, footprintZ: number): [number, number] {
    return [Math.round((x - (footprintX * CELL_SIZE) / 2) / CELL_SIZE), Math.round((z - (footprintZ * CELL_SIZE) / 2) / CELL_SIZE)];
  }

  /** World position of a footprint's centre given its top-left cell. */
  cellCenter(cx: number, cz: number, footprintX: number, footprintZ: number): [number, number] {
    return [(cx + footprintX / 2) * CELL_SIZE, (cz + footprintZ / 2) * CELL_SIZE];
  }
}
