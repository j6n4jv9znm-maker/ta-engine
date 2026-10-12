import type { SavedGame } from '../sim/skirmish';

/*
 * Saved games, kept in the browser's (or the Mac app's) local storage, newest first. A save is small:
 * the game's settings plus the player's commands.
 */

const KEY = 'ta.saves';
const MAX_SAVES = 20;

export function listSaves(): SavedGame[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as SavedGame[];
    return Array.isArray(list) ? list.filter((s) => s && s.version === 1) : [];
  } catch {
    return [];
  }
}

/** Stores a save; returns false if the storage refused it. */
export function addSave(save: SavedGame): boolean {
  const list = [save, ...listSaves()].slice(0, MAX_SAVES);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function deleteSave(savedAt: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(listSaves().filter((s) => s.savedAt !== savedAt)));
  } catch {
    // nothing to do
  }
}

/** "Ashap Plateau · Core vs medium · 12:05 played · 11 Oct 14:20" */
export function describeSave(s: SavedGame): string {
  const secs = Math.floor(s.tick / 30);
  const played = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const side = s.settings.side === 'arm' ? 'Arm' : 'Core';
  const against = s.settings.opponent === 'none' ? 'sandbox' : `vs ${s.settings.opponent}`;
  const when = new Date(s.savedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `${s.settings.map} · ${side} ${against} · ${played} played · ${when}`;
}
