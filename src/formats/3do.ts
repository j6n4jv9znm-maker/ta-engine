import { latin1 } from './hpi';

/*
 * 3DO: TA's unit/feature model format. A tree of named pieces, each with an offset from its parent,
 * vertices and polygons. Layout per the community docs and RWE (src/rwe/io/_3do), little-endian:
 *
 *   object (52 bytes): version u32 (1), vertexCount u32, primitiveCount u32, selectionPrimitive i32,
 *                      x i32, y i32, z i32, nameOffset u32, unknown u32, verticesOffset u32,
 *                      primitivesOffset u32, siblingOffset u32, childOffset u32
 *   vertex (12 bytes): x i32, y i32, z i32
 *   primitive (32 bytes): colorIndex u32, vertexCount u32, unknown u32, vertexIndicesOffset u32 (u16 each),
 *                      textureNameOffset u32, unknown u32, unknown u32, isColored u32
 *
 * Coordinates are 16.16 fixed point in a left-handed system. Like RWE, we divide by 65536 and negate z
 * to get a right-handed system (x right, y up, z towards the viewer).
 */

const OBJECT_SIZE = 52;
const PRIMITIVE_SIZE = 32;
const FIXED = 65536;

export class ModelError extends Error {}

export interface ModelPrimitive {
  /** Indices into the piece's vertex list, in file order. */
  vertices: number[];
  /** Palette colour, when the polygon is flat-coloured. */
  colorIndex?: number;
  /** GAF texture entry name, when the polygon is textured. */
  texture?: string;
}

export interface ModelPiece {
  name: string;
  /** Offset from the parent piece (already converted to floats, right-handed). */
  offset: [number, number, number];
  /** Flat [x, y, z, x, y, z, ...] in the piece's own space. */
  vertices: number[];
  primitives: ModelPrimitive[];
  /** Index of the ground quad TA uses for selection, not drawn. Undefined when the piece has none. */
  selectionPrimitive?: number;
  children: ModelPiece[];
}

/** Parses a 3DO file and returns its root piece. */
export function parse3do(bytes: Uint8Array): ModelPiece {
  const roots = readSiblings(new Reader(bytes), 0, 0);
  if (roots.length !== 1) throw new ModelError(`expected one root piece, found ${roots.length}`);
  return roots[0]!;
}

function readSiblings(r: Reader, offset: number, depth: number): ModelPiece[] {
  if (depth > 64) throw new ModelError('piece tree too deep (corrupt?)');
  const out: ModelPiece[] = [];
  const seen = new Set<number>();
  let at = offset;
  do {
    if (seen.has(at)) throw new ModelError('sibling loop (corrupt?)');
    seen.add(at);
    r.check(at, OBJECT_SIZE);
    if (r.u32(at) !== 1) throw new ModelError(`bad piece version at ${at}`);
    const vertexCount = r.u32(at + 4);
    const primitiveCount = r.u32(at + 8);
    const selection = r.i32(at + 12);
    const name = r.cstring(r.u32(at + 28));
    const verticesOffset = r.u32(at + 36);
    const primitivesOffset = r.u32(at + 40);
    const sibling = r.u32(at + 44);
    const child = r.u32(at + 48);

    const vertices: number[] = [];
    r.check(verticesOffset, vertexCount * 12);
    for (let i = 0; i < vertexCount; i++) {
      const v = verticesOffset + i * 12;
      vertices.push(r.i32(v) / FIXED, r.i32(v + 4) / FIXED, -r.i32(v + 8) / FIXED);
    }

    const primitives: ModelPrimitive[] = [];
    r.check(primitivesOffset, primitiveCount * PRIMITIVE_SIZE);
    for (let i = 0; i < primitiveCount; i++) {
      const p = primitivesOffset + i * PRIMITIVE_SIZE;
      const n = r.u32(p + 4);
      const idxOffset = r.u32(p + 12);
      const texOffset = r.u32(p + 16);
      const isColored = r.u32(p + 28) !== 0;
      r.check(idxOffset, n * 2);
      const indices: number[] = [];
      for (let j = 0; j < n; j++) {
        const vi = r.u16(idxOffset + j * 2);
        if (vi >= vertexCount) throw new ModelError(`${name}: vertex index ${vi} out of range`);
        indices.push(vi);
      }
      const prim: ModelPrimitive = { vertices: indices };
      if (isColored) prim.colorIndex = r.u32(p) & 0xff;
      if (texOffset !== 0) prim.texture = r.cstring(texOffset);
      primitives.push(prim);
    }

    out.push({
      name,
      offset: [r.i32(at + 16) / FIXED, r.i32(at + 20) / FIXED, -r.i32(at + 24) / FIXED],
      vertices,
      primitives,
      selectionPrimitive: selection >= 0 && selection < primitiveCount ? selection : undefined,
      children: child !== 0 ? readSiblings(r, child, depth + 1) : [],
    });
    at = sibling;
  } while (at !== 0);
  return out;
}

/** Every piece in the tree, depth-first, parents before children. */
export function allPieces(root: ModelPiece): ModelPiece[] {
  const out: ModelPiece[] = [];
  const walk = (p: ModelPiece) => {
    out.push(p);
    p.children.forEach(walk);
  };
  walk(root);
  return out;
}

/** Texture names used anywhere in the model. */
export function textureNames(root: ModelPiece): Set<string> {
  const names = new Set<string>();
  for (const p of allPieces(root)) for (const prim of p.primitives) if (prim.texture) names.add(prim.texture);
  return names;
}

class Reader {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  check(at: number, len: number): void {
    if (at < 0 || at + len > this.bytes.length) throw new ModelError(`read of ${len} bytes at ${at} out of range`);
  }
  u16(at: number): number {
    this.check(at, 2);
    return this.view.getUint16(at, true);
  }
  u32(at: number): number {
    this.check(at, 4);
    return this.view.getUint32(at, true);
  }
  i32(at: number): number {
    this.check(at, 4);
    return this.view.getInt32(at, true);
  }
  cstring(at: number): string {
    let end = at;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    if (end >= this.bytes.length) throw new ModelError('unterminated string');
    return latin1(this.bytes.subarray(at, end));
  }
}
