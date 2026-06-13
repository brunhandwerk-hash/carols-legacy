import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// glTF "hero" model loading for landmark buildings (see the hybrid asset policy
// in CLAUDE.md). Generic dwellings stay procedural; landmarks whose BuildingDef
// has a `model` load an authored .glb from public/models/ and swap it in for the
// procedural mesh once ready. If the file is missing or fails to load, the
// procedural fallback simply stays — nothing breaks.
// ---------------------------------------------------------------------------

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group>>();

// load (and cache) a glb, returning a fresh clone per call so each instance is
// independent
export function loadModel(url: string): Promise<THREE.Group> {
  let p = cache.get(url);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
    });
    cache.set(url, p);
  }
  return p.then((scene) => scene.clone(true));
}

export interface FitOpts {
  fitRadius?: number; // auto-scale so the footprint ~fits this radius (metres)
  scale?: number;     // explicit scale (overrides auto-fit)
  rotationY?: number;
  yOffset?: number;
}

// Scale + orient a loaded model so it sits on the ground (base at y=0), centred
// on its footprint. Returns a wrapper Group ready to drop into a building group.
export function fitModel(model: THREE.Group, opts: FitOpts): THREE.Group {
  const wrap = new THREE.Group();
  model.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);

  let s = opts.scale ?? 1;
  if (opts.scale === undefined && opts.fitRadius) {
    const footprint = Math.max(size.x, size.z) || 1;
    s = (opts.fitRadius * 2 * 0.92) / footprint;
  }
  model.scale.setScalar(s);
  // centre on XZ and rest the base on the platform
  model.position.set(-center.x * s, -box.min.y * s + (opts.yOffset ?? 0), -center.z * s);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
  if (opts.rotationY) wrap.rotation.y = opts.rotationY;
  wrap.add(model);
  return wrap;
}
