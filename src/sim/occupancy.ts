/*
 * Which height cells are taken (RWE's OccupiedGrid). A cell can hold a mobile unit, a building and a
 * feature at once, tracked separately:
 *   - mobile units and blocking features always block;
 *   - building cells block unless their yard-map letter makes them passable (e.g. a factory's yard while
 *     it is open), so units can be built inside a factory and drive out.
 */
export class Occupancy {
  /** Mobile unit id per cell, 0 for none. */
  readonly mobile: Int32Array;
  /** Building unit id per cell, 0 for none. */
  readonly buildings: Int32Array;
  /** 1 where a building cell is currently passable. */
  readonly passable: Uint8Array;
  /** Blocking feature id + 1 per cell, 0 for none. */
  readonly features: Int32Array;
  /** Bumped whenever buildings or features change, so cached path grids know to rebuild. */
  version = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const n = width * height;
    this.mobile = new Int32Array(n);
    this.buildings = new Int32Array(n);
    this.passable = new Uint8Array(n);
    this.features = new Int32Array(n);
  }

  inBounds(x: number, z: number, w: number, h: number): boolean {
    return x >= 0 && z >= 0 && x + w <= this.width && z + h <= this.height;
  }

  /**
   * True if any cell in the rectangle is blocked for unit `self` (out of bounds counts as blocked).
   * Cells of building `ignoreBuilding` don't count (a new unit driving out of its factory).
   */
  blocked(x: number, z: number, w: number, h: number, self = 0, ignoreBuilding = 0): boolean {
    if (!this.inBounds(x, z, w, h)) return true;
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const i = (z + dz) * this.width + x + dx;
        if (this.features[i]) return true;
        const m = this.mobile[i]!;
        if (m !== 0 && m !== self) return true;
        const b = this.buildings[i]!;
        if (b !== 0 && b !== self && b !== ignoreBuilding && !this.passable[i]) return true;
      }
    }
    return false;
  }

  /** True if a blocking feature or a solid building cell is in the rectangle (ignores mobile units). */
  staticBlocked(x: number, z: number, w: number, h: number): boolean {
    if (!this.inBounds(x, z, w, h)) return true;
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const i = (z + dz) * this.width + x + dx;
        if (this.features[i] || (this.buildings[i] && !this.passable[i])) return true;
      }
    }
    return false;
  }

  /** The first mobile unit other than `self` found in the rectangle, or 0. */
  firstUnit(x: number, z: number, w: number, h: number, self = 0): number {
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.height) continue;
        const u = this.mobile[cz * this.width + cx]!;
        if (u !== 0 && u !== self) return u;
      }
    }
    return 0;
  }

  setUnit(x: number, z: number, w: number, h: number, id: number): void {
    this.each(x, z, w, h, (i) => (this.mobile[i] = id));
  }

  clearUnit(x: number, z: number, w: number, h: number, id: number): void {
    this.each(x, z, w, h, (i) => {
      if (this.mobile[i] === id) this.mobile[i] = 0;
    });
  }

  /** Marks a building's footprint; `passableAt(dx, dz)` says which of its cells can be driven over. */
  setBuilding(x: number, z: number, w: number, h: number, id: number, passableAt: (dx: number, dz: number) => boolean): void {
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.height) continue;
        const i = cz * this.width + cx;
        this.buildings[i] = id;
        this.passable[i] = passableAt(dx, dz) ? 1 : 0;
      }
    }
    this.version++;
  }

  clearBuilding(x: number, z: number, w: number, h: number, id: number): void {
    this.each(x, z, w, h, (i) => {
      if (this.buildings[i] === id) {
        this.buildings[i] = 0;
        this.passable[i] = 0;
      }
    });
    this.version++;
  }

  setFeature(x: number, z: number, w: number, h: number, featureId: number): void {
    this.each(x, z, w, h, (i) => (this.features[i] = featureId + 1));
    this.version++;
  }

  clearFeature(x: number, z: number, w: number, h: number, featureId: number): void {
    this.each(x, z, w, h, (i) => {
      if (this.features[i] === featureId + 1) this.features[i] = 0;
    });
    this.version++;
  }

  private each(x: number, z: number, w: number, h: number, fn: (i: number) => void): void {
    for (let dz = 0; dz < h; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        if (cx >= 0 && cz >= 0 && cx < this.width && cz < this.height) fn(cz * this.width + cx);
      }
    }
  }
}

/**
 * Yard-map letters (per RWE's parseYardMapCell): whether a building cell can be driven over, given
 * whether the yard is open. 'c', 'C', 'g' pass when open, 'O' when closed, 'y', 'Y', '.' always.
 */
export function yardCellPassable(letter: string | undefined, yardOpen: boolean): boolean {
  switch (letter) {
    case 'c':
    case 'C':
    case 'g':
      return yardOpen;
    case 'O':
      return !yardOpen;
    case 'y':
    case 'Y':
    case '.':
      return true;
    default:
      return false;
  }
}
