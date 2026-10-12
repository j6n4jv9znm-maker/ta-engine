import { frameToRgba, parseGaf, type GafEntry } from '../formats/gaf';
import type { Palette } from '../formats/palette';
import type { Vfs } from '../vfs';

/*
 * TA's own interface art, read from the player's game files and turned into image URLs for the page:
 *   anims/ARMINT.GAF, CORINT.GAF   PANELSIDE (the left panel), PANELTOP, PANELBOT (the bars)
 *   anims/commongui.GAF            ARMPAN/CORPAN (the build/orders area), order buttons such as
 *                                  ARMSTOP or ARMRECLAIM (frames: normal, pressed, ...), ARMPREV/ARMNEXT
 *   anims/CURSORS.GAF              the mouse cursors (cursornormal, cursormove, cursorattack, ...)
 * Nothing here is bundled; it is all made at load time from the player's own data.
 */

export interface GuiSprite {
  url: string;
  width: number;
  height: number;
  /** The frame's hotspot (cursors). */
  x: number;
  y: number;
}

export class TaGui {
  private readonly entries = new Map<string, GafEntry>();
  private readonly cache = new Map<string, GuiSprite | undefined>();

  private constructor(private readonly palette: Palette) {}

  static async load(vfs: Vfs, palette: Palette): Promise<TaGui> {
    const gui = new TaGui(palette);
    for (const path of ['anims/armint.gaf', 'anims/corint.gaf', 'anims/commongui.gaf', 'anims/cursors.gaf']) {
      if (!vfs.exists(path)) continue;
      try {
        // Arm's and Core's panels share names (PANELSIDE...), so each is also kept as "armint:panelside".
        const file = path.slice(path.lastIndexOf('/') + 1, -4);
        for (const e of parseGaf(await vfs.read(path))) {
          gui.entries.set(`${file}:${e.name.toLowerCase()}`, e);
          if (!gui.entries.has(e.name.toLowerCase())) gui.entries.set(e.name.toLowerCase(), e);
        }
      } catch {
        // a damaged file just means fewer pictures
      }
    }
    return gui;
  }

  /** A frame of a named sprite as an image URL, or undefined if the game files don't have it. */
  sprite(name: string, frame = 0): GuiSprite | undefined {
    const key = `${name.toLowerCase()}#${frame}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const f = this.entries.get(name.toLowerCase())?.frames[frame];
    let s: GuiSprite | undefined;
    if (f) {
      const c = document.createElement('canvas');
      c.width = f.width;
      c.height = f.height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frameToRgba(f, this.palette)), f.width, f.height), 0, 0);
      s = { url: c.toDataURL(), width: f.width, height: f.height, x: f.x, y: f.y };
    }
    this.cache.set(key, s);
    return s;
  }

  /** A CSS cursor value for a TA cursor (its first frame, with its hotspot), falling back to `fallback`. */
  cursor(name: string, fallback = 'auto'): string {
    const s = this.sprite(name);
    return s ? `url(${s.url}) ${Math.max(0, s.x)} ${Math.max(0, s.y)}, ${fallback}` : fallback;
  }
}
