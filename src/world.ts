import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAP, PALETTE, START } from './config';
import { terrainHeight, surfaceHeight, terrainSlope, riverX, inMap, buildTerrainMesh, buildRoadMesh, buildBackdropMesh, registerFlatSpot, roadDistance, lonLatToWorld, TREELINE } from './terrain';
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

  // scene.background is owned by main.ts (the sky HDRI dome, with a colour
  // fallback set before boot) — don't overwrite it here.
  // atmospheric perspective: clear in the playable foreground, washing the far
  // massifs (~17 km out) toward the sky-horizon colour so they read as hazy
  // painted peaks instead of a hard-edged contour model
  scene.fog = new THREE.Fog(PALETTE.fog, 3000, 24000);

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
  // the river is painted into the terrain mesh itself (aRiver attribute → blue in the
  // ground shader), so no separate water plane is added — it can't bury or z-fight.
  scene.add(buildRoadMesh());

  const gatherables = scatterNature(scene);
  paintForestFloor(terrain); // dark-green the forest footprint (clearings now known)

  return { scene, terrain, sun, gatherables };
}

// Bake a dark forest-floor green into the terrain vertex colours wherever the
// forest grows. Distant chunks render no tree geometry (see updateForestReveal), so
// this tint is what makes the far valley still read as deep forest instead of
// bright meadow — at a fraction of the draw cost.
function paintForestFloor(terrain: THREE.Mesh): void {
  const geo = terrain.geometry as THREE.BufferGeometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  const splat = geo.attributes.aSplat as THREE.BufferAttribute | undefined;
  const dark = new THREE.Color(0x4a6238);
  const dark2 = new THREE.Color(0x5a7344);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    if (!forestedAt(x, z)) continue;
    if (roadDistance(x, z) < 6) continue; // keep the cobbled roads readable
    const v = 0.5 + 0.5 * Math.sin(x * 0.021 + 1.3) * Math.sin(z * 0.018);
    c.copy(dark).lerp(dark2, v);
    // keep a hint of the underlying terrain variation under the forest tint
    col.setXYZ(i,
      col.getX(i) * 0.16 + c.r * 0.84,
      col.getY(i) * 0.16 + c.g * 0.84,
      col.getZ(i) * 0.16 + c.b * 0.84);
    // route the ground splat to the forest-floor texture here (keep any rock)
    if (splat) {
      const wRock = splat.getW(i);
      splat.setXYZW(i, (1 - wRock) * 0.12, (1 - wRock) * 0.88, 0, wRock);
    }
  }
  col.needsUpdate = true;
  if (splat) splat.needsUpdate = true;
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

// The forest is one card-tree InstancedMesh per ~512 m chunk (frustum-culled as a
// unit). A chunk renders only within a generous radius of the camera's look-at
// point or settlement activity; beyond that the baked dark forest-floor tint
// (paintForestFloor) carries the look cheaply, so the wilderness costs nothing.
interface ForestChunk { cx: number; cz: number; mesh: THREE.InstancedMesh }
const forestChunks: ForestChunk[] = [];
const SHOW_ACT = 600; // show chunks within this of settlement activity

export function updateForestReveal(camX = Infinity, camZ = Infinity, camDist = 600): void {
  const showCam = Math.min(3200, camDist * 1.5 + 800); // ring scales with zoom; tint carries beyond
  const camR2 = showCam * showCam, actR2 = SHOW_ACT * SHOW_ACT;
  for (const c of forestChunks) {
    let show = (c.cx - camX) ** 2 + (c.cz - camZ) ** 2 < camR2;
    if (!show) show = roadDistance(c.cx, c.cz) < SHOW_ACT;
    if (!show) {
      for (const b of G.buildings) {
        if ((b.x - c.cx) ** 2 + (b.z - c.cz) ** 2 < actR2) { show = true; break; }
      }
    }
    if (!show) {
      for (const v of G.villagers) {
        if ((v.x - c.cx) ** 2 + (v.z - c.cz) ** 2 < actR2) { show = true; break; }
      }
    }
    if (c.mesh.visible !== show) c.mesh.visible = show;
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

// A "card tree": two intersecting vertical quads textured with one stylized pine.
// Reads as a 3D tree from the RTS camera at ~8 tris. Origin at the trunk base. The
// artwork sits centred in the texture with wide transparent margins, so the card
// is slimmed to the pine's true aspect and its UVs cropped to the pine's bounding
// box (measured off the SVG viewBox 680×540: x 228..452, y 62 apex .. 518 base).
function buildCardTreeGeometry(): THREE.BufferGeometry {
  const w = 6.5, h = 13;
  const p1 = new THREE.PlaneGeometry(w, h); p1.translate(0, h / 2, 0);
  const p2 = new THREE.PlaneGeometry(w, h); p2.translate(0, h / 2, 0); p2.rotateY(Math.PI / 2);
  const g = mergeGeometries([p1, p2]);
  p1.dispose(); p2.dispose();
  const u0 = 228 / 680, u1 = 452 / 680;          // tree spans x 228..452
  const v0 = 1 - 518 / 540, v1 = 1 - 62 / 540;   // trunk base..apex (texture flipY)
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  uv.needsUpdate = true;
  return g;
}

// Card-tree material: the stylized pine PNG, alpha-tested (opaque pass, no sorting,
// works with GTAO). The texture is sRGB so the GPU decodes it to linear on sample.
// Lit by the HDRI env + sun, with a touch of self-illumination so the trees lift
// out of shadow and sit with the brightly-lit buildings/ground.
let cardTreeMat: THREE.MeshStandardMaterial | null = null;
function cardTreeMaterial(): THREE.MeshStandardMaterial {
  if (cardTreeMat) return cardTreeMat;
  const tex = new THREE.TextureLoader().load('/textures/foliage/stylized_pine_tree_transparent.png');
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  cardTreeMat = new THREE.MeshStandardMaterial({
    map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, metalness: 0,
    emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.12,
  });
  return cardTreeMat;
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

// Low-frequency clump field used to VARY forest density (denser/sparser patches),
// so the wood reads naturally instead of as a uniform carpet — without leaving
// large bare areas (only the explicit clearings are true meadows).
function forestClump(x: number, z: number): number {
  return 0.5 + 0.32 * Math.sin(x * 0.0023 + 1.7) * Math.cos(z * 0.0019 - 0.5)
       + 0.24 * Math.sin((x + z) * 0.0015 + 3.1) * Math.sin((x - z) * 0.0017);
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

  // --- the forest: clustered card-trees. Instead of a uniform 9 m carpet, a
  // low-frequency clump field carves the wood into thickets with open meadows
  // between (natural, less "raster"). One InstancedMesh of card-trees per ~512 m
  // chunk so the GPU frustum-culls whole chunks; each instance picks one of the
  // 7 conifer photos. Trees below HARVEST_MAX_H are harvestable wood nodes. ---
  const cardGeo = buildCardTreeGeometry();
  const cardMat = cardTreeMaterial();
  const HARVEST_MAX_H = 420;
  const SPACING = 14;   // base canopy spacing (density then varies by clump)
  const CHUNK = 512;
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
          const jx = (crng() - 0.5) * SPACING * 0.95;
          const jz = (crng() - 0.5) * SPACING * 0.95;
          const x = gx + jx, z = gz + jz;
          if (!inMap(x, z)) continue;
          // density VARIES with the clump field but never drops to bare — the
          // valley stays densely wooded (matching the forested backdrop); only the
          // explicit clearings/river/pasture (via forestedAt below) are true meadows
          const nearCamp = (x - START.camp.x) ** 2 + (z - START.camp.z) ** 2 < 520 * 520;
          if (!nearCamp) {
            const density = Math.max(0.45, Math.min(1, 0.7 + 1.0 * (forestClump(x, z) - 0.5)));
            if (crng() > density) continue;
          }
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
      // all chunks share the one card geometry (every tree is the same pine now)
      const mesh = new THREE.InstancedMesh(cardGeo, cardMat, spots.length);
      mesh.castShadow = false; // cards don't self-shadow well; keep the budget
      mesh.raycast = () => {};
      mesh.visible = false; // updateForestReveal shows it within the camera ring
      spots.forEach((s, i) => {
        // plant on the *rendered* surface (like buildings/villagers) so trees
        // don't sink into or float above the coarse mesh between DEM samples
        dummy.position.set(s.x, surfaceHeight(s.x, s.z), s.z);
        dummy.scale.setScalar(0.8 + crng() * 0.85);
        dummy.rotation.set(0, crng() * Math.PI * 2, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        if (s.h < HARVEST_MAX_H) {
          G.nodes.push({ kind: 'wood', x: s.x, z: s.z, amount: 120, alive: true, mesh: [mesh], index: i });
        }
      });
      mesh.computeBoundingSphere(); // spread instances → cull on the real footprint
      scene.add(mesh);
      forestChunks.push({ cx: x0 + CHUNK / 2, cz: z0 + CHUNK / 2, mesh });
      totalTrees += spots.length;
    }
  }
  console.log(`forest: ${totalTrees} card-trees, ${G.nodes.length} harvestable, ${forestChunks.length} chunks`);

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
  // a guaranteed stone outcrop right beside the start camp, offset toward the
  // camp's own bank (away from the river) so it's always reachable without a
  // bridge — the lat/lon outcrops above are too far for the early game.
  const campSide = Math.sign(START.camp.x - riverX(START.camp.z)) || 1;
  const nearCamp = { x: START.camp.x + campSide * 50, z: START.camp.z - 22, r: 26, count: 24 };
  for (let i = 0; i < nearCamp.count; i++) {
    const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * nearCamp.r;
    const x = nearCamp.x + Math.cos(a) * d, z = nearCamp.z + Math.sin(a) * d;
    if (!inMap(x, z) || !clearOf(x, z, 2)) continue;
    if (terrainSlope(x, z) > 1.45) continue;
    rockSpots.push({ x, z });
  }
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockSpots.length);
  rocks.castShadow = true;
  rockSpots.forEach((s, i) => {
    dummy.position.set(s.x, surfaceHeight(s.x, s.z) + 0.6, s.z);
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
    dummy.position.set(s.x, surfaceHeight(s.x, s.z) + 0.7, s.z);
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

// vertical offset baked into each kind's instance matrix at scatter time, so a
// re-seated node keeps sitting the same way it was first planted
const NODE_Y_OFFSET: Record<ResourceNode['kind'], number> = { wood: 0, stone: 0.6, food: 0.7 };

// After the terrain is reshaped under a building (flattenUnder), trees/rocks/
// berries near the footprint keep the height baked in at scatter time and would
// hang in the air or sink. Re-seat every node within reach onto the new surface,
// preserving its baked scale/rotation (only the Y translation changes).
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
export function reseatNodesNear(x: number, z: number, r: number): void {
  const r2 = r * r;
  const touched = new Set<THREE.InstancedMesh>();
  for (const n of G.nodes) {
    if (!n.alive) continue;
    const dx = n.x - x, dz = n.z - z;
    if (dx * dx + dz * dz > r2) continue;
    const y = surfaceHeight(n.x, n.z) + NODE_Y_OFFSET[n.kind];
    for (const m of n.mesh) {
      m.getMatrixAt(n.index, _m);
      _m.decompose(_p, _q, _s);
      _p.y = y;
      _m.compose(_p, _q, _s);
      m.setMatrixAt(n.index, _m);
      touched.add(m);
    }
  }
  for (const m of touched) m.instanceMatrix.needsUpdate = true;
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
