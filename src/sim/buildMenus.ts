import { latin1 } from '../formats/hpi';
import { getBlock, getValue, parseTdf } from '../formats/tdf';
import type { Vfs } from '../vfs';

/*
 * What each builder can build, in TA's menu order. Like RWE (LoadingScene::loadBuilderGui), a builder's
 * menu pages are guis/<UNIT>1.GUI, <UNIT>2.GUI, ...; each page's gadgets named after a unit are its
 * buttons. Units added by the expansions and patches register themselves in download/*.tdf
 * ([MENUENTRYn] UNITMENU=<builder>; MENU=<page>; BUTTON=<slot>; UNITNAME=<unit>), which RWE doesn't
 * read yet; we add them to the named page, in button order.
 */

/** Builder unit name (lowercase) -> pages -> unit names. */
export type BuildMenus = Map<string, string[][]>;

export async function loadBuildMenus(vfs: Vfs, unitNames: Set<string>): Promise<BuildMenus> {
  const menus: BuildMenus = new Map();
  const isUnit = (n: string) => unitNames.has(n.toLowerCase());

  // GUI pages, grouped by builder: "ARMCOM1.GUI" -> ("armcom", 1).
  const pages = new Map<string, Map<number, string[]>>();
  for (const f of vfs.listDir('guis', '.gui')) {
    const m = /^guis\/(.+?)(\d+)\.gui$/i.exec(f.path);
    if (!m || !isUnit(m[1]!)) continue;
    const text = latin1(await vfs.read(f.path));
    if (text.slice(0, 64).includes('\0')) continue; // a few .gui files are binary
    const root = parseTdf(text, { keepDuplicateBlocks: true });
    const entries: string[] = [];
    for (const g of Object.values(root)) {
      if (typeof g !== 'object') continue;
      const common = getBlock(g, 'common');
      const name = common && getValue(common, 'name');
      if (name && isUnit(name)) entries.push(name.toUpperCase());
    }
    const builder = m[1]!.toLowerCase();
    if (!pages.has(builder)) pages.set(builder, new Map());
    pages.get(builder)!.set(Number(m[2]), entries);
  }

  // Expansion units, from download/*.tdf.
  const extra = new Map<string, { page: number; button: number; unit: string }[]>();
  for (const f of vfs.listDir('download', '.tdf')) {
    const root = parseTdf(latin1(await vfs.read(f.path)));
    for (const b of Object.values(root)) {
      if (typeof b !== 'object') continue;
      const builder = getValue(b, 'UNITMENU')?.toLowerCase();
      const unit = getValue(b, 'UNITNAME');
      if (!builder || !unit || !isUnit(unit) || !isUnit(builder)) continue;
      if (!extra.has(builder)) extra.set(builder, []);
      extra.get(builder)!.push({ page: Number(getValue(b, 'MENU') ?? 1), button: Number(getValue(b, 'BUTTON') ?? 0), unit: unit.toUpperCase() });
    }
  }

  for (const builder of new Set([...pages.keys(), ...extra.keys()])) {
    const byPage = pages.get(builder) ?? new Map<number, string[]>();
    const list = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => [...e]);
    const adds = (extra.get(builder) ?? []).sort((a, b) => a.page - b.page || a.button - b.button);
    for (const a of adds) {
      if (list.some((p) => p.includes(a.unit))) continue;
      const i = Math.max(0, a.page - 1);
      while (list.length <= i) list.push([]);
      list[i]!.push(a.unit);
    }
    const nonEmpty = list.filter((p) => p.length > 0);
    if (nonEmpty.length) menus.set(builder, nonEmpty);
  }
  return menus;
}
