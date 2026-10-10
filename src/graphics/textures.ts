import { frameToRgba, parseGaf } from '../formats/gaf';
import type { Palette } from '../formats/palette';
import type { Vfs } from '../vfs';

/*
 * Model textures. Following RWE (src/rwe/atlas_util.cpp):
 *   - every entry of every textures/*.gaf is a texture, named by its entry name; we use frame 0
 *     (animated textures can come later);
 *   - textures/LOGOS.GAF holds team-colour textures: each entry has one frame per team colour (10).
 * Names are matched case-insensitively.
 */

export const TEAM_COLOR_COUNT = 10;
export const LOGOS_PATH = 'textures/LOGOS.GAF';

export interface TextureImage {
  width: number;
  height: number;
  /** width*height*4 RGBA, top row first. */
  rgba: Uint8Array<ArrayBuffer>;
}

export interface TextureLibrary {
  /** Lowercased name -> image. */
  textures: Map<string, TextureImage>;
  /** Lowercased name -> one image per team colour. */
  teamTextures: Map<string, TextureImage[]>;
}

export async function loadTextureLibrary(vfs: Vfs, palette: Palette): Promise<TextureLibrary> {
  const textures = new Map<string, TextureImage>();
  const teamTextures = new Map<string, TextureImage[]>();
  for (const f of vfs.listDir('textures', '.gaf')) {
    const isLogos = f.path.toLowerCase() === LOGOS_PATH.toLowerCase();
    for (const entry of parseGaf(await vfs.read(f.path))) {
      if (entry.frames.length === 0) continue;
      const key = entry.name.toLowerCase();
      if (isLogos) {
        // Some logo frames differ in size from frame 0 (e.g. a 32x33 among 32x32); RWE clips to frame 0.
        const first = entry.frames[0]!;
        teamTextures.set(
          key,
          entry.frames.map((fr) => clip({ width: fr.width, height: fr.height, rgba: frameToRgba(fr, palette) }, first.width, first.height)),
        );
      } else {
        const fr = entry.frames[0]!;
        textures.set(key, { width: fr.width, height: fr.height, rgba: frameToRgba(fr, palette) });
      }
    }
  }
  return { textures, teamTextures };
}

/** Looks up a texture for a given team colour (0-9). Team textures fall back to colour 0. */
export function findTexture(lib: TextureLibrary, name: string, team = 0): TextureImage | undefined {
  const key = name.toLowerCase();
  const team_ = lib.teamTextures.get(key);
  if (team_) return team_[team] ?? team_[0];
  return lib.textures.get(key);
}

function clip(img: TextureImage, width: number, height: number): TextureImage {
  if (img.width === width && img.height === height) return img;
  const rgba = new Uint8Array(width * height * 4);
  const w = Math.min(width, img.width);
  for (let y = 0; y < Math.min(height, img.height); y++) {
    rgba.set(img.rgba.subarray(y * img.width * 4, (y * img.width + w) * 4), y * width * 4);
  }
  return { width, height, rgba };
}
