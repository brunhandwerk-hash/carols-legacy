import * as THREE from 'three';
import { MAP, PALETTE } from './config';

// ---- the Prahova river course (north -> south along +z, east side of the valley) ----
export function riverX(z: number): number {
  return 195 + Math.sin(z * 0.006) * 28 + Math.sin(z * 0.0021 + 1.7) * 16;
}

// Plots are flattened circles where buildings stand. Registered before mesh build.
export interface FlatSpot { x: number; z: number; r: number }
const flatSpots: FlatSpot[] = [];
const flatHeights: number[] = [];

export function registerFlatSpot(x: number, z: number, r: number): void {
  flatSpots.push({ x, z, r });
  flatHeights.push(rawHeight(x, z));
}

function gauss(x: number, z: number, cx: number, cz: number, s: number): number {
  const dx = x - cx, dz = z - cz;
  return Math.exp(-(dx * dx + dz * dz) / (2 * s * s));
}

function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

// distance from (x,z) to segment a-b
function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = ((x - ax) * dx + (z - az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt((x - (ax + dx * t)) ** 2 + (z - (az + dz * t)) ** 2);
}

// ridged fractal-ish noise for crags (cheap, analytic)
function crags(x: number, z: number): number {
  let n = 0;
  n += 1 - Math.abs(Math.sin(x * 0.011 + z * 0.007));
  n += (1 - Math.abs(Math.sin(x * 0.027 - z * 0.019 + 2.3))) * 0.5;
  n += (1 - Math.abs(Math.sin(x * 0.061 + z * 0.043 + 0.8))) * 0.25;
  return n / 1.75; // 0..1
}

// Height before plot flattening. Modeled on the real Prahova valley at Sinaia:
// floor ~0m (rel.), town shoulder terrace +60..90m, Peles clearing +150m,
// Bucegi wall west rising to the map edge, grassy Baiu slope east.
function rawHeight(x: number, z: number): number {
  // valley floor: the Prahova flows southward, so north is higher
  let h = -z * 0.02;

  // --- western Bucegi wall ---
  // distance west of the foot line (the wall's base bows toward town near the centre)
  const footX = -260 + Math.sin(z * 0.004) * 40 + (z > 100 ? (z - 100) * 0.08 : 0);
  const w = Math.max(0, footX - x);
  // main rise: saturating climb to ~330m at the map edge
  const wallT = 1 - Math.exp(-((w / 220) ** 2));
  let wall = wallT * 330;
  // crags grow with altitude
  wall += crags(x, z) * wallT * 70;
  h += wall;

  // --- town shoulder terrace (monastery & royal domain sit on it) ---
  // a broad bench on the lower west slope, tilted gently uphill to the NW
  const benchD = segDist(x, z, -70, -60, -300, -330);
  const bench = Math.exp(-((benchD / 130) ** 2));
  h += bench * 55 - bench * Math.min(1, w / 150) * 30; // soften the wall under the bench

  // monastery knoll on the bench
  h += gauss(x, z, -90, -120, 60) * 12;
  // the Peles clearing: higher terrace at the ravine head
  h += gauss(x, z, -390, -440, 110) * 40;

  // --- Peles creek ravine: cuts from the clearing down past the monastery ---
  const ravD = segDist(x, z, -45, -70, -360, -400);
  if (ravD < 46) {
    const t = 1 - ravD / 46;
    h -= t * t * 16;
  }

  // --- eastern Baiu slope: smooth grassy rise across the river ---
  const e = Math.max(0, x - (riverX(z) + 70));
  const eastT = 1 - Math.exp(-((e / 260) ** 2));
  h += eastT * 170 + Math.sin(x * 0.008 + z * 0.006) * eastT * 12;

  // gentle broad undulation everywhere
  h += Math.sin(x * 0.021) * Math.cos(z * 0.023) * 2.4;
  h += Math.sin(x * 0.006 + z * 0.009) * 4.5;
  h += Math.sin(x * 0.05 + 3) * Math.sin(z * 0.041) * 1.0;

  // --- river channel ---
  const d = Math.abs(x - riverX(z));
  if (d < 30) {
    const t = 1 - d / 30;
    h -= t * t * 7;
  }
  return h;
}

export function terrainHeight(x: number, z: number): number {
  let h = rawHeight(x, z);
  for (let i = 0; i < flatSpots.length; i++) {
    const s = flatSpots[i];
    const dx = x - s.x, dz = z - s.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const blend = 1 - smoothstep(s.r, s.r * 1.9, dist);
    if (blend > 0) h = h * (1 - blend) + flatHeights[i] * blend;
  }
  return h;
}

export function terrainSlope(x: number, z: number): number {
  const e = 1.5;
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return Math.sqrt(hx * hx + hz * hz) / (2 * e);
}

export function inRiver(x: number, z: number): boolean {
  return Math.abs(x - riverX(z)) < 14;
}

export function inMap(x: number, z: number): boolean {
  return x > MAP.minX + 6 && x < MAP.maxX - 6 && z > MAP.minZ + 6 && z < MAP.maxZ - 6;
}

export function walkable(x: number, z: number): boolean {
  return inMap(x, z) && terrainSlope(x, z) < 0.95;
}

// ---- historical roads, painted into the terrain colors ----
// hamlet -> monastery; monastery -> up the Peles creek; monastery -> park & station
const ROADS: [number, number][][] = [
  [[70, 230], [40, 130], [10, 70], [-40, -20], [-80, -90]],                  // hamlet up to the monastery gate
  [[-80, -100], [-140, -180], [-200, -260], [-240, -300], [-275, -340], [-340, -395], [-400, -430]], // Peles creek road
  [[-340, -395], [-350, -470], [-290, -545]],                                 // fork up to Pelisor and Foisor
  [[-40, -20], [40, 40], [75, 95], [130, 95], [170, 90]],                     // down past the park & casino to the station
  [[10, 70], [-10, 170], [0, 290], [40, 420]],                                // south along the future boulevard
  [[170, 90], [235, 20], [290, -100]],                                        // bridge over the Prahova to Cumpatu
];

export function roadDistance(x: number, z: number): number {
  let best = Infinity;
  for (const road of ROADS) {
    for (let i = 0; i < road.length - 1; i++) {
      const [ax, az] = road[i], [bx, bz] = road[i + 1];
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz;
      let t = ((x - ax) * dx + (z - az) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, pz = az + dz * t;
      const d = Math.sqrt((x - px) ** 2 + (z - pz) ** 2);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---- mesh ----
export function buildTerrainMesh(): THREE.Mesh {
  const segX = 300, segZ = 390;
  const geo = new THREE.PlaneGeometry(MAP.width, MAP.depth, segX, segZ);
  geo.rotateX(-Math.PI / 2); // plane xz, +z south
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const grassLow = new THREE.Color(PALETTE.grassLow);
  const grassHigh = new THREE.Color(PALETTE.grassHigh);
  const meadow = new THREE.Color(PALETTE.meadow);
  const rockC = new THREE.Color(PALETTE.rock);
  const rockHigh = new THREE.Color(PALETTE.rockHigh);
  const dirt = new THREE.Color(PALETTE.dirt);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);
    const slope = terrainSlope(x, z);
    // base grass varies with a soft pattern
    const v = 0.5 + 0.5 * Math.sin(x * 0.03 + 2) * Math.sin(z * 0.027);
    c.copy(grassLow).lerp(grassHigh, v).lerp(meadow, 0.35 * Math.max(0, Math.sin(x * 0.015 - z * 0.012)));
    // rocky on steep ground
    if (slope > 0.55) c.lerp(slope > 1.1 ? rockHigh : rockC, Math.min(1, (slope - 0.55) / 0.5));
    // snow above the treeline on the high west wall
    const snowAmt = Math.max(0, (h - 230) / 80);
    if (snowAmt > 0) c.lerp(new THREE.Color(PALETTE.snow), Math.min(1, snowAmt));
    // river banks: gravel
    const rd = Math.abs(x - riverX(z));
    if (rd < 22) c.lerp(dirt, (1 - rd / 22) * 0.7);
    // dirt roads
    const road = roadDistance(x, z);
    if (road < 4.5) c.lerp(dirt, (1 - road / 4.5) * 0.85);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

export function buildRiverMesh(): THREE.Mesh {
  const steps = 220;
  const halfW = 13;
  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const z = MAP.minZ + (i / steps) * MAP.depth;
    const x = riverX(z);
    const y = rawHeight(x, z) + 2.2;
    verts.push(x - halfW, y, z, x + halfW, y, z);
    if (i < steps) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({
    color: PALETTE.water, transparent: true, opacity: 0.85,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'river';
  return mesh;
}
