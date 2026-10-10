import { latin1 } from '../formats/hpi';
import { getValue, parseTdf, type TdfBlock } from '../formats/tdf';
import type { Vfs } from '../vfs';

/*
 * Feature definitions (trees, rocks, wrecks, ...) from features/**\/*.tdf. Each file holds blocks named
 * after the feature. Field meanings follow RWE (src/rwe/io/featuretdf). A feature is drawn either as a
 * GAF sprite (anims/<filename>.gaf, entry <seqname>, optional shadow <seqnameshad>) or, when `object`
 * is set, as a 3DO model.
 */

export interface FeatureDef {
  name: string;
  world: string;
  description: string;
  category: string;
  /** Footprint in 16-pixel cells. */
  footprintX: number;
  footprintZ: number;
  height: number;
  fileName: string;
  seqName: string;
  seqNameShadow: string;
  /** 3DO model name, when the feature is a model rather than a sprite. */
  object: string;
  animTrans: boolean;
  shadTrans: boolean;
  blocking: boolean;
  reclaimable: boolean;
  metal: number;
  energy: number;
}

/** RWE draws features at least this tall as upright sprites; shorter ones lie flat on the ground. */
export const STANDING_FEATURE_MIN_HEIGHT = 10;

export function isStanding(def: FeatureDef): boolean {
  return def.height >= STANDING_FEATURE_MIN_HEIGHT;
}

/** Reads every feature definition. Keys are lowercased feature names; later files win. */
export async function loadFeatureDefinitions(vfs: Vfs): Promise<Map<string, FeatureDef>> {
  const defs = new Map<string, FeatureDef>();
  for (const f of vfs.list()) {
    if (!/^features\/.*\.tdf$/i.test(f.path)) continue;
    const root = parseTdf(latin1(await vfs.read(f.path)));
    for (const [name, block] of Object.entries(root)) {
      if (typeof block === 'object') defs.set(name, toDef(name, block));
    }
  }
  return defs;
}

function toDef(name: string, b: TdfBlock): FeatureDef {
  const s = (k: string) => getValue(b, k) ?? '';
  const n = (k: string, d = 0) => {
    const v = Number.parseInt(s(k), 10);
    return Number.isFinite(v) ? v : d;
  };
  return {
    name,
    world: s('world'),
    description: s('description'),
    category: s('category'),
    footprintX: n('footprintx', 1),
    footprintZ: n('footprintz', 1),
    height: n('height'),
    fileName: s('filename'),
    seqName: s('seqname'),
    seqNameShadow: s('seqnameshad'),
    object: s('object'),
    animTrans: n('animtrans') !== 0,
    shadTrans: n('shadtrans') !== 0,
    blocking: n('blocking') !== 0,
    reclaimable: n('reclaimable') !== 0,
    metal: n('metal'),
    energy: n('energy'),
  };
}
