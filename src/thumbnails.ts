import * as THREE from 'three';
import { DEFS } from './buildings';
import { loadModel, fitModel } from './models';

// ---------------------------------------------------------------------------
// Offscreen building-preview thumbnails. Each building (procedural mesh OR its
// authored glTF) is rendered once to a small transparent PNG, used in the build
// menu cards + detail card — so the menu shows the actual building, Foundation-
// style, not a flat icon. Uses its own tiny WebGL renderer, disposed when done.
// ---------------------------------------------------------------------------

export async function renderBuildingThumbnails(
  keys: readonly string[],
  onReady: (key: string, dataUrl: string) => void,
  size = 192,
): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xdfeefc, 0x6a7a52, 1.5);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.position.set(4, 7, 5);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbcd0e0, 0.7);
  fill.position.set(-5, 3, -3);
  scene.add(fill);

  const cam = new THREE.PerspectiveCamera(32, 1, 0.05, 2000);

  for (const key of keys) {
    const def = DEFS[key];
    if (!def) continue;
    const grp = new THREE.Group();
    try {
      if (def.model) {
        const gl = await loadModel(def.model.url);
        grp.add(fitModel(gl, {
          fitRadius: def.model.fitRadius ?? def.radius,
          scale: def.model.scale, rotationY: def.model.rotationY, yOffset: def.model.yOffset,
        }));
      } else {
        def.build(grp);
      }
    } catch {
      def.build(grp); // glTF failed → procedural fallback
    }
    scene.add(grp);

    grp.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(grp);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(0.5, sphere.radius);
    const dist = (r / Math.sin((cam.fov * Math.PI / 180) / 2)) * 0.95;
    const dir = new THREE.Vector3(1, 0.85, 1).normalize(); // 3/4 hero angle
    cam.position.copy(sphere.center).addScaledVector(dir, dist);
    cam.lookAt(sphere.center);

    renderer.render(scene, cam);
    const url = renderer.domElement.toDataURL('image/png');
    onReady(key, url);

    scene.remove(grp);
    grp.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose();
    });
    await new Promise((res) => setTimeout(res, 0)); // yield so the UI stays responsive
  }

  renderer.dispose();
}
