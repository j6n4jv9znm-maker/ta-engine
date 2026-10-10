/*
 * Phase 2 milestone page: pick any unit and rotate it, fully textured, in any team colour.
 * Rendering only; there is no simulation here yet.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { allPieces, parse3do } from '../formats/3do';
import { latin1 } from '../formats/hpi';
import { parsePalette, PALETTE_PATH, type Palette } from '../formats/palette';
import { getBlock, getValue, parseTdfWithWarnings } from '../formats/tdf';
import { createUnitModel, type UnitModel } from '../graphics/threeModel';
import { loadTextureLibrary, TEAM_COLOR_COUNT, type TextureLibrary } from '../graphics/textures';
import { listUnitFiles } from '../units';
import type { Vfs } from '../vfs';
import { openDevServerVfs, openPickedVfs } from './devData';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const listEl = $('list');
const infoEl = $('info');
const filterEl = $<HTMLInputElement>('filter');
const wireEl = $<HTMLInputElement>('wire');
const spinEl = $<HTMLInputElement>('spin');
const flashEl = $<HTMLInputElement>('flash');
const view = $('view');

interface UnitRow {
  unitName: string;
  name: string;
  description: string;
  objectName: string;
}

let vfs: Vfs | undefined;
let palette: Palette | undefined;
let lib: TextureLibrary | undefined;
let units: UnitRow[] = [];
let current: UnitModel | undefined;
let team = 0;
let loadToken = 0;

// --- Three.js scene -------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2430);
const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
camera.position.set(60, 50, 80);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-1, 4, 1);
scene.add(sun);
const grid = new THREE.GridHelper(200, 20, 0x335533, 0x223322);
scene.add(grid);
const turntable = new THREE.Group();
scene.add(turntable);

function resize(): void {
  const w = view.clientWidth;
  const h = view.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop((t) => {
  if (spinEl.checked) turntable.rotation.y = (t / 1000) * 0.4;
  controls.update();
  renderer.render(scene, camera);
});

// --- Data loading -----------------------------------------------------------
async function load(open: () => Promise<Vfs | undefined>, none: string): Promise<void> {
  statusEl.textContent = 'Opening archives…';
  try {
    const v = await open();
    if (!v) {
      statusEl.textContent = none;
      return;
    }
    vfs = v;
    statusEl.textContent = 'Loading palette and textures…';
    palette = parsePalette(await v.read(PALETTE_PATH));
    lib = await loadTextureLibrary(v, palette);
    statusEl.textContent = 'Reading unit list…';
    units = [];
    for (const path of listUnitFiles(v)) {
      const info = getBlock(parseTdfWithWarnings(latin1(await v.read(path))).root, 'UNITINFO');
      if (!info) continue;
      const objectName = getValue(info, 'Objectname');
      if (!objectName) continue;
      units.push({
        unitName: getValue(info, 'UnitName') ?? objectName,
        name: getValue(info, 'Name') ?? '',
        description: getValue(info, 'Description') ?? '',
        objectName,
      });
    }
    statusEl.textContent = `${units.length} units, ${lib.textures.size} textures`;
    renderList();
    const start = units.find((u) => u.unitName.toUpperCase() === 'ARMCOM') ?? units[0];
    if (start) void showUnit(start);
  } catch (e) {
    statusEl.textContent = String(e);
  }
}

function renderList(): void {
  const q = filterEl.value.trim().toLowerCase();
  listEl.textContent = '';
  for (const u of units) {
    if (!`${u.unitName} ${u.name} ${u.description}`.toLowerCase().includes(q)) continue;
    const d = document.createElement('div');
    d.innerHTML = `${esc(u.unitName)} <span class="meta">${esc(u.name)}</span>`;
    d.title = u.description;
    d.dataset.unit = u.unitName;
    d.addEventListener('click', () => void showUnit(u));
    listEl.append(d);
  }
  highlight();
}

function highlight(): void {
  const name = current?.root.userData.unitName as string | undefined;
  listEl.querySelectorAll<HTMLDivElement>('div').forEach((d) => d.classList.toggle('sel', d.dataset.unit === name));
}

async function showUnit(u: UnitRow): Promise<void> {
  if (!vfs || !palette || !lib) return;
  const token = ++loadToken;
  const path = `objects3d/${u.objectName}.3do`;
  if (!vfs.exists(path)) {
    infoEl.textContent = `${u.unitName}: model ${path} not found`;
    return;
  }
  const root = parse3do(await vfs.read(path));
  if (token !== loadToken) return;

  if (current) {
    turntable.remove(current.root);
    current.dispose();
  }
  current = createUnitModel(root, lib, palette, team);
  current.root.userData.unitName = u.unitName;
  turntable.add(current.root);
  applyWireframe();
  applyFlashes();
  frame(current.root);
  highlight();

  const pieces = allPieces(root);
  const tris = pieces.reduce((n, p) => n + p.primitives.length, 0);
  infoEl.innerHTML = `<b>${esc(u.unitName)}</b>, ${esc(u.name)}: ${esc(u.description)}<br>
    ${esc(path)}<br>${pieces.length} pieces, ${tris} polygons<br>
    pieces: ${esc(pieces.map((p) => p.name).join(', '))}
    ${current.missingTextures.length ? `<br>missing textures: ${esc(current.missingTextures.join(', '))}` : ''}`;
}

/** Points the camera at the model and sizes the grid to it. */
function frame(obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 10);
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(radius * 1.1, radius * 0.8, radius * 1.5));
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  grid.position.y = box.min.y;
}

function applyWireframe(): void {
  current?.root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      for (const m of [o.material].flat() as THREE.MeshLambertMaterial[]) m.wireframe = wireEl.checked;
    }
  });
}

/**
 * Until unit scripts run (Phase 4), muzzle-flash pieces show as solid blobs. A unit's Create script
 * normally hides them; this is a viewer-only stand-in going by the usual piece names.
 */
const FLASH_PIECE = /fl(a?sh|are)|fire|muzzle/i;
function applyFlashes(): void {
  current?.pieces.forEach((g, name) => {
    const mesh = g.children.find((c) => c instanceof THREE.Mesh);
    if (mesh) mesh.visible = !(flashEl.checked && FLASH_PIECE.test(name));
  });
}

// --- Controls ---------------------------------------------------------------
filterEl.addEventListener('input', renderList);
wireEl.addEventListener('change', applyWireframe);
flashEl.addEventListener('change', applyFlashes);
$<HTMLInputElement>('picker').addEventListener('change', (ev) => {
  const files = (ev.target as HTMLInputElement).files ?? [];
  void load(() => openPickedVfs(files), 'That folder has no .hpi/.ufo/.ccx/.gp3 files.');
});

const swatches = $('swatches');
function renderSwatches(): void {
  swatches.textContent = '';
  for (let i = 0; i < TEAM_COLOR_COUNT; i++) {
    const b = document.createElement('button');
    b.title = `Team ${i + 1}`;
    b.className = i === team ? 'on' : '';
    // The LOGOS "colorsmd" entry is a solid swatch of each team colour; use its centre pixel.
    const img = lib?.teamTextures.get('colorsmd')?.[i];
    if (img) {
      const p = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
      b.style.background = `rgb(${img.rgba[p]},${img.rgba[p + 1]},${img.rgba[p + 2]})`;
    }
    b.addEventListener('click', () => {
      team = i;
      current?.setTeam(i);
      renderSwatches();
    });
    swatches.append(b);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

void load(openDevServerVfs, 'No data/ folder found. Pick your TA folder instead.').then(renderSwatches);
