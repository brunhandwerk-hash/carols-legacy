import * as THREE from 'three';
import { MAP, PALETTE, START } from './config';
import { terrainHeight, terrainSlope, riverX, inMap, buildTerrainMesh, buildRiverMesh, registerFlatSpot, roadDistance, lonLatToWorld, TREELINE } from './terrain';
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
  scene.fog = new THREE.Fog(PALETTE.fog, 900, 9000);

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
  scene.add(buildRiverMesh());

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

function inClearing(x: number, z: number): boolean {
  for (const c of clearings) {
    const dx = x - c.x, dz = z - c.z;
    if (dx * dx + dz * dz < c.r * c.r) return true;
  }
  return false;
}

const AMBIENT_MIN_H = 420;        // below this: harvestable gameplay trees
const RIVER_MEADOW = 45;          // open strip along the Prahova
const EAST_PASTURE_H = 520;       // Baiu side turns to grass above this

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
  clearings.push({ x: START.camp.x, z: START.camp.z, r: 130 }); // the hamlet's meadow

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

  // --- gameplay forest: harvestable trees blanketing the lower valley,
  // including the future town site (it is 1690 — there is no town yet) ---
  const treeSpots: { x: number; z: number }[] = [];
  for (let tries = 0; tries < 500000 && treeSpots.length < 20000; tries++) {
    const x = MAP.minX + 14 + rng() * (MAP.width - 28);
    const z = MAP.minZ + 14 + rng() * (MAP.depth - 28);
    const h = terrainHeight(x, z);
    if (h >= AMBIENT_MIN_H) continue; // upper forest is the ambient tier
    const slope = terrainSlope(x, z);
    if (slope > 1.3) continue;
    if (inClearing(x, z)) continue;
    if (x > riverX(z) + 150 && h > EAST_PASTURE_H) continue;
    if (!clearOf(x, z, 4)) continue;
    if (rng() > 0.78) continue; // near-solid forest with small natural gaps
    treeSpots.push({ x, z });
  }
  // starter woodlots: groves on the valley floor near the hamlet
  const groves = [
    { x: START.camp.x + 60, z: START.camp.z - 40, r: 35, count: 40 },
    { x: START.camp.x - 55, z: START.camp.z + 50, r: 30, count: 30 },
    { x: START.camp.x - 20, z: START.camp.z - 85, r: 25, count: 22 },
  ];
  for (const g of groves) {
    for (let i = 0; i < g.count; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * g.r;
      const x = g.x + Math.cos(a) * d, z = g.z + Math.sin(a) * d;
      if (!clearOf(x, z, 3) || !inMap(x, z)) continue;
      treeSpots.push({ x, z });
    }
  }

  const trunkGeo = new THREE.CylinderGeometry(0.45, 0.65, 3.2, 5);
  trunkGeo.translate(0, 1.6, 0);
  const cone1Geo = new THREE.ConeGeometry(3.1, 6.5, 6);
  cone1Geo.translate(0, 5.2, 0);
  const cone2Geo = new THREE.ConeGeometry(2.2, 5, 6);
  cone2Geo.translate(0, 8.6, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: PALETTE.trunk });
  const pine1Mat = new THREE.MeshLambertMaterial({ color: PALETTE.pineDark });
  const pine2Mat = new THREE.MeshLambertMaterial({ color: PALETTE.pineMid });

  const n = treeSpots.length;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, n);
  const cones1 = new THREE.InstancedMesh(cone1Geo, pine1Mat, n);
  const cones2 = new THREE.InstancedMesh(cone2Geo, pine2Mat, n);
  trunks.castShadow = cones1.castShadow = cones2.castShadow = true;

  treeSpots.forEach((s, i) => {
    const y = terrainHeight(s.x, s.z);
    const sc = 0.85 + rng() * 0.8;
    dummy.position.set(s.x, y, s.z);
    dummy.scale.setScalar(sc);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    cones1.setMatrixAt(i, dummy.matrix);
    cones2.setMatrixAt(i, dummy.matrix);
    G.nodes.push({
      kind: 'wood', x: s.x, z: s.z, amount: 120, alive: true,
      mesh: [trunks, cones1, cones2], index: i,
    });
  });
  scene.add(trunks, cones1, cones2);

  // --- ambient forest: the mountainsides up to the treeline. Pure scenery —
  // not harvestable, no shadows, excluded from raycasting for performance. ---
  const ambientSpots: { x: number; z: number }[] = [];
  for (let tries = 0; tries < 900000 && ambientSpots.length < 42000; tries++) {
    const x = MAP.minX + 14 + rng() * (MAP.width - 28);
    const z = MAP.minZ + 14 + rng() * (MAP.depth - 28);
    const h = terrainHeight(x, z);
    if (h < AMBIENT_MIN_H || h > TREELINE) continue;
    if (terrainSlope(x, z) > 1.45) continue;
    if (inClearing(x, z)) continue;
    if (x > riverX(z) + 150 && h > EAST_PASTURE_H) continue; // Baiu pasture
    if (roadDistance(x, z) < 6) continue;
    if (rng() > 0.85) continue;
    ambientSpots.push({ x, z });
  }
  const amb1 = new THREE.InstancedMesh(cone1Geo, pine1Mat, ambientSpots.length);
  const amb2 = new THREE.InstancedMesh(cone2Geo, pine2Mat, ambientSpots.length);
  amb1.raycast = () => {}; // skip in picking
  amb2.raycast = () => {};
  ambientSpots.forEach((s, i) => {
    dummy.position.set(s.x, terrainHeight(s.x, s.z), s.z);
    dummy.scale.setScalar(1.3 + rng() * 0.9);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    dummy.updateMatrix();
    amb1.setMatrixAt(i, dummy.matrix);
    amb2.setMatrixAt(i, dummy.matrix);
  });
  scene.add(amb1, amb2);

  // --- stone outcrops (real-world locations on the lower slopes) ---
  const rockGeo = new THREE.DodecahedronGeometry(2.4, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x9a958c });
  const rockSpots: { x: number; z: number }[] = [];
  const rockGeos = [
    { lat: 45.3500, lon: 25.5390, r: 60, count: 22 },  // quarry slope west of town
    { lat: 45.3620, lon: 25.5520, r: 45, count: 14 },  // upper valley outcrops
    { lat: 45.3525, lon: 25.5640, r: 50, count: 12 },  // Baiu side
    { lat: 45.3395, lon: 25.5455, r: 50, count: 14 },  // southern slopes
    { lat: 45.3440, lon: 25.5495, r: 40, count: 12 },  // riverside boulders near the hamlet
  ];
  for (const c of rockGeos) {
    const w = lonLatToWorld(c.lon, c.lat);
    for (let i = 0; i < c.count; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * c.r;
      const x = w.x + Math.cos(a) * d, z = w.z + Math.sin(a) * d;
      if (!inMap(x, z) || !clearOf(x, z, 2)) continue;
      if (terrainSlope(x, z) > 1.2) continue;
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

  return [trunks, cones1, cones2, rocks, bushes];
}

// hide a depleted node's instances by scaling them to zero
export function hideNode(node: ResourceNode): void {
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const m of node.mesh) {
    m.setMatrixAt(node.index, zero);
    m.instanceMatrix.needsUpdate = true;
  }
}

export function nodeFromInstance(mesh: THREE.InstancedMesh, instanceId: number): ResourceNode | null {
  for (const n of G.nodes) {
    if (n.index === instanceId && n.mesh.includes(mesh)) return n.alive ? n : null;
  }
  return null;
}
