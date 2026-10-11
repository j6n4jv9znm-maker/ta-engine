/*
 * Which height cells are taken, by a unit or a blocking feature (RWE's OccupiedGrid). Units can't move
 * into cells held by another unit or a blocking feature.
 */
export class Occupancy {
  /** Unit id per cell, 0 for none. */
  readonly units: Int32Array;
  /** 1 where a blocking feature sits. */
  readonly features: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.units = new Int32Array(width * height);
    this.features = new Uint8Array(width * height);
  }

  inBounds(x: number, z: number, w: number, h: number): boolean {
    return x >= 0 && z >= 0 && x + w <= this.width && z + h <= this.height;
  }

  /** True if any cell in the rectangle is blocked for unit `self` (out of bounds counts as blocked). */
  blocked(x: number, z: number, w: number, h: number, self = 0): boolean {
    if (!this.inBounds(x, z, w, h)) return true;
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const i = (z + dz) * this.width + x + dx;
        if (this.features[i]) return true;
        const u = this.units[i]!;
        if (u !== 0 && u !== self) return true;
      }
    }
    return false;
  }

  /** True if a blocking feature sits anywhere in the rectangle (ignores units). */
  featureBlocked(x: number, z: number, w: number, h: number): boolean {
    if (!this.inBounds(x, z, w, h)) return true;
    for (let dz = 0; dz < h; dz++) for (let dx = 0; dx < w; dx++) if (this.features[(z + dz) * this.width + x + dx]) return true;
    return false;
  }

  /** The first unit other than `self` found in the rectangle, or 0. */
  firstUnit(x: number, z: number, w: number, h: number, self = 0): number {
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.height) continue;
        const u = this.units[cz * this.width + cx]!;
        if (u !== 0 && u !== self) return u;
      }
    }
    return 0;
  }

  setUnit(x: number, z: number, w: number, h: number, id: number): void {
    this.fill(this.units, x, z, w, h, id);
  }

  clearUnit(x: number, z: number, w: number, h: number, id: number): void {
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.height) continue;
        const i = cz * this.width + cx;
        if (this.units[i] === id) this.units[i] = 0;
      }
    }
  }

  setFeature(x: number, z: number, w: number, h: number): void {
    this.fill(this.features, x, z, w, h, 1);
  }

  private fill(arr: Int32Array | Uint8Array, x: number, z: number, w: number, h: number, v: number): void {
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        if (cx >= 0 && cz >= 0 && cx < this.width && cz < this.height) arr[cz * this.width + cx] = v;
      }
    }
  }
}
