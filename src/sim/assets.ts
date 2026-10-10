import { parse3do } from '../formats/3do';
import { parseCob } from '../formats/cob';
import type { Vfs } from '../vfs';
import type { UnitDef } from './unitDef';
import type { UnitAssets } from './world';

/** Loads (and caches) a unit type's model and script for the simulation. */
export class UnitAssetLoader {
  private readonly cache = new Map<string, Promise<UnitAssets | undefined>>();

  constructor(
    private readonly vfs: Vfs,
    readonly defs: Map<string, UnitDef>,
  ) {}

  load(unitName: string): Promise<UnitAssets | undefined> {
    const key = unitName.toLowerCase();
    let p = this.cache.get(key);
    if (!p) {
      p = this.read(key);
      this.cache.set(key, p);
    }
    return p;
  }

  private async read(key: string): Promise<UnitAssets | undefined> {
    const def = this.defs.get(key);
    if (!def) return undefined;
    const modelPath = `objects3d/${def.objectName}.3do`;
    const scriptPath = `scripts/${def.unitName}.cob`;
    return {
      def,
      model: this.vfs.exists(modelPath) ? parse3do(await this.vfs.read(modelPath)) : undefined,
      script: this.vfs.exists(scriptPath) ? parseCob(await this.vfs.read(scriptPath)) : undefined,
    };
  }
}
