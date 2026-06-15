import * as THREE from 'three';
import { MAP, START } from './config';
import { terrainHeight, terrainSlope, inMap, riverX } from './terrain';
import { G, canAfford, pay } from './state';
import { Building, DEFS } from './buildings';
import { loadModel, fitModel } from './models';
import type { Villager } from './units';
import { nearestHarvestable, hideNode, WorldRefs } from './world';
import { setSelection, refreshSelectionPanel, setGhostRequest, toast, showNodeTip, hideNodeTip } from './ui';

// a finished crossing (timber or stone) unlocks the far bank for building
function bridgeBuilt(): boolean {
  return G.buildings.some(
    (b) => (b.def.key === 'bridge' || b.def.key === 'bridge_stone') && b.phase === 'done');
}

export interface CameraRig {
  target: { x: number; z: number };
  yaw: number;
  dist: number;
  update: (dt: number) => void;
  jumpTo: (x: number, z: number) => void;
}

const MIN_PITCH = 0.3;   // near-horizon, Google-Maps-style tilt
const MAX_PITCH = 1.45;  // almost top-down

export function initInput(
  canvas: HTMLCanvasElement,
  camera: THREE.PerspectiveCamera,
  world: WorldRefs,
): CameraRig {
  const rig = {
    target: { x: 934, z: 700 }, // hardcoded opening view: low angle looking at the mountains
    yaw: 0.349,
    dist: 220,
    pitch: 0.30,
  };

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key === 'Escape') { cancelGhost(); setSelection([], null); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  let pointerX = 0, pointerY = 0;
  let pointerSeen = false; // no edge-pan until the mouse has actually moved
  let pointerInside = true; // edge-pan pauses when the cursor leaves the window
  window.addEventListener('pointermove', () => { pointerSeen = true; pointerInside = true; }, { once: true });
  // stop edge-scrolling the moment the cursor leaves the page (e.g. to a 2nd monitor)
  document.addEventListener('mouseleave', () => { pointerInside = false; });
  document.addEventListener('mouseenter', () => { pointerInside = true; });
  window.addEventListener('blur', () => { pointerInside = false; });

  // keep the camera target inside a playable area inset from the rendered map edge
  const MARGIN_X = MAP.width * 0.12;
  const MARGIN_Z = MAP.depth * 0.12;
  function clampTarget(): void {
    rig.target.x = Math.min(MAP.maxX - MARGIN_X, Math.max(MAP.minX + MARGIN_X, rig.target.x));
    rig.target.z = Math.min(MAP.maxZ - MARGIN_Z, Math.max(MAP.minZ + MARGIN_Z, rig.target.z));
  }
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function raycastAt(cx: number, cy: number, objects: THREE.Object3D[]): THREE.Intersection[] {
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(objects, true);
  }

  function groundPoint(cx: number, cy: number): THREE.Vector3 | null {
    const hits = raycastAt(cx, cy, [world.terrain]);
    return hits.length ? hits[0].point : null;
  }

  // ---- ghost building placement ----
  let ghost: { key: string; mesh: THREE.Group; ring: THREE.Mesh; valid: boolean } | null = null;
  const okMat = new THREE.MeshBasicMaterial({ color: 0x7fc456, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const badMat = new THREE.MeshBasicMaterial({ color: 0xc45656, transparent: true, opacity: 0.4, side: THREE.DoubleSide });

  setGhostRequest((defKey: string) => {
    cancelGhost();
    const def = DEFS[defKey];
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(def.radius, def.radius, 0.5, 24), okMat);
    ring.position.y = 0.25;
    g.add(ring);
    const shape = new THREE.Group();
    def.build(shape); // immediate procedural placeholder
    shape.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.material = okMat;
        o.castShadow = false;
      }
    });
    g.add(shape);
    world.scene.add(g);
    ghost = { key: defKey, mesh: g, ring, valid: false };
    // if this building uses an authored glTF, show THAT shape in the preview so it
    // matches what actually gets placed (tinted by updateGhost each frame)
    if (def.model) {
      const m = def.model;
      loadModel(m.url).then((gl) => {
        if (!ghost || ghost.key !== defKey) return; // cancelled or switched
        const fitted = fitModel(gl, { fitRadius: m.fitRadius ?? def.radius, scale: m.scale, rotationY: m.rotationY, yOffset: m.yOffset });
        fitted.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = false; });
        shape.clear(); // drop the procedural placeholder
        shape.add(fitted);
      }).catch(() => { /* keep the procedural placeholder */ });
    }
  });

  function cancelGhost(): void {
    if (ghost) { world.scene.remove(ghost.mesh); ghost = null; }
  }

  function updateGhost(): void {
    if (!ghost) return;
    const p = groundPoint(pointerX, pointerY);
    if (!p) return;
    ghost.mesh.position.set(p.x, terrainHeight(p.x, p.z), p.z);
    const def = DEFS[ghost.key];
    // buildings terrace their own ground (see Building.addFoundation), so they can
    // sit on fairly steep slopes — only true cliffs and the river are off-limits.
    // Keep the whole footprint out of the river channel; bridges may cross it.
    const riverDist = Math.abs(p.x - riverX(p.z));
    const riverOk = def.noFoundation || riverDist > 13 + def.radius;
    // the far bank is off-limits until a bridge spans the river. Bridges (noFoundation)
    // are exempt so the first crossing can always be placed.
    const startSign = Math.sign(START.camp.x - riverX(START.camp.z));
    const ptSign = Math.sign(p.x - riverX(p.z));
    const sideOk = def.noFoundation || bridgeBuilt() || ptSign === startSign;
    let valid = inMap(p.x, p.z) && riverOk && sideOk && terrainSlope(p.x, p.z) < 0.95;
    if (valid) {
      for (const b of G.buildings) {
        const d2 = (b.x - p.x) ** 2 + (b.z - p.z) ** 2;
        if (d2 < (b.def.radius + def.radius + 1) ** 2) { valid = false; break; }
      }
    }
    ghost.valid = valid;
    const mat = valid ? okMat : badMat;
    ghost.mesh.traverse((o) => { if (o instanceof THREE.Mesh) o.material = mat; });
  }

  function placeGhost(): void {
    if (!ghost || !ghost.valid) {
      if (ghost) {
        const p = groundPoint(pointerX, pointerY);
        const def = DEFS[ghost.key];
        const farBank = p && !def.noFoundation && !bridgeBuilt() &&
          Math.sign(p.x - riverX(p.z)) !== Math.sign(START.camp.x - riverX(START.camp.z));
        toast(farBank ? 'Bridge the Prahova to build on the far bank.' : 'Cannot build here.');
      }
      return;
    }
    const def = DEFS[ghost.key];
    if (!canAfford(def.cost)) { toast('Not enough resources.'); cancelGhost(); return; }
    pay(def.cost);
    const { x, z } = { x: ghost.mesh.position.x, z: ghost.mesh.position.z };
    // clear trees/bushes under the footprint
    for (const n of G.nodes) {
      if (!n.alive) continue;
      if ((n.x - x) ** 2 + (n.z - z) ** 2 < (def.radius + 2) ** 2) { n.alive = false; hideNode(n); }
    }
    // most buildings get a random yaw; a bridge auto-orients to span the river
    let rotY = Math.random() * Math.PI * 2;
    if (ghost.key === 'bridge') {
      const dXdZ = (riverX(z + 8) - riverX(z - 8)) / 16;
      rotY = Math.atan2(dXdZ, 1);
    }
    const b = new Building(ghost.key, x, z, 'site', world.scene, rotY);
    for (const v of G.selected) v.orderBuild(b);
    cancelGhost();
    refreshSelectionPanel();
  }

  // ---- selection / map-drag: click, drag-to-pan, Shift+drag box-select ----
  const selbox = document.getElementById('selbox')!;
  let dragStart: { x: number; y: number } | null = null;  // left: click-select / box-select
  let dragging = false;
  let rDragStart: { x: number; y: number } | null = null; // right: command / map-pan
  let rDragging = false;
  let panLast = { x: 0, y: 0 };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 0) {
      // Ctrl/Alt + left-drag orbits the camera (laptops without a middle button)
      if (e.ctrlKey || e.altKey) { orbit = { x: e.clientX, y: e.clientY }; return; }
      if (ghost) { placeGhost(); return; }
      // left-click selects; left-drag box-selects villagers
      dragStart = { x: e.clientX, y: e.clientY };
      dragging = false;
    } else if (e.button === 2) {
      // right-drag pans the map (grab style); a stationary right-click does nothing
      rDragStart = { x: e.clientX, y: e.clientY };
      panLast = { x: e.clientX, y: e.clientY };
      rDragging = false;
    } else if (e.button === 1) {
      e.preventDefault();
      orbit = { x: e.clientX, y: e.clientY };
    }
  });

  window.addEventListener('pointermove', (e) => {
    pointerX = e.clientX; pointerY = e.clientY; pointerInside = true;
    if (orbit) {
      rig.yaw -= (e.clientX - orbit.x) * 0.005;
      rig.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, rig.pitch + (e.clientY - orbit.y) * 0.004));
      orbit = { x: e.clientX, y: e.clientY };
    }
    if (dragStart) {
      const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
      if (!dragging && dx * dx + dy * dy > 36) { dragging = true; selbox.style.display = 'block'; }
      if (dragging) {
        const x = Math.min(dragStart.x, e.clientX), y = Math.min(dragStart.y, e.clientY);
        selbox.style.left = `${x}px`; selbox.style.top = `${y}px`;
        selbox.style.width = `${Math.abs(dx)}px`; selbox.style.height = `${Math.abs(dy)}px`;
      }
    }
    if (rDragStart) {
      const dx = e.clientX - rDragStart.x, dy = e.clientY - rDragStart.y;
      if (!rDragging && dx * dx + dy * dy > 36) { rDragging = true; canvas.style.cursor = 'grabbing'; }
      if (rDragging) {
        // grab-the-map: move the target so the world under the cursor follows it,
        // rotation-aware so it always tracks the actual on-screen direction
        const mdx = e.clientX - panLast.x, mdy = e.clientY - panLast.y;
        panLast = { x: e.clientX, y: e.clientY };
        const cos = Math.cos(rig.yaw), sin = Math.sin(rig.yaw);
        const k = rig.dist / 620;
        rig.target.x -= (cos * mdx + sin * mdy) * k;
        rig.target.z -= (-sin * mdx + cos * mdy) * k;
        clampTarget();
      }
    }
    updateHoverTip(e.clientX, e.clientY);
  });

  // ---- resource hover tooltip ----
  const NODE_LABEL = { wood: 'Timber', stone: 'Stone', food: 'Berries' };
  function updateHoverTip(cx: number, cy: number): void {
    if (orbit || dragStart || rDragStart || ghost) { hideNodeTip(); return; }
    const p = groundPoint(cx, cy);
    const node = p ? nearestHarvestable(p.x, p.z, 6) : null;
    if (!node) { hideNodeTip(); return; }
    showNodeTip(cx, cy, `${NODE_LABEL[node.kind]} · ${Math.ceil(node.amount)} left`);
  }

  window.addEventListener('pointerup', (e) => {
    if (orbit) { orbit = null; return; }
    if (e.button === 2 && rDragStart) {
      canvas.style.cursor = '';
      const wasDrag = rDragging;
      rDragStart = null;
      rDragging = false;
      if (ghost) { cancelGhost(); return; }
      // right-click is camera-pan / ghost-cancel only — villagers are autonomous,
      // so a stationary right-click no longer issues any command.
      return;
    }
    if (e.button !== 0 || !dragStart) return;
    selbox.style.display = 'none';
    if (dragging) {
      // box select villagers via screen projection
      const x0 = Math.min(dragStart.x, e.clientX), x1 = Math.max(dragStart.x, e.clientX);
      const y0 = Math.min(dragStart.y, e.clientY), y1 = Math.max(dragStart.y, e.clientY);
      const r = canvas.getBoundingClientRect();
      const v3 = new THREE.Vector3();
      const picked: Villager[] = [];
      for (const v of G.villagers) {
        v3.copy(v.group.position).setY(v.group.position.y + 1);
        v3.project(camera);
        const sx = r.left + ((v3.x + 1) / 2) * r.width;
        const sy = r.top + ((1 - v3.y) / 2) * r.height;
        if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) picked.push(v);
      }
      setSelection(picked, null);
    } else {
      // single click: villager > building > clear (trees aren't selectable,
      // so skip the instanced forest for speed)
      const targets: THREE.Object3D[] = [
        ...G.villagers.map((v) => v.group),
        ...G.buildings.map((b) => b.group),
        world.terrain,
      ];
      const hits = raycastAt(e.clientX, e.clientY, targets);
      let done = false;
      for (const h of hits) {
        const vil = h.object.userData.villager as Villager | undefined;
        if (vil) { setSelection([vil], null); done = true; break; }
        const bld = h.object.userData.building as Building | undefined;
        if (bld) { setSelection([], bld); done = true; break; }
        if (h.object.name === 'terrain') break;
      }
      if (!done) setSelection([], null);
    }
    dragStart = null;
    dragging = false;
  });

  // right-click is reserved for the camera (pan) — villagers run themselves.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- camera ----
  let orbit: { x: number; y: number } | null = null;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const oldDist = rig.dist;
    // dynamic zoom step: fine near the ground (precise framing of the action),
    // growing larger the further out you are so you get in/out fast
    const MIN_D = 40, MAX_D = 3400;
    const t = (rig.dist - MIN_D) / (MAX_D - MIN_D); // 0 = closest, 1 = farthest
    const step = 0.10 + 0.26 * t;                    // 10% step up close → 36% far out
    const factor = e.deltaY > 0 ? 1 + step : 1 / (1 + step);
    rig.dist = Math.min(MAX_D, Math.max(MIN_D, rig.dist * factor));
    // Google-Maps-style: zoom toward the point under the cursor
    if (rig.dist < oldDist) {
      const p = groundPoint(e.clientX, e.clientY);
      if (p) {
        const f = 1 - rig.dist / oldDist;
        rig.target.x += (p.x - rig.target.x) * f;
        rig.target.z += (p.z - rig.target.z) * f;
        clampTarget();
      }
    }
  }, { passive: false });

  const EDGE = 14;
  function update(dt: number): void {
    const panSpeed = rig.dist * 0.85 * dt;
    // fwd = toward the top of the screen, rgt = toward the right — both in screen
    // space, then rotated by the camera yaw so they always match what you see
    let fwd = 0, rgt = 0;
    if (keys.has('w') || keys.has('arrowup')) fwd += 1;
    if (keys.has('s') || keys.has('arrowdown')) fwd -= 1;
    if (keys.has('a') || keys.has('arrowleft')) rgt -= 1;
    if (keys.has('d') || keys.has('arrowright')) rgt += 1;
    // edge-pan only while the cursor is actually inside the window — moving to a
    // second screen must not keep scrolling the map
    if (pointerSeen && pointerInside) {
      if (pointerX < EDGE) rgt -= 1;
      if (pointerX > window.innerWidth - EDGE) rgt += 1;
      if (pointerY < EDGE) fwd += 1;
      if (pointerY > window.innerHeight - EDGE && pointerY < window.innerHeight - 2) fwd -= 1;
    }
    if (keys.has('q')) rig.yaw += dt * 1.6;
    if (keys.has('e')) rig.yaw -= dt * 1.6;
    if (fwd !== 0 || rgt !== 0) {
      const cos = Math.cos(rig.yaw), sin = Math.sin(rig.yaw);
      // screen-up on the ground = (-sin, -cos); screen-right = (cos, -sin)
      rig.target.x += (-sin * fwd + cos * rgt) * panSpeed;
      rig.target.z += (-cos * fwd - sin * rgt) * panSpeed;
      clampTarget();
    }
    const ty = terrainHeight(rig.target.x, rig.target.z);
    const cy = Math.sin(rig.pitch) * rig.dist;
    const ch = Math.cos(rig.pitch) * rig.dist;
    const cx = rig.target.x + Math.sin(rig.yaw) * ch;
    const cz = rig.target.z + Math.cos(rig.yaw) * ch;
    // keep the camera above the terrain (the Bucegi wall is tall)
    const groundY = terrainHeight(
      Math.min(MAP.maxX, Math.max(MAP.minX, cx)),
      Math.min(MAP.maxZ, Math.max(MAP.minZ, cz)),
    );
    camera.position.set(cx, Math.max(ty + cy, groundY + 12), cz);
    camera.lookAt(rig.target.x, ty, rig.target.z);
    // sun + shadow frustum follow the camera target
    world.sun.position.set(rig.target.x - 180, 260, rig.target.z - 120);
    world.sun.target.position.set(rig.target.x, ty, rig.target.z);
    updateGhost();
  }

  return {
    get target() { return rig.target; },
    get yaw() { return rig.yaw; },
    get dist() { return rig.dist; },
    update,
    jumpTo: (x: number, z: number) => { rig.target.x = x; rig.target.z = z; clampTarget(); },
  } as CameraRig;
}
