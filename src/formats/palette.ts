/*
 * TA palettes (palettes/PALETTE.PAL in totala1.hpi): 256 entries of 4 bytes, R G B and an unused
 * byte, per the community docs and RWE (src/rwe/ColorPalette.cpp). All 8-bit game graphics index it.
 */

export const PALETTE_PATH = 'palettes/PALETTE.PAL';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export class Palette {
  /** 256 * 4 bytes of RGBA, ready to copy into image data or a texture. */
  readonly rgba: Uint8Array;

  constructor(rgba: Uint8Array) {
    if (rgba.length !== 1024) throw new Error(`palette must be 1024 RGBA bytes, got ${rgba.length}`);
    this.rgba = rgba;
  }

  color(index: number): Rgba {
    const i = (index & 0xff) * 4;
    return { r: this.rgba[i]!, g: this.rgba[i + 1]!, b: this.rgba[i + 2]!, a: this.rgba[i + 3]! };
  }

  /** CSS hex string like "#a0b0c0". */
  hex(index: number): string {
    const { r, g, b } = this.color(index);
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
}

/** Parses a .pal file. Every colour is opaque; GAF transparency is handled per image later. */
export function parsePalette(bytes: Uint8Array): Palette {
  if (bytes.length < 1024) throw new Error(`palette file too small: ${bytes.length} bytes (need 1024)`);
  const rgba = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4] = bytes[i * 4]!;
    rgba[i * 4 + 1] = bytes[i * 4 + 1]!;
    rgba[i * 4 + 2] = bytes[i * 4 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  return new Palette(rgba);
}
