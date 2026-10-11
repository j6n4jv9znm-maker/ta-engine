/*
 * Sandbox on a real map (Phases 5 and 6): select units, move them, and build a base and an army from a
 * Commander: build menus, placing buildings, factories, rally points, reclaiming, and the economy.
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
import { loadBuildMenus, type BuildMenus } from '../sim/buildMenus';
import { TICKS_PER_SECOND } from '../sim/pieces';
import { loadUnitDefs } from '../sim/unitDef';
import { World, type SimFeature, type SimUnit, type UnitAssets } from '../sim/world';
import type { Vfs } from '../vfs';
import { openDevServerVfs, openPickedVfs } from './devData';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const mapSel = $<HTMLSelectElement>('map');
const startWithSel = $<HTMLSelectElement>('startWith');
const clockEl = $('clock');
const selInfoEl = $('selInfo');
const commandsEl = $('commands');
const buildEl = $('build');
const minimapEl = $<HTMLCanvasElement>('minimap');
const boxEl = $('box');
const view = $('view');

const ME = 0;
const ARMY: [string, number][] = [
  ['ARMPW', 6],
  ['ARMSTUMP', 4],
  ['ARMFLASH', 4],
  ['ARMJETH', 3],
  ['ARMHAM', 3],
];
const TEAM_COLOURS = [0, 1]; // blue for you, red for the other side

let vfs: Vfs | undefined;
let palette: Palette | undefined;
let lib: TextureLibrary | undefined;
let featureDefs: Map<string, FeatureDef> | undefined;
let menus: BuildMenus = new Map();
const assets = new Map<string, UnitAssets>();

interface Game {
  map: GameMap;
  world: World;
  terrain: Terrain;
  sprites: FeatureSprites;
  featureModels: UnitModel[];
  featureObjects: Map<number, THREE.Object3D>;
  hiddenFeatures: Set<number>;
  units: UnitRenderer;
  group: THREE.Group;
}
let game: Game | undefined;
const selected = new Set<number>();
let paused = false;
let speed = 1;

/** What a left-click does right now. */
type Mode = { kind: 'select' } | { kind: 'place'; unitName: string } | { kind: 'reclaim' };
let mode: Mode = { kind: 'select' };
let menuPage = 0;

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

// Placement ghost: a box the size of the building's footprint.
const ghost = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x55ff55, wireframe: true, transparent: true, opacity: 0.8, depthTest: false }),
);
ghost.visible = false;
ghost.renderOrder = 4;
scene.add(ghost);

// --- Fixed-step loop ----------------------------------------------------------
const TICK_MS = 1000 / TICKS_PER_SECOND;
let last = performance.now();
let acc = 0;
renderer.setAnimationLoop((t) => {
  const dt = Math.min(250, t - last);
  last = t;
  rts.update(dt / 1000);
  if (game && !paused) {
    acc += dt * speed;
    let steps = 0;
    while (acc >= TICK_MS && steps++ < 20) {
      acc -= TICK_MS;
      game.world.tick();
    }
    if (steps >= 20) acc = 0;
  }
  if (game) {
    for (const id of selected) if (!game.world.units.has(id)) selected.delete(id);
    game.units.update(game.world, paused ? 1 : acc / TICK_MS, selected);
    syncFeatures(game);
    const secs = Math.floor(game.world.tickCount / TICKS_PER_SECOND);
    clockEl.textContent = `Game time ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · wind ${game.world.windSpeed}`;
    drawResources(game.world);
    refreshPanelSoon();
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
    statusEl.textContent = 'Loading textures and features…';
    palette = parsePalette(await v.read(PALETTE_PATH));
    lib = await loadTextureLibrary(v, palette);
    featureDefs = await loadFeatureDefinitions(v);
    statusEl.textContent = 'Loading every unit…';
    const defs = await loadUnitDefs(v);
    const loader = new UnitAssetLoader(v, defs);
    for (const name of defs.keys()) {
      const a = await loader.load(name);
      if (a) assets.set(name, a);
    }
    menus = await loadBuildMenus(v, new Set(defs.keys()));
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
  const world = new World(map, { seed: 20261011, assets: (n) => assets.get(n.toLowerCase()) });
  const starts = map.ota?.schemas[0]?.startPositions.filter((p): p is { x: number; z: number } => !!p) ?? [];
  const mine = starts[0] ?? { x: map.widthUnits / 2, z: map.heightUnits / 2 };
  const theirs = starts[1];
  const face = (z: number) => (z < map.heightUnits / 2 ? 0 : 32768);
  world.spawn(assets.get('armcom')!, ME, mine.x, mine.z, face(mine.z));
  if (startWithSel.value === 'army') spawnGroup(world, ARMY, ME, mine.x, mine.z + 120);
  if (theirs) world.spawn(assets.get('corcom')!, 1, theirs.x, theirs.z, face(theirs.z));

  const terrain = createTerrain(map.tnt, palette);
  const sprites = await createFeatureSprites(vfs, palette, map.features);
  const { group: featureGroup, models: featureModels, objects: featureObjects } = await createFeatureModels(map);
  const units = new UnitRenderer(lib, palette, (u) => assets.get(u.def.unitName.toLowerCase()), (owner) => TEAM_COLOURS[owner] ?? owner);

  stopGame();
  const group = new THREE.Group();
  group.add(terrain.mesh, sprites.group, featureGroup, units.group);
  scene.add(group);
  game = { map, world, terrain, sprites, featureModels, featureObjects, hiddenFeatures: new Set(), units, group };
  (window as unknown as { ta: unknown }).ta = { game, selected, scene, rts };
  selected.clear();
  setMode({ kind: 'select' });
  acc = 0;
  rts.setMap({ mapWidth: map.widthUnits, mapHeight: map.heightUnits, heightAt: (x, z) => world.terrain.heightAt(x, z) });
  rts.lookAt(mine.x, mine.z);
  rts.distance = 600;
  prepareMinimap(map);
  // Start with the Commander selected.
  for (const u of world.units.values()) if (u.owner === ME && u.def.commander) selected.add(u.id);
  refreshPanel();
  statusEl.textContent = `${mapName}`;
}

function spawnGroup(world: World, list: [string, number][], owner: number, x: number, z: number): void {
  let i = 0;
  for (const [name, count] of list) {
    const a = assets.get(name.toLowerCase());
    if (!a) continue;
    for (let k = 0; k < count; k++, i++) world.spawn(a, owner, x + ((i % 6) - 2.5) * 48, z + Math.floor(i / 6) * 48);
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
async function createFeatureModels(map: GameMap): Promise<{ group: THREE.Group; models: UnitModel[]; objects: Map<number, THREE.Object3D> }> {
  const group = new THREE.Group();
  const byObject = new Map<string, UnitModel | null>();
  const objects = new Map<number, THREE.Object3D>();
  for (let i = 0; i < map.features.length; i++) {
    const f = map.features[i]!;
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
    objects.set(i, inst);
  }
  return { group, models: [...byObject.values()].filter((m): m is UnitModel => m !== null), objects };
}

/** Hides features the simulation has removed (reclaimed). */
function syncFeatures(g: Game): void {
  for (const f of g.world.features) {
    if (f.alive || g.hiddenFeatures.has(f.id)) continue;
    g.hiddenFeatures.add(f.id);
    g.sprites.setVisible(g.map.features[f.id]!, false);
    const obj = g.featureObjects.get(f.id);
    if (obj) obj.visible = false;
  }
}

// --- Picking ----------------------------------------------------------------------------
const canvas = renderer.domElement;

function localPoint(e: MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function screenPos(x: number, y: number, z: number): { x: number; y: number; behind: boolean } {
  const v = new THREE.Vector3(x, y, z).project(rts.camera);
  return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight, behind: v.z > 1 };
}

function groundAt(p: { x: number; y: number }): THREE.Vector3 | undefined {
  if (!game) return undefined;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((p.x / canvas.clientWidth) * 2 - 1, -(p.y / canvas.clientHeight) * 2 + 1), rts.camera);
  return ray.intersectObject(game.terrain.mesh, false)[0]?.point;
}

/** The unit drawn nearest the cursor, if close enough. */
function unitAt(p: { x: number; y: number }, filter: (u: SimUnit) => boolean): SimUnit | undefined {
  if (!game) return undefined;
  let best: SimUnit | undefined;
  let bestD = Infinity;
  for (const u of game.world.units.values()) {
    if (!filter(u)) continue;
    const s = screenPos(u.x, u.y + 8, u.z);
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    const radius = (Math.max(u.def.footprintX, u.def.footprintZ) * 8 * 600) / rts.distance;
    if (!s.behind && d < Math.max(14, radius) && d < bestD) {
      best = u;
      bestD = d;
    }
  }
  return best;
}

function featureAt(p: { x: number; y: number }): SimFeature | undefined {
  if (!game) return undefined;
  const hit = groundAt(p);
  if (!hit) return undefined;
  let best: SimFeature | undefined;
  let bestD = Infinity;
  for (const f of game.world.features) {
    if (!f.alive || !f.def.reclaimable) continue;
    const d = Math.hypot(f.x - hit.x, f.z - hit.z) - (Math.max(f.def.footprintX, f.def.footprintZ) * 16) / 2;
    if (d < 16 && d < bestD) {
      best = f;
      bestD = d;
    }
  }
  return best;
}

const mineFinished = (u: SimUnit) => u.owner === ME && !!game?.world.isFinished(u);

// --- Mouse and keys -----------------------------------------------------------------------
let dragStart: { x: number; y: number } | undefined;

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) dragStart = localPoint(e);
});

window.addEventListener('mousemove', (e) => {
  if (mode.kind === 'place' && game) updateGhost(localPoint(e));
  if (!dragStart || mode.kind !== 'select') return;
  const p = localPoint(e);
  Object.assign(boxEl.style, {
    display: 'block',
    left: `${Math.min(p.x, dragStart.x)}px`,
    top: `${Math.min(p.y, dragStart.y)}px`,
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

  if (mode.kind === 'place') {
    const builder = selectedBuilder();
    const hit = groundAt(p);
    if (builder && hit) {
      const site = game.world.buildSite(mode.unitName, hit.x, hit.z);
      if (site.ok) game.world.issue({ kind: 'build', unitId: builder.id, unitName: mode.unitName, x: site.x, z: site.z, queue: e.shiftKey });
    }
    if (!e.shiftKey) setMode({ kind: 'select' });
    return;
  }
  if (mode.kind === 'reclaim') {
    const f = featureAt(p);
    if (f) game.world.issue({ kind: 'reclaim', unitIds: builderIds(), featureId: f.id, queue: e.shiftKey });
    if (!e.shiftKey) setMode({ kind: 'select' });
    return;
  }

  if (!e.shiftKey) selected.clear();
  if (Math.hypot(p.x - start.x, p.y - start.y) < 5) {
    const u = unitAt(p, mineFinished);
    if (u) {
      if (e.shiftKey && selected.has(u.id)) selected.delete(u.id);
      else selected.add(u.id);
    }
  } else {
    const x0 = Math.min(p.x, start.x);
    const x1 = Math.max(p.x, start.x);
    const y0 = Math.min(p.y, start.y);
    const y1 = Math.max(p.y, start.y);
    // A box picks mobile units; buildings only if the box catches nothing else (as in TA).
    const inBox = [...game.world.units.values()].filter((u) => {
      if (!mineFinished(u)) return false;
      const s = screenPos(u.x, u.y + 8, u.z);
      return !s.behind && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
    });
    const mobile = inBox.filter((u) => u.def.bmCode !== 0);
    for (const u of mobile.length ? mobile : inBox) selected.add(u.id);
  }
  menuPage = 0;
  refreshPanel();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!game) return;
  if (mode.kind !== 'select') {
    setMode({ kind: 'select' });
    return;
  }
  if (selected.size === 0) return;
  const p = localPoint(e);
  const ids = [...selected];
  const builders = builderIds();
  // Help build a half-finished unit?
  const unfinished = unitAt(p, (u) => u.owner === ME && !game!.world.isFinished(u));
  if (unfinished && builders.length) {
    game.world.issue({ kind: 'assist', unitIds: builders, targetId: unfinished.id, queue: e.shiftKey });
    return;
  }
  // Reclaim a rock, tree or wreck?
  const f = builders.length ? featureAt(p) : undefined;
  if (f) {
    game.world.issue({ kind: 'reclaim', unitIds: builders, featureId: f.id, queue: e.shiftKey });
    return;
  }
  const hit = groundAt(p);
  if (!hit) return;
  game.world.issue({ kind: 'move', unitIds: ids, x: hit.x, z: hit.z, queue: e.shiftKey });
  showMoveMarker(hit);
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
  if (!game) return;
  const k = e.key.toLowerCase();
  if (k === 's' && selected.size) game.world.issue({ kind: 'stop', unitIds: [...selected] });
  if (k === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    for (const u of game.world.units.values()) if (mineFinished(u) && u.def.bmCode !== 0) selected.add(u.id);
    refreshPanel();
  }
  if (e.key === 'Escape') {
    if (mode.kind !== 'select') setMode({ kind: 'select' });
    else {
      selected.clear();
      refreshPanel();
    }
  }
});

function setMode(m: Mode): void {
  mode = m;
  ghost.visible = false;
  canvas.style.cursor = m.kind === 'select' ? '' : 'crosshair';
  refreshPanel();
}

function updateGhost(p: { x: number; y: number }): void {
  if (mode.kind !== 'place' || !game) return;
  const hit = groundAt(p);
  const def = assets.get(mode.unitName.toLowerCase())?.def;
  if (!hit || !def) {
    ghost.visible = false;
    return;
  }
  const site = game.world.buildSite(mode.unitName, hit.x, hit.z);
  const h = Math.max(16, def.footprintX * 4);
  ghost.scale.set(def.footprintX * 16, h, def.footprintZ * 16);
  ghost.position.set(site.x, game.world.terrain.heightAt(site.x, site.z) + h / 2, site.z);
  (ghost.material as THREE.MeshBasicMaterial).color.set(site.ok ? 0x55ff55 : 0xff4444);
  ghost.visible = true;
}

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

// --- Side panel: selection, commands, build menu ------------------------------------------
function selectedUnits(): SimUnit[] {
  return [...selected].map((id) => game?.world.units.get(id)).filter((u): u is SimUnit => !!u);
}

/** The builder whose menu we show: the first selected unit that has one. */
function selectedBuilder(): SimUnit | undefined {
  return selectedUnits().find((u) => u.def.builder && menus.has(u.def.unitName.toLowerCase()));
}

function builderIds(): number[] {
  return selectedUnits()
    .filter((u) => u.def.builder && !u.factory)
    .map((u) => u.id);
}

let panelKey = '';
let panelTimer = 0;
function refreshPanelSoon(): void {
  // Factory queues and task lists change as the game runs; refresh a few times a second.
  if (++panelTimer % 15 === 0) refreshPanel();
}

function refreshPanel(): void {
  const units = selectedUnits();
  const builder = selectedBuilder();
  const queueText = builder?.factory ? builder.factory.queue.map((q) => `${q.unitName}:${q.count}`).join(',') : '';
  const key = `${[...selected].join(',')}|${mode.kind}|${mode.kind === 'place' ? mode.unitName : ''}|${menuPage}|${queueText}|${units.map((u) => u.tasks.length).join(',')}`;
  if (key === panelKey) return;
  panelKey = key;

  // Selection summary.
  if (units.length === 0) {
    selInfoEl.textContent = 'Nothing selected.';
  } else {
    const counts = new Map<string, number>();
    for (const u of units) counts.set(u.def.name || u.def.unitName, (counts.get(u.def.name || u.def.unitName) ?? 0) + 1);
    const tasks = units.length === 1 ? describeTasks(units[0]!) : '';
    selInfoEl.textContent = `Selected ${units.length}:\n` + [...counts].map(([n, c]) => `  ${c} × ${n}`).join('\n') + tasks;
  }

  // Command buttons.
  commandsEl.textContent = '';
  if (units.length) {
    addButton(commandsEl, 'Stop (S)', () => game?.world.issue({ kind: 'stop', unitIds: [...selected] }));
    if (builderIds().length) {
      const b = addButton(commandsEl, 'Reclaim', () => setMode(mode.kind === 'reclaim' ? { kind: 'select' } : { kind: 'reclaim' }));
      b.classList.toggle('on', mode.kind === 'reclaim');
    }
    const switchable = units.filter((u) => u.def.onOffable);
    if (switchable.length) {
      const on = switchable.some((u) => u.scripts?.state.activated);
      addButton(commandsEl, on ? 'Turn off' : 'Turn on', () => game?.world.issue({ kind: 'activate', unitIds: switchable.map((u) => u.id), on: !on }));
    }
  }

  // Build menu.
  buildEl.textContent = '';
  if (!builder) return;
  const pages = menus.get(builder.def.unitName.toLowerCase()) ?? [];
  menuPage = Math.min(menuPage, Math.max(0, pages.length - 1));
  const head = document.createElement('div');
  head.className = 'row';
  head.innerHTML = `<b>${esc(builder.def.name)}</b> <span class="dim">builds (page ${menuPage + 1}/${pages.length})</span>`;
  if (pages.length > 1) {
    addButton(head, '‹', () => {
      menuPage = (menuPage + pages.length - 1) % pages.length;
      refreshPanel();
    });
    addButton(head, '›', () => {
      menuPage = (menuPage + 1) % pages.length;
      refreshPanel();
    });
  }
  buildEl.append(head);
  const grid = document.createElement('div');
  grid.id = 'buildGrid';
  for (const name of pages[menuPage] ?? []) {
    const def = assets.get(name.toLowerCase())?.def;
    if (!def) continue;
    const b = document.createElement('button');
    const queued = builder.factory?.queue.filter((q) => q.unitName === name).reduce((s, q) => s + q.count, 0) ?? 0;
    b.innerHTML = `${esc(def.name)}<small>${Math.round(def.buildCostMetal)} M · ${Math.round(def.buildCostEnergy)} E</small>${queued ? `<span class="count">${queued}</span>` : ''}`;
    b.title = `${def.description}\nBuild time ${Math.round(def.buildTime)}`;
    b.classList.toggle('on', mode.kind === 'place' && mode.unitName === name);
    if (builder.factory) {
      b.addEventListener('click', (e) => game?.world.issue({ kind: 'factory', unitId: builder.id, unitName: name, count: e.shiftKey ? 5 : 1 }));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        game?.world.issue({ kind: 'factory', unitId: builder.id, unitName: name, count: e.shiftKey ? -5 : -1 });
      });
    } else {
      b.addEventListener('click', () => setMode({ kind: 'place', unitName: name }));
    }
    grid.append(b);
  }
  buildEl.append(grid);
}

function describeTasks(u: SimUnit): string {
  if (!game) return '';
  const lines: string[] = [];
  if (!game.world.isFinished(u)) lines.push(`being built: ${Math.round(game.world.buildFraction(u) * 100)}%`);
  for (const t of u.tasks.slice(0, 5)) {
    if (t.kind === 'move') lines.push('move');
    else if (t.kind === 'build') lines.push(`build ${assets.get(t.unitName.toLowerCase())?.def.name ?? t.unitName}`);
    else if (t.kind === 'assist') lines.push('help build');
    else lines.push('reclaim');
  }
  if (u.factory?.queue.length) lines.push('queue: ' + u.factory.queue.map((q) => `${q.count} × ${assets.get(q.unitName.toLowerCase())?.def.name ?? q.unitName}`).join(', '));
  if (u.def.extractsMetal && game.world.isFinished(u)) lines.push(`metal here: ${(game.world.metalUnder(u) * u.def.extractsMetal).toFixed(2)}/s`);
  return lines.length ? '\n' + lines.join('\n') : '';
}

function addButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  parent.append(b);
  return b;
}

// --- Resource bar ---------------------------------------------------------------------------
function drawResources(world: World): void {
  const s = world.players[ME]!.stats();
  const fmt = (r: typeof s.metal, id: 'm' | 'e') => {
    $(`${id}Fill`).style.width = `${r.storage > 0 ? Math.min(100, (r.stock / r.storage) * 100) : 0}%`;
    const el = $(`${id}Text`);
    el.textContent = `${Math.floor(r.stock)}/${Math.round(r.storage)}  +${r.income.toFixed(1)} −${r.wanted.toFixed(1)}`;
    el.classList.toggle('stall', r.stalled);
  };
  fmt(s.metal, 'm');
  fmt(s.energy, 'e');
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
    const r = Math.max(2, (u.def.footprintX * 16 * sx) / 2);
    g.fillRect(u.x * sx - r / 2, u.z * sz - r / 2, r, r);
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
    game.world.issue({ kind: 'move', unitIds: [...selected], x, z, queue: e.shiftKey });
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
startWithSel.addEventListener('change', () => void startGame(mapSel.value));
$('restart').addEventListener('click', () => void startGame(mapSel.value));
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? 'Resume' : 'Pause';
});
$('fast').addEventListener('click', () => {
  speed = speed === 1 ? 4 : 1;
  $('fast').classList.toggle('on', speed > 1);
});
$<HTMLInputElement>('picker').addEventListener('change', (ev) => {
  const files = (ev.target as HTMLInputElement).files ?? [];
  void load(() => openPickedVfs(files), 'That folder has no .hpi/.ufo/.ccx/.gp3 files.');
});

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

void load(openDevServerVfs, 'No data/ folder found. Pick your TA folder instead.');
