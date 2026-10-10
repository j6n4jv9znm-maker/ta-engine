import type { ModelPiece } from '../formats/3do';
import type { Palette } from '../formats/palette';

/*
 * Turns one 3DO piece into plain triangle arrays, independent of any renderer (so it can be tested in
 * Node and reused if the renderer changes). Triangulation and UVs follow RWE (src/rwe/mesh_util.cpp):
 *   - a textured quad becomes triangles (2,1,0) and (3,2,0), with the texture's corners mapped
 *     0 = top-left, 1 = top-right, 2 = bottom-right, 3 = bottom-left;
 *   - a flat-coloured polygon becomes a fan from its first vertex, walking backwards;
 *   - anything else (points, lines, the selection quad) is not drawn.
 */

export interface GeometryGroup {
  /** Texture name, or null for flat-coloured triangles. */
  texture: string | null;
  /** First vertex and vertex count in the arrays below (3 per triangle). */
  start: number;
  count: number;
}

export interface PieceGeometry {
  positions: Float32Array;
  uvs: Float32Array;
  /** RGB 0..1 per vertex (white for textured triangles). */
  colors: Float32Array;
  groups: GeometryGroup[];
}

const TL = [0, 0];
const TR = [1, 0];
const BR = [1, 1];
const BL = [0, 1];

export function buildPieceGeometry(piece: ModelPiece, palette: Palette): PieceGeometry {
  // Bucket triangles by texture so each texture is one draw group.
  const buckets = new Map<string | null, { pos: number[]; uv: number[]; col: number[] }>();
  const bucket = (key: string | null) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { pos: [], uv: [], col: [] }));
    return b;
  };
  const v = piece.vertices;
  const push = (b: { pos: number[]; uv: number[]; col: number[] }, vi: number, uv: number[], rgb: number[]) => {
    b.pos.push(v[vi * 3]!, v[vi * 3 + 1]!, v[vi * 3 + 2]!);
    b.uv.push(uv[0]!, uv[1]!);
    b.col.push(rgb[0]!, rgb[1]!, rgb[2]!);
  };
  const white = [1, 1, 1];

  piece.primitives.forEach((prim, i) => {
    if (i === piece.selectionPrimitive) return;
    const idx = prim.vertices;
    if (prim.texture && idx.length === 4) {
      const b = bucket(prim.texture.toLowerCase());
      push(b, idx[2]!, BR, white);
      push(b, idx[1]!, TR, white);
      push(b, idx[0]!, TL, white);
      push(b, idx[3]!, BL, white);
      push(b, idx[2]!, BR, white);
      push(b, idx[0]!, TL, white);
      return;
    }
    if (idx.length >= 3 && prim.colorIndex !== undefined) {
      const c = palette.color(prim.colorIndex);
      const rgb = [c.r / 255, c.g / 255, c.b / 255];
      const b = bucket(null);
      for (let k = idx.length - 1; k >= 2; k--) {
        push(b, idx[0]!, TL, rgb);
        push(b, idx[k]!, TL, rgb);
        push(b, idx[k - 1]!, TL, rgb);
      }
    }
  });

  const groups: GeometryGroup[] = [];
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  for (const [texture, b] of buckets) {
    groups.push({ texture, start: pos.length / 3, count: b.pos.length / 3 });
    pos.push(...b.pos);
    uv.push(...b.uv);
    col.push(...b.col);
  }
  return { positions: new Float32Array(pos), uvs: new Float32Array(uv), colors: new Float32Array(col), groups };
}
