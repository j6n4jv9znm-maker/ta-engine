import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allPieces, parse3do, textureNames } from '../src/formats/3do';
import { parsePalette, PALETTE_PATH, type Palette } from '../src/formats/palette';
import { buildPieceGeometry } from '../src/graphics/pieceGeometry';
import { findTexture, loadTextureLibrary } from '../src/graphics/textures';
import { openDataDir } from '../src/io/nodeVfs';
import { DATA_DIR, hasGameData } from '../src/testData';
import type { Vfs } from '../src/vfs';

interface TestPiece {
  name: string;
  offset: [number, number, number]; // in fixed-point units
  vertices: [number, number, number][];
  primitives: { vertices: number[]; color?: number; texture?: string }[];
  selection?: number;
  children?: TestPiece[];
}

/** Writes a 3DO file as documented in src/formats/3do.ts. */
function build3do(root: TestPiece): Uint8Array {
  const out: number[] = [];
  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const set32 = (at: number, v: number) => out.splice(at, 4, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const str = (s: string) => {
    const at = out.length;
    for (const c of s) out.push(c.charCodeAt(0));
    out.push(0);
    return at;
  };

  const writeSiblings = (pieces: TestPiece[]): number => {
    const starts = pieces.map((p) => {
      const at = out.length;
      u32(1);
      u32(p.vertices.length);
      u32(p.primitives.length);
      u32(p.selection ?? -1);
      p.offset.forEach(u32);
      for (let i = 0; i < 6; i++) u32(0); // name, unknown, vertices, primitives, sibling, child
      return at;
    });
    pieces.forEach((p, i) => {
      const at = starts[i]!;
      set32(at + 28, str(p.name));
      set32(at + 36, out.length);
      for (const v of p.vertices) v.forEach(u32);
      const primAt = out.length;
      set32(at + 40, primAt);
      for (let k = 0; k < p.primitives.length * 8; k++) u32(0);
      p.primitives.forEach((prim, k) => {
        const pa = primAt + k * 32;
        set32(pa, prim.color ?? 0);
        set32(pa + 4, prim.vertices.length);
        set32(pa + 12, out.length);
        for (const vi of prim.vertices) out.push(vi & 0xff, vi >> 8);
        if (prim.texture) set32(pa + 16, str(prim.texture));
        set32(pa + 28, prim.color !== undefined ? 1 : 0);
      });
      if (i + 1 < pieces.length) set32(at + 44, starts[i + 1]!);
      if (p.children?.length) set32(at + 48, writeSiblings(p.children));
    });
    return starts[0]!;
  };
  writeSiblings([root]);
  return Uint8Array.from(out);
}

const F = 65536;

describe('3DO loader', () => {
  const quad: [number, number, number][] = [
    [0, 0, 0],
    [F, 0, 0],
    [F, F, 0],
    [0, F, 0],
  ];
  const model = build3do({
    name: 'base',
    offset: [0, 0, 0],
    vertices: quad,
    primitives: [{ vertices: [0, 1, 2, 3] }, { vertices: [0, 1, 2, 3], texture: 'Skin' }, { vertices: [0, 1, 2, 3, 0], color: 3 }],
    selection: 0,
    children: [
      { name: 'turret', offset: [2 * F, 3 * F, 4 * F], vertices: quad, primitives: [{ vertices: [0, 1, 2], color: 1 }] },
      { name: 'flare', offset: [0, 0, 0], vertices: [], primitives: [] },
    ],
  });

  it('reads the piece tree, names and offsets (z flipped to right-handed)', () => {
    const root = parse3do(model);
    expect(allPieces(root).map((p) => p.name)).toEqual(['base', 'turret', 'flare']);
    expect(root.children[0]!.offset).toEqual([2, 3, -4]);
    expect(root.vertices.slice(6, 9)).toEqual([1, 1, -0]);
    expect(root.selectionPrimitive).toBe(0);
    expect(root.primitives[1]!.texture).toBe('Skin');
    expect(root.primitives[2]!.colorIndex).toBe(3);
    expect(textureNames(root)).toEqual(new Set(['Skin']));
  });

  it('triangulates like RWE and skips the selection quad', () => {
    const raw = new Uint8Array(1024);
    raw.set([255, 0, 0, 0], 3 * 4);
    const geo = buildPieceGeometry(parse3do(model), parsePalette(raw));
    // textured quad -> 2 triangles; 5-vertex coloured polygon -> fan of 3 triangles
    expect(geo.groups).toEqual([
      { texture: 'skin', start: 0, count: 6 },
      { texture: null, start: 6, count: 9 },
    ]);
    // first textured triangle is vertices (2,1,0) with UVs bottom-right, top-right, top-left
    expect([...geo.positions.slice(0, 3)]).toEqual([1, 1, -0]);
    expect([...geo.uvs.slice(0, 6)]).toEqual([1, 1, 1, 0, 0, 0]);
    expect([...geo.colors.slice(18, 21)]).toEqual([1, 0, 0]);
  });

  it('rejects garbage', () => {
    expect(() => parse3do(new Uint8Array(100))).toThrow();
  });
});

describe.skipIf(!hasGameData())('3DO loader (your game files)', () => {
  let vfs: Vfs;
  let close: () => Promise<void>;
  let pal: Palette;
  beforeAll(async () => {
    ({ vfs, close } = await openDataDir(DATA_DIR));
    pal = parsePalette(await vfs.read(PALETTE_PATH));
  });
  afterAll(() => close?.());

  it('loads the Arm Commander with its named pieces', async () => {
    const root = parse3do(await vfs.read('objects3d/ARMCOM.3do'));
    const names = allPieces(root).map((p) => p.name.toLowerCase());
    for (const n of ['torso', 'head', 'biggun', 'nanolath', 'lleg', 'rleg']) expect(names).toContain(n);
  });

  it('parses every model, builds geometry, and finds every texture it uses', async () => {
    const lib = await loadTextureLibrary(vfs, pal);
    const files = vfs.list().filter((f) => /\.3do$/i.test(f.path));
    expect(files.length).toBeGreaterThan(500);
    let triangles = 0;
    for (const f of files) {
      const root = parse3do(await vfs.read(f.path));
      for (const p of allPieces(root)) triangles += buildPieceGeometry(p, pal).positions.length / 9;
      for (const t of textureNames(root)) expect(findTexture(lib, t), `${f.path}: ${t}`).toBeDefined();
    }
    expect(triangles).toBeGreaterThan(50000);
  });
});
