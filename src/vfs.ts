import { HpiArchive, splitPath, type HpiFile } from './formats/hpi';
import type { ByteSource } from './io/byteSource';

/*
 * Virtual filesystem: layers several HPI-format archives so later layers override earlier ones,
 * the way TA does. Lookups are case-insensitive, matching TA on Windows.
 *
 * Load order follows RWE (src/rwe/vfs/CompositeVirtualFileSystem.cpp), which gives priority by
 * extension: .gp3 > .gpf > .ccx > .ufo > .hpi. So rev31.gp3 (the 3.1 patch) beats everything and
 * Core Contingency / Battle Tactics (.ccx) beat the base game. RWE doesn't define an order within one
 * extension; we sort names alphabetically and let the later name win (tactics8 over tactics1).
 */

const EXTENSION_PRIORITY = ['.hpi', '.ufo', '.ccx', '.gpf', '.gp3'];

export function isArchiveName(name: string): boolean {
  return EXTENSION_PRIORITY.includes(extensionOf(name));
}

/** Sorts archive file names from lowest to highest priority (the order they should be mounted). */
export function archiveLoadOrder(names: string[]): string[] {
  return names
    .filter(isArchiveName)
    .sort((a, b) => {
      const pa = EXTENSION_PRIORITY.indexOf(extensionOf(a));
      const pb = EXTENSION_PRIORITY.indexOf(extensionOf(b));
      if (pa !== pb) return pa - pb;
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export interface VfsFile {
  /** Path as stored in the winning archive (original case). */
  path: string;
  size: number;
  archive: HpiArchive;
  entry: HpiFile;
  /** Names of lower-priority archives that also contain this path and were overridden. */
  overrides: string[];
}

export class Vfs {
  /** Lowercased path -> winning file. */
  private readonly index = new Map<string, VfsFile>();
  readonly archives: HpiArchive[] = [];

  /** Opens archives and mounts them in TA's load order, whatever order they are passed in. */
  static async fromSources(sources: ByteSource[]): Promise<Vfs> {
    const byName = new Map(sources.map((s) => [s.name, s]));
    const vfs = new Vfs();
    for (const name of archiveLoadOrder([...byName.keys()])) {
      vfs.mount(await HpiArchive.open(byName.get(name)!));
    }
    return vfs;
  }

  /** Mounts an archive on top of everything mounted so far. */
  mount(archive: HpiArchive): void {
    this.archives.push(archive);
    for (const entry of archive.files()) {
      const key = normalize(entry.path);
      const prev = this.index.get(key);
      this.index.set(key, {
        path: entry.path,
        size: entry.size,
        archive,
        entry,
        overrides: prev ? [...prev.overrides, prev.archive.name] : [],
      });
    }
  }

  get fileCount(): number {
    return this.index.size;
  }

  stat(path: string): VfsFile | undefined {
    return this.index.get(normalize(path));
  }

  exists(path: string): boolean {
    return this.index.has(normalize(path));
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.stat(path);
    if (!f) throw new Error(`File not found: ${path}`);
    return f.archive.extract(f.entry);
  }

  /** All winning files, sorted by path. */
  list(): VfsFile[] {
    return [...this.index.values()].sort((a, b) => cmp(a.path.toLowerCase(), b.path.toLowerCase()));
  }

  /** Files directly inside `dir` (not subdirectories), optionally filtered by extension like ".fbi". */
  listDir(dir: string, extension?: string): VfsFile[] {
    const prefix = normalize(dir) + '/';
    const ext = extension?.toLowerCase();
    return this.list().filter((f) => {
      const p = f.path.toLowerCase();
      return p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && (!ext || p.endsWith(ext));
    });
  }
}

export function normalize(path: string): string {
  return splitPath(path).join('/').toLowerCase();
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
