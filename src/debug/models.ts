/*
 * Model viewer: pick any unit, rotate it, fully textured, in any team colour (Phase 2), and run its
 * unit script (Phase 4): walk, aim, fire, build, open/close and die.
 *
 * The script and piece animation run in the simulation at a fixed 30 Hz; the renderer only reads the
 * piece state to pose the model. Flying debris from explosions is a renderer-only effect.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { allPieces, parse3do, type ModelPiece } from '../formats/3do';
import { parseCob } from '../formats/cob';
import { latin1 } from '../formats/hpi';
import { parsePalette, PALETTE_PATH, type Palette } from '../formats/palette';
import { getBlock, getValue, parseTdfWithWarnings } from '../formats/tdf';
import { applyPose } from '../graphics/pose';
import { createUnitModel, type UnitModel } from '../graphics/threeModel';
import { TICKS_PER_SECOND } from '../sim/pieces';
import { Rng } from '../sim/rng';
import { ExplodeType, UnitScripts } from '../sim/unitScripts';
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
const scriptInfoEl = $('scriptInfo');
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
let currentRow: UnitRow | undefined;
let currentRoot: ModelPiece | undefined;
let scripts: UnitScripts | undefined;
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

// Fixed-step simulation (30 Hz), decoupled from the frame rate.
const TICK_MS = 1000 / TICKS_PER_SECOND;
let lastFrame = performance.now();
let accumulator = 0;
let spinAngle = 0;
renderer.setAnimationLoop((t) => {
  const dt = Math.min(250, t - lastFrame);
  lastFrame = t;
  if (spinEl.checked) spinAngle += (dt / 1000) * 0.4;
  turntable.rotation.y = spinAngle;
  accumulator += dt;
  while (accumulator >= TICK_MS) {
    accumulator -= TICK_MS;
    simTick();
  }
  if (current && scripts) applyPose(current, scripts.pieces);
  updateDebris(dt / 1000);
  controls.update();
  renderer.render(scene, camera);
});

function simTick(): void {
  if (!scripts) return;
  scripts.tick();
  const events = scripts.events;
  scripts.events = [];
  for (const e of events) if (e.kind === 'explode') spawnDebris(e.piece, e.type);
  if (dying && !scripts.vm.threads.some((th) => th.name.toLowerCase() === 'killed' && th.state.kind !== 'finished' && !th.killed)) {
    dying = false;
    if (current) current.root.visible = false; // the unit is gone; its pieces flew off
    setScriptInfo('Killed finished. Press Reset to bring the unit back.');
  }
}

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
  const cobPath = `scripts/${u.unitName}.cob`;
  const cob = vfs.exists(cobPath) ? parseCob(await vfs.read(cobPath)) : undefined;
  if (token !== loadToken) return;

  if (current) {
    turntable.remove(current.root);
    current.dispose();
  }
  clearDebris();
  current = createUnitModel(root, lib, palette, team);
  current.root.userData.unitName = u.unitName;
  currentRow = u;
  currentRoot = root;
  turntable.add(current.root);
  applyWireframe();
  frame(current.root);
  highlight();
  startScripts(cob);

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
  // TA models face -z, so put the camera on that side to see the unit's front.
  camera.position.copy(center).add(new THREE.Vector3(radius * 1.1, radius * 0.8, -radius * 1.5));
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

// --- Unit script ------------------------------------------------------------
let walking = false;
let building = false;
let open = false;
let dying = false;

function startScripts(cob: ReturnType<typeof parseCob> | undefined): void {
  walking = building = open = dying = false;
  renderActionState();
  if (!cob || !currentRoot) {
    scripts = undefined;
    setScriptInfo('This unit has no script.');
    return;
  }
  scripts = new UnitScripts(cob, currentRoot, new Rng(12345));
  scripts.start('Create');
  setScriptInfo(`Script: ${cob.functions.length} functions. Ran Create.`);
}

function run(name: string, params: number[] = []): void {
  if (!scripts) return;
  if (!scripts.vm.hasFunction(name)) {
    setScriptInfo(`This unit's script has no ${name}.`);
    return;
  }
  scripts.start(name, params);
  setScriptInfo(`Ran ${name}${params.length ? `(${params.join(', ')})` : ''}.`);
}

function setScriptInfo(text: string): void {
  const errors = scripts?.vm.errors ?? [];
  scriptInfoEl.textContent = errors.length ? `${text} Script errors: ${errors.join('; ')}` : text;
}

function renderActionState(): void {
  $('aWalk').classList.toggle('on', walking);
  $('aBuild').classList.toggle('on', building);
  $('aOpen').classList.toggle('on', open);
}

/** Random aim within the front half, in COB angle units (65536 per turn). */
const rng = new Rng(777);
function randomHeading(): number {
  return rng.int(-16384, 16384);
}

$('aWalk').addEventListener('click', () => {
  walking = !walking;
  run(walking ? 'StartMoving' : 'StopMoving');
  renderActionState();
});
$('aAim').addEventListener('click', () => {
  const heading = randomHeading();
  const pitch = rng.int(0, 6000);
  run('AimPrimary', [heading, pitch]);
});
$('aFire').addEventListener('click', () => run('FirePrimary'));
$('aBuild').addEventListener('click', () => {
  building = !building;
  if (building) run('StartBuilding', [randomHeading(), 0]);
  else run('StopBuilding');
  if (scripts) scripts.state.inBuildStance = building;
  renderActionState();
});
$('aOpen').addEventListener('click', () => {
  open = !open;
  if (scripts) scripts.state.activated = open;
  run(open ? 'Activate' : 'Deactivate');
  renderActionState();
});
$('aDie').addEventListener('click', () => {
  if (!scripts || dying) return;
  if (!scripts.vm.hasFunction('Killed')) {
    setScriptInfo('This unit has no Killed script (Commanders die with a special blast).');
    return;
  }
  dying = true;
  run('Killed', [100, 0]); // severity 100%: the most violent death
});
$('aReset').addEventListener('click', () => {
  if (currentRow) void showUnit(currentRow);
});

// --- Debris (renderer-only effect for explode) ----------------------------------
interface Debris {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}
let debris: Debris[] = [];

function spawnDebris(pieceName: string, type: number): void {
  if (!current) return;
  const g = current.pieces.get(pieceName.toLowerCase());
  const mesh = g?.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh);
  if (!g || !mesh) return;
  // BITMAPONLY means "just the explosion graphic": the piece itself doesn't fly off.
  if (type & ExplodeType.BITMAPONLY) return;
  const copy = new THREE.Mesh(mesh.geometry, mesh.material);
  g.updateWorldMatrix(true, false);
  g.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
  scene.add(copy);
  const fall = (type & ExplodeType.FALL) !== 0;
  const speed = fall ? 15 : 60;
  debris.push({
    obj: copy,
    vel: new THREE.Vector3((Math.random() - 0.5) * speed, fall ? 10 : 40 + Math.random() * 40, (Math.random() - 0.5) * speed),
    spin: new THREE.Vector3(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3),
    life: 3,
  });
}

function updateDebris(dt: number): void {
  const floor = grid.position.y;
  for (const d of debris) {
    d.vel.y -= 120 * dt;
    d.obj.position.addScaledVector(d.vel, dt);
    d.obj.rotation.x += d.spin.x * dt;
    d.obj.rotation.y += d.spin.y * dt;
    d.obj.rotation.z += d.spin.z * dt;
    if (d.obj.position.y < floor) {
      d.obj.position.y = floor;
      d.vel.set(d.vel.x * 0.4, -d.vel.y * 0.3, d.vel.z * 0.4);
      d.spin.multiplyScalar(0.5);
    }
    d.life -= dt;
  }
  for (const d of debris) if (d.life <= 0) scene.remove(d.obj);
  debris = debris.filter((d) => d.life > 0);
}

function clearDebris(): void {
  for (const d of debris) scene.remove(d.obj);
  debris = [];
}

// --- Controls ---------------------------------------------------------------
filterEl.addEventListener('input', renderList);
wireEl.addEventListener('change', applyWireframe);
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
