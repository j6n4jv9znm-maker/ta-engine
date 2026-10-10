import { BlobSource } from '../io/byteSource';
import { HttpRangeSource } from '../io/httpSource';
import { isArchiveName, Vfs } from '../vfs';

/** Opens the archives in data/ through the dev server. Returns undefined when there are none. */
export async function openDevServerVfs(): Promise<Vfs | undefined> {
  try {
    const res = await fetch('/__ta-data/');
    const list = (await res.json()) as { name: string; size: number }[];
    if (list.length === 0) return undefined;
    return await Vfs.fromSources(
      list.map((a) => new HttpRangeSource(a.name, a.size, `/__ta-data/${encodeURIComponent(a.name)}`)),
    );
  } catch {
    return undefined;
  }
}

/** Opens the archives among files the user picked (e.g. from a folder input). */
export async function openPickedVfs(files: Iterable<File>): Promise<Vfs | undefined> {
  const archives = [...files].filter((f) => isArchiveName(f.name));
  if (archives.length === 0) return undefined;
  return Vfs.fromSources(archives.map((f) => new BlobSource(f.name, f)));
}
