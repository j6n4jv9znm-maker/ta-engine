import { latin1 } from './hpi';
import type { Palette } from './palette';

/*
 * GAF: TA's palettized sprite/texture container (unit textures, build pics, explosions, UI).
 * Layout per the community docs and RWE (src/rwe/io/gaf), little-endian:
 *
 *   header:  version u32 (0x00010100), entryCount u32, unknown u32, then entryCount u32 entry offsets
 *   entry:   frameCount u16, unknown u16, unknown u32, name char[32], then frameCount × (frameOffset u32, unknown u32)
 *   frame:   width u16, height u16, x i16, y i16, transparencyIndex u8, compressed u8, subframeCount u16,
 *            unknown u32, dataOffset u32, unknown u32                                   (24 bytes)
 *
 * A frame either holds pixels itself (subframeCount 0) or lists subframes (u32 offsets at dataOffset),
 * each a frame header of its own, drawn on top of each other. x/y are the origin (hotspot) offsets:
 * a layer's top-left in the frame is (frame.x - layer.x, frame.y - layer.y).
 *
 * Compressed pixels are stored row by row: u16 byte count, then runs, each starting with a mask byte:
 *   mask & 1        skip (mask >> 1) transparent pixels
 *   mask & 2        repeat the next byte (mask >> 2) + 1 times
 *   otherwise       copy the next (mask >> 2) + 1 bytes
 */

const GAF_VERSION = 0x00010100;
const FRAME_HEADER_SIZE = 24;

export class GafError extends Error {}

export interface GafLayer {
  width: number;
  height: number;
  x: number;
  y: number;
  transparencyIndex: number;
  /** width*height palette indices, row-major, top row first. */
  pixels: Uint8Array;
}

export interface GafFrame {
  width: number;
  height: number;
  /** Origin offset: where the sprite's hotspot sits inside the frame. */
  x: number;
  y: number;
  transparencyIndex: number;
  layers: GafLayer[];
}

export interface GafEntry {
  name: string;
  frames: GafFrame[];
}

/** Parses every entry and frame of a GAF file. Pixel data stays as palette indices. */
export function parseGaf(bytes: Uint8Array): GafEntry[] {
  const r = new Reader(bytes);
  if (r.u32(0) !== GAF_VERSION) throw new GafError(`not a GAF file (version 0x${r.u32(0).toString(16)})`);
  const count = r.u32(4);
  const entries: GafEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = r.u32(12 + i * 4);
    const frameCount = r.u16(at);
    const name = r.name(at + 8, 32);
    const frames: GafFrame[] = [];
    for (let f = 0; f < frameCount; f++) {
      frames.push(readFrame(r, r.u32(at + 40 + f * 8), 0));
    }
    entries.push({ name, frames });
  }
  return entries;
}

function readFrame(r: Reader, at: number, depth: number): GafFrame {
  if (depth > 1) throw new GafError('nested subframes');
  const h = readFrameHeader(r, at);
  if (h.subframeCount === 0) {
    const layer = readLayer(r, h);
    return { width: h.width, height: h.height, x: h.x, y: h.y, transparencyIndex: h.transparencyIndex, layers: [layer] };
  }
  const layers: GafLayer[] = [];
  for (let i = 0; i < h.subframeCount; i++) {
    const sub = readFrameHeader(r, r.u32(h.dataOffset + i * 4));
    if (sub.subframeCount !== 0) throw new GafError('nested subframes');
    layers.push(readLayer(r, sub));
  }
  return { width: h.width, height: h.height, x: h.x, y: h.y, transparencyIndex: h.transparencyIndex, layers };
}

interface FrameHeader {
  width: number;
  height: number;
  x: number;
  y: number;
  transparencyIndex: number;
  compressed: boolean;
  subframeCount: number;
  dataOffset: number;
}

function readFrameHeader(r: Reader, at: number): FrameHeader {
  r.check(at, FRAME_HEADER_SIZE);
  return {
    width: r.u16(at),
    height: r.u16(at + 2),
    x: r.i16(at + 4),
    y: r.i16(at + 6),
    transparencyIndex: r.u8(at + 8),
    compressed: r.u8(at + 9) !== 0,
    subframeCount: r.u16(at + 10),
    dataOffset: r.u32(at + 16),
  };
}

function readLayer(r: Reader, h: FrameHeader): GafLayer {
  const { width, height, transparencyIndex } = h;
  let pixels: Uint8Array;
  if (!h.compressed) {
    r.check(h.dataOffset, width * height);
    pixels = r.bytes.slice(h.dataOffset, h.dataOffset + width * height);
  } else {
    pixels = new Uint8Array(width * height).fill(transparencyIndex);
    let pos = h.dataOffset;
    for (let y = 0; y < height; y++) {
      const rowLen = r.u16(pos);
      pos += 2;
      r.check(pos, rowLen);
      decodeRow(r.bytes.subarray(pos, pos + rowLen), pixels.subarray(y * width, (y + 1) * width), transparencyIndex);
      pos += rowLen;
    }
  }
  return { width, height, x: h.x, y: h.y, transparencyIndex, pixels };
}

/** Decodes one compressed row into `out` (already filled with the transparency index). */
export function decodeRow(row: Uint8Array, out: Uint8Array, transparencyIndex: number): void {
  let i = 0;
  let x = 0;
  while (i < row.length && x < out.length) {
    const mask = row[i++]!;
    if (mask & 1) {
      const n = mask >> 1;
      out.fill(transparencyIndex, x, Math.min(out.length, x + n));
      x += n;
    } else if (mask & 2) {
      const n = (mask >> 2) + 1;
      if (i >= row.length) throw new GafError('malformed row (repeat)');
      out.fill(row[i++]!, x, Math.min(out.length, x + n));
      x += n;
    } else {
      const n = (mask >> 2) + 1;
      if (i + n > row.length) throw new GafError('malformed row (copy)');
      const take = Math.min(n, out.length - x);
      out.set(row.subarray(i, i + take), x);
      i += n;
      x += n;
    }
  }
}

/**
 * Flattens a frame's layers into one RGBA image (width*height*4). Each layer's transparent pixels let
 * lower layers show through; pixels not covered by any layer are fully transparent.
 */
export function frameToRgba(frame: GafFrame, palette: Palette): Uint8Array<ArrayBuffer> {
  const { width, height } = frame;
  const out = new Uint8Array(width * height * 4);
  for (const layer of frame.layers) {
    const ox = frame.x - layer.x;
    const oy = frame.y - layer.y;
    for (let y = 0; y < layer.height; y++) {
      const ty = y + oy;
      if (ty < 0 || ty >= height) continue;
      for (let x = 0; x < layer.width; x++) {
        const tx = x + ox;
        if (tx < 0 || tx >= width) continue;
        const idx = layer.pixels[y * layer.width + x]!;
        if (idx === layer.transparencyIndex) continue;
        const o = (ty * width + tx) * 4;
        const p = idx * 4;
        out[o] = palette.rgba[p]!;
        out[o + 1] = palette.rgba[p + 1]!;
        out[o + 2] = palette.rgba[p + 2]!;
        out[o + 3] = 255;
      }
    }
  }
  return out;
}

class Reader {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  check(at: number, len: number): void {
    if (at < 0 || at + len > this.bytes.length) throw new GafError(`read of ${len} bytes at ${at} out of range`);
  }
  u8(at: number): number {
    this.check(at, 1);
    return this.bytes[at]!;
  }
  u16(at: number): number {
    this.check(at, 2);
    return this.view.getUint16(at, true);
  }
  i16(at: number): number {
    this.check(at, 2);
    return this.view.getInt16(at, true);
  }
  u32(at: number): number {
    this.check(at, 4);
    return this.view.getUint32(at, true);
  }
  name(at: number, max: number): string {
    this.check(at, max);
    let end = at;
    while (end < at + max && this.bytes[end] !== 0) end++;
    return latin1(this.bytes.subarray(at, end));
  }
}
