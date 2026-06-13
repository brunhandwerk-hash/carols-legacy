import * as THREE from 'three';
import { MAP, PALETTE } from './config';
import { cobbleMaterial, waterMaterial } from './materials';

// ---- real-world digital elevation model (public/dem.bin, see scripts/fetch-dem.mjs) ----
// World coords: x east (m), z south (m), origin at the bbox centre. Heights in
// metres above the valley base (lowest point of the bbox, ~745 m a.s.l.).

interface DemMeta {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
  w: number; h: number; widthM: number; depthM: number;
  minElev: number; maxElev: number;
}

let dem: Int16Array;
let meta: DemMeta;
let baseElev = 0;

export const TREELINE = 1005;  // ~1750m a.s.l. relative to base
export const SNOWLINE = 1115;  // ~1860m a.s.l.

export async function loadDem(): Promise<void> {
  const [metaRes, binRes] = await Promise.all([fetch('/dem.json'), fetch('/dem.bin')]);
  meta = await metaRes.json();
  dem = new Int16Array(await binRes.arrayBuffer());
  baseElev = meta.minElev;
  MAP.width = meta.widthM;
  MAP.depth = meta.depthM;
  MAP.minX = -meta.widthM / 2; MAP.maxX = meta.widthM / 2;
  MAP.minZ = -meta.depthM / 2; MAP.maxZ = meta.depthM / 2;
  traceRiver();
}

export function lonLatToWorld(lon: number, lat: number): { x: number; z: number } {
  const fx = (lon - meta.minLon) / (meta.maxLon - meta.minLon);
  const fz = (meta.maxLat - lat) / (meta.maxLat - meta.minLat); // north at minZ
  return { x: MAP.minX + fx * MAP.width, z: MAP.minZ + fz * MAP.depth };
}

// bilinear sample of the DEM, in metres above valley base
function rawHeight(x: number, z: number): number {
  const fx = ((x - MAP.minX) / MAP.width) * (meta.w - 1);
  const fz = ((z - MAP.minZ) / MAP.depth) * (meta.h - 1);
  const x0 = Math.max(0, Math.min(meta.w - 2, Math.floor(fx)));
  const z0 = Math.max(0, Math.min(meta.h - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const tz = Math.max(0, Math.min(1, fz - z0));
  const i = z0 * meta.w + x0;
  const h00 = dem[i], h10 = dem[i + 1], h01 = dem[i + meta.w], h11 = dem[i + meta.w + 1];
  const top = h00 + (h10 - h00) * tx;
  const bot = h01 + (h11 - h01) * tx;
  return top + (bot - top) * tz - baseElev;
}

// ---- the Prahova: traced along the valley floor of the real DEM ----
const riverPts: number[] = []; // x per row
let riverStep = 20;

function traceRiver(): void {
  riverStep = 20;
  const rows = Math.floor(MAP.depth / riverStep);
  // start at the north edge: lowest point in the central band
  let prevX = 0;
  let best = Infinity;
  for (let x = -1200; x <= 2400; x += 10) {
    const h = rawHeight(x, MAP.minZ + 30);
    if (h < best) { best = h; prevX = x; }
  }
  for (let r = 0; r <= rows; r++) {
    const z = MAP.minZ + r * riverStep;
    let bx = prevX, bh = Infinity;
    for (let x = prevX - 220; x <= prevX + 220; x += 8) {
      const h = rawHeight(x, z);
      if (h < bh) { bh = h; bx = x; }
    }
    riverPts.push(bx);
    prevX = bx;
  }
}

export function riverX(z: number): number {
  const f = (z - MAP.minZ) / riverStep;
  const i = Math.max(0, Math.min(riverPts.length - 2, Math.floor(f)));
  const t = Math.max(0, Math.min(1, f - i));
  return riverPts[i] + (riverPts[i + 1] - riverPts[i]) * t;
}

export function inRiver(x: number, z: number): boolean {
  return Math.abs(x - riverX(z)) < 16;
}

// ---- plot flattening (building sites stamped level into the real terrain) ----
export interface FlatSpot { x: number; z: number; r: number }
const flatSpots: FlatSpot[] = [];
const flatHeights: number[] = [];

export function registerFlatSpot(x: number, z: number, r: number): void {
  flatSpots.push({ x, z, r });
  flatHeights.push(rawHeight(x, z));
}

function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
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

// The rendered terrain mesh (buildTerrainMesh) is a coarse grid: its surface
// linearly interpolates terrainHeight between vertices spaced TERR_SEG apart,
// so it does NOT match the full-res terrainHeight between those vertices. Things
// that must sit *on the visible ground* (villagers) use this, which reproduces
// the mesh's own interpolation — otherwise they sink into concave ground.
export const TERR_SEG_X = 380;
export const TERR_SEG_Z = 440;

export function surfaceHeight(x: number, z: number): number {
  const gx = MAP.width / TERR_SEG_X, gz = MAP.depth / TERR_SEG_Z;
  const cx = Math.min(MAP.maxX, Math.max(MAP.minX, x));
  const cz = Math.min(MAP.maxZ, Math.max(MAP.minZ, z));
  const ix = Math.min(TERR_SEG_X - 1, Math.floor((cx - MAP.minX) / gx));
  const iz = Math.min(TERR_SEG_Z - 1, Math.floor((cz - MAP.minZ) / gz));
  const x0 = MAP.minX + ix * gx, z0 = MAP.minZ + iz * gz;
  const tx = (cx - x0) / gx, tz = (cz - z0) / gz;
  // PlaneGeometry splits each quad into two triangles along the b–d diagonal:
  // a=(0,0) b=(0,1) c=(1,1) d=(1,0). Pick the triangle this point lands in and
  // interpolate its plane exactly, so a unit stands flush on the rendered face.
  const ha = terrainHeight(x0, z0);          // (0,0)
  const hb = terrainHeight(x0, z0 + gz);      // (0,1)
  const hc = terrainHeight(x0 + gx, z0 + gz); // (1,1)
  const hd = terrainHeight(x0 + gx, z0);      // (1,0)
  if (tx + tz <= 1) {
    return ha + (hd - ha) * tx + (hb - ha) * tz;
  }
  return (hb - hc + hd) + (hc - hb) * tx + (hc - hd) * tz;
}

export function terrainSlope(x: number, z: number): number {
  const e = 6;
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return Math.sqrt(hx * hx + hz * hz) / (2 * e);
}

export function inMap(x: number, z: number): boolean {
  return x > MAP.minX + 12 && x < MAP.maxX - 12 && z > MAP.minZ + 12 && z < MAP.maxZ - 12;
}

export function walkable(x: number, z: number): boolean {
  return inMap(x, z) && terrainSlope(x, z) < 0.85;
}

// ---- historical roads, painted into the terrain colors ----
let ROADS: [number, number][][] = [];
export function setRoads(roads: [number, number][][]): void {
  ROADS = roads;
}

export function roadDistance(x: number, z: number): number {
  let best = Infinity;
  for (const road of ROADS) {
    for (let i = 0; i < road.length - 1; i++) {
      const [ax, az] = road[i], [bx, bz] = road[i + 1];
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((x - ax) * dx + (z - az) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + dx * t, pz = az + dz * t;
      const d = Math.sqrt((x - px) ** 2 + (z - pz) ** 2);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---- meshes ----
export function buildTerrainMesh(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(MAP.width, MAP.depth, TERR_SEG_X, TERR_SEG_Z);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const grassLow = new THREE.Color(PALETTE.grassLow);
  const grassHigh = new THREE.Color(PALETTE.grassHigh);
  const meadow = new THREE.Color(PALETTE.meadow);
  const alpine = new THREE.Color(0xa8b07e); // high pasture
  const rockC = new THREE.Color(PALETTE.rock);
  const rockHigh = new THREE.Color(PALETTE.rockHigh);
  const snowC = new THREE.Color(PALETTE.snow);
  const dirt = new THREE.Color(PALETTE.dirt);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);
    const slope = terrainSlope(x, z);
    const v = 0.5 + 0.5 * Math.sin(x * 0.013 + 2) * Math.sin(z * 0.011);
    c.copy(grassLow).lerp(grassHigh, v).lerp(meadow, 0.35 * Math.max(0, Math.sin(x * 0.006 - z * 0.005)));
    // alpine pasture fading in above the forests
    if (h > TREELINE - 120) c.lerp(alpine, Math.min(1, (h - (TREELINE - 120)) / 160));
    // rock on steep ground, more above the treeline
    if (slope > 0.55) c.lerp(slope > 1.0 ? rockHigh : rockC, Math.min(1, (slope - 0.55) / 0.45));
    if (h > SNOWLINE) c.lerp(snowC, Math.min(1, (h - SNOWLINE) / 90));
    const rd = Math.abs(x - riverX(z));
    if (rd < 26) c.lerp(dirt, (1 - rd / 26) * 0.6);
    const road = roadDistance(x, z);
    if (road < 5) c.lerp(dirt, (1 - road / 5) * 0.85);
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

// resample a polyline into ~`step`-metre points (keeps the path smooth when draped)
function resamplePath(path: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1], [bx, bz] = path[i];
    const segLen = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(segLen / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([ax + (bx - ax) * t, az + (bz - az) * t]);
    }
  }
  return out;
}

// a cobbled road ribbon draped over the terrain along the historical road network
let roadMat: THREE.MeshStandardMaterial | null = null;
export function buildRoadMesh(): THREE.Mesh {
  const half = 2.6;   // road half-width (m)
  const lift = 0.14;  // sit just above the ground to avoid z-fighting
  const verts: number[] = [], uvs: number[] = [], idx: number[] = [];
  let vbase = 0;
  for (const road of ROADS) {
    const pts = resamplePath(road, 3);
    if (pts.length < 2) continue;
    let cum = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
      const px = -dz, pz = dx; // left-perpendicular
      const lx = x + px * half, lz = z + pz * half;
      const rx = x - px * half, rz = z - pz * half;
      if (i > 0) cum += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      verts.push(lx, surfaceHeight(lx, lz) + lift, lz, rx, surfaceHeight(rx, rz) + lift, rz);
      const v = cum / 3.2;
      uvs.push(0, v, 1.7, v);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = vbase + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    vbase += pts.length * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  if (!roadMat) roadMat = cobbleMaterial();
  const mesh = new THREE.Mesh(geo, roadMat);
  mesh.receiveShadow = true;
  mesh.name = 'road';
  return mesh;
}

let waterMat: THREE.MeshStandardMaterial | null = null;

// scroll the ripple normal map downstream so the water reads as flowing
export function updateWater(dt: number): void {
  if (!waterMat || !waterMat.normalMap) return;
  waterMat.normalMap.offset.y = (waterMat.normalMap.offset.y + dt * 0.06) % 1;
  waterMat.map!.offset.y = (waterMat.map!.offset.y + dt * 0.03) % 1;
}

export function buildRiverMesh(): THREE.Mesh {
  const steps = 320;
  const halfW = 17;
  const verts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  let cum = 0;
  let px = 0, pz = 0;
  for (let i = 0; i <= steps; i++) {
    const z = MAP.minZ + (i / steps) * MAP.depth;
    const x = riverX(z);
    // sit just above the carved valley floor; the reflective PBR water catches
    // the sky so the channel reads clearly even where the banks are shallow
    const y = rawHeight(x, z) + 1.2;
    if (i > 0) cum += Math.hypot(x - px, z - pz);
    px = x; pz = z;
    verts.push(x - halfW, y, z, x + halfW, y, z);
    const v = cum / 26;
    uvs.push(0, v, 1, v);
    if (i < steps) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  if (!waterMat) waterMat = waterMaterial();
  const mesh = new THREE.Mesh(geo, waterMat);
  mesh.renderOrder = 1; // draw the translucent water after the terrain
  mesh.name = 'river';
  return mesh;
}
