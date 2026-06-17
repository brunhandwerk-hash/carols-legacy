import * as THREE from 'three';
import { MAP, PALETTE } from './config';
import { cobbleMaterial, waterMaterial, terrainGroundMaterial } from './materials';
import { G } from './state';

// ---- real-world digital elevation model (public/dem.bin, see scripts/fetch-dem.mjs) ----
// World coords: x east (m), z south (m), origin at the bbox centre. Heights in
// metres above the valley base (lowest point of the bbox, ~745 m a.s.l.).

interface DemMeta {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
  w: number; h: number; widthM: number; depthM: number;
  minElev: number; maxElev: number;
}

let dem: Float32Array;
let demRaw: Int16Array | null = null; // unsmoothed source samples, kept for the DEM-points debug view
let meta: DemMeta;
let baseElev = 0;

export const TREELINE = 1005;  // ~1750m a.s.l. relative to base
export const SNOWLINE = 1115;  // ~1860m a.s.l.

// Separable binomial blur ([1,4,6,4,1]/16) with clamped edges, run `passes` times
// (each pass ≈1 px sigma; N passes ≈ √N px) — dissolves the DEM's integer-metre
// quantization staircase into smooth, continuous heights. The source's real detail
// lives at ~7 m (1 px) so a couple of passes clean the 1 m steps with little cost
// to genuine features.
function smoothDem(src: Int16Array, w: number, h: number, passes = 3): Float32Array {
  const k = [1, 4, 6, 4, 1], r = 2, inv = 1 / 16;
  let buf = Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -r; t <= r; t++) {
          let xx = x + t; xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
          s += buf[row + xx] * k[t + r];
        }
        tmp[row + x] = s * inv;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let t = -r; t <= r; t++) {
          let yy = y + t; yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
          s += tmp[yy * w + x] * k[t + r];
        }
        out[y * w + x] = s * inv;
      }
    }
    buf = out.slice();
  }
  return buf;
}

export async function loadDem(): Promise<void> {
  const [metaRes, binRes] = await Promise.all([fetch('/dem.json'), fetch('/dem.bin')]);
  meta = await metaRes.json();
  // The DEM is stored as integer metres, so ~18% of neighbouring samples are
  // identical — a 1 m quantization staircase that bicubic can't dissolve (the
  // control points sit on the steps) and that the shading badly amplifies, since
  // normals are the derivative of height. A light separable blur (≈1 px sigma)
  // dissolves the steps into continuous slopes while barely touching the real
  // ~7 m-resolution features. Done once at load.
  demRaw = new Int16Array(await binRes.arrayBuffer());
  dem = smoothDem(demRaw, meta.w, meta.h);
  baseElev = meta.minElev;
  MAP.width = meta.widthM;
  MAP.depth = meta.depthM;
  MAP.minX = -meta.widthM / 2; MAP.maxX = meta.widthM / 2;
  MAP.minZ = -meta.depthM / 2; MAP.maxZ = meta.depthM / 2;
  traceRiver();
}

// ---- wide-area backdrop DEM (the surrounding Bucegi / Baiului massifs) ----
interface BackMeta { minLat: number; maxLat: number; minLon: number; maxLon: number; w: number; h: number; minElev: number; maxElev: number }
let backDem: Int16Array | null = null;
let backMeta: BackMeta | null = null;

export async function loadBackdrop(): Promise<void> {
  try {
    const [metaRes, binRes] = await Promise.all([fetch('/backdrop.json'), fetch('/backdrop.bin')]);
    if (!metaRes.ok || !binRes.ok) return;
    backMeta = await metaRes.json();
    backDem = new Int16Array(await binRes.arrayBuffer());
  } catch {
    backDem = null; // backdrop is purely cosmetic — never block boot on it
  }
}

export function lonLatToWorld(lon: number, lat: number): { x: number; z: number } {
  const fx = (lon - meta.minLon) / (meta.maxLon - meta.minLon);
  const fz = (meta.maxLat - lat) / (meta.maxLat - meta.minLat); // north at minZ
  return { x: MAP.minX + fx * MAP.width, z: MAP.minZ + fz * MAP.depth };
}

// inverse of lonLatToWorld — map world metres back to geographic coords, so tools
// can report where on the real Sinaia map a point sits.
export function worldToLonLat(x: number, z: number): { lon: number; lat: number } {
  const fx = (x - MAP.minX) / MAP.width;
  const fz = (z - MAP.minZ) / MAP.depth;
  return {
    lon: meta.minLon + fx * (meta.maxLon - meta.minLon),
    lat: meta.maxLat - fz * (meta.maxLat - meta.minLat),
  };
}

// clamped DEM lookup at integer grid indices
function demAt(ix: number, iz: number): number {
  ix = ix < 0 ? 0 : ix > meta.w - 1 ? meta.w - 1 : ix;
  iz = iz < 0 ? 0 : iz > meta.h - 1 ? meta.h - 1 : iz;
  return dem[iz * meta.w + ix];
}

// 1-D Catmull-Rom: smooth cubic through p1,p2 using neighbours p0,p3 (t in [0,1])
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

// Bicubic (Catmull-Rom) sample of the DEM, in metres above valley base. Bicubic is
// C1-continuous (no crease at every grid line, unlike bilinear) and it smooths the
// DEM's 1 m integer quantization into continuous slopes — so the rendered ground
// reads as natural hillsides instead of grid-aligned facets/terraces. Costs 16
// taps vs 4; fine for the one-time mesh build and the modest runtime sampling.
function rawHeight(x: number, z: number): number {
  const fx = ((x - MAP.minX) / MAP.width) * (meta.w - 1);
  const fz = ((z - MAP.minZ) / MAP.depth) * (meta.h - 1);
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const c0 = catmull(demAt(ix - 1, iz - 1), demAt(ix, iz - 1), demAt(ix + 1, iz - 1), demAt(ix + 2, iz - 1), tx);
  const c1 = catmull(demAt(ix - 1, iz),     demAt(ix, iz),     demAt(ix + 1, iz),     demAt(ix + 2, iz),     tx);
  const c2 = catmull(demAt(ix - 1, iz + 1), demAt(ix, iz + 1), demAt(ix + 1, iz + 1), demAt(ix + 2, iz + 1), tx);
  const c3 = catmull(demAt(ix - 1, iz + 2), demAt(ix, iz + 2), demAt(ix + 1, iz + 2), demAt(ix + 2, iz + 2), tx);
  return catmull(c0, c1, c2, c3, tz) - baseElev;
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

// ---- the river channel, carved into the terrain itself ----
// The Prahova used to be a flat blue ribbon laid *on* the ground at +0.4 m. The
// coarse rendered mesh (~16 m spacing) never dips for a 22 m river, so the banks
// sat 1–2 m *above* the water and occluded it from every angle — the river kept
// "disappearing". Instead we carve an actual trench into terrainHeight (the single
// source of truth): the mesh dips, the water fills the trench, and the banks frame
// it. The bed is flattened to a *level* cross-section (following the centreline
// downstream) out to RIVER_FLAT, then ramps back to undisturbed ground at RIVER_BANK.
// The rendered terrain mesh is coarse (~16 m vertex spacing), so the channel must be
// wide enough that several vertices always fall inside it — otherwise the mesh only
// dips where a vertex happens to land and the water gets buried in between. Flattening
// to a level bed (not just subtracting a constant depth) is essential: a constant
// subtraction preserves the cross-valley slope, so a steep bank still pokes above the
// water; a level bed guarantees the water plane clears the ground beneath it.
const RIVER_FLAT = 14;   // half-width of the flat channel bed (≥ mesh spacing)
const RIVER_BANK = 30;   // half-width where the bank ramps back to undisturbed ground
const RIVER_DEPTH = 3.0; // how far below the centreline ground the bed sits

// The flat bed level at a given downstream position. Cross-sectionally constant —
// that is what makes the bed level instead of a shifted-down hillside.
function riverBed(z: number): number {
  return rawHeight(riverX(z), z) - RIVER_DEPTH;
}

// True perpendicular distance from (x,z) to the river centreline polyline. Using
// |x − riverX(z)| (horizontal offset at fixed z) under-measures the distance where
// the river bends, so the outer bank gets under-carved and the water buries there.
function riverDist(x: number, z: number): number {
  if (riverPts.length === 0) return Infinity;
  const f = (z - MAP.minZ) / riverStep;
  const c = Math.round(f);
  let best = Infinity;
  for (let r = Math.max(0, c - 3); r < Math.min(riverPts.length - 1, c + 3); r++) {
    const z0 = MAP.minZ + r * riverStep, z1 = z0 + riverStep;
    const x0 = riverPts[r], x1 = riverPts[r + 1];
    const dx = x1 - x0, dz = z1 - z0;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz)));
    const d = Math.hypot(x - (x0 + t * dx), z - (z0 + t * dz));
    if (d < best) best = d;
  }
  return best;
}

// Blend weight (0..1) of the level bed at this point: 1 across the flat bed,
// ramping to 0 at the bank rim.
function riverBlend(x: number, z: number): number {
  if (riverPts.length === 0) return 0; // river not traced yet
  const d = riverDist(x, z);
  if (d >= RIVER_BANK) return 0;
  if (d <= RIVER_FLAT) return 1;
  return 1 - smoothstep(RIVER_FLAT, RIVER_BANK, d);
}

// ---- plot flattening (building sites stamped level into the real terrain) ----
// r = full-flat plateau radius (blends out smoothly to 1.9·r). terrace = a runtime
// building shelf (mergeable with neighbours); false = a fixed landmark plot.
export interface FlatSpot { x: number; z: number; r: number; terrace: boolean }
const flatSpots: FlatSpot[] = [];
const flatHeights: number[] = [];
let terrainMesh: THREE.Mesh | null = null; // set by buildTerrainMesh, deformed by flattenUnder

export function registerFlatSpot(x: number, z: number, r: number): void {
  flatSpots.push({ x, z, r, terrace: false });
  flatHeights.push(rawHeight(x, z));
}

// Level the *rendered* terrain under a building at runtime — instead of dropping a
// stone cylinder/terrace on top of it. Registers a flat spot (so terrainHeight /
// surfaceHeight stay the single source of truth) then re-seats every nearby mesh
// vertex to the new, flattened height with a smooth falloff into the slope.
export function flattenUnder(x: number, z: number, r: number): void {
  // Merge the whole CONNECTED cluster of building terraces this footprint joins
  // onto ONE shared level. Otherwise overlapping plots level to different ground
  // heights and their blends fight — leaving buildings sunk on the uphill side and
  // floating on the downhill side. The merge is transitive (A–B–C chains count),
  // so a building bridging two others pulls all three together; with one shared
  // level the overlapping (smooth, wide) blends all aim at the same height and
  // every footprint stays flat. Fixed landmark plots are never merged.
  const merged: number[] = [];
  const frontier: { x: number; z: number; r: number }[] = [{ x, z, r }];
  while (frontier.length) {
    const f = frontier.pop()!;
    for (let i = 0; i < flatSpots.length; i++) {
      const s = flatSpots[i];
      if (!s.terrace || merged.includes(i)) continue;
      if (Math.hypot(f.x - s.x, f.z - s.z) < f.r + s.r) { merged.push(i); frontier.push({ x: s.x, z: s.z, r: s.r }); }
    }
  }
  let hSum = rawHeight(x, z), wSum = 1;
  for (const i of merged) { hSum += flatHeights[i]; wSum += 1; }
  const shared = hSum / wSum;
  flatSpots.push({ x, z, r, terrace: true });
  flatHeights.push(shared);
  for (const i of merged) flatHeights[i] = shared; // pull the whole cluster to the shared level
  if (!terrainMesh) return;
  // re-deform the mesh over the new shelf AND every terrace whose level we moved
  const zones = [{ x, z, r }];
  for (const i of merged) { const s = flatSpots[i]; zones.push({ x: s.x, z: s.z, r: s.r }); }
  const geo = terrainMesh.geometry as THREE.BufferGeometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  // The PlaneGeometry vertex grid is regular, so we only touch the rows/cols
  // covering the edited zones instead of scanning all ~1M vertices each placement.
  const gx = MAP.width / TERR_SEG_X, gz = MAP.depth / TERR_SEG_Z;
  const nx = TERR_SEG_X + 1; // verts per row
  let minWX = Infinity, minWZ = Infinity, maxWX = -Infinity, maxWZ = -Infinity;
  for (const zn of zones) {
    const reach = zn.r * 1.9 + 1;
    if (zn.x - reach < minWX) minWX = zn.x - reach;
    if (zn.x + reach > maxWX) maxWX = zn.x + reach;
    if (zn.z - reach < minWZ) minWZ = zn.z - reach;
    if (zn.z + reach > maxWZ) maxWZ = zn.z + reach;
  }
  const ix0 = Math.max(0, Math.floor((minWX - MAP.minX) / gx));
  const ix1 = Math.min(TERR_SEG_X, Math.ceil((maxWX - MAP.minX) / gx));
  const iz0 = Math.max(0, Math.floor((minWZ - MAP.minZ) / gz));
  const iz1 = Math.min(TERR_SEG_Z, Math.ceil((maxWZ - MAP.minZ) / gz));
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const i = iz * nx + ix;
      const vx = pos.getX(i), vz = pos.getZ(i);
      for (const zn of zones) {
        const dx = vx - zn.x, dz = vz - zn.z, reach = zn.r * 1.9 + 1;
        if (dx * dx + dz * dz <= reach * reach) { pos.setY(i, terrainHeight(vx, vz)); break; }
      }
    }
  }
  pos.needsUpdate = true;
  recomputeNormalsRegion(geo, ix0, ix1, iz0, iz1);
  geo.computeBoundingSphere();
}

// Recompute vertex normals for just the edited window instead of the whole mesh
// (re-normalling ~1M verts on every building placement would hitch). Uses the same
// analytic height-gradient normals as buildTerrainMesh (triangulation-independent,
// so building terraces match the surrounding ground with no seam and no diagonal
// "corduroy"). Only the ring of vertices around the edited window can have changed.
function recomputeNormalsRegion(
  geo: THREE.BufferGeometry, ix0: number, ix1: number, iz0: number, iz1: number,
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const nx = TERR_SEG_X + 1;
  const gxS = MAP.width / TERR_SEG_X, gzS = MAP.depth / TERR_SEG_Z;
  const vx0 = Math.max(0, ix0 - 1), vx1 = Math.min(TERR_SEG_X, ix1 + 1);
  const vz0 = Math.max(0, iz0 - 1), vz1 = Math.min(TERR_SEG_Z, iz1 + 1);
  for (let iz = vz0; iz <= vz1; iz++)
    for (let ix = vx0; ix <= vx1; ix++) {
      const i = iz * nx + ix;
      const x = pos.getX(i), z = pos.getZ(i);
      const nxv = (terrainHeight(x - gxS, z) - terrainHeight(x + gxS, z)) / (2 * gxS);
      const nzv = (terrainHeight(x, z - gzS) - terrainHeight(x, z + gzS)) / (2 * gzS);
      const inv = 1 / Math.hypot(nxv, 1, nzv);
      nrm.setXYZ(i, nxv * inv, inv, nzv * inv);
    }
  nrm.needsUpdate = true;
}

function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

export function terrainHeight(x: number, z: number): number {
  let h = rawHeight(x, z);
  let flat = 0; // strongest flat-spot blend at this point
  for (let i = 0; i < flatSpots.length; i++) {
    const s = flatSpots[i];
    const dx = x - s.x, dz = z - s.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const blend = 1 - smoothstep(s.r, s.r * 1.9, dist);
    if (blend > 0) { h = h * (1 - blend) + flatHeights[i] * blend; if (blend > flat) flat = blend; }
  }
  // carve the river trench by flattening toward a level bed, but yield to any
  // building terrace stamped over this spot
  if (flat < 1) {
    const w = riverBlend(x, z) * (1 - flat);
    if (w > 0) h = h * (1 - w) + riverBed(z) * w;
  }
  return h;
}

// The rendered terrain mesh (buildTerrainMesh) is a coarse grid: its surface
// linearly interpolates terrainHeight between vertices spaced TERR_SEG apart,
// so it does NOT match the full-res terrainHeight between those vertices. Things
// that must sit *on the visible ground* (villagers) use this, which reproduces
// the mesh's own interpolation — otherwise they sink into concave ground.
// Rendered terrain grid. Things that must sit *on* the visible ground (trees,
// buildings, villagers) sample surfaceHeight() — which reconstructs THIS mesh's
// exact triangle — so they sit flush regardless of mesh density.
// Matched to the DEM's native sampling (~6.7 m): the DEM is 932×1078, and
// terrainHeight() just bilinearly interpolates those samples, so a finer mesh
// would add vertices with no extra relief. This is the detail ceiling. The mesh
// is static (built once at boot, never recomputed per frame), so the only cost of
// the higher vertex count is GPU memory + a slightly longer one-time boot paint;
// flattenUnder() edits just a local window so building placement stays cheap.
export const TERR_SEG_X = 626;  // ~10 m spacing (was 928 / ~6.7 m) — ~904k tris vs ~2M
export const TERR_SEG_Z = 722;

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

// A flattened building terrace (its level disc + the ramp that blends it back
// into the hillside) is deliberately traversable — it's the plot villagers must
// reach to build/work there. Carving a shelf into a slope, though, leaves a
// steep downhill rim whose slope exceeds the walkable limit, which would seal
// the building off and strand anyone heading to it. So count flat-spot ground
// as walkable regardless of that artificial rim slope.
function inFlatSpot(x: number, z: number): boolean {
  for (let i = 0; i < flatSpots.length; i++) {
    const s = flatSpots[i];
    const dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz < (s.r * 1.9) ** 2) return true;
  }
  return false;
}

// the river channel is impassable except over a bridge: a bridge (whether still
// a construction site or finished) opens a crossing corridor wide enough to span
// both banks, so builders can reach the in-river site and travellers can cross.
const BRIDGE_CROSS_R = 20; // ≥ river half-width (16) so the corridor reaches both banks
function nearBridgeCrossing(x: number, z: number): boolean {
  for (const b of G.buildings) {
    if (b.def.key !== 'bridge' && b.def.key !== 'bridge_stone') continue;
    if (b.phase === 'planned') continue;
    if ((b.x - x) ** 2 + (b.z - z) ** 2 < BRIDGE_CROSS_R ** 2) return true;
  }
  return false;
}

export function walkable(x: number, z: number): boolean {
  if (!inMap(x, z)) return false;
  if (inRiver(x, z) && !nearBridgeCrossing(x, z)) return false;
  return terrainSlope(x, z) < 0.85 || inFlatSpot(x, z);
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

// ---- debug views (dev menu) ----
// Raw DEM samples as a point cloud — the SOURCE data at its native grid, before
// any smoothing/bicubic interpolation. Lets you compare the source against the
// rendered mesh (e.g. the integer-metre quantization staircase shows here).
export function buildDemPointsMesh(): THREE.Points {
  const src = demRaw, w = meta.w, h = meta.h;
  const pos = new Float32Array(w * h * 3);
  let n = 0;
  for (let iz = 0; iz < h; iz++) for (let ix = 0; ix < w; ix++) {
    const x = MAP.minX + (ix / (w - 1)) * MAP.width;
    const z = MAP.minZ + (iz / (h - 1)) * MAP.depth;
    const y = (src ? src[iz * w + ix] : dem[iz * w + ix]) - baseElev;
    pos[n * 3] = x; pos[n * 3 + 1] = y + 0.3; pos[n * 3 + 2] = z; n++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffd27a, size: 1.4, sizeAttenuation: true, toneMapped: false });
  const pts = new THREE.Points(geo, mat);
  pts.name = 'demPoints';
  return pts;
}

// ---- meshes ----
export function buildTerrainMesh(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(MAP.width, MAP.depth, TERR_SEG_X, TERR_SEG_Z);
  geo.rotateX(-Math.PI / 2);
  // Re-triangulate with an ALTERNATING (herringbone) diagonal instead of
  // PlaneGeometry's uniform one. A single shared diagonal across every quad makes
  // the whole grid's facets line up, so at grazing angles the shading/AO traces a
  // regular diagonal "corduroy" across flat ground (visible even untextured, and
  // amplified by the texture). Flipping the diagonal on every other quad cancels
  // that bias — same vertices, same winding (verified), so normals/culling are
  // unaffected. This is the geometric root fix; the analytic normals only handled
  // the normal-averaging half.
  {
    const nx = TERR_SEG_X + 1;
    const idx = new Uint32Array(TERR_SEG_X * TERR_SEG_Z * 6);
    let t = 0;
    for (let iz = 0; iz < TERR_SEG_Z; iz++) {
      for (let ix = 0; ix < TERR_SEG_X; ix++) {
        const a = ix + nx * iz, b = ix + nx * (iz + 1), cc = (ix + 1) + nx * (iz + 1), d = (ix + 1) + nx * iz;
        if (((ix + iz) & 1) === 0) { // PlaneGeometry's default diagonal (b–d)
          idx[t] = a; idx[t + 1] = b; idx[t + 2] = d; idx[t + 3] = b; idx[t + 4] = cc; idx[t + 5] = d;
        } else {                     // flipped diagonal (a–c), same winding
          idx[t] = a; idx[t + 1] = b; idx[t + 2] = cc; idx[t + 3] = a; idx[t + 4] = cc; idx[t + 5] = d;
        }
        t += 6;
      }
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const splat = new Float32Array(pos.count * 4); // [grass, forest, dirt, rock] blend weights
  const river = new Float32Array(pos.count);     // 0..1 water weight (shader paints the ground blue)
  const c = new THREE.Color();
  const grassLow = new THREE.Color(PALETTE.grassLow);
  const grassHigh = new THREE.Color(PALETTE.grassHigh);
  const meadow = new THREE.Color(PALETTE.meadow);
  const alpine = new THREE.Color(0xa8b07e); // high pasture
  const rockC = new THREE.Color(PALETTE.rock);
  const rockHigh = new THREE.Color(PALETTE.rockHigh);
  const snowC = new THREE.Color(PALETTE.snow);
  const dirt = new THREE.Color(PALETTE.dirt);
  const bankC = new THREE.Color(0x4c5a34);  // damp, darker-green riverbank under the painted-blue channel

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
    // the Prahova: painted straight into the ground (the shader turns this band
    // blue). Using true perpendicular distance so the course stays clean on bends.
    const rd = riverDist(x, z);
    if (rd < RIVER_BANK) c.lerp(bankC, (1 - rd / RIVER_BANK) * 0.4); // damp grassy banks under the blue
    // water weight: solid across the channel bed, quick fade into the banks
    river[i] = rd <= RIVER_FLAT ? 1 : 1 - smoothstep(RIVER_FLAT, RIVER_FLAT + 8, rd);
    const road = roadDistance(x, z);
    if (road < 5) c.lerp(dirt, (1 - road / 5) * 0.85);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    // ground-texture splat weights (forest channel is filled by paintForestFloor)
    const wRock = slope > 0.55 ? Math.min(1, (slope - 0.55) / 0.45) : 0;
    const wDirt = road < 5 ? (1 - road / 5) * 0.9 : 0;
    const wGrass = Math.max(0, 1 - wRock - wDirt);
    splat[i * 4] = wGrass; splat[i * 4 + 1] = 0; splat[i * 4 + 2] = wDirt; splat[i * 4 + 3] = wRock;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));
  geo.setAttribute('aRiver', new THREE.BufferAttribute(river, 1));
  // Analytic normals from the height gradient — NOT computeVertexNormals(). The
  // mesh is a uniform grid whose quads all split along the SAME diagonal, so
  // face-averaged normals carry a 45° directional bias that reads as regular
  // parallel diagonal shading lines ("corduroy") on smooth slopes — an artifact,
  // not terrain (it has no morphological sense, runs diagonal to the valley, and
  // got more visible once de-terracing removed the height noise masking it).
  // Sampling the terrainHeight gradient is independent of how the quads are split.
  const gxS = MAP.width / TERR_SEG_X, gzS = MAP.depth / TERR_SEG_Z;
  const nrm = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const nxv = (terrainHeight(x - gxS, z) - terrainHeight(x + gxS, z)) / (2 * gxS);
    const nzv = (terrainHeight(x, z - gzS) - terrainHeight(x, z + gzS)) / (2 * gzS);
    const inv = 1 / Math.hypot(nxv, 1, nzv);
    nrm[i * 3] = nxv * inv; nrm[i * 3 + 1] = inv; nrm[i * 3 + 2] = nzv * inv;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  // image-based PBR ground: real grass/forest/dirt/rock textures splat-blended by
  // the aSplat weights, with the vertex colours surviving as a light tint.
  const mat = terrainGroundMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  terrainMesh = mesh;
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
  if (!roadMat) {
    roadMat = cobbleMaterial();
    // pull the ribbon toward the camera in depth so it never z-fights the
    // (now much finer) terrain mesh it's draped on
    roadMat.polygonOffset = true;
    roadMat.polygonOffsetFactor = -2;
    roadMat.polygonOffsetUnits = -2;
  }
  const mesh = new THREE.Mesh(geo, roadMat);
  mesh.receiveShadow = true;
  mesh.renderOrder = 1; // after terrain (0), before river (2)
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

// A static backdrop of the real surrounding mountains, built from the wide-area
// low-res DEM (loadBackdrop). It rings the detailed playable terrain: every
// vertex is placed with the same lon/lat->world mapping, so the Bucegi to the
// west and the Baiului to the east sit exactly where they really are. The
// central playable footprint is left hollow (the detailed mesh fills it); a
// one-cell apron of backdrop quads tucks under the detailed edge to avoid gaps.
export function buildBackdropMesh(): THREE.Mesh | null {
  if (!backDem || !backMeta) return null;
  const { w, h, minLat, maxLat, minLon, maxLon } = backMeta;
  const N = w * h;
  const wx = new Float32Array(N), wz = new Float32Array(N), asl = new Float32Array(N);
  for (let j = 0; j < h; j++) {
    const lat = maxLat - (j / (h - 1)) * (maxLat - minLat); // row 0 = north
    for (let i = 0; i < w; i++) {
      const lon = minLon + (i / (w - 1)) * (maxLon - minLon);
      const p = lonLatToWorld(lon, lat);
      const k = j * w + i;
      wx[k] = p.x; wz[k] = p.z; asl[k] = backDem[k];
    }
  }
  // approximate horizontal cell size (m) for slope + apron tuck
  const cell = Math.hypot(wx[1] - wx[0], wz[1] - wz[0]) || 80;
  const inX = (x: number) => x > MAP.minX && x < MAP.maxX;
  const inZ = (z: number) => z > MAP.minZ && z < MAP.maxZ;
  const interior = (x: number, z: number): boolean => inX(x) && inZ(z);

  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const splat = new Float32Array(N * 4); // [grass, forest, dirt, rock] for the shared ground material
  const c = new THREE.Color();
  const forestLo = new THREE.Color(0x35492c), forestHi = new THREE.Color(0x4a6738);
  const alpine = new THREE.Color(0x8f9a6a);
  const rock = new THREE.Color(0x8a8479), rockHi = new THREE.Color(0xa39c8f), snow = new THREE.Color(0xeef2f5);
  // haze tint: softens the hard elevation bands toward the sky colour so the
  // massifs read as atmospheric painted peaks, not a high-contrast contour model
  const haze = new THREE.Color(PALETTE.fog);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      // tuck vertices that fall inside the playable footprint far down so the
      // detailed terrain hides them; keep true elevation everywhere outside
      const inside = interior(wx[k], wz[k]);
      let yNat = asl[k] - baseElev;
      // close the seam where the backdrop meets the detailed mesh: blend the
      // near-edge backdrop height toward the detailed terrain's edge height over
      // a few cells, so the two surfaces line up instead of stepping.
      if (!inside) {
        const cxw = Math.min(MAP.maxX, Math.max(MAP.minX, wx[k]));
        const czw = Math.min(MAP.maxZ, Math.max(MAP.minZ, wz[k]));
        const dOut = Math.hypot(wx[k] - cxw, wz[k] - czw);
        const band = cell * 3;
        if (dOut < band) {
          const t = dOut / band;
          yNat = terrainHeight(cxw, czw) * (1 - t) + yNat * t;
        }
      }
      const y = yNat - (inside ? 60 : 0);
      pos[k * 3] = wx[k]; pos[k * 3 + 1] = y; pos[k * 3 + 2] = wz[k];
      // slope from grid neighbours
      const il = k - (i > 0 ? 1 : 0), ir = k + (i < w - 1 ? 1 : 0);
      const iu = k - (j > 0 ? w : 0), id = k + (j < h - 1 ? w : 0);
      const dh = Math.hypot(asl[ir] - asl[il], asl[id] - asl[iu]) / (2 * cell);
      const a = asl[k];
      // elevation bands: forest -> alpine pasture -> rock, with snow up high
      if (a < 1350) c.copy(forestLo).lerp(forestHi, Math.min(1, Math.max(0, (a - 760) / 590)));
      else if (a < 1700) c.copy(forestHi).lerp(alpine, (a - 1350) / 350);
      else c.copy(alpine).lerp(rockHi, Math.min(1, (a - 1700) / 350));
      if (dh > 0.5) c.lerp(a > 1500 ? rockHi : rock, Math.min(1, (dh - 0.5) / 0.7));
      if (a > 1850) c.lerp(snow, Math.min(1, (a - 1850) / 280));
      c.lerp(haze, 0.18); // desaturate toward the sky so distance haze blends cleanly
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      // ground-texture splat weights so the massifs read as textured terrain
      // (grass low, forest mid-band, rock on steep/high ground) — not flat colour
      let wR = dh > 0.5 ? Math.min(1, (dh - 0.5) / 0.7) : 0;
      if (a > 1650) wR = Math.max(wR, Math.min(1, (a - 1650) / 350));
      const wF = Math.max(0, Math.min(1, (a - 820) / 220)) * Math.max(0, Math.min(1, (1750 - a) / 250));
      const wG = Math.max(0.05, 1 - wF - wR);
      splat[k * 4] = wG; splat[k * 4 + 1] = wF; splat[k * 4 + 2] = 0; splat[k * 4 + 3] = wR;
    }
  }

  const idx: number[] = [];
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, d = a + w, e = d + 1;
      // skip quads whose centre sits well inside the playable footprint (the
      // detailed mesh covers it); keep a one-cell apron straddling the edge
      const cxw = (wx[a] + wx[e]) / 2, czw = (wz[a] + wz[e]) / 2;
      if (cxw > MAP.minX + cell && cxw < MAP.maxX - cell && czw > MAP.minZ + cell && czw < MAP.maxZ - cell) continue;
      idx.push(a, d, b, b, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // same splat-blended image-based ground material as the playable terrain, so the
  // surrounding massifs are textured grass/forest/rock (hazed by distance fog)
  // instead of flat washed-out colour.
  const mat = terrainGroundMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'backdrop';
  mesh.raycast = () => {}; // inert for picking
  mesh.renderOrder = -1;   // draw first, behind everything
  return mesh;
}

export function buildRiverMesh(): THREE.Mesh {
  const steps = 380;
  const halfW = RIVER_FLAT; // span the full flat channel bed
  const lift = 2.0;         // sit clearly above the rendered bed (still ~1 m below the rim) so it never buries
  const verts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  let cum = 0;
  let px = 0, pz = 0;
  for (let i = 0; i <= steps; i++) {
    const z = MAP.minZ + (i / steps) * MAP.depth;
    const x = riverX(z);
    // A flat water surface, draped at the *rendered* channel-bed height (surfaceHeight,
    // which reproduces the coarse mesh's actual dip) plus a lift — so the water is
    // guaranteed to sit above the ground beneath it regardless of how the mesh
    // happened to triangulate the carve. The carved banks rise past ±RIVER_FLAT and
    // frame the ribbon instead of occluding it.
    const level = surfaceHeight(x, z) + lift;
    const lx = x - halfW, rx = x + halfW;
    const ly = level, ry = level;
    if (i > 0) cum += Math.hypot(x - px, z - pz);
    px = x; pz = z;
    verts.push(lx, ly, z, rx, ry, z);
    const v = cum / 22;
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
  if (!waterMat) {
    waterMat = waterMaterial();
    waterMat.polygonOffset = true;
    waterMat.polygonOffsetFactor = -3; // pull in front of road + terrain
    waterMat.polygonOffsetUnits = -3;
  }
  const mesh = new THREE.Mesh(geo, waterMat);
  mesh.renderOrder = 2; // draw the translucent water after terrain (0) and road (1)
  mesh.name = 'river';
  return mesh;
}
