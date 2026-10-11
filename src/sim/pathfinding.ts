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

  const g = new Map<number, number>([[startI, 0]]);
  const parent = new Map<number, number>();
  const closed = new Set<number>();
  const heap = new MinHeap();
  let seq = 0;
  const h0 = octile(start[0], start[1], goal[0], goal[1]);
  heap.push({ f: h0, h: h0, seq: seq++, i: startI });

  let best = startI;
  let bestH = h0;
  let expanded = 0;
  let reached = false;

  while (heap.size > 0) {
    const node = heap.pop()!;
    if (closed.has(node.i)) continue;
    closed.add(node.i);
    if (node.h < bestH) {
      best = node.i;
      bestH = node.h;
    }
    if (node.i === goalI) {
      reached = true;
      best = node.i;
      break;
    }
    if (++expanded >= maxExpansions) break;

    const x = node.i % width;
    const z = (node.i - x) / width;
    const gHere = g.get(node.i)!;
    for (const [dx, dz, cost] of DIRS) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
      if (!passable(nx, nz)) continue;
      if (dx !== 0 && dz !== 0 && (!passable(x + dx, z) || !passable(x, z + dz))) continue;
      const ni = idx(nx, nz);
      if (closed.has(ni)) continue;
      const ng = gHere + cost;
      const old = g.get(ni);
      if (old !== undefined && old <= ng) continue;
      g.set(ni, ng);
      parent.set(ni, node.i);
      const h = octile(nx, nz, goal[0], goal[1]);
      heap.push({ f: ng + h, h, seq: seq++, i: ni });
    }
  }

  const cells: [number, number][] = [];
  for (let i: number | undefined = best; i !== undefined && i !== startI; i = parent.get(i)) {
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

interface HeapNode {
  f: number;
  h: number;
  seq: number;
  i: number;
}

/** Binary min-heap ordered by f, then h, then insertion order (so ties break the same way every time). */
class MinHeap {
  private a: HeapNode[] = [];
  get size(): number {
    return this.a.length;
  }
  push(n: HeapNode): void {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): HeapNode | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l]!, a[m]!)) m = l;
        if (r < a.length && less(a[r]!, a[m]!)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        i = m;
      }
    }
    return top;
  }
}

function less(x: HeapNode, y: HeapNode): boolean {
  if (x.f !== y.f) return x.f < y.f;
  if (x.h !== y.h) return x.h < y.h;
  return x.seq < y.seq;
}
