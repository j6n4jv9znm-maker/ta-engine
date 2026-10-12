import { invoke } from '@tauri-apps/api/core';
import { Vfs } from '../vfs';
import { checkRange, type ByteSource } from './byteSource';

/*
 * Game files inside the Mac app (Tauri). The app remembers the player's Total Annihilation folder
 * and reads byte ranges from its archives on request (src-tauri/src/lib.rs).
 */

export function inApp(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

class AppArchiveSource implements ByteSource {
  constructor(
    readonly name: string,
    readonly size: number,
  ) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this, offset, length);
    if (length === 0) return new Uint8Array(0);
    const buf = await invoke<ArrayBuffer>('read_range', { name: this.name, offset, length });
    const bytes = new Uint8Array(buf);
    if (bytes.length !== length) throw new Error(`${this.name}: expected ${length} bytes, got ${bytes.length}`);
    return bytes;
  }
}

/** The remembered game folder, if any. */
export function appDataDir(): Promise<string | null> {
  return invoke<string | null>('data_dir');
}

/** Shows a folder picker; resolves to the chosen folder, or null if cancelled. Rejects with a message if the folder has no archives. */
export function chooseAppDataDir(): Promise<string | null> {
  return invoke<string | null>('choose_data_dir');
}

/** Opens the archives in the remembered folder. */
export async function openAppVfs(): Promise<Vfs | undefined> {
  const list = await invoke<{ name: string; size: number }[]>('list_archives');
  if (list.length === 0) return undefined;
  return Vfs.fromSources(list.map((a) => new AppArchiveSource(a.name, a.size)));
}

/** Writes a line to the app's log file (in the app's settings folder), with the time. */
export function appLog(line: string): void {
  void invoke('app_log', { line: `${new Date().toISOString()} ${line}` }).catch(() => undefined);
}
