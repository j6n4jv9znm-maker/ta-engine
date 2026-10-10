import { getBlock, getValue, type TdfBlock } from './tdf';

/*
 * OTA: a map's settings (maps/<name>.ota), in TDF syntax. Fields follow RWE (src/rwe/io/ota/ota.cpp):
 * a [GlobalHeader] with mission text and environment values, then [Schema N] blocks (one per game type)
 * holding extra [features] (featureN: Featurename, XPos, ZPos in height cells) and [specials]
 * (specialN: specialwhat, XPos, ZPos in pixels), where specialwhat "StartPos1".."StartPos10" marks
 * the players' start positions.
 */

export interface OtaSchema {
  type: string;
  surfaceMetal: number;
  features: { name: string; x: number; z: number }[];
  /** Start positions in pixels from the map's top-left, indexed by player (0-based). */
  startPositions: ({ x: number; z: number } | undefined)[];
}

export interface OtaInfo {
  missionName: string;
  description: string;
  planet: string;
  size: string;
  numPlayers: string;
  tidalStrength: number;
  solarStrength: number;
  minWindSpeed: number;
  maxWindSpeed: number;
  gravity: number;
  lavaWorld: boolean;
  schemas: OtaSchema[];
}

export function parseOta(root: TdfBlock): OtaInfo {
  const h = getBlock(root, 'GlobalHeader');
  if (!h) throw new Error('OTA has no [GlobalHeader]');
  const str = (b: TdfBlock, k: string) => getValue(b, k) ?? '';
  const num = (b: TdfBlock, k: string, d = 0) => {
    const n = Number.parseInt(getValue(b, k) ?? '', 10);
    return Number.isFinite(n) ? n : d;
  };

  const schemas: OtaSchema[] = [];
  const count = num(h, 'SCHEMACOUNT', 0);
  for (let i = 0; i < Math.max(count, 1); i++) {
    const s = getBlock(h, `Schema ${i}`);
    if (!s) continue;
    const features: OtaSchema['features'] = [];
    const fb = getBlock(s, 'features');
    for (let j = 0; fb && getBlock(fb, `feature${j}`); j++) {
      const f = getBlock(fb, `feature${j}`)!;
      features.push({ name: str(f, 'Featurename'), x: num(f, 'XPos'), z: num(f, 'ZPos') });
    }
    const startPositions: OtaSchema['startPositions'] = [];
    const sb = getBlock(s, 'specials');
    for (let j = 0; sb && getBlock(sb, `special${j}`); j++) {
      const sp = getBlock(sb, `special${j}`)!;
      const m = /^startpos(\d+)$/i.exec(str(sp, 'specialwhat'));
      if (m) startPositions[Number(m[1]) - 1] = { x: num(sp, 'XPos'), z: num(sp, 'ZPos') };
    }
    schemas.push({ type: str(s, 'Type'), surfaceMetal: num(s, 'SurfaceMetal', 3), features, startPositions });
  }

  return {
    missionName: str(h, 'missionname'),
    description: str(h, 'missiondescription'),
    planet: str(h, 'planet'),
    size: str(h, 'size'),
    numPlayers: str(h, 'numplayers'),
    tidalStrength: num(h, 'tidalstrength'),
    solarStrength: num(h, 'solarstrength'),
    minWindSpeed: num(h, 'minwindspeed'),
    maxWindSpeed: num(h, 'maxwindspeed'),
    gravity: num(h, 'gravity', 112),
    lavaWorld: num(h, 'lavaworld') !== 0,
    schemas,
  };
}
