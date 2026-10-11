/*
 * Phase 5 milestone page: a sandbox on a real map. Select your units (click or drag a box) and move
 * them around with right-click; they path around cliffs, water, rocks and each other.
 *
 * The simulation (src/sim/world.ts) runs at a fixed 30 Hz and only changes through commands. This page
 * turns mouse and keyboard input into commands and draws whatever the simulation says.
 */
import * as THREE from 'three';
import { parse3do } from '../formats/3do';
import { parsePalette, PALETTE_PATH, type Palette } from '../formats/palette';
import { createFeatureSprites, type FeatureSprites } from '../graphics/featureSprites';
import { RtsCamera } from '../graphics/rtsCamera';
import { createTerrain, type Terrain } from '../graphics/terrain';
import { loadTextureLibrary, type TextureLibrary } from '../graphics/textures';
import { createUnitModel, type UnitModel } from '../graphics/threeModel';
import { UnitRenderer } from '../graphics/unitRenderer';
import { loadFeatureDefinitions, type FeatureDef } from '../map/features';
import { listMaps, loadGameMap, type GameMap } from '../map/mapData';
import { UnitAssetLoader } from '../sim/assets';
import { TICKS_PER_SECOND } from '../sim/pieces';
import { loadUnitDefs } from '../sim/unitDef';
import { World, type SimUnit, type UnitAssets } from '../sim/world';
import type { Vfs } from '../vfs';
import { openDevServerVfs, openPickedVfs } from './devData';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const mapSel = $<HTMLSelectElement>('map');
const clockEl = $('clock');
const selInfoEl = $('selInfo');
const minimapEl = $<HTMLCanvasElement>('minimap');
const boxEl = $('box');
const view = $('view');

/** The player's side and the computer-less "other side" placed for scenery. */
const ME = 0;
const ARMY: [string, number][] = [
  ['ARMCOM', 1],
  ['ARMPW', 6],
  ['ARMSTUMP', 4],
  ['ARMFLASH', 4],
  ['ARMJETH', 3],
  ['ARMBULL', 2],
  ['ARMHAM', 3],
];
const OTHER_SIDE: [string, number][] = [
  ['CORCOM', 1],
  ['CORAK', 6],
  ['CORRAID', 4],
];
const TEAM_COLOURS = [0, 1]; // blue for you, red for the other side

let vfs: Vfs | undefined;
let palette: Palette | undefined;
let lib: TextureLibrary | undefined;
let featureDefs: Map<string, FeatureDef> | undefined;
let loader: UnitAssetLoader | undefined;
const assets = new Map<string, UnitAssets>();

interface Game {
  map: GameMap;
  world: World;
  terrain: Terrain;
  sprites: FeatureSprites;
  featureModels: UnitModel[];
  units: UnitRenderer;
  group: THREE.Group;
}
let game: Game | undefined;
const selected = new Set<number>();
let paused = false;

// --- Scene ------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.domElement.className = 'main';
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-1, 4, 1);
scene.add(sun);
const rts = new RtsCamera(renderer.domElement, { mapWidth: 1, mapHeight: 1 }, { wasd: false, dragButtons: [1] });

function resize(): void {
  renderer.setSize(view.clientWidth, view.clientHeight, false);
  rts.resize(view.clientWidth, view.clientHeight);
}
window.addEventListener('resize', resize);
resize();

// --- Fixed-step loop ----------------------------------------------------------
const TICK_MS = 1000 / TICKS_PER_SECOND;
let last = performance.now();
let acc = 0;
renderer.setAnimationLoop((t) => {
  const dt = Math.min(250, t - last);
  last = t;
  rts.update(dt / 1000);
  if (game && !paused) {
    acc += dt;
    while (acc >= TICK_MS) {
      acc -= TICK_MS;
      game.world.tick();
    }
  }
  if (game) {
    for (const id of selected) if (!game.world.units.has(id)) selected.delete(id);
    game.units.update(game.world, paused ? 1 : acc / TICK_MS, selected);
    const secs = Math.floor(game.world.tickCount / TICKS_PER_SECOND);
    clockEl.textContent = `Game time ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} (tick ${game.world.tickCount})`;
  }
  renderer.render(scene, rts.camera);
  drawMinimap();
});

// --- Loading -------------------------------------------------------------------
async function load(open: () => Promise<Vfs | undefined>, none: string): Promise<void> {
  statusEl.textContent = 'Opening archives…';
  try {
    const v = await open();
    if (!v) {
      statusEl.textContent = none;
      return;
    }
    vfs = v;
    statusEl.textContent = 'Loading textures, features and units…';
    palette = parsePalette(await v.read(PALETTE_PATH));
    lib = await loadTextureLibrary(v, palette);
    featureDefs = await loadFeatureDefinitions(v);
    loader = new UnitAssetLoader(v, await loadUnitDefs(v));
    for (const [name] of [...ARMY, ...OTHER_SIDE]) {
      const a = await loader.load(name);
      if (a) assets.set(a.def.unitName.toLowerCase(), a);
    }
    mapSel.textContent = '';
    for (const name of listMaps(v)) {
      if (/example/i.test(name)) continue;
      const o = document.createElement('option');
      o.value = o.textContent = name;
      mapSel.append(o);
    }
    mapSel.value = [...mapSel.options].some((o) => o.value === 'The Pass') ? 'The Pass' : (mapSel.options[0]?.value ?? '');
    await startGame(mapSel.value);
  } catch (e) {
    statusEl.textContent = String(e);
  }
}

async function startGame(mapName: string): Promise<void> {
  if (!vfs || !palette || !lib || !featureDefs) return;
  statusEl.textContent = `Loading ${mapName}…`;
  const map = await loadGameMap(vfs, mapName, featureDefs);
  const world = new World(map, 20261011);
  const starts = map.ota?.schemas[0]?.startPositions.filter((p): p is { x: number; z: number } => !!p) ?? [];
  const mine = starts[0] ?? { x: map.widthUnits / 2, z: map.heightUnits / 2 };
  const theirs = starts[1];
  spawnGroup(world, ARMY, ME, mine.x, mine.z);
  if (theirs) spawnGroup(world, OTHER_SIDE, 1, theirs.x, theirs.z);

  const terrain = createTerrain(map.tnt, palette);
  const sprites = await createFeatureSprites(vfs, palette, map.features);
  const { group: featureGroup, models: featureModels } = await createFeatureModels(map);
  const units = new UnitRenderer(lib, palette, (u) => assets.get(u.def.unitName.toLowerCase()), (owner) => TEAM_COLOURS[owner] ?? owner);

  stopGame();
  const group = new THREE.Group();
  group.add(terrain.mesh, sprites.group, featureGroup, units.group);
  scene.add(group);
  game = { map, world, terrain, sprites, featureModels, units, group };
  // Handy from the browser console while debugging: window.ta.game.world, window.ta.selected, ...
  (window as unknown as { ta: unknown }).ta = { game, selected, scene, rts };
  selected.clear();
  acc = 0;
  rts.setMap({ mapWidth: map.widthUnits, mapHeight: map.heightUnits, heightAt: (x, z) => world.terrain.heightAt(x, z) });
  rts.lookAt(mine.x, mine.z);
  rts.distance = 700;
  prepareMinimap(map);
  updateSelInfo();
  statusEl.textContent = `${mapName}: ${world.units.size} units`;
}

function spawnGroup(world: World, list: [string, number][], owner: number, x: number, z: number): void {
  let i = 0;
  for (const [name, count] of list) {
    const a = assets.get(name.toLowerCase());
    if (!a) continue;
    for (let k = 0; k < count; k++, i++) {
      // Lay them out in a loose grid around the start, facing the middle of the map.
      const gx = (i % 6) - 2.5;
      const gz = Math.floor(i / 6) - 1;
      world.spawn(a, owner, x + gx * 48, z + gz * 48, z < world.map.heightUnits / 2 ? 0 : 32768);
    }
  }
}

function stopGame(): void {
  if (!game) return;
  scene.remove(game.group);
  game.terrain.dispose();
  game.sprites.dispose();
  game.featureModels.forEach((m) => m.dispose());
  game.units.dispose();
  game = undefined;
}

/** Wrecks and other features that are 3D models (as on the map viewer page). */
async function createFeatureModels(map: GameMap): Promise<{ group: THREE.Group; models: UnitModel[] }> {
  const group = new THREE.Group();
  const byObject = new Map<string, UnitModel | null>();
  for (const f of map.features) {
    if (!f.def.object) continue;
    const key = f.def.object.toLowerCase();
    if (!byObject.has(key)) {
      const path = `objects3d/${f.def.object}.3do`;
      byObject.set(key, vfs!.exists(path) ? createUnitModel(parse3do(await vfs!.read(path)), lib!, palette!) : null);
    }
    const model = byObject.get(key);
    if (!model) continue;
    const inst = model.root.clone();
    inst.position.set(f.x, f.y, f.z);
    inst.rotation.y = Math.PI;
    group.add(inst);
  }
  return { group, models: [...byObject.values()].filter((m): m is UnitModel => m !== null) };
}

// --- Selection and orders ------------------------------------------------------------
const canvas = renderer.domElement;
let dragStart: { x: number; y: number } | undefined;

function localPoint(e: MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** A unit's position on screen, in canvas pixels. */
function screenPos(u: SimUnit): { x: number; y: number; behind: boolean } {
  const v = new THREE.Vector3(u.x, u.y + 8, u.z).project(rts.camera);
  return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight, behind: v.z > 1 };
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) dragStart = localPoint(e);
});

window.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  const p = localPoint(e);
  const x = Math.min(p.x, dragStart.x);
  const y = Math.min(p.y, dragStart.y);
  Object.assign(boxEl.style, {
    display: 'block',
    left: `${x}px`,
    top: `${y}px`,
    width: `${Math.abs(p.x - dragStart.x)}px`,
    height: `${Math.abs(p.y - dragStart.y)}px`,
  });
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !dragStart || !game) {
    dragStart = undefined;
    return;
  }
  const p = localPoint(e);
  const start = dragStart;
  dragStart = undefined;
  boxEl.style.display = 'none';
  if (!e.shiftKey) selected.clear();
  const mine = [...game.world.units.values()].filter((u) => u.owner === ME);
  if (Math.hypot(p.x - start.x, p.y - start.y) < 5) {
    // Click: the nearest of my units under the cursor.
    let best: SimUnit | undefined;
    let bestD = Infinity;
    for (const u of mine) {
      const s = screenPos(u);
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      const radius = (Math.max(u.def.footprintX, u.def.footprintZ) * 16 * 700) / rts.distance;
      if (!s.behind && d < Math.max(14, radius) && d < bestD) {
        best = u;
        bestD = d;
      }
    }
    if (best) {
      if (e.shiftKey && selected.has(best.id)) selected.delete(best.id);
      else selected.add(best.id);
    }
  } else {
    const x0 = Math.min(p.x, start.x);
    const x1 = Math.max(p.x, start.x);
    const y0 = Math.min(p.y, start.y);
    const y1 = Math.max(p.y, start.y);
    for (const u of mine) {
      const s = screenPos(u);
      if (!s.behind && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) selected.add(u.id);
    }
  }
  updateSelInfo();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!game || selected.size === 0) return;
  const p = localPoint(e);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((p.x / canvas.clientWidth) * 2 - 1, -(p.y / canvas.clientHeight) * 2 + 1), rts.camera);
  const hit = ray.intersectObject(game.terrain.mesh, false)[0];
  if (!hit) return;
  game.world.issue({ kind: 'move', unitIds: [...selected], x: hit.point.x, z: hit.point.z });
  showMoveMarker(hit.point);
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
  if (!game) return;
  if (e.key.toLowerCase() === 's' && selected.size) game.world.issue({ kind: 'stop', unitIds: [...selected] });
  if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    for (const u of game.world.units.values()) if (u.owner === ME) selected.add(u.id);
    updateSelInfo();
  }
  if (e.key === 'Escape') {
    selected.clear();
    updateSelInfo();
  }
});

// A short-lived marker where a move order was given.
const marker = new THREE.Mesh(
  new THREE.RingGeometry(6, 9, 24).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x88ff88, depthTest: false, transparent: true }),
);
marker.renderOrder = 3;
marker.visible = false;
scene.add(marker);
let markerTimer: number | undefined;
function showMoveMarker(p: THREE.Vector3): void {
  marker.position.set(p.x, p.y + 1, p.z);
  marker.visible = true;
  window.clearTimeout(markerTimer);
  markerTimer = window.setTimeout(() => (marker.visible = false), 600);
}

function updateSelInfo(): void {
  if (!game || selected.size === 0) {
    selInfoEl.textContent = 'Nothing selected.';
    return;
  }
  const counts = new Map<string, number>();
  for (const id of selected) {
    const u = game.world.units.get(id);
    if (u) counts.set(u.def.name || u.def.unitName, (counts.get(u.def.name || u.def.unitName) ?? 0) + 1);
  }
  selInfoEl.textContent = `Selected ${selected.size}:\n` + [...counts].map(([n, c]) => `  ${c} × ${n}`).join('\n');
}

// --- Minimap --------------------------------------------------------------------------
let minimapImage: ImageData | undefined;

function prepareMinimap(map: GameMap): void {
  const { width, height, pixels } = map.tnt.minimap;
  minimapEl.width = width;
  minimapEl.height = height;
  const img = new ImageData(width, height);
  for (let i = 0; i < pixels.length; i++) {
    const c = palette!.color(pixels[i]!);
    img.data.set([c.r, c.g, c.b, 255], i * 4);
  }
  minimapImage = img;
  minimapEl.style.width = `${Math.min(width * 1.5, 260)}px`;
}

function drawMinimap(): void {
  if (!game || !minimapImage) return;
  const g = minimapEl.getContext('2d')!;
  g.putImageData(minimapImage, 0, 0);
  const sx = minimapEl.width / game.map.widthUnits;
  const sz = minimapEl.height / game.map.heightUnits;
  for (const u of game.world.units.values()) {
    g.fillStyle = selected.has(u.id) ? '#fff' : u.owner === ME ? '#3c6cff' : '#ff3c3c';
    g.fillRect(u.x * sx - 1, u.z * sz - 1, 2, 2);
  }
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -rts.target.y);
  const ray = new THREE.Raycaster();
  const hit = new THREE.Vector3();
  g.strokeStyle = '#fff';
  g.beginPath();
  [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ].forEach(([x, y], i) => {
    ray.setFromCamera(new THREE.Vector2(x, y), rts.camera);
    if (!ray.ray.intersectPlane(plane, hit)) return;
    if (i === 0) g.moveTo(hit.x * sx, hit.z * sz);
    else g.lineTo(hit.x * sx, hit.z * sz);
  });
  g.closePath();
  g.stroke();
}

minimapEl.addEventListener('mousedown', (e) => {
  if (!game) return;
  const point = (ev: MouseEvent) => {
    const r = minimapEl.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * game!.map.widthUnits, ((ev.clientY - r.top) / r.height) * game!.map.heightUnits] as const;
  };
  if (e.button === 2 && selected.size) {
    const [x, z] = point(e);
    game.world.issue({ kind: 'move', unitIds: [...selected], x, z });
    return;
  }
  const jump = (ev: MouseEvent) => {
    const [x, z] = point(ev);
    rts.lookAt(x, z);
  };
  jump(e);
  const move = (ev: MouseEvent) => jump(ev);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', () => window.removeEventListener('mousemove', move), { once: true });
  e.stopPropagation();
});
minimapEl.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Controls ---------------------------------------------------------------------------
mapSel.addEventListener('change', () => void startGame(mapSel.value));
$('restart').addEventListener('click', () => void startGame(mapSel.value));
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
});
$<HTMLInputElement>('picker').addEventListener('change', (ev) => {
  const files = (ev.target as HTMLInputElement).files ?? [];
  void load(() => openPickedVfs(files), 'That folder has no .hpi/.ufo/.ccx/.gp3 files.');
});

void load(openDevServerVfs, 'No data/ folder found. Pick your TA folder instead.');
