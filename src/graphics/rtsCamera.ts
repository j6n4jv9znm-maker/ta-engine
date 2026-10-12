import * as THREE from 'three';

/*
 * RTS camera: looks at a point on the map from a fixed tilt, like TA's view from the south.
 * Pan with WASD/arrow keys, by resting the mouse against the view's edge, by dragging with the
 * right/middle button (the ground stays under the pointer), or with a two-finger swipe on a trackpad.
 * Zoom with the mouse wheel or by pinching, towards the point under the pointer. Q/E rotate and R
 * resets the rotation, when rotation is on.
 */

export interface RtsCameraOptions {
  /** Map size in world units, to keep the view on the map. */
  mapWidth: number;
  mapHeight: number;
  /** Ground height lookup; the camera sits at the map's typical ground height (it doesn't bob over hills, as in TA). */
  heightAt?: (x: number, z: number) => number;
}

export interface RtsCameraControls {
  /** Pan with W/A/S/D as well as the arrow keys (off when those letters are game commands). */
  wasd?: boolean;
  /** Mouse buttons that drag the view (1 middle, 2 right). */
  dragButtons?: number[];
  /** Q/E rotate the view (off keeps north up, as in TA). */
  rotate?: boolean;
}

/**
 * TA draws the map as if seen from straight above, with things lifted up the screen by half their
 * height. An orthographic camera tilted down by atan(2) (about 63°) gives the same proportions: no
 * perspective, flat-looking ground, and height shown at half the scale of ground distance.
 */
const PITCH = Math.atan(2);
/** How much of the ground the view shows for a given `distance` (it plays the part of zoom). */
const VIEW_ANGLE = THREE.MathUtils.degToRad(17.5);
const MIN_DIST = 150;
const MAX_DIST = 4000;
const EDGE = 12; // pixels from the view's edge that start edge-scrolling
const EDGE_DELAY = 0.25; // seconds the pointer must rest at an edge, so crossing it to the side panel doesn't scroll

export class RtsCamera {
  readonly camera: THREE.OrthographicCamera;
  /** Width over height of the view. */
  aspect = 1;
  /** Point on the ground the camera looks at. */
  readonly target = new THREE.Vector3();
  distance = 900;
  yaw = 0;
  /** Scroll when the pointer rests at the view's edge (off by default: on a laptop it moves the view by surprise). */
  edgeScroll = false;

  private keys = new Set<string>();
  private mouse: { x: number; y: number } | undefined;
  private drag: { x: number; y: number } | undefined;
  private edgeTime = 0;
  private readonly cleanups: (() => void)[] = [];

  private readonly wasd: boolean;
  private readonly dragButtons: number[];
  private readonly rotate: boolean;

  constructor(
    private readonly el: HTMLElement,
    private opts: RtsCameraOptions,
    controls: RtsCameraControls = {},
  ) {
    this.wasd = controls.wasd ?? true;
    this.dragButtons = controls.dragButtons ?? [1, 2];
    this.rotate = controls.rotate ?? true;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 40000);
    this.target.set(opts.mapWidth / 2, 0, opts.mapHeight / 2);

    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void) => {
      t.addEventListener(type, fn as EventListener, { passive: false });
      this.cleanups.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(window, 'keydown', (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.key.toLowerCase());
      if (e.key.toLowerCase() === 'r' && this.wasd && this.rotate) this.yaw = 0;
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
    on(window, 'blur', () => this.keys.clear());
    on(el, 'mousemove', (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.drag) {
        this.panPixels(-(e.clientX - this.drag.x), -(e.clientY - this.drag.y));
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
    // Safari reports trackpad pinches as gesture events rather than ctrl+wheel.
    type Gesture = UIEvent & { scale: number; clientX: number; clientY: number };
    on(el, 'gesturestart', (e: Gesture) => {
      e.preventDefault();
      this.gestureScale = 1;
      this.inGesture = true;
    });
    on(el, 'gesturechange', (e: Gesture) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = this.mouse?.x ?? r.width / 2;
      const py = this.mouse?.y ?? r.height / 2;
      this.zoomAt((this.distance * this.gestureScale) / Math.max(0.05, e.scale), px, py);
      this.gestureScale = e.scale;
    });
    on(el, 'gestureend', (e: Gesture) => {
      e.preventDefault();
      this.inGesture = false;
    });
    on(el, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      // Mac trackpads send two-finger swipes as wheel events too. Pinch (which arrives with ctrlKey)
      // and real mouse wheels zoom; a two-finger swipe pans, so it doesn't fling the camera away.
      // A trackpad gives itself away with sideways, fractional or small deltas. Once one has been
      // seen, every later plain wheel event is a swipe: a fast flick can look just like a mouse wheel
      // and would otherwise zoom far out.
      if (e.ctrlKey && this.inGesture) return; // Safari: already handled as a gesture
      if (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40) this.trackpad = true;
      const mouseWheel = e.deltaMode !== 0 || (!this.trackpad && Math.abs(e.deltaY) >= 40);
      if (e.ctrlKey || mouseWheel) {
        const amount = e.ctrlKey ? e.deltaY * 0.01 : Math.sign(e.deltaY) * 0.15;
        const r = el.getBoundingClientRect();
        this.zoomAt(this.distance * Math.exp(amount), e.clientX - r.left, e.clientY - r.top);
      } else {
        this.panPixels(e.deltaX, e.deltaY);
      }
    });
  }

  private trackpad = false;
  private inGesture = false;
  private gestureScale = 1;

  setMap(opts: RtsCameraOptions): void {
    this.opts = opts;
    this.target.y = typicalHeight(opts);
    this.lookAt(opts.mapWidth / 2, opts.mapHeight / 2);
  }

  /** Centres the view on the ground at (x, z), allowing for that spot being above or below the view's fixed height. */
  lookAt(x: number, z: number): void {
    const above = (this.opts.heightAt?.(x, z) ?? this.target.y) - this.target.y;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const shift = above / Math.tan(PITCH);
    this.target.x = x - s * shift;
    this.target.z = z - c * shift;
    this.clamp();
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
    this.place();
  }

  /** Half the height of the view on the ground, in world units, at the current zoom. */
  viewHalfHeight(): number {
    return this.distance * Math.tan(VIEW_ANGLE);
  }

  /** Moves the view by screen-relative amounts in world units (dx right, dz down the screen). */
  panScreen(dx: number, dz: number): void {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    this.target.x += dx * c + dz * s;
    this.target.z += -dx * s + dz * c;
    this.clamp();
  }

  /** Pans by an amount in screen pixels, so the ground moves with the pointer or fingers. */
  panPixels(px: number, py: number): void {
    const perPixel = (2 * this.viewHalfHeight()) / Math.max(1, this.el.clientHeight);
    this.panScreen(px * perPixel, (py * perPixel) / Math.sin(PITCH));
  }

  /** Zooms to `distance`, keeping the ground point under (px, py) (pixels in the view) where it is on screen. */
  zoomAt(distance: number, px: number, py: number): void {
    const before = this.groundUnder(px, py);
    this.distance = THREE.MathUtils.clamp(distance, MIN_DIST, MAX_DIST);
    const after = this.groundUnder(px, py);
    if (before && after) {
      this.target.x += before.x - after.x;
      this.target.z += before.z - after.z;
      this.clamp();
    }
    this.place();
  }

  private groundUnder(px: number, py: number): THREE.Vector3 | undefined {
    this.place();
    const ndc = new THREE.Vector2((px / Math.max(1, this.el.clientWidth)) * 2 - 1, -(py / Math.max(1, this.el.clientHeight)) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.target.y), hit) ?? undefined;
  }

  /** Puts the camera where `target`, `distance` and `yaw` say. */
  private place(): void {
    const back = 8000; // far enough that hills and aircraft are never behind the camera
    const horiz = back * Math.cos(PITCH);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horiz,
      this.target.y + back * Math.sin(PITCH),
      this.target.z + Math.cos(this.yaw) * horiz,
    );
    this.camera.lookAt(this.target);
    // The view's size follows the zoom; the camera itself sits well back so nothing gets clipped.
    const h = this.viewHalfHeight();
    Object.assign(this.camera, { left: -h * this.aspect, right: h * this.aspect, top: h, bottom: -h });
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
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
      let ex = 0;
      let ez = 0;
      if (this.mouse.x < EDGE) ex -= 1;
      if (this.mouse.x > w - EDGE) ex += 1;
      if (this.mouse.y < EDGE) ez -= 1;
      if (this.mouse.y > h - EDGE) ez += 1;
      this.edgeTime = ex || ez ? this.edgeTime + dt : 0;
      if (this.edgeTime >= EDGE_DELAY) {
        dx += ex;
        dz += ez;
      }
    } else {
      this.edgeTime = 0;
    }
    if (dx || dz) this.panScreen(Math.sign(dx) * speed, Math.sign(dz) * speed);
    if (this.rotate && this.keys.has('q')) this.yaw += dt * 1.5;
    if (this.rotate && this.keys.has('e')) this.yaw -= dt * 1.5;

    this.place();
  }

  dispose(): void {
    this.cleanups.forEach((c) => c());
  }

  private clamp(): void {
    this.target.x = THREE.MathUtils.clamp(this.target.x, 0, this.opts.mapWidth);
    this.target.z = THREE.MathUtils.clamp(this.target.z, 0, this.opts.mapHeight);
  }
}

/** The median ground height over a grid of samples, so the view height stays fixed while panning. */
function typicalHeight(opts: RtsCameraOptions): number {
  if (!opts.heightAt) return 0;
  const samples: number[] = [];
  for (let i = 0.5; i < 16; i++) for (let j = 0.5; j < 16; j++) samples.push(opts.heightAt((opts.mapWidth * i) / 16, (opts.mapHeight * j) / 16));
  samples.sort((a, b) => a - b);
  return samples[samples.length >> 1] ?? 0;
}
