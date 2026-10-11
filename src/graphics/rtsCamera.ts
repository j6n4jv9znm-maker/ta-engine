import * as THREE from 'three';

/*
 * RTS camera: looks at a point on the map from a fixed tilt, like TA's view from the south.
 * Pan with WASD/arrow keys, by pushing the mouse against the window edge, or by dragging with the
 * right/middle button. Zoom with the mouse wheel. Q/E rotate, R resets the rotation.
 */

export interface RtsCameraOptions {
  /** Map size in world units, to keep the view on the map. */
  mapWidth: number;
  mapHeight: number;
  /** Ground height lookup, so the camera follows hills. */
  heightAt?: (x: number, z: number) => number;
}

export interface RtsCameraControls {
  /** Pan with W/A/S/D as well as the arrow keys (off when those letters are game commands). */
  wasd?: boolean;
  /** Mouse buttons that drag the view (1 middle, 2 right). */
  dragButtons?: number[];
}

const PITCH = THREE.MathUtils.degToRad(58); // down from horizontal; close to TA's look
const MIN_DIST = 150;
const MAX_DIST = 4000;
const EDGE = 12; // pixels from the window edge that start edge-scrolling

export class RtsCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Point on the ground the camera looks at. */
  readonly target = new THREE.Vector3();
  distance = 900;
  yaw = 0;
  edgeScroll = true;

  private keys = new Set<string>();
  private mouse: { x: number; y: number } | undefined;
  private drag: { x: number; y: number } | undefined;
  private readonly cleanups: (() => void)[] = [];

  private readonly wasd: boolean;
  private readonly dragButtons: number[];

  constructor(
    private readonly el: HTMLElement,
    private opts: RtsCameraOptions,
    controls: RtsCameraControls = {},
  ) {
    this.wasd = controls.wasd ?? true;
    this.dragButtons = controls.dragButtons ?? [1, 2];
    this.camera = new THREE.PerspectiveCamera(35, 1, 10, 30000);
    this.target.set(opts.mapWidth / 2, 0, opts.mapHeight / 2);

    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void) => {
      t.addEventListener(type, fn as EventListener, { passive: false });
      this.cleanups.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(window, 'keydown', (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.key.toLowerCase());
      if (e.key.toLowerCase() === 'r' && this.wasd) this.yaw = 0;
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());
    on(el, 'mousemove', (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.drag) {
        const scale = this.distance / 700;
        this.panScreen(-(e.clientX - this.drag.x) * scale, -(e.clientY - this.drag.y) * scale);
        this.drag = { x: e.clientX, y: e.clientY };
      }
    });
    on(el, 'mouseleave', () => (this.mouse = undefined));
    on(el, 'mousedown', (e: MouseEvent) => {
      if (this.dragButtons.includes(e.button)) {
        this.drag = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    });
    on(window, 'mouseup', () => (this.drag = undefined));
    on(el, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(el, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(e.deltaY * 0.0015), MIN_DIST, MAX_DIST);
    });
  }

  setMap(opts: RtsCameraOptions): void {
    this.opts = opts;
    this.lookAt(opts.mapWidth / 2, opts.mapHeight / 2);
  }

  lookAt(x: number, z: number): void {
    this.target.x = x;
    this.target.z = z;
    this.clamp();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Moves the view by screen-relative amounts in world units (dx right, dz down the screen). */
  panScreen(dx: number, dz: number): void {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    this.target.x += dx * c + dz * s;
    this.target.z += -dx * s + dz * c;
    this.clamp();
  }

  /** Call once per frame with the elapsed seconds. */
  update(dt: number): void {
    const speed = this.distance * 1.2 * dt;
    let dx = 0;
    let dz = 0;
    const k = (letter: string, arrow: string) => this.keys.has(arrow) || (this.wasd && this.keys.has(letter));
    if (k('a', 'arrowleft')) dx -= 1;
    if (k('d', 'arrowright')) dx += 1;
    if (k('w', 'arrowup')) dz -= 1;
    if (k('s', 'arrowdown')) dz += 1;
    if (this.edgeScroll && this.mouse && !this.drag) {
      const { clientWidth: w, clientHeight: h } = this.el;
      if (this.mouse.x < EDGE) dx -= 1;
      if (this.mouse.x > w - EDGE) dx += 1;
      if (this.mouse.y < EDGE) dz -= 1;
      if (this.mouse.y > h - EDGE) dz += 1;
    }
    if (dx || dz) this.panScreen(Math.sign(dx) * speed, Math.sign(dz) * speed);
    if (this.keys.has('q')) this.yaw += dt * 1.5;
    if (this.keys.has('e')) this.yaw -= dt * 1.5;

    const ground = this.opts.heightAt?.(this.target.x, this.target.z) ?? 0;
    this.target.y += (ground - this.target.y) * Math.min(1, dt * 6);
    const horiz = this.distance * Math.cos(PITCH);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horiz,
      this.target.y + this.distance * Math.sin(PITCH),
      this.target.z + Math.cos(this.yaw) * horiz,
    );
    this.camera.lookAt(this.target);
  }

  dispose(): void {
    this.cleanups.forEach((c) => c());
  }

  private clamp(): void {
    this.target.x = THREE.MathUtils.clamp(this.target.x, 0, this.opts.mapWidth);
    this.target.z = THREE.MathUtils.clamp(this.target.z, 0, this.opts.mapHeight);
  }
}
