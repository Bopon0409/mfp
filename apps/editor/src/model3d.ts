// 3D models in fills (MODEL3D): glTF / GLB is drawn by three.js in its own WebGL context
// (OffscreenCanvas), the frame goes to the canvas as an image (ImageBitmap → CanvasKit). three.js
// loads only when the file has a model. The canvas shows a still frame (view angle, clip time);
// frames are cached by size and angle; playback supplies its own clip time and rotation (hooks).
// Compressed models: meshopt and Draco.

import type { CanvasKit, Image } from 'canvaskit-wasm';
import type { ImageBytesSource } from '@mfp/io-figma';
import type { ModelSource, ModelView } from '@mfp/renderer';
import { t as tl } from './i18n/index.ts';

type Three = typeof import('three');
type GLTF = import('three/examples/jsm/loaders/GLTFLoader.js').GLTF;

/** Model animation clips (for the panel): name and duration, seconds. */
export interface ModelInfo {
  clips: { name: string; duration: number }[];
  /** Model bounds (for layer size on insert): width and height in front view. */
  width: number;
  height: number;
}

interface Entry {
  gltf: GLTF;
  scene: import('three').Scene;
  root: import('three').Object3D;
  center: import('three').Vector3;
  radius: number;
  info: ModelInfo;
  /** Animation for a paint (key): its own mixer and clip action. */
  mixers: WeakMap<object, { mixer: import('three').AnimationMixer; clip: string | null; action: import('three').AnimationAction | null }>;
}

interface Frame {
  image: Image;
  bitmap: ImageBitmap;
  used: number;
}

/** Does it look like glTF: GLB (glTF header) or JSON with “asset”. */
export function isModelBytes(b: Uint8Array): boolean {
  if (b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46) return true;
  let i = 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09 || b[i] === 0xef || b[i] === 0xbb || b[i] === 0xbf)) i++;
  if (b[i] !== 0x7b) return false;
  const head = new TextDecoder().decode(b.subarray(i, Math.min(b.length, i + 4096)));
  return /"asset"\s*:/.test(head) && /"version"\s*:\s*"2/.test(head);
}

/** Lighting: ambient tone, direct (key), fill and rim. */
const LIGHTS: Record<string, { env: number; key: number; fill: number; rim: number; exposure: number }> = {
  STUDIO: { env: 1, key: 2.2, fill: 0.8, rim: 1.2, exposure: 1 },
  SOFT: { env: 1.4, key: 1, fill: 1, rim: 0.4, exposure: 1.05 },
  CONTRAST: { env: 0.5, key: 3.4, fill: 0.25, rim: 2.2, exposure: 0.95 },
};

/** Playback hooks: clip time and view angle for paint key (none — still frame and the fill's angle). */
export interface ModelHooks {
  time?(key: object, hash: string, view: ModelView, info: ModelInfo): number;
  camera?(key: object, view: ModelView): ModelView['camera'];
  live?(key: object): boolean;
}

export class ModelLibrary implements ModelSource {
  private ck: CanvasKit;
  private source: () => ImageBytesSource | null;
  private onLoad: (hash: string) => void;
  private hooks: ModelHooks;
  private three: Three | null = null;
  private threeLoading: Promise<void> | null = null;
  private renderer: import('three').WebGLRenderer | null = null;
  private canvas: OffscreenCanvas | null = null;
  private loader: import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader | null = null;
  private envMap: import('three').Texture | null = null;
  private entries = new Map<string, Entry | null | Promise<void>>();
  private frames = new Map<string, Frame>();
  private clock = 0;
  /** Load error (show once). */
  onError: ((message: string) => void) | null = null;

  constructor(ck: CanvasKit, source: () => ImageBytesSource | null, onLoad: (hash: string) => void, hooks: ModelHooks = {}) {
    this.ck = ck;
    this.source = source;
    this.onLoad = onLoad;
    this.hooks = hooks;
  }

  /** No loads pending (export waits for models). */
  get idle(): boolean {
    if (this.threeLoading && !this.three) return false;
    for (const e of this.entries.values()) if (e instanceof Promise) return false;
    return true;
  }

  live(key: object): boolean {
    return this.hooks.live?.(key) ?? false;
  }

  /** three.js, glTF loader (meshopt, Draco) and the shared WebGL renderer. */
  private ensureThree(): Promise<void> {
    this.threeLoading ??= (async () => {
      const [THREE, { GLTFLoader }, { MeshoptDecoder }, { DRACOLoader }, { RoomEnvironment }] = await Promise.all([
        import('three'),
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/libs/meshopt_decoder.module.js'),
        import('three/examples/jsm/loaders/DRACOLoader.js'),
        import('three/examples/jsm/environments/RoomEnvironment.js'),
      ]);
      this.canvas = new OffscreenCanvas(256, 256);
      const renderer = new THREE.WebGLRenderer({ canvas: this.canvas as unknown as HTMLCanvasElement, alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      const pmrem = new THREE.PMREMGenerator(renderer);
      this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      // three.js wires up the Draco decoder itself (files next to the loader module).
      loader.setDRACOLoader(new DRACOLoader());
      this.loader = loader;
      this.renderer = renderer;
      this.three = THREE;
    })();
    return this.threeLoading;
  }

  /** Model info (clips, size): for the panel and insertion. */
  async info(hash: string): Promise<ModelInfo | null> {
    await this.ensureThree();
    if (!this.entries.has(hash)) this.entries.set(hash, this.load(hash));
    const e = this.entries.get(hash);
    if (e instanceof Promise) await e;
    const done = this.entries.get(hash);
    return done && !(done instanceof Promise) ? done.info : null;
  }

  /** Model info from bytes (before writing to storage). */
  async infoOf(bytes: Uint8Array): Promise<ModelInfo | null> {
    await this.ensureThree();
    try {
      const e = await this.parse(bytes);
      this.disposeEntry(e);
      return e.info;
    } catch {
      return null;
    }
  }

  private async parse(bytes: Uint8Array): Promise<Entry> {
    const THREE = this.three!;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const gltf = await this.loader!.parseAsync(buf, '');
    const scene = new THREE.Scene();
    const root = gltf.scene ?? gltf.scenes[0]!;
    scene.add(root);
    scene.environment = this.envMap;
    // Lights: key, fill, rim — attached to the camera (move with it).
    const lights = new THREE.Group();
    lights.name = '__mfp_lights';
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(3, 4, 5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-4, 1, 3);
    const rim = new THREE.DirectionalLight(0xffffff, 1);
    rim.position.set(0, 3, -5);
    lights.add(key, fill, rim);
    scene.add(lights);
    const box = new THREE.Box3().setFromObject(root, true);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1e-6, size.length() / 2);
    return {
      gltf,
      scene,
      root,
      center,
      radius,
      mixers: new WeakMap(),
      info: { clips: gltf.animations.map((a) => ({ name: a.name || tl('Анимация'), duration: a.duration })), width: size.x || 1, height: size.y || 1 },
    };
  }

  private async load(hash: string): Promise<void> {
    let entry: Entry | null = null;
    try {
      await this.ensureThree();
      const bytes = await this.source()?.readImage(hash);
      if (bytes) entry = await this.parse(bytes);
    } catch (e) {
      console.warn('3D-модель', hash, e);
      this.onError?.(`3D-модель не открылась: ${(e as Error).message}`);
    }
    this.entries.set(hash, entry);
    if (entry) this.onLoad(hash);
  }

  frame(hash: string, key: object, view: ModelView, w: number, h: number, time: number | null): Image | undefined {
    if (!this.three) {
      void this.ensureThree().then(() => this.onLoad(hash));
      return undefined;
    }
    let e = this.entries.get(hash);
    if (e === undefined) {
      this.entries.set(hash, this.load(hash));
      return undefined;
    }
    if (!e || e instanceof Promise) return undefined;
    const entry = e;
    const camera = this.hooks.camera?.(key, view) ?? view.camera;
    const clipName = view.clip === '' ? null : (view.clip ?? entry.info.clips[0]?.name ?? null);
    const t = time ?? this.hooks.time?.(key, hash, view, entry.info) ?? view.pose;
    const id = `${hash}|${w}x${h}|${camera.yaw.toFixed(2)},${camera.pitch.toFixed(2)},${camera.zoom.toFixed(3)}|${clipName ?? '-'}@${clipName ? t.toFixed(3) : 0}|${view.lighting}|${view.fill ? 1 : 0}`;
    const hit = this.frames.get(id);
    if (hit) {
      hit.used = ++this.clock;
      return hit.image;
    }
    const bitmap = this.render(entry, key, clipName, t, camera, view.lighting, view.fill, w, h);
    if (!bitmap) return undefined;
    const image = this.ck.MakeLazyImageFromTextureSource(bitmap);
    if (!image) {
      bitmap.close();
      return undefined;
    }
    this.frames.set(id, { image, bitmap, used: ++this.clock });
    this.evict();
    return image;
  }

  /** At most 48 frames (free long-unused ones). */
  private evict() {
    if (this.frames.size <= 48) return;
    const old = [...this.frames.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, this.frames.size - 48);
    for (const [id, f] of old) {
      f.image.delete();
      f.bitmap.close();
      this.frames.delete(id);
    }
  }

  private render(entry: Entry, key: object, clipName: string | null, t: number, cam: ModelView['camera'], lighting: string, fill: boolean, w: number, h: number): ImageBitmap | null {
    const THREE = this.three!;
    const renderer = this.renderer!;
    // Clip pose: the paint's own mixer.
    let m = entry.mixers.get(key);
    if (!m || m.clip !== clipName) {
      m?.mixer.stopAllAction();
      const mixer = new THREE.AnimationMixer(entry.root);
      const clip = clipName ? entry.gltf.animations.find((a) => (a.name || tl('Анимация')) === clipName) : undefined;
      const action = clip ? mixer.clipAction(clip) : null;
      action?.play();
      m = { mixer, clip: clipName, action };
      entry.mixers.set(key, m);
    }
    if (m.action) {
      const d = m.action.getClip().duration || 1;
      m.mixer.setTime(((t % d) + d) % d);
    } else m.mixer.setTime(0);
    // Camera: on a sphere around the model; “fit” — the whole model, “fill” — by the shorter side.
    const aspect = w / h;
    const fov = 30;
    const camera = new THREE.PerspectiveCamera(fov, aspect, entry.radius / 100, entry.radius * 100);
    const half = (fov * Math.PI) / 360;
    const fitV = entry.radius / Math.sin(half);
    const fitH = entry.radius / Math.sin(Math.atan(Math.tan(half) * aspect));
    const dist = (fill ? Math.min(fitV, fitH) : Math.max(fitV, fitH)) / Math.max(0.05, cam.zoom);
    const yaw = (cam.yaw * Math.PI) / 180;
    const pitch = (Math.max(-89, Math.min(89, cam.pitch)) * Math.PI) / 180;
    camera.position.set(entry.center.x + dist * Math.sin(yaw) * Math.cos(pitch), entry.center.y + dist * Math.sin(pitch), entry.center.z + dist * Math.cos(yaw) * Math.cos(pitch));
    camera.lookAt(entry.center);
    // Light comes from the camera.
    const L = LIGHTS[lighting] ?? LIGHTS.STUDIO!;
    const lights = entry.scene.getObjectByName('__mfp_lights')!;
    lights.position.copy(camera.position);
    lights.quaternion.copy(camera.quaternion);
    lights.scale.setScalar(entry.radius);
    const [key3, fill3, rim3] = lights.children as import('three').DirectionalLight[];
    key3!.intensity = L.key;
    fill3!.intensity = L.fill;
    rim3!.intensity = L.rim;
    key3!.target.position.copy(entry.center);
    entry.scene.environmentIntensity = L.env;
    renderer.toneMappingExposure = L.exposure;
    renderer.setSize(w, h, false);
    renderer.render(entry.scene, camera);
    return (this.canvas as OffscreenCanvas).transferToImageBitmap();
  }

  /** Bytes under the hash changed (or the document closed) — forget the model and frames. */
  invalidate(hash: string) {
    const e = this.entries.get(hash);
    if (e && !(e instanceof Promise)) this.disposeEntry(e);
    this.entries.delete(hash);
    for (const [id, f] of this.frames) {
      if (!id.startsWith(`${hash}|`)) continue;
      f.image.delete();
      f.bitmap.close();
      this.frames.delete(id);
    }
  }

  private disposeEntry(e: Entry) {
    e.scene.traverse((o) => {
      const mesh = o as import('three').Mesh;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v && typeof v === 'object' && 'isTexture' in v) (v as import('three').Texture).dispose();
        mat.dispose();
      }
    });
  }

  dispose() {
    for (const e of this.entries.values()) if (e && !(e instanceof Promise)) this.disposeEntry(e);
    this.entries.clear();
    for (const f of this.frames.values()) {
      f.image.delete();
      f.bitmap.close();
    }
    this.frames.clear();
  }
}
