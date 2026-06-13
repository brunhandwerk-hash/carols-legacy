import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAP, PALETTE, START } from './config';
import { terrainHeight, terrainSlope, riverX, inMap, buildTerrainMesh, buildRiverMesh, buildRoadMesh, buildBackdropMesh, registerFlatSpot, roadDistance, lonLatToWorld, TREELINE } from './terrain';
import { PLOTS } from './plots';
import { G, ResourceNode } from './state';

export interface WorldRefs {
  scene: THREE.Scene;
  terrain: THREE.Mesh;
  sun: THREE.DirectionalLight;
  gatherables: THREE.InstancedMesh[]; // raycast targets for resource nodes
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWorld(scene: THREE.Scene): WorldRefs {
  // every landmark plot is flattened into the terrain before meshing
  for (const p of PLOTS) registerFlatSpot(p.x, p.z, p.r);
  registerFlatSpot(START.camp.x, START.camp.z, 14);

  scene.background = new THREE.Color(PALETTE.sky);
  // light, long-range haze: enough atmospheric perspective to give the distant
  // massifs depth, but far enough that the peaks stay visible on the horizon
  scene.fog = new THREE.Fog(PALETTE.fog, 1400, 40000);

  const hemi = new THREE.HemisphereLight(0xcfe4f0, 0x6a7a52, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(PALETTE.sun, 1.9);
  sun.position.set(-180, 600, -120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 2400;
  const sc = 280;
  sun.shadow.camera.left = -sc; sun.shadow.camera.right = sc;
  sun.shadow.camera.top = sc; sun.shadow.camera.bottom = -sc;
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  scene.add(sun.target);

  const terrain = buildTerrainMesh();
  scene.add(terrain);
  const backdrop = buildBackdropMesh();
  if (backdrop) scene.add(backdrop);
  scene.add(buildRiverMesh());
  scene.add(buildRoadMesh());

  const gatherables = scatterNature(scene);

  return { scene, terrain, sun, gatherables };
}

// ---- forest clearings (poieni) — real ones, by name ----
// World coords resolved at scatter time from lat/lon.
const CLEARING_GEOS = [
  { lat: 45.3460, lon: 25.5215, r: 190 },  // Poiana Stanii Regale
  { lat: 45.3418, lon: 25.5070, r: 140 },  // Cota 1400 meadow
  { lat: 45.3555, lon: 25.5375, r: 130 },  // Poiana Foisorului
  { lat: 45.3604, lon: 25.5421, r: 110 },  // Peles esplanade
  { lat: 45.3590, lon: 25.5414, r: 80 },   // Pelisor terrace
  { lat: 45.3559, lon: 25.5479, r: 70 },   // monastery surroundings
  { lat: 45.3650, lon: 25.5300, r: 120 },  // northern slope poiana
  { lat: 45.3330, lon: 25.5290, r: 150 },  // southern slope poiana
  { lat: 45.3560, lon: 25.5660, r: 130 },  // lower Baiu poiana (Cumpatu side)
];

let clearings: { x: number; z: number; r: number }[] = [];

// forest level-of-detail: chunks near the camera show every tree, distant
// chunks swap to a sparse fat-tree proxy
interface ForestChunk { cx: number; cz: number; near: THREE.InstancedMesh; far: THREE.InstancedMesh }
const forestChunks: ForestChunk[] = [];
const LOD_DIST = 1500;

export function updateForestLOD(camX: number, camZ: number): void {
  for (const c of forestChunks) {
    const d2 = (c.cx - camX) ** 2 + (c.cz - camZ) ** 2;
    const isNear = d2 < LOD_DIST * LOD_DIST;
    if (c.near.visible !== isNear) {
      c.near.visible = isNear;
      c.far.visible = !isNear;
    }
  }
}

function inClearing(x: number, z: number): boolean {
  for (const c of clearings) {
    const dx = x - c.x, dz = z - c.z;
    if (dx * dx + dz * dz < c.r * c.r) return true;
  }
  return false;
}

const RIVER_MEADOW = 45;          // open strip along the Prahova
const EAST_PASTURE_H = 520;       // Baiu side turns to grass above this

// merged spruce: trunk + two cones, vertex-colored, one draw call per chunk
function buildTreeGeometry(): THREE.BufferGeometry {
  const paint = (g: THREE.BufferGeometry, color: number): THREE.BufferGeometry => {
    const c = new THREE.Color(color);
    const count = g.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  };
  const trunk = paint(new THREE.CylinderGeometry(0.45, 0.65, 3.2, 5), PALETTE.trunk);
  trunk.translate(0, 1.6, 0);
  const cone1 = paint(new THREE.ConeGeometry(3.1, 6.5, 6), PALETTE.pineDark);
  cone1.translate(0, 5.2, 0);
  const cone2 = paint(new THREE.ConeGeometry(2.2, 5, 6), PALETTE.pineMid);
  cone2.translate(0, 8.6, 0);
  const merged = mergeGeometries([trunk, cone1, cone2]);
  trunk.dispose(); cone1.dispose(); cone2.dispose();
  return merged;
}

// deterministic forest predicate — used for the minimap tint
export function forestedAt(x: number, z: number): boolean {
  const h = terrainHeight(x, z);
  if (h > TREELINE) return false;
  if (terrainSlope(x, z) > 1.4) return false;
  if (inClearing(x, z)) return false;
  if (Math.abs(x - riverX(z)) < RIVER_MEADOW) return false;
  if (x > riverX(z) + 150 && h > EAST_PASTURE_H) return false; // Baiu pasture
  return true;
}

// ---- trees, rocks, berry bushes: instanced meshes + resource nodes ----
function scatterNature(scene: THREE.Scene): THREE.InstancedMesh[] {
  const rng = mulberry32(1883);
  const dummy = new THREE.Object3D();

  clearings = CLEARING_GEOS.map((c) => {
    const w = lonLatToWorld(c.lon, c.lat);
    return { x: w.x, z: w.z, r: c.r };
  });
  clearings.push({ x: START.camp.x, z: START.camp.z, r: 100 }); // the hamlet's meadow

  const clearOf = (x: number, z: number, margin: number): boolean => {
    for (const p of PLOTS) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < (p.r + margin) ** 2) return false;
    }
    const dx = x - START.camp.x, dz = z - START.camp.z;
    if (dx * dx + dz * dz < (16 + margin) ** 2) return false;
    if (Math.abs(x - riverX(z)) < RIVER_MEADOW + margin) return false;
    if (roadDistance(x, z) < 5 + margin) return false;
    return true;
  };

  // --- the forest: real density (~9m spacing), covering everything below the
  // treeline including the future town site (anno 1690 — no town yet).
  // One merged tree geometry, one InstancedMesh per ~1km terrain chunk, so the
  // GPU frustum-culls whole chunks. Trees below HARVEST_MAX_H are resource
  // nodes; higher forest is scenery. Picking goes through terrain-hit +
  // nearest-node lookup, never the instances. ---
  const treeGeo = buildTreeGeometry();
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const HARVEST_MAX_H = 420;
  const SPACING = 9;
  const CHUNK = 1024;
  const FILL = 0.8;
  let totalTrees = 0;

  const chunksX = Math.ceil(MAP.width / CHUNK);
  const chunksZ = Math.ceil(MAP.depth / CHUNK);
  for (let cz = 0; cz < chunksZ; cz++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const crng = mulberry32(((cx * 73856093) ^ (cz * 19349663) ^ 1883) >>> 0);
      const x0 = MAP.minX + cx * CHUNK;
      const z0 = MAP.minZ + cz * CHUNK;
      const spots: { x: number; z: number; h: number }[] = [];
      for (let gz = z0; gz < Math.min(z0 + CHUNK, MAP.maxZ - 14); gz += SPACING) {
        for (let gx = x0; gx < Math.min(x0 + CHUNK, MAP.maxX - 14); gx += SPACING) {
          const keep = crng() <= FILL;
          const jx = (crng() - 0.5) * SPACING * 0.9;
          const jz = (crng() - 0.5) * SPACING * 0.9;
          if (!keep) continue;
          const x = gx + jx, z = gz + jz;
          if (!inMap(x, z)) continue;
          const h = terrainHeight(x, z);
          if (h > TREELINE) continue;
          if (terrainSlope(x, z) > 1.35) continue;
          if (inClearing(x, z)) continue;
          if (x > riverX(z) + 150 && h > EAST_PASTURE_H) continue; // Baiu pasture
          if (!clearOf(x, z, 4)) continue;
          spots.push({ x, z, h });
        }
      }
      if (spots.length === 0) continue;
      // near mesh: every tree, full detail. Trees don't cast shadows — they're
      // background filler and dropping them from the shadow pass frees the GPU
      // budget for the detailed PBR buildings.
      const mesh = new THREE.InstancedMesh(treeGeo, treeMat, spots.length);
      mesh.castShadow = false;
      mesh.raycast = () => {};
      // far mesh: every 4th tree, fattened — swapped in beyond LOD_DIST
      const farSpots = spots.filter((_, i) => i % 4 === 0);
      const farMesh = new THREE.InstancedMesh(treeGeo, treeMat, farSpots.length);
      farMesh.raycast = () => {};
      farMesh.visible = false;
      spots.forEach((s, i) => {
        dummy.position.set(s.x, s.h, s.z);
        dummy.scale.setScalar(0.85 + crng() * 0.8);
        dummy.rotation.set(0, crng() * Math.PI * 2, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        if (s.h < HARVEST_MAX_H) {
          G.nodes.push({ kind: 'wood', x: s.x, z: s.z, amount: 120, alive: true, mesh: [mesh], index: i });
        }
      });
      farSpots.forEach((s, i) => {
        dummy.position.set(s.x, s.h, s.z);
        dummy.scale.set(1.7, 1.35, 1.7);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        farMesh.setMatrixAt(i, dummy.matrix);
      });
      scene.add(mesh, farMesh);
      forestChunks.push({
        cx: x0 + CHUNK / 2, cz: z0 + CHUNK / 2, near: mesh, far: farMesh,
      });
      totalTrees += spots.length;
    }
  }
  console.log(`forest: ${totalTrees} trees, ${G.nodes.length} harvestable, ${forestChunks.length} chunks`);

  // --- stone outcrops (real-world locations on the lower slopes) ---
  const rockGeo = new THREE.DodecahedronGeometry(2.4, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x9a958c });
  const rockSpots: { x: number; z: number }[] = [];
  const rockGeos = [
    { lat: 45.3468, lon: 25.5548, r: 42, count: 26 },  // hamlet quarry-slope — reachable from the start camp
    { lat: 45.3500, lon: 25.5390, r: 60, count: 24 },  // quarry slope west of town
    { lat: 45.3620, lon: 25.5520, r: 45, count: 16 },  // upper valley outcrops
    { lat: 45.3525, lon: 25.5640, r: 50, count: 14 },  // Baiu side
    { lat: 45.3395, lon: 25.5455, r: 50, count: 16 },  // southern slopes
    { lat: 45.3440, lon: 25.5495, r: 40, count: 16 },  // riverside boulders near the hamlet
  ];
  for (const c of rockGeos) {
    const w = lonLatToWorld(c.lon, c.lat);
    for (let i = 0; i < c.count; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * c.r;
      const x = w.x + Math.cos(a) * d, z = w.z + Math.sin(a) * d;
      if (!inMap(x, z) || !clearOf(x, z, 2)) continue;
      if (terrainSlope(x, z) > 1.45) continue;
      rockSpots.push({ x, z });
    }
  }
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockSpots.length);
  rocks.castShadow = true;
  rockSpots.forEach((s, i) => {
    dummy.position.set(s.x, terrainHeight(s.x, s.z) + 0.6, s.z);
    dummy.scale.set(0.8 + rng(), 0.6 + rng() * 0.7, 0.8 + rng());
    dummy.rotation.set(rng(), rng() * Math.PI, rng() * 0.5);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
    G.nodes.push({ kind: 'stone', x: s.x, z: s.z, amount: 250, alive: true, mesh: [rocks], index: i });
  });
  scene.add(rocks);

  // --- berry thickets near the hamlet and along the river ---
  const bushGeo = new THREE.IcosahedronGeometry(1.5, 0);
  const bushMat = new THREE.MeshLambertMaterial({ color: 0x4f7a38 });
  const bushSpots: { x: number; z: number }[] = [];
  const bushClusters = [
    { x: START.camp.x + 45, z: START.camp.z + 55, r: 30, count: 11 },
    { x: START.camp.x - 60, z: START.camp.z - 30, r: 26, count: 8 },
    { x: START.camp.x + 10, z: START.camp.z - 130, r: 26, count: 8 },
  ];
  const bushGeos = [
    { lat: 45.3625, lon: 25.5545, r: 35, count: 8 },   // upriver banks
    { lat: 45.3480, lon: 25.5600, r: 40, count: 8 },   // Baiu pastures
  ];
  for (const c of bushGeos) {
    const w = lonLatToWorld(c.lon, c.lat);
    bushClusters.push({ x: w.x, z: w.z, r: c.r, count: c.count });
  }
  for (const c of bushClusters) {
    for (let i = 0; i < c.count; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * c.r;
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      if (!inMap(x, z) || !clearOf(x, z, 1)) continue;
      bushSpots.push({ x, z });
    }
  }
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, bushSpots.length);
  bushes.castShadow = true;
  bushSpots.forEach((s, i) => {
    dummy.position.set(s.x, terrainHeight(s.x, s.z) + 0.7, s.z);
    dummy.scale.set(1 + rng() * 0.6, 0.7 + rng() * 0.4, 1 + rng() * 0.6);
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.updateMatrix();
    bushes.setMatrixAt(i, dummy.matrix);
    G.nodes.push({ kind: 'food', x: s.x, z: s.z, amount: 150, alive: true, mesh: [bushes], index: i });
  });
  scene.add(bushes);

  // raycast targets for picking: rocks and bushes only — trees are picked via
  // terrain hit + nearest node (see input.ts)
  return [rocks, bushes];
}

// hide a depleted node's instances by scaling them to zero
export function hideNode(node: ResourceNode): void {
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const m of node.mesh) {
    m.setMatrixAt(node.index, zero);
    m.instanceMatrix.needsUpdate = true;
  }
}

// nearest living node of any kind to a ground point — forgiving right-click /
// hover picking, so rocks and bushes are as easy to target as trees
export function nearestHarvestable(x: number, z: number, maxDist: number): ResourceNode | null {
  let best: ResourceNode | null = null;
  let bd = maxDist * maxDist;
  for (const n of G.nodes) {
    if (!n.alive) continue;
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

export function nodeFromInstance(mesh: THREE.InstancedMesh, instanceId: number): ResourceNode | null {
  for (const n of G.nodes) {
    if (n.index === instanceId && n.mesh.includes(mesh)) return n.alive ? n : null;
  }
  return null;
}
