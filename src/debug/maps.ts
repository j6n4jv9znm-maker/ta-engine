/*
 * Phase 3 milestone page: fly over any original map with its features shown.
 * Rendering only; there is no simulation here yet.
 */
import * as THREE from 'three';
import { parse3do } from '../formats/3do';
import { parsePalette, PALETTE_PATH, type Palette } from '../formats/palette';
import { createFeatureSprites, type FeatureSprites } from '../graphics/featureSprites';
import { RtsCamera } from '../graphics/rtsCamera';
import { createTerrain, type Terrain } from '../graphics/terrain';
import { loadTextureLibrary, type TextureLibrary } from '../graphics/textures';
import { createUnitModel, type UnitModel } from '../graphics/threeModel';
import { loadFeatureDefinitions, type FeatureDef } from '../map/features';
import { heightAt, listMaps, loadGameMap, type GameMap } from '../map/mapData';
import type { Vfs } from '../vfs';
import { openDevServerVfs, openPickedVfs } from './devData';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $('status');
const listEl = $('list');
const infoEl = $('info');
const filterEl = $<HTMLInputElement>('filter');
const featEl = $<HTMLInputElement>('feat');
const startsEl = $<HTMLInputElement>('starts');
const edgeEl = $<HTMLInputElement>('edge');
const wireEl = $<HTMLInputElement>('wire');
const minimapEl = $<HTMLCanvasElement>('minimap');
const view = $('view');

let vfs: Vfs | undefined;
let palette: Palette | undefined;
let lib: TextureLibrary | undefined;
let featureDefs: Map<string, FeatureDef> | undefined;
let maps: { name: string; title: string }[] = [];
let current: { map: GameMap; terrain: Terrain; sprites: FeatureSprites; models: UnitModel[]; group: THREE.Group } | undefined;
let loadToken = 0;

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
const rts = new RtsCamera(renderer.domElement, { mapWidth: 1, mapHeight: 1 });
const startMarkers = new THREE.Group();
scene.add(startMarkers);

function resize(): void {
  renderer.setSize(view.clientWidth, view.clientHeight, false);
  rts.resize(view.clientWidth, view.clientHeight);
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
renderer.setAnimationLoop((t) => {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  rts.edgeScroll = edgeEl.checked;
  rts.update(dt);
  renderer.render(scene, rts.camera);
  drawMinimapView();
});

// --- Loading ------------------------------------------------------------------
async function load(open: () => Promise<Vfs | undefined>, none: string): Promise<void> {
  statusEl.textContent = 'Opening archives…';
  try {
    const v = await open();
    if (!v) {
      statusEl.textContent = none;
      return;
    }
    vfs = v;
    statusEl.textContent = 'Loading palette, textures and feature definitions…';
    palette = parsePalette(await v.read(PALETTE_PATH));
    lib = await loadTextureLibrary(v, palette);
    featureDefs = await loadFeatureDefinitions(v);
    maps = listMaps(v).map((name) => ({ name, title: name }));
    statusEl.textContent = `${maps.length} maps`;
    renderList();
    const first = maps.find((m) => /^the pass$/i.test(m.name)) ?? maps.find((m) => !/example/i.test(m.name));
    if (first) void showMap(first.name);
  } catch (e) {
    statusEl.textContent = String(e);
  }
}

function renderList(): void {
  const q = filterEl.value.trim().toLowerCase();
  listEl.textContent = '';
  for (const m of maps) {
    if (!m.name.toLowerCase().includes(q)) continue;
    const d = document.createElement('div');
    d.textContent = m.name;
    d.dataset.map = m.name;
    d.classList.toggle('sel', current?.map.name === m.name);
    d.addEventListener('click', () => void showMap(m.name));
    listEl.append(d);
  }
}

async function showMap(name: string): Promise<void> {
  if (!vfs || !palette || !lib || !featureDefs) return;
  const token = ++loadToken;
  statusEl.textContent = `Loading ${name}…`;
  try {
    const map = await loadGameMap(vfs, name, featureDefs);
    const terrain = createTerrain(map.tnt, palette);
    const sprites = await createFeatureSprites(vfs, palette, map.features);
    const { group: modelGroup, models } = await createFeatureModels(map);
    if (token !== loadToken) {
      terrain.dispose();
      sprites.dispose();
      models.forEach((m) => m.dispose());
      return;
    }
    unload();
    const group = new THREE.Group();
    const featureGroup = new THREE.Group();
    featureGroup.name = 'features';
    featureGroup.add(sprites.group, modelGroup);
    group.add(terrain.mesh, featureGroup);
    scene.add(group);
    current = { map, terrain, sprites, models, group };
    applyToggles();

    rts.setMap({ mapWidth: map.widthUnits, mapHeight: map.heightUnits, heightAt: (x, z) => heightAt(map.tnt, x, z) });
    const start = map.ota?.schemas[0]?.startPositions[0];
    if (start) rts.lookAt(start.x, start.z);
    buildStartMarkers(map);
    drawMinimap(map);
    renderList();

    const o = map.ota;
    infoEl.innerHTML = `<b>${esc(o?.missionName || name)}</b><br>
      ${o?.description ? esc(o.description) + '<br>' : ''}
      ${o?.planet ? `planet: ${esc(o.planet)}<br>` : ''}
      size: ${map.widthUnits} x ${map.heightUnits} pixels (${map.tnt.width} x ${map.tnt.height} cells), ${map.tnt.tileCount} tiles<br>
      sea level ${map.tnt.seaLevel}, wind ${o?.minWindSpeed ?? '?'}-${o?.maxWindSpeed ?? '?'}, tidal ${o?.tidalStrength ?? '?'}<br>
      ${map.features.length} features, ${o?.schemas[0]?.startPositions.filter(Boolean).length ?? 0} start positions
      ${sprites.missing.length ? `<br>missing sprites: ${esc(sprites.missing.join(', '))}` : ''}
      ${map.unknownFeatures.length ? `<br>unknown features: ${esc(map.unknownFeatures.join(', '))}` : ''}`;
    statusEl.textContent = `${maps.length} maps`;
  } catch (e) {
    statusEl.textContent = `${name}: ${String(e)}`;
  }
}

/** Features drawn as 3D models (wrecks, some rocks). One model build per feature type, cloned per instance. */
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
    inst.rotation.y = Math.PI; // RWE places feature models turned half way round
    group.add(inst);
  }
  return { group, models: [...byObject.values()].filter((m): m is UnitModel => m !== null) };
}

function unload(): void {
  if (!current) return;
  scene.remove(current.group);
  current.terrain.dispose();
  current.sprites.dispose();
  current.models.forEach((m) => m.dispose());
  current = undefined;
}

function buildStartMarkers(map: GameMap): void {
  startMarkers.clear();
  (map.ota?.schemas[0]?.startPositions ?? []).forEach((p, i) => {
    if (!p) return;
    const y = heightAt(map.tnt, p.x, p.z);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#ffd400';
    g.beginPath();
    g.arc(32, 32, 28, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#000';
    g.font = 'bold 36px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(i + 1), 32, 34);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
    sprite.position.set(p.x, y + 40, p.z);
    sprite.scale.set(48, 48, 1);
    startMarkers.add(sprite);
  });
}

// --- Minimap ------------------------------------------------------------------
let minimapImage: ImageData | undefined;

function drawMinimap(map: GameMap): void {
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

/** Redraws the minimap with the camera's view rectangle and start positions. */
function drawMinimapView(): void {
  if (!current || !minimapImage) return;
  const g = minimapEl.getContext('2d')!;
  g.putImageData(minimapImage, 0, 0);
  const sx = minimapEl.width / current.map.widthUnits;
  const sz = minimapEl.height / current.map.heightUnits;
  // The camera's view on the ground: cast the four screen corners onto the plane at the target's height.
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -rts.target.y);
  const ray = new THREE.Raycaster();
  const hit = new THREE.Vector3();
  g.strokeStyle = '#fff';
  g.lineWidth = 1;
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
  if (startsEl.checked) {
    g.fillStyle = '#ffd400';
    for (const p of current.map.ota?.schemas[0]?.startPositions ?? []) {
      if (p) g.fillRect(p.x * sx - 1.5, p.z * sz - 1.5, 3, 3);
    }
  }
}

minimapEl.addEventListener('mousedown', (e) => {
  if (!current) return;
  const jump = (ev: MouseEvent) => {
    const r = minimapEl.getBoundingClientRect();
    rts.lookAt(((ev.clientX - r.left) / r.width) * current!.map.widthUnits, ((ev.clientY - r.top) / r.height) * current!.map.heightUnits);
  };
  jump(e);
  const move = (ev: MouseEvent) => jump(ev);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', () => window.removeEventListener('mousemove', move), { once: true });
});

// --- Controls -----------------------------------------------------------------
function applyToggles(): void {
  if (!current) return;
  const f = current.group.getObjectByName('features');
  if (f) f.visible = featEl.checked;
  startMarkers.visible = startsEl.checked;
  (current.terrain.mesh.material as THREE.ShaderMaterial).wireframe = wireEl.checked;
}
filterEl.addEventListener('input', renderList);
[featEl, startsEl, wireEl].forEach((el) => el.addEventListener('change', applyToggles));
$<HTMLInputElement>('picker').addEventListener('change', (ev) => {
  const files = (ev.target as HTMLInputElement).files ?? [];
  void load(() => openPickedVfs(files), 'That folder has no .hpi/.ufo/.ccx/.gp3 files.');
});

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

void load(openDevServerVfs, 'No data/ folder found. Pick your TA folder instead.');
