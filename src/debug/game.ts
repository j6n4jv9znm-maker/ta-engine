/*
 * Sandbox on a real map (Phases 5-7): select units, move them, build a base and an army from a
 * Commander (build menus, placing buildings, factories, rally points, reclaiming, the economy), and
 * fight: attack orders, auto-targeting, shots, explosions, wrecks, line of sight and fog of war.
 *
 * The simulation (src/sim/world.ts) runs at a fixed 30 Hz and only changes through commands. This page
 * turns mouse and keyboard input into commands and draws whatever the simulation says.
 */
import * as THREE from 'three';
import { parse3do } from '../formats/3do';
import { parsePalette, PALETTE_PATH, type Palette } from '../formats/palette';
import { CombatRenderer } from '../graphics/combatRenderer';
import { createFeatureSprites, type FeatureSprites } from '../graphics/featureSprites';
import { RtsCamera } from '../graphics/rtsCamera';
import { parsePcx } from '../formats/pcx';
import { GameAudio, type UnitSoundKey } from '../audio/gameAudio';
import { SetupScreen, type GameSettings } from '../ui/setupScreen';
import { TaGui } from '../ui/taGui';
import { loadCampaigns, loadMission, missionResult, type Mission } from '../map/mission';
import { addSave, deleteSave, describeSave, listSaves } from '../ui/saves';
import { createTerrain, type Terrain } from '../graphics/terrain';
import { loadTextureLibrary, type TextureLibrary } from '../graphics/textures';
import { createUnitModel, type UnitModel } from '../graphics/threeModel';
import { UnitRenderer } from '../graphics/unitRenderer';
import { loadFeatureDefinitions, type FeatureDef } from '../map/features';
import { listMaps, loadGameMap, type GameMap } from '../map/mapData';
import { UnitAssetLoader } from '../sim/assets';
import { loadAiProfile, type AiPlan, type Difficulty } from '../sim/ai/aiProfile';
import { createSkirmish, replayGame, saveGame, type SavedGame } from '../sim/skirmish';
import { loadBuildMenus, type BuildMenus } from '../sim/buildMenus';
import { TICKS_PER_SECOND } from '../sim/pieces';
import { loadUnitDefs } from '../sim/unitDef';
import { EXPLORED, RADAR, SEEN, VIS_TILE } from '../sim/visibility';
import { loadWeaponDefs, type WeaponDef } from '../sim/weaponDef';
import { World, type SimFeature, type SimUnit, type UnitAssets } from '../sim/world';
import type { Vfs } from '../vfs';
import { appDataDir, appLog, chooseAppDataDir, inApp, openAppVfs } from '../io/appData';
import { openDevServerVfs, openPickedVfs } from './devData';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const clockEl = $('clock');
const selInfoEl = $('selInfo');
const commandsEl = $('commands');
const buildEl = $('build');
const minimapEl = $<HTMLCanvasElement>('minimap');
const boxEl = $('box');
const view = $('view');
const loadingEl = $('loading');

const ME = 0;
const TEAM_COLOURS = [0, 1]; // blue for you, red for the other side

let vfs: Vfs | undefined;
let audio: GameAudio | undefined;
let gui: TaGui | undefined;
let palette: Palette | undefined;
let lib: TextureLibrary | undefined;
let featureDefs: Map<string, FeatureDef> | undefined;
let menus: BuildMenus = new Map();
let weapons = new Map<string, WeaponDef>();
let aiPlans = new Map<Difficulty, AiPlan>();
const assets = new Map<string, UnitAssets>();

interface Game {
  map: GameMap;
  world: World;
  terrain: Terrain;
  sprites: FeatureSprites;
  featureModels: UnitModel[];
  featureObjects: Map<number, THREE.Object3D>;
  hiddenFeatures: Set<number>;
  /** Wrecks and heaps that appeared during the game, drawn on their own. */
  extraFeatures: Map<number, { obj: THREE.Object3D; dispose?: () => void }>;
  units: UnitRenderer;
  combat: CombatRenderer;
  fogVersion: number;
  group: THREE.Group;
}
let game: Game | undefined;
const selected = new Set<number>();
let paused = false;
let setup: SetupScreen | undefined;
let settings: GameSettings | undefined;
let seed = 0;
let mission: Mission | undefined;
let missionOutcome: 'won' | 'lost' | undefined;
let speed = 1;

/** What a left-click does right now. */
type Mode = { kind: 'select' } | { kind: 'place'; unitName: string } | { kind: 'reclaim' };
let mode: Mode = { kind: 'select' };
let menuPage = 0;
let menuBuilderId = -1;

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
scene.add(sun, sun.target);
// Shadows, as TA draws under every unit: the sun casts them a little down and to the right. The
// shadow camera follows the view so only what's on screen needs shadow-map space.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0015;
const SUN_DIR = new THREE.Vector3(-0.6, 1, -0.5).normalize();
function aimSun(): void {
  const t = rts.target;
  const reach = rts.viewHalfHeight() * Math.max(1, rts.aspect) * 1.4;
  sun.target.position.copy(t);
  sun.position.copy(t).addScaledVector(SUN_DIR, 3000);
  const cam = sun.shadow.camera;
  Object.assign(cam, { left: -reach, right: reach, top: reach, bottom: -reach, near: 10, far: 8000 });
  cam.updateProjectionMatrix();
}
const rts = new RtsCamera(renderer.domElement, { mapWidth: 1, mapHeight: 1 }, { wasd: false, dragButtons: [1], rotate: false });

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
/** Time spent in each part of the last frame, in ms (for spotting slow frames from the console). */
const frameTimes: Record<string, number> = {};
function timed(name: string, fn: () => void): void {
  const a = performance.now();
  fn();
  frameTimes[name] = performance.now() - a;
}

function frame(t: number): void {
  const dt = Math.max(0, Math.min(250, t - last));
  last = t;
  rts.update(dt / 1000);
  timed('sim', () => {
    if (game && !paused && !setup?.visible) {
      acc += dt * speed;
      let steps = 0;
      while (acc >= TICK_MS && steps++ < 20) {
        acc -= TICK_MS;
        game.world.tick();
      }
      if (steps >= 20) acc = 0;
    }
  });
  if (game) {
    const g = game;
    for (const id of selected) if (!g.world.units.has(id) || g.world.units.get(id)!.dying) selected.delete(id);
    const alpha = paused ? 1 : acc / TICK_MS;
    timed('units', () => g.units.update(g.world, alpha, selected));
    timed('combat', () => g.combat.update(g.world, alpha, dt / 1000, g.units, ME));
    timed('audio', () => audio?.update(g.world, ME, listener()));
    timed('features', () => {
      syncFeatures(g);
      syncFog(g);
    });
    const secs = Math.floor(g.world.tickCount / TICKS_PER_SECOND);
    clockEl.textContent = `Game time ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · wind ${g.world.windSpeed}`;
    timed('panel', () => {
      drawResources(g.world);
      refreshPanelSoon();
    });
  }
  aimSun();
  timed('render', () => renderer.render(scene, rts.camera));
  timed('minimap', drawMinimap);
  timed('overlay', drawOverlay);
}
renderer.setAnimationLoop(frame);

// --- Loading -------------------------------------------------------------------
async function load(open: () => Promise<Vfs | undefined>, none: string): Promise<void> {
  statusEl.textContent = 'Opening archives…';
  // Show loading progress over the whole window until the setup screen appears.
  const progress = new MutationObserver(() => (loadingEl.textContent = statusEl.textContent));
  progress.observe(statusEl, { childList: true, characterData: true, subtree: true });
  loadingEl.textContent = statusEl.textContent;
  loadingEl.hidden = false;
  try {
    const v = await open();
    if (!v) {
      statusEl.textContent = none;
      progress.disconnect();
      loadingEl.hidden = true;
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
    audio = await GameAudio.load(v);
    gui = await TaGui.load(v, palette);
    applyPanelArt('arm');
    weapons = await loadWeaponDefs(v);
    aiPlans = await loadAiProfile(v);
    // Campaign mission maps belong on the Campaign tab, not in the skirmish list.
    const campaigns = await loadCampaigns(v);
    const missionMaps = new Set(campaigns.flatMap((c) => c.missions.map((m) => m.map.toLowerCase())));
    const maps = listMaps(v)
      .filter((n) => !/example/i.test(n) && !missionMaps.has(n.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    setup?.el.remove();
    setup = new SetupScreen(v, palette, maps, (s) => void startGame(s), () => undefined, campaigns);
    document.body.append(setup.el);
    void dressSetupScreen(v);
    showSaves();
    setup.show(false);
    progress.disconnect();
    loadingEl.hidden = true;
    statusEl.textContent = 'Pick a map and press Start game.';
  } catch (e) {
    statusEl.textContent = String(e);
    progress.disconnect();
    loadingEl.hidden = true;
  }
}

async function startGame(s: GameSettings, save?: SavedGame): Promise<void> {
  if (!vfs || !palette || !lib || !featureDefs) return;
  settings = s;
  const mapName = s.map;
  statusEl.textContent = `Loading ${mapName}…`;
  const map = await loadGameMap(vfs, mapName, featureDefs);
  seed = save?.seed ?? (Math.random() * 2 ** 31) | 0;
  const deps = { assets: (n: string) => assets.get(n.toLowerCase()), weapons, featureDefs, menus, aiPlans };
  mission = s.mission ? await loadMission(vfs, s.mission) : undefined;
  missionOutcome = undefined;
  const { world, home: mine } = createSkirmish(map, s, seed, deps, mission);
  if (save) {
    loadingEl.hidden = false;
    await replayGame(world, save, (f) => (loadingEl.textContent = `Loading saved game… ${Math.round(f * 100)}%`));
    loadingEl.hidden = true;
  }
  audio?.reset(world.tickCount);
  applyPanelArt(s.side);
  paused = false;
  $('pause').textContent = 'Pause';

  const terrain = createTerrain(map.tnt, palette);
  const sprites = await createFeatureSprites(vfs, palette, map.features);
  const { group: featureGroup, models: featureModels, objects: featureObjects } = await createFeatureModels(map);
  const units = new UnitRenderer(lib, palette, (u) => assets.get(u.def.unitName.toLowerCase()), (owner) => TEAM_COLOURS[owner] ?? owner);
  units.viewer = ME;
  const combat = new CombatRenderer(vfs, palette);

  stopGame();
  const group = new THREE.Group();
  terrain.mesh.receiveShadow = true;
  featureGroup.traverse((o) => (o.castShadow = o instanceof THREE.Mesh));
  group.add(terrain.mesh, sprites.group, featureGroup, units.group, combat.group);
  scene.add(group);
  game = { map, world, terrain, sprites, featureModels, featureObjects, hiddenFeatures: new Set(), extraFeatures: new Map(), units, combat, fogVersion: -1, group };
  (window as unknown as { ta: unknown }).ta = { game, selected, scene, rts, frameTimes, frame, mode: () => mode, featureAt, groundAt, audio, renderer };
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


function stopGame(): void {
  if (!game) return;
  scene.remove(game.group);
  game.terrain.dispose();
  game.sprites.dispose();
  game.featureModels.forEach((m) => m.dispose());
  game.extraFeatures.forEach((f) => f.dispose?.());
  game.units.dispose();
  game.combat.dispose();
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

/** Hides features the simulation has removed (reclaimed) and draws new ones (wrecks, heaps). */
function syncFeatures(g: Game): void {
  for (const f of g.world.features) {
    if (f.id >= g.map.features.length && f.alive && !g.extraFeatures.has(f.id)) addExtraFeature(g, f);
    if (f.alive || g.hiddenFeatures.has(f.id)) continue;
    g.hiddenFeatures.add(f.id);
    const placed = g.map.features[f.id];
    if (placed) g.sprites.setVisible(placed, false);
    const obj = g.featureObjects.get(f.id) ?? g.extraFeatures.get(f.id)?.obj;
    if (obj) obj.visible = false;
  }
}

const wreckModels = new Map<string, Promise<UnitModel | undefined>>();
function addExtraFeature(g: Game, f: SimFeature): void {
  const holder = new THREE.Group();
  g.extraFeatures.set(f.id, { obj: holder });
  g.group.add(holder);
  if (f.def.object) {
    const key = f.def.object.toLowerCase();
    if (!wreckModels.has(key)) {
      const path = `objects3d/${f.def.object}.3do`;
      wreckModels.set(key, vfs!.exists(path) ? vfs!.read(path).then((b) => createUnitModel(parse3do(b), lib!, palette!)) : Promise.resolve(undefined));
    }
    void wreckModels.get(key)!.then((m) => m && addExtraFeatureModel(holder, f, m));
    return;
  }
  void createFeatureSprites(vfs!, palette!, [{ def: f.def, cellX: f.cellX, cellZ: f.cellZ, x: f.x, y: f.y, z: f.z }]).then((sp) => {
    holder.add(sp.group);
    g.extraFeatures.set(f.id, { obj: holder, dispose: () => sp.dispose() });
  });
}

function addExtraFeatureModel(holder: THREE.Group, f: SimFeature, model: UnitModel): void {
  const inst = model.root.clone();
  inst.position.set(f.x, f.y, f.z);
  inst.rotation.y = Math.PI;
  holder.add(inst);
}

/** Copies the player's line of sight into the terrain's fog. */
function syncFog(g: Game): void {
  const vis = g.world.visibility;
  if (vis.version === g.fogVersion) return;
  g.fogVersion = vis.version;
  const grid = vis.grids[ME]!;
  const out = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = grid[i]! & SEEN ? 255 : grid[i]! & EXPLORED ? 150 : 85;
  g.terrain.setFog(out, vis.width, vis.height, VIS_TILE);
}

/** Health bars over damaged or selected units the player can see. */
const overlay = document.createElement('canvas');
overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;width:100%;height:100%';
view.append(overlay);
function drawOverlay(): void {
  const w = view.clientWidth;
  const h = view.clientHeight;
  if (overlay.width !== w || overlay.height !== h) {
    overlay.width = w;
    overlay.height = h;
  }
  const g = overlay.getContext('2d')!;
  g.clearRect(0, 0, w, h);
  if (!game) return;
  for (const u of game.world.units.values()) {
    if (u.dying || !game.world.isFinished(u)) continue;
    // Self-destruct countdown above the unit, as in TA.
    if (u.selfDestructAt !== undefined && u.owner === ME) {
      const c = screenPos(u.x, u.y + u.height + 20, u.z);
      const left = Math.max(0, Math.ceil((u.selfDestructAt - game.world.tickCount) / 30));
      g.font = 'bold 18px ui-monospace, Menlo, monospace';
      g.textAlign = 'center';
      g.fillStyle = '#000';
      g.fillText(String(left), c.x + 1, c.y + 1);
      g.fillStyle = '#ff5a3c';
      g.fillText(String(left), c.x, c.y);
    }
    const damaged = u.hp < u.def.maxDamage;
    if (!damaged && !selected.has(u.id)) continue;
    if (u.owner !== ME && !(game.world.visibility.at(ME, u.x, u.z) & SEEN)) continue;
    const s = screenPos(u.x, u.y + u.height + 6, u.z);
    if (s.behind || s.x < 0 || s.y < 0 || s.x > w || s.y > h) continue;
    const bw = Math.max(16, (u.def.footprintX * 16 * 500) / rts.distance);
    const f = Math.max(0, u.hp / u.def.maxDamage);
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(s.x - bw / 2 - 1, s.y - 1, bw + 2, 5);
    g.fillStyle = f > 0.6 ? '#4f4' : f > 0.3 ? '#ff4' : '#f44';
    g.fillRect(s.x - bw / 2, s.y, bw * f, 3);
  }
  // Win or lose (a campaign mission by its own goals, checked about once a second).
  if (mission && !missionOutcome && game.world.tickCount % 30 === 0) missionOutcome = missionResult(mission.goals, game.world.units.values());
  const lost = mission ? missionOutcome === 'lost' : game.world.defeated.has(ME);
  const won = mission ? missionOutcome === 'won' : !lost && game.world.players.every((_, p) => p === ME || game!.world.defeated.has(p)) && game.world.players.length > 1;
  if (lost || won) {
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, h / 2 - 40, w, 80);
    g.fillStyle = lost ? '#ff7070' : '#8f8';
    g.font = 'bold 28px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.fillText(mission ? (lost ? 'Mission failed' : 'Mission complete') : lost ? 'Your Commander was destroyed' : 'Victory: the enemy Commander is destroyed', w / 2, h / 2);
    g.font = '14px ui-monospace, Menlo, monospace';
    g.fillStyle = '#ddd';
    g.fillText('Press Restart to play again, or Menu for a new game.', w / 2, h / 2 + 26);
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

/** TA's cursor for what a click would do here: select, move, attack, reclaim or place. */
let cursorAt: { x: number; y: number } | undefined;
let cursorTime = 0;
function updateCursor(): void {
  if (!gui) return;
  let name = 'cursornormal';
  if (mode.kind === 'reclaim') name = 'cursorreclamate';
  else if (mode.kind === 'place') name = 'cursornormal';
  else if (game && cursorAt) {
    const own = unitAt(cursorAt, (u) => u.owner === ME && !u.dying);
    const enemy = selected.size ? unitAt(cursorAt, (u) => u.owner !== ME && !u.dying && game!.world.canSee(ME, u)) : undefined;
    if (enemy) name = 'cursorattack';
    else if (own) name = 'cursorselect';
    else if (selected.size) name = builderIds().length && featureAt(cursorAt) ? 'cursorreclamate' : 'cursormove';
  }
  canvas.style.cursor = gui.cursor(name, mode.kind === 'place' ? 'crosshair' : 'auto');
}

window.addEventListener('mousemove', (e) => {
  if (e.target === canvas && performance.now() - cursorTime > 80) {
    cursorTime = performance.now();
    cursorAt = localPoint(e);
    updateCursor();
  }
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
      if (site.ok && !overlapsQueued(mode.unitName, site)) {
        game.world.issue({ kind: 'build', unitId: builder.id, unitName: mode.unitName, x: site.x, z: site.z, queue: e.shiftKey });
        reply('ok1');
      } else {
        reply('cant1');
        if (!e.shiftKey) return; // stay in placing mode so the player can try another spot
      }
    }
    if (!e.shiftKey) setMode({ kind: 'select' });
    return;
  }
  if (mode.kind === 'reclaim') {
    const f = featureAt(p);
    if (f) {
      game.world.issue({ kind: 'reclaim', unitIds: builderIds(), featureId: f.id, queue: e.shiftKey });
      reply('ok1');
    }
    if (!e.shiftKey) setMode({ kind: 'select' });
    return;
  }

  const before = new Set(selected);
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
  if ([...selected].some((id) => !before.has(id))) reply('select1');
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
  // Attack an enemy unit we can see?
  const enemy = unitAt(p, (u) => u.owner !== ME && !u.dying && game!.world.canSee(ME, u));
  if (enemy) {
    game.world.issue({ kind: 'attack', unitIds: ids, targetId: enemy.id, queue: e.shiftKey });
    reply('ok1');
    return;
  }
  // Help build a half-finished unit?
  const unfinished = unitAt(p, (u) => u.owner === ME && !game!.world.isFinished(u));
  if (unfinished && builders.length) {
    game.world.issue({ kind: 'assist', unitIds: builders, targetId: unfinished.id, queue: e.shiftKey });
    reply('ok1');
    return;
  }
  // Reclaim a rock, tree or wreck?
  const f = builders.length ? featureAt(p) : undefined;
  if (f) {
    game.world.issue({ kind: 'reclaim', unitIds: builders, featureId: f.id, queue: e.shiftKey });
    reply('ok1');
    return;
  }
  const hit = groundAt(p);
  if (!hit) return;
  game.world.issue({ kind: 'move', unitIds: ids, x: hit.x, z: hit.z, queue: e.shiftKey });
  reply('ok1');
  showMoveMarker(hit);
});

// --- Cheats: Enter opens TA's chat line ---------------------------------------------------
const chatEl = $<HTMLInputElement>('chat');
const noteEl = $('note');
const CHEAT_NAMES: Record<string, string> = {
  atm: 'ATM: metal and energy filled (and +10,000 storage)',
  nocost: 'NOCOST: free, instant building',
  nowisee: 'NOWISEE: whole map visible',
  los: 'LOS: whole map visible',
  doubleshot: 'DOUBLESHOT: double damage',
  halfshot: 'HALFSHOT: half damage',
};
let noteTimer: number | undefined;
function note(text: string): void {
  noteEl.textContent = text;
  noteEl.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => (noteEl.hidden = true), 4000);
}
chatEl.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') {
    chatEl.hidden = true;
    chatEl.blur();
  } else if (e.key === 'Enter') {
    const code = chatEl.value.trim().replace(/^\+/, '').toLowerCase();
    chatEl.value = '';
    chatEl.hidden = true;
    chatEl.blur();
    if (!code || !game) return;
    const name = CHEAT_NAMES[code];
    if (!name) {
      note(`Unknown cheat. Try: ${Object.keys(CHEAT_NAMES).map((c) => '+' + c).join(', ')}`);
      return;
    }
    game.world.issue({ kind: 'cheat', player: ME, code });
    const toggles = code !== 'atm';
    const on = toggles ? !game.world.cheat(ME, code === 'los' ? 'nowisee' : code) : true;
    note(`Cheat ${name}${toggles ? (on ? ' (on)' : ' (off)') : ''}`);
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
  if (!game) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    chatEl.hidden = false;
    chatEl.focus();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 's' && selected.size && !(e.ctrlKey || e.metaKey)) game.world.issue({ kind: 'stop', unitIds: [...selected] });
  // Ctrl+D: self-destruct (again to cancel), as in TA. The way to get rid of your own buildings.
  if (k === 'd' && (e.ctrlKey || e.metaKey) && selected.size) {
    e.preventDefault();
    game.world.issue({ kind: 'selfDestruct', unitIds: [...selected] });
  }
  if (e.key === ' ') {
    // Space: look at the selected units, or at your Commander when nothing is selected.
    e.preventDefault();
    const mine = [...game.world.units.values()].filter((u) => u.owner === ME);
    const group = mine.filter((u) => selected.has(u.id));
    const look = group.length ? group : mine.filter((u) => u.def.commander);
    if (look.length) rts.lookAt(look.reduce((a, u) => a + u.x, 0) / look.length, look.reduce((a, u) => a + u.z, 0) / look.length);
  }
  if (e.key === '=' || e.key === '+' || e.key === '-') {
    rts.zoomAt(rts.distance * (e.key === '-' ? 1.25 : 0.8), canvas.clientWidth / 2, canvas.clientHeight / 2);
  }
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

/** The first selected unit answers with one of its sounds (TA plays one reply per order, not one per unit). */
function reply(key: UnitSoundKey): void {
  const u = game ? [...selected].map((id) => game!.world.units.get(id)).find((x) => x) : undefined;
  if (u) audio?.unitSound(u.def, key);
}

/** Where sounds are heard from: the middle of the view, and how wide the view is on the ground. */
function listener(): { x: number; z: number; halfWidth: number; halfDepth: number } {
  // The view's half height is measured across the screen; on the tilted ground it covers more.
  const h = rts.viewHalfHeight();
  return { x: rts.target.x, z: rts.target.z, halfWidth: h * rts.aspect, halfDepth: h / Math.sin(Math.atan(2)) };
}

// Browsers only allow sound once the player has clicked or pressed a key.
window.addEventListener('pointerdown', () => audio?.unlock(), true);
window.addEventListener('keydown', () => audio?.unlock(), true);

function setMode(m: Mode): void {
  mode = m;
  ghost.visible = false;
  updateCursor();
  refreshPanel();
}

/** Whether a building placed at `site` would overlap one already queued (not yet started) by our builders. */
function overlapsQueued(unitName: string, site: { x: number; z: number }): boolean {
  if (!game) return false;
  const def = assets.get(unitName.toLowerCase())?.def;
  if (!def) return false;
  for (const u of game.world.units.values()) {
    if (u.owner !== ME) continue;
    for (const t of u.tasks) {
      if (t.kind !== 'build' || t.targetId !== undefined) continue;
      const other = assets.get(t.unitName.toLowerCase())?.def;
      if (!other) continue;
      const gapX = Math.abs(t.x - site.x) * 2 - (def.footprintX + other.footprintX) * 16;
      const gapZ = Math.abs(t.z - site.z) * 2 - (def.footprintZ + other.footprintZ) * 16;
      if (gapX < 0 && gapZ < 0) return true;
    }
  }
  return false;
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
  (ghost.material as THREE.MeshBasicMaterial).color.set(site.ok && !overlapsQueued(mode.unitName, site) ? 0x55ff55 : 0xff4444);
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
    // One line along the bottom bar, as in TA: what's selected, then (for one unit) its state.
    const names = [...counts].map(([n, c]) => (c > 1 ? `${c} × ${n}` : n)).join(', ');
    const tasks = units.length === 1 ? describeTasks(units[0]!).trim().split('\n').join(' · ') : '';
    selInfoEl.textContent = tasks ? `${names} · ${tasks}` : names;
  }

  // Command buttons.
  commandsEl.textContent = '';
  if (units.length) {
    spriteButton(commandsEl, 'STOP', 0, 'Stop (S)', () => game?.world.issue({ kind: 'stop', unitIds: [...selected] }));
    if (builderIds().length) {
      const b = spriteButton(commandsEl, 'RECLAIM', mode.kind === 'reclaim' ? 1 : 0, 'Reclaim', () => setMode(mode.kind === 'reclaim' ? { kind: 'select' } : { kind: 'reclaim' }));
      b.classList.toggle('on', mode.kind === 'reclaim');
    }
    const switchable = units.filter((u) => u.def.onOffable);
    if (switchable.length) {
      const on = switchable.some((u) => u.scripts?.state.activated);
      spriteButton(commandsEl, 'ONOFF', on ? 2 : 1, on ? 'Turn off' : 'Turn on', () => game?.world.issue({ kind: 'activate', unitIds: switchable.map((u) => u.id), on: !on }));
    }
  }

  // Build menu.
  buildEl.textContent = '';
  if (!builder) return;
  const pages = menus.get(builder.def.unitName.toLowerCase()) ?? [];
  // A different builder starts on its first page.
  if (builder.id !== menuBuilderId) {
    menuBuilderId = builder.id;
    menuPage = 0;
  }
  menuPage = Math.min(menuPage, Math.max(0, pages.length - 1));
  const head = document.createElement('div');
  head.innerHTML = `<b>${esc(builder.def.name)}</b> <span class="dim">can build:</span>`;
  buildEl.append(head);
  if (pages.length > 1) {
    // Page arrows on their own fixed row, so they don't jump around between clicks.
    const nav = document.createElement('div');
    nav.className = 'row';
    spriteButton(nav, 'PREV', 0, '‹ prev', () => {
      menuPage = (menuPage + pages.length - 1) % pages.length;
      refreshPanel();
    });
    const label = document.createElement('span');
    label.className = 'dim';
    label.textContent = `page ${menuPage + 1} of ${pages.length}`;
    nav.append(label);
    spriteButton(nav, 'NEXT', 0, 'next ›', () => {
      menuPage = (menuPage + 1) % pages.length;
      refreshPanel();
    });
    buildEl.append(nav);
  }

  const grid = document.createElement('div');
  grid.id = 'buildGrid';
  for (const name of pages[menuPage] ?? []) {
    const def = assets.get(name.toLowerCase())?.def;
    if (!def) continue;
    const b = document.createElement('button');
    const queued = builder.factory?.queue.filter((q) => q.unitName === name).reduce((s, q) => s + q.count, 0) ?? 0;
    const pic = unitPic(name);
    b.innerHTML = `${pic ? `<img src="${pic}" alt="">` : '<span class="nopic"></span>'}<span class="name">${esc(def.name)}</span>${queued ? `<span class="count">${queued}</span>` : ''}`;
    b.title = `${def.name}: ${def.description}\n${Math.round(def.buildCostMetal)} metal · ${Math.round(def.buildCostEnergy)} energy · build time ${Math.round(def.buildTime)}`;
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

/**
 * Gives the start screen TA's own look from the player's files: the metal title-screen background
 * and the TOTAL ANNIHILATION logo in place of the plain heading.
 */
async function dressSetupScreen(v: Vfs): Promise<void> {
  const pcx = async (name: string) => {
    const f = v.listDir('bitmaps', '.pcx').find((x) => x.path.toLowerCase() === `bitmaps/${name}`);
    return f ? parsePcx(await v.read(f.path)) : undefined;
  };
  const toUrl = (img: { width: number; height: number; rgba: Uint8Array }, crop = { x: 0, y: 0, w: img.width, h: img.height }) => {
    const c = document.createElement('canvas');
    c.width = crop.w;
    c.height = crop.h;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), -crop.x, -crop.y);
    return c.toDataURL();
  };
  try {
    const bg = await pcx('frontbg.pcx');
    if (bg && setup) setup.el.style.background = `#050805 url(${toUrl(bg)}) center / cover`;
    const title = await pcx('frontend1f.pcx');
    const heading = setup?.el.querySelector('.setup-box h1');
    if (title && heading) {
      const logo = document.createElement('img');
      logo.src = toUrl(title, { x: 66, y: 24, w: 524, h: 300 });
      logo.alt = 'Total Annihilation';
      logo.className = 'setup-logo';
      heading.replaceWith(logo);
    }
  } catch {
    // keep the plain look
  }
}

/** The saved-games list on the setup screen. */
function showSaves(): void {
  if (!setup) return;
  const slot = setup.slot;
  slot.textContent = '';
  const saves = listSaves();
  if (!saves.length) return;
  const h = document.createElement('h2');
  h.textContent = 'Saved games';
  slot.append(h);
  for (const save of saves) {
    const row = document.createElement('div');
    row.className = 'save-row';
    const load = document.createElement('button');
    load.textContent = describeSave(save);
    load.title = 'Load this game';
    load.addEventListener('click', () => {
      setup!.hide();
      void startGame(save.settings, save);
    });
    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Delete this save';
    del.addEventListener('click', () => {
      deleteSave(save.savedAt);
      showSaves();
    });
    row.append(load, del);
    slot.append(row);
  }
}

function clockText(tick: number): string {
  const secs = Math.floor(tick / 30);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// Build-menu pictures (unitpics/<name>.pcx), decoded once and kept as data URLs.
const unitPics = new Map<string, string | null>();
function unitPic(name: string): string | undefined {
  const key = name.toLowerCase();
  const have = unitPics.get(key);
  if (have !== undefined) return have ?? undefined;
  unitPics.set(key, null);
  const path = `unitpics/${key}.pcx`;
  if (vfs?.exists(path)) {
    void vfs.read(path).then((bytes) => {
      try {
        const img = parsePcx(bytes);
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
        unitPics.set(key, c.toDataURL());
        panelKey = '';
        refreshPanelSoon();
      } catch {
        // no picture: the button shows the name only
      }
    });
  }
  return undefined;
}


function describeTasks(u: SimUnit): string {
  if (!game) return '';
  const lines: string[] = [];
  if (!game.world.isFinished(u)) lines.push(`being built: ${Math.round(game.world.buildFraction(u) * 100)}%`);
  else lines.push(`health ${Math.ceil(u.hp)}/${u.def.maxDamage}`);
  const weaponNames = u.weapons.filter((w) => w).map((w) => `${w!.def.title} (range ${w!.def.range})`);
  if (weaponNames.length) lines.push('weapons: ' + weaponNames.join(', '));
  for (const t of u.tasks.slice(0, 5)) {
    if (t.kind === 'move') lines.push('move');
    else if (t.kind === 'build') lines.push(`build ${assets.get(t.unitName.toLowerCase())?.def.name ?? t.unitName}`);
    else if (t.kind === 'assist') lines.push('help build');
    else if (t.kind === 'attack') lines.push(`attack ${game.world.units.get(t.targetId)?.def.name ?? ''}`);
    else lines.push('reclaim');
  }
  if (u.factory?.queue.length) lines.push('queue: ' + u.factory.queue.map((q) => `${q.count} × ${assets.get(q.unitName.toLowerCase())?.def.name ?? q.unitName}`).join(', '));
  if (u.def.extractsMetal && game.world.isFinished(u)) lines.push(`metal here: ${(game.world.metalUnder(u) * u.def.extractsMetal).toFixed(2)}/s`);
  return lines.length ? '\n' + lines.join('\n') : '';
}

/** The side whose interface art is showing ('arm' or 'core'). */
let panelSide: 'arm' | 'core' = 'arm';

/** Puts TA's panel art for this side behind the side panel and the top and bottom bars. */
function applyPanelArt(side: 'arm' | 'core'): void {
  panelSide = side;
  if (!gui) return;
  const file = side === 'arm' ? 'armint' : 'corint';
  const set = (v: string, sprite: { url: string } | undefined) => document.documentElement.style.setProperty(v, sprite ? `url(${sprite.url})` : 'none');
  set('--side-art', gui.sprite(`${file}:panelside2`) ?? gui.sprite(`${file}:panelside`));
  set('--top-art', gui.sprite(`${file}:paneltop`));
  set('--bot-art', gui.sprite(`${file}:panelbot`));
  set('--pan-art', gui.sprite(side === 'arm' ? 'ARMPAN' : 'CORPAN'));
  canvas.style.cursor = gui.cursor('cursornormal');
  panelKey = '';
  refreshPanel();
}

/** One of TA's own buttons (e.g. ARMSTOP) at 1.5x, or a plain button if the game files lack it. */
function spriteButton(parent: HTMLElement, name: string, frame: number, label: string, onClick: () => void): HTMLButtonElement {
  const sprite = gui?.sprite(`${panelSide === 'arm' ? 'ARM' : 'COR'}${name}`, frame);
  if (!sprite) return addButton(parent, label, onClick);
  const b = document.createElement('button');
  b.className = 'sprite-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  Object.assign(b.style, { backgroundImage: `url(${sprite.url})`, width: `${sprite.width * 1.5}px`, height: `${sprite.height * 1.5}px` });
  b.addEventListener('click', onClick);
  parent.append(b);
  return b;
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
  // Fit the minimap into TA's square spot at the top of the panel, keeping its shape.
  const fit = 186 / Math.max(width, height);
  minimapEl.style.width = `${width * fit}px`;
  minimapEl.style.height = `${height * fit}px`;
}

const fogCanvas = document.createElement('canvas');
let fogVersion = -1;

function drawMinimap(): void {
  if (!game || !minimapImage) return;
  const g = minimapEl.getContext('2d')!;
  g.putImageData(minimapImage, 0, 0);
  const sx = minimapEl.width / game.map.widthUnits;
  const sz = minimapEl.height / game.map.heightUnits;
  const vis = game.world.visibility;
  // The fog layer only changes when line of sight is refreshed; draw it once into its own canvas.
  if (fogCanvas.width !== vis.width || fogCanvas.height !== vis.height || fogVersion !== vis.version) {
    fogVersion = vis.version;
    fogCanvas.width = vis.width;
    fogCanvas.height = vis.height;
    const img = new ImageData(vis.width, vis.height);
    const grid = vis.grids[ME]!;
    for (let i = 0; i < grid.length; i++) img.data[i * 4 + 3] = grid[i]! & SEEN ? 0 : 115;
    fogCanvas.getContext('2d')!.putImageData(img, 0, 0);
  }
  g.imageSmoothingEnabled = false;
  g.drawImage(fogCanvas, 0, 0, vis.width * VIS_TILE * sx, vis.height * VIS_TILE * sz);
  for (const u of game.world.units.values()) {
    const seen = u.owner === ME || (vis.at(ME, u.x, u.z) & SEEN) !== 0;
    if (!seen && !(vis.at(ME, u.x, u.z) & RADAR)) continue;
    g.fillStyle = selected.has(u.id) ? '#fff' : u.owner === ME ? '#3c6cff' : seen ? '#ff3c3c' : '#ff9a9a';
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
// Hand the keyboard back to the game after using a control. Otherwise a focused menu or button keeps
// it: the arrow keys would change the map (restarting the game) and Space would press Restart.
document.addEventListener('change', (e) => (e.target as HTMLElement).tagName === 'SELECT' && (e.target as HTMLElement).blur());
document.addEventListener('click', (e) => (e.target as HTMLElement).closest('button')?.blur());
canvas.addEventListener('mousedown', () => (document.activeElement as HTMLElement | null)?.blur?.());
$('restart').addEventListener('click', () => settings && void startGame(settings));
$('save').addEventListener('click', () => {
  if (!game || !settings) return;
  const ok = addSave(saveGame(game.world, settings, seed));
  statusEl.textContent = ok ? `Saved at ${clockText(game.world.tickCount)}. Load it from Menu.` : 'Could not save (storage full?).';
  showSaves();
});
$('menu').addEventListener('click', () => setup?.show(!!game));
$<HTMLInputElement>('edge').addEventListener('change', (e) => {
  rts.edgeScroll = (e.target as HTMLInputElement).checked;
  (e.target as HTMLInputElement).blur();
});
$('sound').addEventListener('click', () => {
  if (!audio) return;
  audio.muted = !audio.muted;
  $('sound').textContent = audio.muted ? 'Sound off' : 'Sound on';
  $('sound').classList.toggle('on', !audio.muted);
});
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

// In the Mac app, the game files come from the folder the player chose on first launch; on the
// dev server, from data/.
async function boot(): Promise<void> {
  if (!inApp()) {
    void load(openDevServerVfs, 'No data/ folder found. Pick your TA folder instead.');
    return;
  }
  // Keep a log of status messages and errors, for looking into problems later.
  appLog('started');
  new MutationObserver(() => appLog(`status: ${statusEl.textContent}`)).observe(statusEl, { childList: true, characterData: true, subtree: true });
  window.addEventListener('error', (e) => appLog(`error: ${e.message} at ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => appLog(`error: ${String(e.reason)}`));
  if (await appDataDir()) {
    void load(openAppVfs, 'Your Total Annihilation folder has no game files any more.');
    return;
  }
  const welcome = $('welcome');
  welcome.hidden = false;
  $('chooseFolder').addEventListener('click', () => {
    $('welcomeError').textContent = '';
    chooseAppDataDir().then(
      (dir) => {
        if (!dir) return;
        welcome.hidden = true;
        void load(openAppVfs, 'That folder has no game files.');
      },
      (err) => ($('welcomeError').textContent = String(err)),
    );
  });
}
void boot();
