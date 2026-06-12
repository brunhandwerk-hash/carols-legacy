import * as THREE from 'three';
import { MAP, PALETTE, START } from './config';
import { terrainHeight, terrainSlope, riverX, inMap, buildTerrainMesh, buildRiverMesh, registerFlatSpot, roadDistance } from './terrain';
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
  scene.fog = new THREE.Fog(PALETTE.fog, 260, 900);

  const hemi = new THREE.HemisphereLight(0xcfe4f0, 0x6a7a52, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(PALETTE.sun, 1.9);
  sun.position.set(-180, 260, -120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 900;
  const sc = 240;
  sun.shadow.camera.left = -sc; sun.shadow.camera.right = sc;
  sun.shadow.camera.top = sc; sun.shadow.camera.bottom = -sc;
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  scene.add(sun.target);

  const terrain = buildTerrainMesh();
  scene.add(terrain);
  scene.add(buildRiverMesh());

  buildPeaks(scene);
  const gatherables = scatterNature(scene);

  return { scene, terrain, sun, gatherables };
}

// ---- backdrop mountains beyond the playable map ----
function buildPeaks(scene: THREE.Scene): void {
  const rng = mulberry32(7);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x7e8089 });
  const snowMat = new THREE.MeshLambertMaterial({ color: PALETTE.snow });
  const forestMat = new THREE.MeshLambertMaterial({ color: 0x4b6444 });

  const addPeak = (x: number, z: number, h: number, r: number, snowy: boolean) => {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7, 1), snowy ? rockMat : forestMat);
    cone.position.set(x, terrainHeightSafe(x, z) + h / 2 - 8, z);
    cone.rotation.y = rng() * Math.PI;
    scene.add(cone);
    if (snowy) {
      const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.42, h * 0.34, 7, 1), snowMat);
      cap.position.set(x, cone.position.y + h * 0.36, z);
      cap.rotation.y = cone.rotation.y;
      scene.add(cap);
    }
  };
  // Bucegi wall to the west — tall, craggy, snow-capped
  for (let i = 0; i < 9; i++) {
    const z = MAP.minZ - 60 + i * 100 + rng() * 50;
    addPeak(MAP.minX - 120 - rng() * 130, z, 240 + rng() * 160, 130 + rng() * 70, true);
  }
  // Baiu ridge to the east — lower, rounded, forested
  for (let i = 0; i < 8; i++) {
    const z = MAP.minZ - 40 + i * 105 + rng() * 60;
    addPeak(MAP.maxX + 110 + rng() * 110, z, 150 + rng() * 80, 120 + rng() * 60, rng() > 0.7);
  }
  // northern head of the valley
  for (let i = 0; i < 4; i++) {
    addPeak(MAP.minX + 80 + i * 120 + rng() * 60, MAP.minZ - 160 - rng() * 80, 200 + rng() * 120, 120 + rng() * 60, true);
  }
}

function terrainHeightSafe(x: number, z: number): number {
  const cx = Math.min(MAP.maxX, Math.max(MAP.minX, x));
  const cz = Math.min(MAP.maxZ, Math.max(MAP.minZ, z));
  return terrainHeight(cx, cz);
}

// ---- trees, rocks, berry bushes: instanced meshes + resource nodes ----
function scatterNature(scene: THREE.Scene): THREE.InstancedMesh[] {
  const rng = mulberry32(1883);
  const dummy = new THREE.Object3D();

  const clearOf = (x: number, z: number, margin: number): boolean => {
    for (const p of PLOTS) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < (p.r + margin) ** 2) return false;
    }
    const dx = x - START.camp.x, dz = z - START.camp.z;
    if (dx * dx + dz * dz < (16 + margin) ** 2) return false;
    if (Math.abs(x - riverX(z)) < 10 + margin) return false;
    if (roadDistance(x, z) < 4 + margin) return false;
    return true;
  };

  // --- pines ---
  const treeSpots: { x: number; z: number }[] = [];
  for (let tries = 0; tries < 26000 && treeSpots.length < 3400; tries++) {
    const x = MAP.minX + 6 + rng() * (MAP.width - 12);
    const z = MAP.minZ + 6 + rng() * (MAP.depth - 12);
    if (!clearOf(x, z, 4)) continue;
    if (terrainSlope(x, z) > 1.35) continue;
    // density: heavy on the slopes and the north, light on the valley floor
    const slopeBias = Math.min(1, terrainSlope(x, z) / 0.5);
    const westBias = x < -40 ? 0.75 : 0;
    const eastBias = x > 135 ? 0.6 : 0;
    const northBias = z < -60 ? 0.35 : 0;
    const floorPenalty = (x > -40 && x < 135 && z > -60) ? -0.55 : 0;
    const density = 0.18 + slopeBias * 0.4 + westBias + eastBias + northBias + floorPenalty;
    if (rng() > density) continue;
    treeSpots.push({ x, z });
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
    const sc = 0.75 + rng() * 0.6;
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

  // --- stone outcrops: a quarry slope west of town and scatter in the north ---
  const rockGeo = new THREE.DodecahedronGeometry(2.4, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x9a958c });
  const rockSpots: { x: number; z: number }[] = [];
  const rockClusters = [
    { x: -130, z: 35, r: 26, count: 16 },
    { x: -105, z: -25, r: 18, count: 8 },
    { x: 55, z: -210, r: 24, count: 10 },
    { x: 170, z: -90, r: 22, count: 8 },
  ];
  for (const c of rockClusters) {
    for (let i = 0; i < c.count; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * c.r;
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      if (!inMap(x, z) || !clearOf(x, z, 2)) continue;
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
    { x: 55, z: 140, r: 20, count: 9 },
    { x: 5, z: 170, r: 18, count: 7 },
    { x: 60, z: -45, r: 16, count: 6 },
    { x: -10, z: 45, r: 14, count: 5 },
  ];
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
