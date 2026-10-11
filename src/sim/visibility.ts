/*
 * Line of sight and radar per player, on a grid of 32-unit tiles. Every half second each player's
 * finished units mark the tiles within their sightdistance as seen and within radardistance as on
 * radar (simple circles; TA's terrain-blocked sight is a later refinement). Tiles ever seen stay marked
 * as explored. A player can target and see enemy units that stand on a seen tile; radar shows them as
 * blips only.
 */

export const SEEN = 1;
export const RADAR = 2;
export const EXPLORED = 4;
export const VIS_TILE = 32;

export interface Viewer {
  x: number;
  z: number;
  sight: number;
  radar: number;
}

export class Visibility {
  readonly width: number;
  readonly height: number;
  /** One grid per player: SEEN | RADAR | EXPLORED bits per tile. */
  readonly grids: Uint8Array[];
  /** Bumped on every refresh, so the renderer knows when to redraw the fog. */
  version = 0;

  constructor(mapWidthUnits: number, mapHeightUnits: number, players: number) {
    this.width = Math.ceil(mapWidthUnits / VIS_TILE);
    this.height = Math.ceil(mapHeightUnits / VIS_TILE);
    this.grids = Array.from({ length: players }, () => new Uint8Array(this.width * this.height));
  }

  refresh(player: number, viewers: Viewer[]): void {
    const g = this.grids[player];
    if (!g) return;
    for (let i = 0; i < g.length; i++) g[i]! &= EXPLORED;
    for (const v of viewers) {
      this.stamp(g, v.x, v.z, v.sight, SEEN | EXPLORED);
      if (v.radar > 0) this.stamp(g, v.x, v.z, v.radar, RADAR);
    }
    this.version++;
  }

  at(player: number, x: number, z: number): number {
    const tx = Math.floor(x / VIS_TILE);
    const tz = Math.floor(z / VIS_TILE);
    if (tx < 0 || tz < 0 || tx >= this.width || tz >= this.height) return 0;
    return this.grids[player]?.[tz * this.width + tx] ?? 0;
  }

  private stamp(g: Uint8Array, x: number, z: number, radius: number, bits: number): void {
    const r = radius / VIS_TILE;
    const cx = x / VIS_TILE;
    const cz = z / VIS_TILE;
    const z0 = Math.max(0, Math.floor(cz - r));
    const z1 = Math.min(this.height - 1, Math.floor(cz + r));
    for (let tz = z0; tz <= z1; tz++) {
      const dz = tz + 0.5 - cz;
      const half = Math.sqrt(Math.max(0, r * r - dz * dz));
      const x0 = Math.max(0, Math.floor(cx - half));
      const x1 = Math.min(this.width - 1, Math.floor(cx + half));
      for (let tx = x0; tx <= x1; tx++) g[tz * this.width + tx]! |= bits;
    }
  }
}
