import * as THREE from 'three';
import { MAP, PALETTE } from './config';

// ---- the Prahova river course (north -> south along +z, east side of the valley) ----
export function riverX(z: number): number {
  return 95 + Math.sin(z * 0.012) * 14 + Math.sin(z * 0.004 + 1.7) * 8;
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

// Height before plot flattening.
function rawHeight(x: number, z: number): number {
  // valley floor tilts: the Prahova flows southward, so north is higher
  let h = -z * 0.035;
  // western wall — Furnica / Bucegi side, where Peles will stand
  const w = Math.max(0, -(x + 55));
  h += Math.pow(w / 26, 1.85) * 6.2;
  // eastern slope — the Baiu ridge, gentler
  const e = Math.max(0, x - 150);
  h += Math.pow(e / 30, 1.8) * 5;
  // the monastery knoll above the town
  h += gauss(x, z, -45, -35, 42) * 8;
  // a terrace shoulder where the Peles clearing sits
  h += gauss(x, z, -185, -215, 60) * 5;
  // gentle broad undulation
  h += Math.sin(x * 0.045) * Math.cos(z * 0.05) * 1.1;
  h += Math.sin(x * 0.013 + z * 0.021) * 2.1;
  h += Math.sin(x * 0.11 + 3) * Math.sin(z * 0.09) * 0.45;
  // river channel
  const d = Math.abs(x - riverX(z));
  if (d < 15) {
    const t = 1 - d / 15;
    h -= t * t * 4.2;
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
  return Math.abs(x - riverX(z)) < 7;
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
  [[30, 105], [10, 60], [-12, 8], [-38, -18]],                              // hamlet to monastery gate
  [[-45, -28], [-70, -70], [-95, -120], [-113, -142], [-128, -160], [-160, -195], [-198, -228]], // Peles creek road
  [[-160, -195], [-172, -205]],                                              // fork to Pelisor
  [[-38, -18], [8, 14], [32, 28], [60, 34], [78, 38]],                       // down to the park and station
  [[10, 60], [-4, 78], [10, 130], [30, 175]],                                // south along the future boulevard
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
  const segX = 200, segZ = 260;
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
    // river banks: gravel
    const rd = Math.abs(x - riverX(z));
    if (rd < 10) c.lerp(dirt, (1 - rd / 10) * 0.7);
    // dirt roads
    const road = roadDistance(x, z);
    if (road < 3.6) c.lerp(dirt, (1 - road / 3.6) * 0.85);
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
  const steps = 120;
  const halfW = 6.5;
  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const z = MAP.minZ + (i / steps) * MAP.depth;
    const x = riverX(z);
    const y = rawHeight(x, z) + 1.1;
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
