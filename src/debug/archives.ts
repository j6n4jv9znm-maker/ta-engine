/*
 * Debug page: browse the layered archives, extract any file, view any unit's FBI as JSON, and preview
 * GAF sprites frame by frame.
 * Reads data/ through the dev server when available, or a folder you pick in the browser.
 */
import { frameToRgba, parseGaf, type GafEntry } from '../formats/gaf';
import { latin1 } from '../formats/hpi';
import { parsePalette, PALETTE_PATH, type Palette } from '../formats/palette';
import { getBlock, getValue, parseTdfWithWarnings } from '../formats/tdf';
import { listUnitFiles } from '../units';
import type { Vfs, VfsFile } from '../vfs';
import { openDevServerVfs, openPickedVfs } from './devData';

type Tab = 'files' | 'units' | 'archives';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const listEl = $('list');
const rightEl = $('right');
const filterEl = $<HTMLInputElement>('filter');

let vfs: Vfs | undefined;
let palette: Palette | undefined;
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

async function load(open: () => Promise<Vfs | undefined>, from: string, none: string): Promise<void> {
  statusEl.textContent = 'Opening archives…';
  try {
    const v = await open();
    if (!v) {
      statusEl.textContent = none;
      return;
    }
    vfs = v;
    units = undefined;
    palette = v.exists(PALETTE_PATH) ? parsePalette(await v.read(PALETTE_PATH)) : undefined;
    statusEl.textContent = `${v.archives.length} archives, ${v.fileCount} files (${from})`;
    render();
  } catch (e) {
    statusEl.innerHTML = `<span class="err">${esc(String(e))}</span>`;
  }
}

$<HTMLInputElement>('picker').addEventListener('change', (ev) => {
  const files = (ev.target as HTMLInputElement).files ?? [];
  void load(() => openPickedVfs(files), 'picked folder', 'That folder has no .hpi/.ufo/.ccx/.gp3 files.');
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

  if (/\.gaf$/i.test(f.path) && palette) {
    try {
      showGaf(body, parseGaf(bytes), palette);
    } catch (e) {
      body.innerHTML = `<p class="err">${esc(String(e))}</p>`;
    }
  } else if (/\.pal$/i.test(f.path) && bytes.length >= 1024) {
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

let gafTimer: number | undefined;

/** Lists a GAF's entries; clicking one plays its frames on a canvas. */
function showGaf(body: HTMLElement, entries: GafEntry[], pal: Palette): void {
  body.innerHTML = `<div class="dim">${entries.length} entries. Click one to play it.</div>
    <div style="display:flex;gap:16px;margin-top:8px">
      <div id="gafList" style="min-width:180px"></div>
      <div><canvas id="gafCanvas" style="image-rendering:pixelated;background:#335;width:256px"></canvas>
      <div id="gafInfo" class="dim"></div></div>
    </div>`;
  const listDiv = $('gafList');
  const canvas = $<HTMLCanvasElement>('gafCanvas');
  const info = $('gafInfo');
  const play = (e: GafEntry) => {
    window.clearInterval(gafTimer);
    let i = 0;
    const draw = () => {
      const fr = e.frames[i % e.frames.length];
      if (!fr) return;
      canvas.width = Math.max(1, fr.width);
      canvas.height = Math.max(1, fr.height);
      canvas.style.width = `${Math.min(512, fr.width * 4)}px`;
      const img = new ImageData(new Uint8ClampedArray(frameToRgba(fr, pal)), canvas.width, canvas.height);
      canvas.getContext('2d')!.putImageData(img, 0, 0);
      info.textContent = `${e.name}: frame ${(i % e.frames.length) + 1}/${e.frames.length}, ${fr.width}x${fr.height}, ${fr.layers.length} layer(s)`;
      i++;
    };
    draw();
    if (e.frames.length > 1) gafTimer = window.setInterval(draw, 100);
  };
  for (const e of entries) {
    const d = document.createElement('div');
    d.style.cursor = 'pointer';
    d.textContent = `${e.name} (${e.frames.length})`;
    d.addEventListener('click', () => play(e));
    listDiv.append(d);
  }
  if (entries[0]) play(entries[0]);
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

void load(openDevServerVfs, 'data/ folder', 'No data/ folder found. Pick your TA folder instead.');
