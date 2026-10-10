/*
 * Debug page for Phase 1: browse the layered archives, extract any file, view any unit's FBI as JSON.
 * Reads data/ through the dev server when available, or a folder you pick in the browser.
 */
import { latin1 } from '../formats/hpi';
import { parsePalette } from '../formats/palette';
import { getBlock, getValue, parseTdfWithWarnings } from '../formats/tdf';
import { BlobSource, type ByteSource } from '../io/byteSource';
import { HttpRangeSource } from '../io/httpSource';
import { listUnitFiles } from '../units';
import { isArchiveName, Vfs, type VfsFile } from '../vfs';

type Tab = 'files' | 'units' | 'archives';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const listEl = $('list');
const rightEl = $('right');
const filterEl = $<HTMLInputElement>('filter');

let vfs: Vfs | undefined;
let tab: Tab = 'files';
interface UnitRow {
  path: string;
  unitName: string;
  name: string;
  description: string;
}
let units: UnitRow[] | undefined;

const TDF_EXT = /\.(tdf|fbi|ota|gui)$/i;
const TEXT_EXT = /\.(txt|tdf|fbi|ota|gui|bos|h|ini|inf|bat|pl)$/i;

async function load(sources: ByteSource[], from: string): Promise<void> {
  statusEl.textContent = `Opening ${sources.length} archives…`;
  try {
    vfs = await Vfs.fromSources(sources);
    units = undefined;
    statusEl.textContent = `${vfs.archives.length} archives, ${vfs.fileCount} files (${from})`;
    render();
  } catch (e) {
    statusEl.innerHTML = `<span class="err">${esc(String(e))}</span>`;
  }
}

async function loadFromDevServer(): Promise<void> {
  try {
    const res = await fetch('/__ta-data/');
    const list = (await res.json()) as { name: string; size: number }[];
    if (list.length === 0) throw new Error('empty');
    await load(
      list.map((a) => new HttpRangeSource(a.name, a.size, `/__ta-data/${encodeURIComponent(a.name)}`)),
      'data/ folder',
    );
  } catch {
    statusEl.textContent = 'No data/ folder found. Pick your TA folder instead.';
  }
}

$<HTMLInputElement>('picker').addEventListener('change', (ev) => {
  const files = [...((ev.target as HTMLInputElement).files ?? [])].filter((f) => isArchiveName(f.name));
  if (files.length) void load(files.map((f) => new BlobSource(f.name, f)), 'picked folder');
  else statusEl.textContent = 'That folder has no .hpi/.ufo/.ccx/.gp3 files.';
});

for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab as Tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    render();
  });
}
filterEl.addEventListener('input', () => render());

function render(): void {
  if (!vfs) return;
  const q = filterEl.value.trim().toLowerCase();
  listEl.textContent = '';
  if (tab === 'files') renderFiles(vfs, q);
  else if (tab === 'units') void renderUnits(vfs, q);
  else renderArchives(vfs);
}

function renderFiles(v: Vfs, q: string): void {
  const files = v.list().filter((f) => f.path.toLowerCase().includes(q));
  const MAX = 3000;
  const frag = document.createDocumentFragment();
  for (const f of files.slice(0, MAX)) {
    frag.append(row(`${esc(f.path)} <span class="meta">${fmtSize(f.size)}</span>`, () => showFile(v, f)));
  }
  if (files.length > MAX) frag.append(row(`<span class="meta">…${files.length - MAX} more, type to filter</span>`));
  listEl.append(frag);
}

async function renderUnits(v: Vfs, q: string): Promise<void> {
  if (!units) {
    listEl.innerHTML = '<div class="meta">Reading unit files…</div>';
    const out: UnitRow[] = [];
    for (const path of listUnitFiles(v)) {
      const info = getBlock(parseTdfWithWarnings(latin1(await v.read(path))).root, 'UNITINFO') ?? {};
      out.push({
        path,
        unitName: getValue(info, 'UnitName') ?? path,
        name: getValue(info, 'Name') ?? '',
        description: getValue(info, 'Description') ?? '',
      });
    }
    units = out;
    if (tab !== 'units') return;
    listEl.textContent = '';
  }
  const frag = document.createDocumentFragment();
  for (const u of units) {
    const text = `${u.unitName} ${u.name} ${u.description}`.toLowerCase();
    if (!text.includes(q)) continue;
    frag.append(
      row(`${esc(u.unitName)} <span class="meta">${esc(u.name)}, ${esc(u.description)}</span>`, () =>
        showFile(v, v.stat(u.path)!),
      ),
    );
  }
  listEl.append(frag);
}

function renderArchives(v: Vfs): void {
  v.archives.forEach((a, i) => {
    listEl.append(row(`${i + 1}. ${esc(a.name)} <span class="meta">${a.files().length} files</span>`));
  });
  listEl.append(row('<span class="meta">Later archives override earlier ones.</span>'));
}

function row(html: string, onClick?: () => void): HTMLDivElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  if (onClick) {
    d.addEventListener('click', () => {
      listEl.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
      d.classList.add('sel');
      onClick();
    });
  }
  return d;
}

async function showFile(v: Vfs, f: VfsFile): Promise<void> {
  rightEl.innerHTML = `<p class="dim">Extracting ${esc(f.path)}…</p>`;
  let bytes: Uint8Array;
  try {
    bytes = await v.read(f.path);
  } catch (e) {
    rightEl.innerHTML = `<p class="err">${esc(String(e))}</p>`;
    return;
  }
  const over = f.overrides.length ? `, overrides ${esc(f.overrides.join(', '))}` : '';
  rightEl.innerHTML = `
    <div><b>${esc(f.path)}</b></div>
    <div class="dim">${fmtSize(f.size)} from ${esc(f.archive.name)} (${f.entry.compression})${over}</div>
    <p><button id="dl">Download</button></p>
    <div id="body"></div>`;
  $('dl').addEventListener('click', () => download(f.entry.name, bytes));
  const body = $('body');

  if (/\.pal$/i.test(f.path) && bytes.length >= 1024) {
    const pal = parsePalette(bytes);
    const grid = document.createElement('div');
    grid.id = 'pal';
    for (let i = 0; i < 256; i++) {
      const c = document.createElement('div');
      c.style.background = pal.hex(i);
      c.title = `${i}: ${pal.hex(i)}`;
      c.textContent = String(i);
      grid.append(c);
    }
    body.append(grid);
  } else if (TDF_EXT.test(f.path) && looksLikeText(bytes)) {
    const { root, warnings } = parseTdfWithWarnings(latin1(bytes));
    const warn = warnings.map((w) => `line ${w.line}: ${w.message}`).join('\n');
    body.innerHTML = `${warn ? `<pre class="err">${esc(warn)}</pre>` : ''}<pre>${esc(JSON.stringify(root, null, 2))}</pre>`;
  } else if (TEXT_EXT.test(f.path) || looksLikeText(bytes)) {
    body.innerHTML = `<pre>${esc(latin1(bytes))}</pre>`;
  } else {
    body.innerHTML = `<div class="dim">Binary file. First bytes:</div><pre>${esc(hexDump(bytes.subarray(0, 512)))}</pre>`;
  }
}

function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 2048);
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b < 9 || (b > 13 && b < 32 && b !== 26)) return false;
  }
  return true;
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = [...bytes.subarray(i, i + 16)];
    const hex = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(6, '0')}  ${hex.padEnd(48)}  ${ascii}`);
  }
  return lines.join('\n');
}

function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

void loadFromDevServer();
