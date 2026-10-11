/*
 * A* over height cells for ground units, after RWE (src/rwe/pathfinding): 8 directions with octile
 * costs (straight 10, diagonal 14 in integers so results are exact and deterministic), a diagonal step
 * only when both side cells are open, and when the goal can't be reached, a path to the reachable cell
 * nearest the goal. Positions are a footprint's top-left cell.
 */

export interface PathRequest {
  width: number;
  height: number;
  /** Whether the unit can stand with its footprint's top-left at (x, z). */
  passable: (x: number, z: number) => boolean;
  start: [number, number];
  goal: [number, number];
  /** Give up after expanding this many cells and return the best partial path. */
  maxExpansions?: number;
}

export interface PathResult {
  /** Waypoints (top-left cells) from just after the start to the end, with straight runs merged. */
  waypoints: [number, number][];
  /** False when the goal couldn't be reached and the path ends as close as it could. */
  complete: boolean;
  expanded: number;
}

const STRAIGHT = 10;
const DIAGONAL = 14;
const DIRS: [number, number, number][] = [
  [1, 0, STRAIGHT],
  [-1, 0, STRAIGHT],
  [0, 1, STRAIGHT],
  [0, -1, STRAIGHT],
  [1, 1, DIAGONAL],
  [1, -1, DIAGONAL],
  [-1, 1, DIAGONAL],
  [-1, -1, DIAGONAL],
];

export function octile(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return STRAIGHT * Math.max(dx, dz) + (DIAGONAL - STRAIGHT) * Math.min(dx, dz);
}

export function findPath(req: PathRequest): PathResult {
  const { width, height, passable, start, goal } = req;
  const maxExpansions = req.maxExpansions ?? 40000;
  const idx = (x: number, z: number) => z * width + x;
  const startI = idx(start[0], start[1]);
  const goalI = idx(goal[0], goal[1]);

  // Scratch arrays are reused between searches (stamped with a search number instead of cleared), since
  // a busy battlefield asks for many paths a second.
  const n = width * height;
  const sc = scratch(n);
  const stamp = ++sc.search;
  const gScore = sc.g;
  const parent = sc.parent;
  const seen = sc.seen; // == stamp: has a g score this search
  const closed = sc.closed; // == stamp: expanded this search
  const heap = sc.heap;
  heap.clear();
  let seq = 0;
  const h0 = octile(start[0], start[1], goal[0], goal[1]);
  gScore[startI] = 0;
  seen[startI] = stamp;
  parent[startI] = -1;
  heap.push(h0, h0, seq++, startI);

  let best = startI;
  let bestH = h0;
  let expanded = 0;
  let reached = false;

  while (heap.size > 0) {
    const i = heap.popIndex();
    if (closed[i] === stamp) continue;
    closed[i] = stamp;
    const x = i % width;
    const z = (i - x) / width;
    const hHere = octile(x, z, goal[0], goal[1]);
    if (hHere < bestH) {
      best = i;
      bestH = hHere;
    }
    if (i === goalI) {
      reached = true;
      best = i;
      break;
    }
    if (++expanded >= maxExpansions) break;

    const gHere = gScore[i]!;
    for (const [dx, dz, cost] of DIRS) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
      if (!passable(nx, nz)) continue;
      if (dx !== 0 && dz !== 0 && (!passable(x + dx, z) || !passable(x, z + dz))) continue;
      const ni = idx(nx, nz);
      if (closed[ni] === stamp) continue;
      const ng = gHere + cost;
      if (seen[ni] === stamp && gScore[ni]! <= ng) continue;
      gScore[ni] = ng;
      seen[ni] = stamp;
      parent[ni] = i;
      const h = octile(nx, nz, goal[0], goal[1]);
      heap.push(ng + h, h, seq++, ni);
    }
  }

  const cells: [number, number][] = [];
  for (let i = best; i !== startI && i >= 0; i = parent[i]!) {
    cells.push([i % width, Math.floor(i / width)]);
  }
  cells.reverse();
  return { waypoints: mergeStraightRuns(start, cells), complete: reached, expanded };
}

/** Keeps only the cells where the direction changes, plus the last one. */
function mergeStraightRuns(start: [number, number], cells: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let prev = start;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const n = cells[i + 1];
    if (!n) {
      out.push(c);
      break;
    }
    const d1 = [c[0] - prev[0], c[1] - prev[1]];
    const d2 = [n[0] - c[0], n[1] - c[1]];
    if (d1[0] !== d2[0] || d1[1] !== d2[1]) out.push(c);
    prev = c;
  }
  return out;
}

/** Reusable search buffers per grid size. */
interface Scratch {
  search: number;
  g: Int32Array;
  parent: Int32Array;
  seen: Uint32Array;
  closed: Uint32Array;
  heap: MinHeap;
}
const scratches = new Map<number, Scratch>();
function scratch(n: number): Scratch {
  let s = scratches.get(n);
  if (!s) {
    s = { search: 0, g: new Int32Array(n), parent: new Int32Array(n), seen: new Uint32Array(n), closed: new Uint32Array(n), heap: new MinHeap() };
    scratches.set(n, s);
  }
  return s;
}

/**
 * Binary min-heap ordered by f, then h, then insertion order (so ties break the same way every time),
 * stored in flat arrays to keep garbage down.
 */
class MinHeap {
  private f: number[] = [];
  private h: number[] = [];
  private seq: number[] = [];
  private idx: number[] = [];
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(f: number, h: number, seq: number, i: number): void {
    let k = this.size++;
    this.f[k] = f;
    this.h[k] = h;
    this.seq[k] = seq;
    this.idx[k] = i;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!this.less(k, p)) break;
      this.swap(k, p);
      k = p;
    }
  }

  popIndex(): number {
    const top = this.idx[0]!;
    const last = --this.size;
    if (last > 0) {
      this.f[0] = this.f[last]!;
      this.h[0] = this.h[last]!;
      this.seq[0] = this.seq[last]!;
      this.idx[0] = this.idx[last]!;
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        const r = l + 1;
        let m = k;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === k) break;
        this.swap(k, m);
        k = m;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    if (this.f[a] !== this.f[b]) return this.f[a]! < this.f[b]!;
    if (this.h[a] !== this.h[b]) return this.h[a]! < this.h[b]!;
    return this.seq[a]! < this.seq[b]!;
  }

  private swap(a: number, b: number): void {
    let t = this.f[a]!;
    this.f[a] = this.f[b]!;
    this.f[b] = t;
    t = this.h[a]!;
    this.h[a] = this.h[b]!;
    this.h[b] = t;
    t = this.seq[a]!;
    this.seq[a] = this.seq[b]!;
    this.seq[b] = t;
    t = this.idx[a]!;
    this.idx[a] = this.idx[b]!;
    this.idx[b] = t;
  }
}
