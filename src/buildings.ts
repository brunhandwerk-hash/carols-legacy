import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { surfaceHeight, flattenUnder } from './terrain';
import { G, ResKind, RES_KINDS, GatherKind, pay, canAfford } from './state';
import { woodMaterial, stoneMaterial, thatchMaterial, tileMaterial, plasterMaterial, earthMaterial, brickMaterial } from './materials';
import { loadModel, fitModel, FitOpts } from './models';
import { reseatNodesNear } from './world';
import type { Villager } from './units';

export type BuildingPhase = 'planned' | 'site' | 'done';

export interface BuildingDef {
  key: string;
  name: string;
  desc: string;
  cost: Partial<Record<ResKind, number>>;
  buildPoints: number;
  popCap: number;
  isDropoff: boolean;
  trains: boolean;
  radius: number; // approach / footprint radius
  foodTrickle?: number; // food per second when complete
  coinTrickle?: number; // coin per second when complete (offerings, tolls)
  // refining: every `interval` s, if `input` is affordable, consume it and add
  // `output` (a production chain — e.g. wood -> planks at the sawmill)
  produces?: { input: Partial<Record<ResKind, number>>; output: Partial<Record<ResKind, number>>; interval: number };
  jobSlots?: number;    // worker positions — output requires assigned workers, and scales with how many are present
  boosts?: GatherKind;  // speeds up gathering of this kind within boostRange
  boostRange?: number;  // metres
  defendRange?: number; // metres — auto-damages wild animals within this radius
  defendDps?: number;   // damage per second dealt to animals in defendRange
  noFoundation?: boolean; // skip the terraced stone foundation (e.g. bridges)
  needsWater?: boolean;   // can only be placed at the river's edge (e.g. the fishery)
  flatRadius?: number;    // override the flattened-ground radius (big landmarks need a wider level shelf than radius+8 gives on the coarse mesh)
  requires?: string[];    // building keys that must be 'done' before this unlocks
  // optional authored glTF "hero" model — swaps in for the procedural mesh once
  // loaded (landmarks only); the procedural `build` stays as the fallback
  model?: { url: string } & FitOpts;
  build: (g: THREE.Group) => void;
}

// is this building unlocked? (all its prerequisite buildings are completed)
export function prereqsMet(def: BuildingDef): boolean {
  return !def.requires || def.requires.every((k) => G.buildings.some((b) => b.def.key === k && b.phase === 'done'));
}

export const GATHER_BONUS = 1.7; // carry-rate multiplier near a matching gather camp

// ---- era-based building evolution -----------------------------------------
// Generic dwellings re-skin as the ages progress: rough log + thatch (1690) →
// whitewashed plaster + tile (1800s) → brick + slate (interbellic). Bespoke
// landmarks (monastery, inn) keep their hand-built look. Builders tag their
// wall/roof meshes via `tag(...)`; the active era's materials are swapped in.
interface EraStyle { wall: THREE.Material; roof: THREE.Material }
let ERA_STYLES: EraStyle[]; // built lazily after M is defined
function eraStyle(eraIndex: number): EraStyle {
  const band = eraIndex <= 1 ? 0 : eraIndex === 2 ? 1 : 2;
  return ERA_STYLES[band];
}
function tag<T extends THREE.Object3D>(o: T, role: 'wall' | 'roof'): T {
  o.userData.role = role;
  return o;
}

// ---- shared materials: runtime-generated PBR (see materials.ts) ----
const M = {
  log: woodMaterial(0xa07b4c, 11),          // warmer/brighter so it sits closer to the glTF kit
  logDark: woodMaterial(0x77593a, 12),
  thatch: thatchMaterial(0xc0a566),
  shingle: tileMaterial(0x8a6749, 44),      // wooden shingles
  whitewash: plasterMaterial(0xf2ecdd),
  roofRed: tileMaterial(0x9c4a38, 41),       // fired clay tiles
  roofGray: tileMaterial(0x707a82, 42),      // slate
  stone: stoneMaterial(0x9a958c, 23),
  stoneDark: stoneMaterial(0x7e7a70, 24),
  brick: brickMaterial(0x9c5b43, 71),
  gold: new THREE.MeshStandardMaterial({ color: 0xd4a843, metalness: 1, roughness: 0.34 }),
  dirt: earthMaterial(0x8a6f4d),
  grass: new THREE.MeshStandardMaterial({ color: 0x83a154, roughness: 0.95, metalness: 0 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x2e3b40, roughness: 0.15, metalness: 0.1, emissive: 0x20303a, emissiveIntensity: 0.35 }),
  fire: new THREE.MeshBasicMaterial({ color: 0xe8853a }),
  // ---- props / clutter -------------------------------------------------
  iron: new THREE.MeshStandardMaterial({ color: 0x80868d, metalness: 0.7, roughness: 0.42 }),
  sack: new THREE.MeshStandardMaterial({ color: 0xc8b187, roughness: 0.96, metalness: 0 }),
  cloth: new THREE.MeshStandardMaterial({ color: 0xb24a3c, roughness: 0.9, metalness: 0 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffa53a, emissiveIntensity: 1.3, roughness: 0.5 }),
  hay: new THREE.MeshStandardMaterial({ color: 0xc9a84e, roughness: 0.97, metalness: 0 }),
  cowHide: new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 0.85, metalness: 0 }),
  cowSpot: new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.85, metalness: 0 }),
  milk: new THREE.MeshStandardMaterial({ color: 0xf3f0e6, roughness: 0.4, metalness: 0 }),
};

ERA_STYLES = [
  { wall: M.log, roof: M.thatch },        // 1690–1865 — log & thatch
  { wall: M.whitewash, roof: M.roofRed },  // 1866–1918 — plastered & tiled
  { wall: M.brick, roof: M.roofGray },     // interbellic — brick & slate
];

// Every structural box gets softly beveled edges instead of hard cube corners —
// the chamfer catches the light and reads far less "low-poly blocky". The radius
// is clamped to the thinnest dimension so slender trim/planks stay crisp.
function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const r = Math.min(0.07, Math.min(w, h, d) * 0.22);
  const geo = r > 0.012
    ? new RoundedBoxGeometry(w, h, d, 1, r)
    : new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function pyramid(r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0, sides = 4): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, sides), mat);
  m.position.set(x, y + h / 2, z);
  m.rotation.y = Math.PI / 4;
  m.castShadow = true;
  return m;
}

function cylinder(r: number, h: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), mat);
  m.position.set(x, y + h / 2, z);
  m.castShadow = true;
  return m;
}

// pitched gable roof: triangular cross-section (apex up) extruded along z, with
// eaves overhang. Ridge runs along z; slopes face ±x; gable ends face ±z.
// `y` is the eaves line (base of the roof).
function gableRoof(
  w: number, d: number, h: number, mat: THREE.Material,
  x = 0, y = 0, z = 0, ohX = 0.45, ohZ = 0.45,
): THREE.Mesh {
  const hw = w / 2 + ohX;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, 0); shape.lineTo(hw, 0); shape.lineTo(0, h); shape.closePath();
  const depth = d + 2 * ohZ;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// hip/pyramidal roof for square towers (kept distinct from the cone `pyramid`)
function chimney(mat: THREE.Material, x: number, y: number, z: number, h = 2.2, w = 0.6): THREE.Group {
  const g = new THREE.Group();
  g.add(box(w, h, w, mat, x, y, z));
  g.add(box(w + 0.22, 0.28, w + 0.22, mat, x, y + h, z)); // cap
  return g;
}

// a framed plank door on the +z face at local (x), base at floor height `y0`
function door(x: number, y0: number, zFace: number, frame: THREE.Material, leaf: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.06, 1.78, 0.16, frame, x, y0, zFace));
  g.add(box(0.82, 1.54, 0.12, leaf, x, y0, zFace + 0.06));
  return g;
}

// a shuttered window on a ±x face
function windowSh(xFace: number, y0: number, z: number, frame: THREE.Material, pane: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.16, 0.92, 1.0, frame, xFace, y0, z));
  g.add(box(0.08, 0.66, 0.74, pane, xFace + Math.sign(xFace) * 0.05, y0 + 0.13, z));
  return g;
}

function cross(x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.18, 1.6, 0.18, M.gold, 0, 0, 0));
  g.add(box(0.9, 0.18, 0.18, M.gold, 0, 1.0, 0));
  g.position.set(x, y, z);
  return g;
}

// ---------------------------------------------------------------------------
// Yard props: small procedural clutter scattered around buildings so they read
// as worked, lived-in places (à la Foundation / Manor Lords) rather than bare
// boxes. None are era-tagged, so they keep their own materials across ages.
// All are positioned in the building's local space (origin at the footprint
// centre, y=0 at the platform).
// ---------------------------------------------------------------------------

// a hooped wooden barrel
function barrel(x: number, z: number, s = 1): THREE.Group {
  const g = new THREE.Group();
  const body = cylinder(0.34 * s, 0.8 * s, M.log, 0, 0, 0);
  g.add(body);
  for (const hy of [0.14, 0.62]) {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.355 * s, 0.04 * s, 5, 14), M.iron);
    hoop.position.y = hy * s; hoop.rotation.x = Math.PI / 2;
    hoop.castShadow = true;
    g.add(hoop);
  }
  g.position.set(x, 0, z);
  return g;
}

// a planked crate with corner battens
function crate(x: number, z: number, rot = 0, s = 1): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.66 * s, 0.62 * s, 0.66 * s, M.shingle, 0, 0, 0));
  for (const sx of [-1, 1] as const) for (const sz of [-1, 1] as const)
    g.add(box(0.08 * s, 0.66 * s, 0.08 * s, M.logDark, sx * 0.33 * s, 0, sz * 0.33 * s));
  g.position.set(x, 0, z); g.rotation.y = rot;
  return g;
}

// a plump burlap sack
function sack(x: number, z: number, color = M.sack): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), color);
  m.scale.set(1, 1.35, 1);
  m.position.set(x, 0.38, z);
  m.castShadow = true;
  return m;
}

// a pile of cross-stacked logs (firewood), ridge running along local z
function woodpile(x: number, z: number, rot = 0, len = 2.2): THREE.Group {
  const g = new THREE.Group();
  const r = 0.17;
  const rows: [number, number][] = [[-2, 0], [0, 0], [2, 0], [-1, 1], [1, 1], [0, 2]];
  for (const [ox, oy] of rows) {
    const l = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 7), oy % 2 ? M.logDark : M.log);
    l.rotation.z = Math.PI / 2;
    l.position.set(ox * r, r + oy * r * 1.72, 0);
    l.castShadow = true;
    g.add(l);
  }
  g.position.set(x, 0, z); g.rotation.y = rot;
  return g;
}

// a neat stack of sawn planks
function plankStack(x: number, z: number, rot = 0): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) g.add(box(0.34, 0.06, 2.0, M.shingle, (i % 2) * 0.02, 0.07 * i, 0));
  g.position.set(x, 0, z); g.rotation.y = rot;
  return g;
}

// a chopping stump with an axe sunk into the top
function choppingBlock(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.46, 0.72, 11), M.logDark);
  stump.position.y = 0.36; stump.castShadow = true; g.add(stump);
  const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.95, 6), M.log);
  haft.position.set(0.06, 0.96, 0); haft.rotation.z = 0.5; g.add(haft);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 0.36), M.iron);
  head.position.set(0.3, 1.2, 0); head.rotation.z = 0.5; head.castShadow = true; g.add(head);
  g.position.set(x, 0, z);
  return g;
}

// an A-leg sawhorse / trestle
function sawhorse(x: number, z: number, rot = 0): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.16, 0.16, 1.6, M.log, 0, 0.66, 0));
  for (const sx of [-1, 1] as const) for (const sz of [-0.55, 0.55]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 5), M.logDark);
    leg.position.set(sx * 0.28, 0.4, sz);
    leg.rotation.z = sx * 0.28;
    leg.castShadow = true;
    g.add(leg);
  }
  g.position.set(x, 0, z); g.rotation.y = rot;
  return g;
}

// a small wooden bucket
function bucket(x: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.4, 9), M.logDark);
  m.position.set(x, 0.2, z); m.castShadow = true;
  return m;
}

// a split-rail fence between two local points
function fenceRun(x1: number, z1: number, x2: number, z2: number, posts = 4): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i <= posts; i++) {
    const t = i / posts;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.1, 5), M.logDark);
    p.position.set(x1 + (x2 - x1) * t, 0.5, z1 + (z2 - z1) * t);
    p.castShadow = true; g.add(p);
  }
  const len = Math.hypot(x2 - x1, z2 - z1);
  for (const ry of [0.35, 0.75]) {
    const rail = box(0.06, 0.1, len, M.log, (x1 + x2) / 2, ry, (z1 + z2) / 2);
    rail.rotation.y = Math.atan2(x2 - x1, z2 - z1);
    g.add(rail);
  }
  return g;
}

// a standing lamp post with a glowing lantern
function lanternPost(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 2.3, 6), M.logDark);
  post.position.y = 1.15; post.castShadow = true; g.add(post);
  g.add(box(0.06, 0.06, 0.5, M.logDark, 0, 2.2, 0.22));
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.28, 0.2), M.lamp);
  lamp.position.set(0, 2.06, 0.44); g.add(lamp);
  g.position.set(x, 0, z);
  return g;
}

// a weathered tree stump
function stump(x: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.42, 9), M.logDark);
  m.position.set(x, 0.21, z); m.castShadow = true;
  return m;
}

// a two-wheeled handcart
function handcart(x: number, z: number, rot = 0): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.4, 0.4, 0.9, M.log, 0, 0.5, 0));
  g.add(box(1.4, 0.28, 0.06, M.logDark, 0, 0.62, 0.45));
  g.add(box(1.4, 0.28, 0.06, M.logDark, 0, 0.62, -0.45));
  for (const sz of [-0.5, 0.5]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 12), M.logDark);
    w.rotation.x = Math.PI / 2; w.position.set(-0.25, 0.42, sz); w.castShadow = true; g.add(w);
  }
  g.add(box(1.3, 0.08, 0.08, M.log, 0.95, 0.7, -0.32));
  g.add(box(1.3, 0.08, 0.08, M.log, 0.95, 0.7, 0.32));
  g.position.set(x, 0, z); g.rotation.y = rot;
  return g;
}

// a grazing or standing cow with hide patches and horns
function cow(x: number, z: number, rot = 0, grazing = true): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.66, 9, 7), M.cowHide);
  body.scale.set(0.92, 0.92, 1.55); body.position.y = 1.05; body.castShadow = true;
  g.add(body);
  // hide patches
  for (const [px, py, pz] of [[0.4, 1.2, -0.2], [-0.35, 1.0, 0.4], [0.2, 0.9, 0.8]] as const) {
    const spot = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 5), M.cowSpot);
    spot.scale.set(0.6, 0.5, 0.9); spot.position.set(px, py, pz); g.add(spot);
  }
  // neck + head, lowered to the grass when grazing
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.62), M.cowHide);
  if (grazing) { head.position.set(0, 0.45, 1.35); head.rotation.x = 0.55; }
  else head.position.set(0, 1.2, 1.3);
  head.castShadow = true; g.add(head);
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.2), M.cowSpot);
  muzzle.position.copy(head.position); muzzle.position.z += 0.34; muzzle.position.y -= grazing ? 0.12 : 0.06;
  g.add(muzzle);
  for (const sx of [-1, 1] as const) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.26, 5), M.sack);
    horn.position.set(head.position.x + sx * 0.18, head.position.y + 0.26, head.position.z - 0.05);
    horn.rotation.z = sx * 0.5; g.add(horn);
  }
  // legs
  for (const [lx, lz] of [[-0.32, -0.7], [0.32, -0.7], [-0.32, 0.7], [0.32, 0.7]] as const) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 1.0, 5), M.cowHide);
    leg.position.set(lx, 0.5, lz); leg.castShadow = true; g.add(leg);
    g.add(box(0.14, 0.16, 0.16, M.cowSpot, lx, 0, lz)); // hoof
  }
  // tail
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 0.8, 4), M.cowHide);
  tail.position.set(0, 0.85, -1.0); tail.rotation.x = -0.4; g.add(tail);
  g.position.set(x, 0, z); g.rotation.y = rot;
  return g;
}

// scatter flat chips/pebbles on the ground (sawdust, rubble, trodden earth)
function groundLitter(cx: number, cz: number, r: number, n: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
    const s = 0.1 + Math.random() * 0.2;
    const c = box(s, 0.05, s * 0.6, mat, cx + Math.cos(a) * d, 0.02, cz + Math.sin(a) * d);
    c.rotation.y = Math.random() * Math.PI;
    c.castShadow = false;
    g.add(c);
  }
  return g;
}

// ---- building constructors (all sized in world units) ----
function buildHut(g: THREE.Group): void {
  const W = 4.4, D = 3.6, wallH = 2.3, roofH = 1.9;
  // stone footing the cabin sits on
  g.add(box(W + 0.5, 0.5, D + 0.5, M.stone, 0, 0, 0));
  // walls (era-skinned) + corner posts (reads as a stacked-log cabin)
  g.add(tag(box(W, wallH, D, M.log, 0, 0.5, 0), 'wall'));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    g.add(cylinder(0.2, wallH + 0.35, M.logDark, (sx * W) / 2, 0.4, (sz * D) / 2));
  }
  // pitched roof (era-skinned) with overhang + ridge beam
  const eaves = 0.5 + wallH;
  g.add(tag(gableRoof(W, D, roofH, M.thatch, 0, eaves, 0, 0.5, 0.55), 'roof'));
  g.add(box(0.2, 0.2, D + 1.1, M.logDark, 0, eaves + roofH - 0.16, 0));
  // door (front, +z) and a shuttered window (side, +x)
  g.add(door(0, 0.5, D / 2 + 0.02, M.logDark, M.shingle));
  g.add(windowSh(W / 2 + 0.02, 1.45, -0.4, M.logDark, M.glass));
  // stone chimney with a wisp of smoke at the back corner
  g.add(chimney(M.stone, -W / 2 + 0.5, eaves, -D / 2 + 0.5, 2.0, 0.55));
  // a shepherd's yard: firewood, a water bucket, a barrel by the door
  g.add(woodpile(W / 2 + 1.0, 1.2, 0, 2.0));
  g.add(bucket(-W / 2 - 0.7, 1.0));
  g.add(barrel(W / 2 + 0.6, -1.0, 0.9));
  g.add(stump(-W / 2 - 1.3, -1.4));
}

function buildSheepfold(g: THREE.Group): void {
  // fence ring
  const postGeo = new THREE.CylinderGeometry(0.14, 0.14, 1.2, 5);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const p = new THREE.Mesh(postGeo, M.logDark);
    p.position.set(Math.cos(a) * 5, 0.6, Math.sin(a) * 5);
    p.castShadow = true;
    g.add(p);
    const rail = box(2.4, 0.16, 0.12, M.log, Math.cos(a + 0.225) * 5, 0.8, Math.sin(a + 0.225) * 5);
    rail.rotation.y = -(a + 0.225) - Math.PI / 2;
    g.add(rail);
  }
  // a small timber barn on the north side
  g.add(box(3.2, 0.35, 2.6, M.stone, 0, 0, -3.2));
  g.add(tag(box(2.8, 1.8, 2.2, M.log, 0, 0.35, -3.2), 'wall'));
  g.add(tag(gableRoof(2.8, 2.2, 1.3, M.shingle, 0, 2.15, -3.2, 0.4, 0.4), 'roof'));
  g.add(box(1.0, 1.4, 0.14, M.logDark, 0, 0.35, -2.05)); // barn doorway
  // sheep
  const sheepGeo = new THREE.IcosahedronGeometry(0.55, 0);
  const sheepMat = new THREE.MeshLambertMaterial({ color: 0xe8e2d4 });
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Mesh(sheepGeo, sheepMat);
    s.position.set(Math.cos(i * 2.1) * 2.4, 0.55, Math.sin(i * 2.4) * 2.4);
    s.scale.y = 0.8;
    s.castShadow = true;
    g.add(s);
  }
  // a feed trough, hay bales and a water bucket by the barn
  g.add(box(2.2, 0.4, 0.7, M.log, 1.8, 0.0, -2.6));
  for (const [hx, hz] of [[-2.6, -2.2], [-3.2, -1.4]] as const) {
    const bale = box(1.0, 0.7, 0.7, M.hay, hx, 0, hz);
    g.add(bale);
    g.add(box(1.02, 0.12, 0.72, M.logDark, hx, 0.28, hz)); // baling twine
  }
  g.add(bucket(0.6, -2.8));
}

function buildCamp(g: THREE.Group): void {
  // the founders' hall — a broad communal longhouse, clearly the heart of the
  // settlement rather than just another dwelling. Bigger footprint, a porch,
  // a watch banner, and a working yard around it.
  const W = 8.4, D = 5.0, wallH = 3.1, roofH = 2.9, cx = -0.6;
  // broad stone footing
  g.add(box(W + 0.9, 0.55, D + 0.9, M.stone, cx, 0, 0));
  // stacked-log hall + heavy corner posts
  g.add(box(W, wallH, D, M.log, cx, 0.55, 0));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    g.add(cylinder(0.26, wallH + 0.55, M.logDark, cx + (sx * W) / 2, 0.4, (sz * D) / 2));
  }
  // a mid-wall post and tie-beam, so the long walls read as framed
  g.add(cylinder(0.22, wallH + 0.3, M.logDark, cx, 0.4, D / 2));
  g.add(cylinder(0.22, wallH + 0.3, M.logDark, cx, 0.4, -D / 2));
  // big pitched shingle roof with deep eaves + ridge beam
  const eaves = 0.55 + wallH;
  g.add(gableRoof(W, D, roofH, M.shingle, cx, eaves, 0, 0.7, 0.75));
  g.add(box(0.26, 0.26, D + 1.7, M.logDark, cx, eaves + roofH - 0.2, 0));
  // gable-end king post & decorative carved bargeboard
  g.add(box(0.24, roofH - 0.4, 0.3, M.logDark, cx, eaves, D / 2 + 0.55));
  // covered porch over a wide double doorway (front, +z)
  for (const ps of [-1.4, 1.4]) g.add(cylinder(0.16, wallH - 0.2, M.logDark, cx + ps, 0.55, D / 2 + 1.4));
  g.add(box(W - 1.2, 0.16, 1.6, M.shingle, cx, eaves - 0.1, D / 2 + 1.0));
  g.add(door(cx - 0.7, 0.55, D / 2 + 0.02, M.logDark, M.shingle));
  g.add(door(cx + 0.7, 0.55, D / 2 + 0.02, M.logDark, M.shingle));
  // shuttered windows on the long sides
  g.add(windowSh(cx + W / 2 + 0.02, 1.7, -1.2, M.logDark, M.glass));
  g.add(windowSh(cx + W / 2 + 0.02, 1.7, 1.2, M.logDark, M.glass));
  g.add(windowSh(cx - W / 2 - 0.02, 1.7, 0, M.logDark, M.glass));
  // stone chimney with smoke at the back
  g.add(chimney(M.stone, cx - W / 2 + 0.9, eaves, -D / 2 + 0.8, 3.0, 0.7));
  // the hamlet's banner pole with a red standard — marks the founders' seat
  const poleX = cx + W / 2 + 2.0, poleZ = D / 2 - 0.4;
  g.add(cylinder(0.13, 7.0, M.logDark, poleX, 0, poleZ));
  g.add(box(0.07, 1.3, 2.0, M.cloth, poleX + 0.05, 5.4, poleZ + 1.0));
  // working yard: fire ring, woodpile, chopping block, stores
  g.add(cylinder(0.5, 0.5, M.fire, 6.2, 0, -2.4));
  g.add(box(3, 0.25, 3, M.dirt, 6.2, -0.05, -2.4));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.add(box(0.42, 0.32, 0.42, M.stone, 6.2 + Math.cos(a) * 1.0, 0, -2.4 + Math.sin(a) * 1.0));
  }
  g.add(stump(7.6, -1.0));
  g.add(stump(5.0, -3.4));
  g.add(woodpile(6.4, 1.2, 0.2, 2.4));
  g.add(choppingBlock(5.4, 2.2));
  g.add(barrel(cx - W / 2 - 1.4, 1.6));
  g.add(crate(cx - W / 2 - 1.2, -0.2, 0.4));
  g.add(sack(cx - W / 2 - 2.0, 0.6));
  g.add(groundLitter(6.0, 0.2, 2.0, 12, M.log));
}

function buildLumberCamp(g: THREE.Group): void {
  // an open-sided sawpit: posts + plank roof, stacked logs, a saw-trestle
  for (const [sx, sz] of [[-2.2, -1.6], [2.2, -1.6], [-2.2, 1.6], [2.2, 1.6]] as const) {
    g.add(cylinder(0.16, 2.6, M.logDark, sx, 0, sz));
  }
  g.add(tag(gableRoof(5.0, 4.0, 1.3, M.shingle, 0, 2.6, 0, 0.4, 0.3), 'roof'));
  const logGeo = new THREE.CylinderGeometry(0.32, 0.32, 3.4, 6);
  for (let i = 0; i < 4; i++) {
    const l = new THREE.Mesh(logGeo, M.log);
    l.rotation.z = Math.PI / 2;
    l.position.set(-1.6 + (i % 2) * 0.7, 0.32 + Math.floor(i / 2) * 0.55, 1.2);
    l.castShadow = true;
    g.add(l);
  }
  // a log being sawn on the trestle, with a two-man saw biting into it
  g.add(sawhorse(-0.5, -1.2, 0.08));
  g.add(sawhorse(1.4, -1.2, -0.08));
  const onTrestle = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.6, 7), M.log);
  onTrestle.rotation.z = Math.PI / 2; onTrestle.position.set(0.45, 0.95, -1.2);
  onTrestle.castShadow = true; g.add(onTrestle);
  const sawBlade = box(1.3, 0.34, 0.04, M.iron, 0.45, 1.3, -1.2);
  sawBlade.rotation.z = 0.12; g.add(sawBlade);
  g.add(box(0.1, 0.42, 0.1, M.logDark, -0.25, 1.32, -1.2)); // saw handles
  g.add(box(0.1, 0.42, 0.1, M.logDark, 1.15, 1.42, -1.2));
  // a stack of finished planks, fresh-cut logs, and an axe in a chopping block
  g.add(plankStack(2.6, -0.6, 0.1));
  g.add(woodpile(-2.8, -0.4, Math.PI / 2, 2.6));
  g.add(choppingBlock(-2.4, 1.6));
  g.add(stump(2.8, 1.6));
  g.add(barrel(-2.0, 2.0, 0.9));
  // sawdust and offcuts trodden into the ground
  g.add(groundLitter(0, 0, 3.4, 22, M.log));
}

function buildQuarry(g: THREE.Group): void {
  // a worked rock face: cut blocks, a sledge, a winch frame
  const blocks = [[-1.6, 0, 1.2, 1.4], [0, 0, 0.8, 1.1], [1.5, 0, 1.0, 0.9], [-0.6, 0.9, 0.9, 0.8]];
  for (const [x, y, s, h] of blocks) {
    g.add(box(s * 1.4, h, s * 1.4, M.stone, x, y, 1.0));
  }
  // winch A-frame over the pit
  g.add(box(0.2, 3.2, 0.2, M.logDark, -1.8, 0, -1.4));
  g.add(box(0.2, 3.2, 0.2, M.logDark, 1.8, 0, -1.4));
  g.add(box(4.2, 0.22, 0.22, M.log, 0, 3.1, -1.4));
  g.add(box(0.5, 0.6, 0.5, M.stone, 0, 1.4, -1.4)); // hanging block
  // rubble pad
  g.add(box(5, 0.18, 4, M.dirt, 0, -0.02, 0));
  // mason's clutter: sledge, chisels in a crate, dressed blocks, stone rubble
  g.add(handcart(-2.8, 2.2, 0.5));
  g.add(crate(2.6, 2.0, -0.3));
  g.add(box(0.9, 0.6, 0.7, M.stoneDark, 2.4, 0.18, -2.0));
  g.add(box(0.7, 0.5, 0.6, M.stoneDark, 1.5, 0.18, -2.4));
  g.add(barrel(-2.6, -1.6));
  g.add(groundLitter(0, 0.5, 3.0, 24, M.stone));
}

function buildForager(g: THREE.Group): void {
  // a forager's hut with drying racks and berry baskets
  g.add(box(3.2, 0.35, 2.8, M.stone, -1, 0, 0));
  g.add(tag(box(3, 1.8, 2.6, M.log, -1, 0.35, 0), 'wall'));
  g.add(tag(gableRoof(3, 2.6, 1.2, M.thatch, -1, 2.15, 0, 0.4, 0.4), 'roof'));
  g.add(door(-1, 0.35, 1.32, M.logDark, M.shingle));
  // drying rack
  g.add(box(0.16, 1.6, 0.16, M.logDark, 1.4, 0, -1));
  g.add(box(0.16, 1.6, 0.16, M.logDark, 1.4, 0, 1));
  g.add(box(0.16, 0.1, 2.2, M.log, 1.4, 1.5, 0));
  // baskets of berries
  const berry = new THREE.MeshLambertMaterial({ color: 0x7a2f3a });
  for (const [bx, bz] of [[1.2, 0.9], [2.0, 0.2], [1.6, -0.8]] as const) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.32, 0.5, 8), M.log);
    b.position.set(bx, 0.25, bz);
    b.castShadow = true;
    g.add(b);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.36, 7, 5, 0, Math.PI * 2, 0, Math.PI / 2), berry);
    top.position.set(bx, 0.5, bz);
    g.add(top);
  }
  // herbs hung to dry on the rack, sacks of foraged goods, a barrel of preserves
  for (const hx of [0.9, 1.4, 1.9]) {
    const bundle = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 6), M.hay);
    bundle.position.set(hx, 1.25, -1); bundle.rotation.x = Math.PI; g.add(bundle);
  }
  g.add(sack(-2.4, 1.2));
  g.add(sack(-2.7, 0.4, M.sack));
  g.add(barrel(2.2, -1.6, 0.85));
  g.add(bucket(0.2, -1.6));
}

function buildInn(g: THREE.Group): void {
  const W = 8, D = 5.5;
  // stone footing + whitewashed ground floor
  g.add(box(W + 0.6, 0.6, D + 0.6, M.stone, 0, 0, 0));
  g.add(box(W, 3, D, M.whitewash, 0, 0.6, 0));
  // exposed-timber upper storey, slightly jettied out
  g.add(box(W + 0.5, 0.35, D + 0.5, M.log, 0, 3.6, 0));
  g.add(box(W + 0.2, 2.4, D + 0.2, M.whitewash, 0, 3.95, 0));
  // half-timbering: corner posts + cross-braces
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      g.add(box(0.28, 2.4, 0.28, M.logDark, (sx * (W + 0.2)) / 2, 3.95, (sz * (D + 0.2)) / 2));
    }
  }
  g.add(box(W + 0.2, 0.25, D + 0.2, M.logDark, 0, 6.35, 0)); // top plate
  // pitched shingle roof with overhang + ridge
  g.add(gableRoof(W + 0.2, D + 0.2, 2.6, M.shingle, 0, 6.6, 0, 0.6, 0.7));
  g.add(box(0.25, 0.25, D + 1.6, M.logDark, 0, 6.6 + 2.6 - 0.2, 0));
  // ground-floor door + flanking windows; upper windows
  g.add(door(0, 0.6, D / 2 + 0.02, M.logDark, M.shingle));
  g.add(box(1.2, 1.3, 0.12, M.glass, -2.4, 1.6, D / 2 + 0.04));
  g.add(box(1.2, 1.3, 0.12, M.glass, 2.4, 1.6, D / 2 + 0.04));
  for (const ux of [-2.4, 0, 2.4]) g.add(box(1.0, 1.1, 0.12, M.glass, ux, 4.4, (D + 0.2) / 2 + 0.04));
  // chimney
  g.add(chimney(M.stone, W / 2 - 1.0, 6.6, -D / 2 + 0.8, 2.6, 0.7));
  // a coaching-inn yard: lanterns flanking the door, ale barrels, a parked cart
  g.add(lanternPost(-1.6, D / 2 + 0.9));
  g.add(lanternPost(1.6, D / 2 + 0.9));
  g.add(barrel(W / 2 + 0.9, 1.6));
  g.add(barrel(W / 2 + 1.5, 1.0, 0.95));
  g.add(barrel(W / 2 + 0.9, 0.2, 0.9));
  g.add(handcart(-W / 2 - 1.6, 0.5, 0.3));
  g.add(crate(-W / 2 - 1.2, -1.8, -0.4));
  g.add(sack(-W / 2 - 1.9, -1.4));
}

function buildMonastery(g: THREE.Group): void {
  // courtyard walls
  const wallH = 3.2, half = 15;
  g.add(box(half * 2, wallH, 1, M.whitewash, 0, 0, -half));
  g.add(box(half * 2, wallH, 1, M.whitewash, 0, 0, half));
  g.add(box(1, wallH, half * 2, M.whitewash, -half, 0, 0));
  g.add(box(1, wallH, half * 2, M.whitewash, half, 0, 0));
  // wall roofs
  g.add(box(half * 2 + 0.6, 0.5, 1.8, M.shingle, 0, wallH, -half));
  g.add(box(half * 2 + 0.6, 0.5, 1.8, M.shingle, 0, wallH, half));
  g.add(box(1.8, 0.5, half * 2 + 0.6, M.shingle, -half, wallH, 0));
  g.add(box(1.8, 0.5, half * 2 + 0.6, M.shingle, half, wallH, 0));
  // gate tower (south side, facing the town)
  g.add(box(4.5, 6.5, 3, M.whitewash, 0, 0, half));
  g.add(pyramid(3, 3, M.roofGray, 0, 6.5, half));
  g.add(cross(0, 9.7, half));
  // cells along the inside of the north wall
  g.add(box(22, 2.6, 4, M.whitewash, 0, 0, -half + 2.8));
  g.add(box(22.6, 0.4, 4.8, M.shingle, 0, 2.6, -half + 2.8));
  // the church: nave + apse + steeple
  g.add(box(9, 4.2, 5.5, M.whitewash, 0, 0, 0.5));
  const apse = cylinder(2.6, 4.2, M.whitewash, 0, 0, -3.6);
  g.add(apse);
  const apseRoof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.6, 10), M.roofGray);
  apseRoof.position.set(0, 5, -3.6);
  apseRoof.castShadow = true;
  g.add(apseRoof);
  // nave roof
  const naveRoof = box(9.6, 1.4, 6.1, M.roofGray, 0, 4.2, 0.5);
  naveRoof.scale.y = 1;
  g.add(naveRoof);
  // steeple over the nave
  g.add(box(3, 3.4, 3, M.whitewash, 0, 5.4, 1.8));
  const spire = new THREE.Mesh(new THREE.ConeGeometry(2, 3.4, 8), M.roofGray);
  spire.position.set(0, 10.5, 1.8);
  spire.castShadow = true;
  g.add(spire);
  g.add(cross(0, 12.4, 1.8));
  // a working monastery courtyard: a well, lanterns by the gate, stores
  const well = cylinder(1.1, 1.1, M.stone, -6, 0, 6);
  g.add(well);
  g.add(box(0.2, 2.4, 0.2, M.logDark, -6.9, 1.1, 6));
  g.add(box(0.2, 2.4, 0.2, M.logDark, -5.1, 1.1, 6));
  g.add(pyramid(1.5, 0.9, M.shingle, -6, 3.5, 6));
  g.add(lanternPost(-2.4, half - 1.2));
  g.add(lanternPost(2.4, half - 1.2));
  g.add(barrel(6, 7));
  g.add(barrel(6.8, 6.5, 0.95));
  g.add(crate(5.4, 8, 0.3));
  g.add(woodpile(7.5, -2, Math.PI / 2, 3.2));
}

function buildHunters(g: THREE.Group): void {
  // a hunters' lodge: raised log cabin, a watch platform with a horn, antler
  // trophy over the door, drying hides and a rack of spears
  const W = 4.6, D = 3.8, wallH = 2.4;
  g.add(box(W + 0.5, 0.4, D + 0.5, M.stone, 0, 0, 0));
  g.add(tag(box(W, wallH, D, M.log, 0, 0.4, 0), 'wall'));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
    g.add(cylinder(0.2, wallH + 0.4, M.logDark, (sx * W) / 2, 0.3, (sz * D) / 2));
  const eaves = 0.4 + wallH;
  g.add(tag(gableRoof(W, D, 1.7, M.shingle, 0, eaves, 0, 0.5, 0.5), 'roof'));
  g.add(door(0, 0.4, D / 2 + 0.02, M.logDark, M.shingle));
  // antler trophy over the door
  for (const sx of [-1, 1] as const) {
    for (let k = 0; k < 3; k++) {
      const tine = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.5, 4), M.sack);
      tine.position.set(sx * (0.18 + k * 0.14), 2.0 + k * 0.12, D / 2 + 0.1);
      tine.rotation.z = sx * (0.5 + k * 0.18);
      g.add(tine);
    }
  }
  // a watch platform on stilts beside the lodge
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
    g.add(cylinder(0.12, 3.4, M.logDark, W / 2 + 1.8 + sx * 0.7, 0, -1.0 + sz * 0.7));
  g.add(box(2.0, 0.18, 2.0, M.shingle, W / 2 + 1.8, 3.3, -1.0));
  g.add(box(2.0, 0.6, 0.12, M.logDark, W / 2 + 1.8, 3.5, -2.0)); // rail
  // drying hides on a rack
  g.add(box(0.14, 1.6, 0.14, M.logDark, -W / 2 - 1.4, 0, -1.0));
  g.add(box(0.14, 1.6, 0.14, M.logDark, -W / 2 - 1.4, 0, 1.0));
  g.add(box(0.14, 0.12, 2.2, M.log, -W / 2 - 1.4, 1.5, 0));
  for (const hz of [-0.6, 0.6]) {
    const hide = box(0.06, 1.0, 0.8, M.sack, -W / 2 - 1.4, 0.4, hz);
    g.add(hide);
  }
  // a stack of pelts and a leaning rack of spears
  g.add(box(1.0, 0.4, 0.7, M.sack, -W / 2 - 0.4, 0.1, 1.6));
  for (const sxo of [-0.15, 0, 0.15]) {
    const spear = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 5), M.logDark);
    spear.position.set(W / 2 + 0.3 + sxo, 1.0, 1.5);
    spear.rotation.z = 0.25;
    spear.castShadow = true;
    g.add(spear);
  }
}

function buildFishery(g: THREE.Group): void {
  // a fisherman's hut raised on stilts at the water's edge, with a jetty,
  // hung nets, a drying line of fish, an upturned rowboat and barrels of catch
  const W = 3.6, D = 3.0, floor = 0.9;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
    g.add(cylinder(0.16, floor + 0.4, M.logDark, (sx * W) / 2, -0.3, (sz * D) / 2));
  g.add(box(W + 0.4, 0.25, D + 0.4, M.log, 0, floor - 0.25, 0)); // deck/floor
  g.add(tag(box(W, 1.9, D, M.log, 0, floor, 0), 'wall'));
  g.add(tag(gableRoof(W, D, 1.3, M.thatch, 0, floor + 1.9, 0, 0.5, 0.5), 'roof'));
  g.add(door(0, floor, D / 2 + 0.02, M.logDark, M.shingle));
  // jetty reaching out over the water (toward +x, the river side)
  for (const jx of [W / 2 + 0.9, W / 2 + 2.2, W / 2 + 3.5]) {
    g.add(cylinder(0.12, floor + 0.6, M.logDark, jx, -0.5, -0.8));
    g.add(cylinder(0.12, floor + 0.6, M.logDark, jx, -0.5, 0.8));
  }
  g.add(box(4.4, 0.16, 2.0, M.log, W / 2 + 2.4, floor - 0.25, 0));
  // a drying line of fish between two posts
  g.add(cylinder(0.1, 2.2, M.logDark, -W / 2 - 0.8, 0, -1.0));
  g.add(cylinder(0.1, 2.2, M.logDark, -W / 2 - 0.8, 0, 1.2));
  for (const fz of [-0.7, -0.1, 0.5, 1.0]) {
    const fish = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), M.iron);
    fish.scale.set(1, 2.0, 0.5); fish.position.set(-W / 2 - 0.8, 1.5, fz);
    g.add(fish);
  }
  // a hung net (a thin translucent sheet)
  const net = box(0.04, 1.3, 1.8, M.sack, -W / 2 - 0.05, 0.5, -0.4);
  g.add(net);
  // an upturned rowboat on the bank + barrels of catch
  const boat = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), M.log);
  boat.scale.set(1, 0.5, 2.2); boat.rotation.z = Math.PI; boat.position.set(-1.6, 0.45, 2.6);
  boat.castShadow = true; g.add(boat);
  g.add(barrel(1.6, 2.6, 0.9));
  g.add(barrel(2.4, 2.5));
}

function buildBridge(g: THREE.Group): void {
  // a timber-and-stone crossing spanning the river. The long axis is local X;
  // placement auto-orients it across the stream (see input.ts). It rides on its
  // own stone piers (no terraced foundation).
  const L = 36, wHalf = 2.6, deckY = 1.9;
  // stone abutments + mid piers
  for (const pxr of [-1, -0.5, 0, 0.5, 1]) {
    const pier = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.15, deckY + 3.2, 8), M.stone);
    pier.position.set(pxr * L * 0.46, deckY - (deckY + 3.2) / 2, 0);
    pier.castShadow = true; pier.receiveShadow = true;
    g.add(pier);
  }
  // a gently cambered plank deck (built from segments so it can arch)
  const segs = 9;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const sx = (t - 0.5) * L;
    const camber = Math.sin(t * Math.PI) * 0.7;
    g.add(box(L / segs + 0.1, 0.3, wHalf * 2, M.log, sx, deckY + camber, 0));
  }
  // cross-plank treads
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    const sx = (t - 0.5) * (L - 2);
    const camber = Math.sin(t * Math.PI) * 0.7;
    g.add(box(0.5, 0.08, wHalf * 2 - 0.1, M.logDark, sx, deckY + camber + 0.18, 0));
  }
  // railings: posts + top rail along both edges
  for (const sz of [-1, 1] as const) {
    for (let i = 0; i < 11; i++) {
      const t = i / 10;
      const sx = (t - 0.5) * (L - 1.5);
      const camber = Math.sin(t * Math.PI) * 0.7;
      g.add(cylinder(0.1, 1.1, M.logDark, sx, deckY + camber + 0.15, sz * wHalf));
    }
    // top rail in cambered segments
    for (let i = 0; i < segs; i++) {
      const t = i / (segs - 1);
      const sx = (t - 0.5) * (L - 1.5);
      const camber = Math.sin(t * Math.PI) * 0.7;
      g.add(box(L / segs, 0.16, 0.16, M.log, sx, deckY + camber + 1.2, sz * wHalf));
    }
  }
}

// the upgraded crossing: same span, rebuilt in dressed stone — a solid arched
// deck on heavier piers with low stone parapets instead of timber railings.
function buildBridgeStone(g: THREE.Group): void {
  const L = 36, wHalf = 2.7, deckY = 1.9;
  // heavier stone piers
  for (const pxr of [-1, -0.5, 0, 0.5, 1]) {
    const pier = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.35, deckY + 3.2, 8), M.stoneDark);
    pier.position.set(pxr * L * 0.46, deckY - (deckY + 3.2) / 2, 0);
    pier.castShadow = true; pier.receiveShadow = true;
    g.add(pier);
  }
  // a cambered dressed-stone deck
  const segs = 9;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const sx = (t - 0.5) * L;
    const camber = Math.sin(t * Math.PI) * 0.7;
    g.add(box(L / segs + 0.1, 0.36, wHalf * 2, M.stone, sx, deckY + camber, 0));
  }
  // low solid parapets along both edges
  for (const sz of [-1, 1] as const) {
    for (let i = 0; i < segs; i++) {
      const t = i / (segs - 1);
      const sx = (t - 0.5) * (L - 1);
      const camber = Math.sin(t * Math.PI) * 0.7;
      g.add(box(L / segs, 0.7, 0.34, M.stone, sx, deckY + camber + 0.45, sz * (wHalf - 0.15)));
    }
  }
}

function buildStana(g: THREE.Group): void {
  // a mountain cattle dairy: a low log byre, a fenced paddock of grazing cattle,
  // a butter churn and rounds of cheese drying on a rack
  const W = 3.8, D = 3.2;
  g.add(box(W + 0.5, 0.35, D + 0.5, M.stone, -3.2, 0, -2.2));
  g.add(tag(box(W, 1.95, D, M.log, -3.2, 0.35, -2.2), 'wall'));
  g.add(tag(gableRoof(W, D, 1.35, M.thatch, -3.2, 2.3, -2.2, 0.5, 0.5), 'roof'));
  g.add(door(-3.2, 0.35, -2.2 + D / 2 + 0.02, M.logDark, M.shingle));
  g.add(chimney(M.stone, -3.2 - W / 2 + 0.6, 2.3, -2.2, 1.8, 0.5));
  // paddock fence — an open rectangle with a gateway gap at the front-left
  g.add(fenceRun(-0.6, 3.6, 5.2, 3.6, 6));
  g.add(fenceRun(5.2, 3.6, 5.2, -2.2, 5));
  g.add(fenceRun(5.2, -2.2, -0.6, -2.2, 5));
  g.add(fenceRun(-0.6, -2.2, -0.6, 1.4, 3));
  // grazing cattle
  g.add(cow(1.4, 2.4, 0.6, true));
  g.add(cow(3.3, 0.5, 2.3, true));
  g.add(cow(2.1, -0.9, 4.0, false));
  g.add(cow(4.0, 2.7, 1.2, true));
  // milking corner: stool + pail + churn
  g.add(box(0.4, 0.42, 0.4, M.logDark, -1.5, 0, 1.1));
  g.add(bucket(-1.1, 1.4));
  g.add(cylinder(0.3, 1.0, M.log, -1.9, 0, 0.1));
  g.add(cylinder(0.06, 0.95, M.logDark, -1.9, 1.0, 0.1)); // churn dasher
  // cheese rounds drying on a rack beside the hut
  g.add(box(0.12, 1.3, 0.12, M.logDark, -5.0, 0, -1.4));
  g.add(box(0.12, 1.3, 0.12, M.logDark, -5.0, 0, 0.3));
  g.add(box(0.12, 0.1, 1.9, M.log, -5.0, 1.2, -0.55));
  for (const cz of [-1.0, -0.45, 0.1]) {
    const round = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.16, 10), M.milk);
    round.position.set(-5.0, 0.92, cz); round.castShadow = true; g.add(round);
  }
  // a heap of hay for the winter byre
  g.add(box(1.3, 0.7, 0.95, M.hay, 0.4, 0, 3.1));
}

function buildSawmill(g: THREE.Group): void {
  // a water-powered sawmill (joagăr): log lodge, a waterwheel on the river side,
  // a circular saw on a bench, log piles and stacked planks
  const W = 4.6, D = 3.6, wallH = 2.3;
  g.add(box(W + 0.5, 0.4, D + 0.5, M.stone, 0, 0, 0));
  g.add(tag(box(W, wallH, D, M.log, 0, 0.4, 0), 'wall'));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
    g.add(cylinder(0.2, wallH + 0.4, M.logDark, (sx * W) / 2, 0.3, (sz * D) / 2));
  const eaves = 0.4 + wallH;
  g.add(tag(gableRoof(W, D, 1.6, M.shingle, 0, eaves, 0, 0.5, 0.5), 'roof'));
  g.add(door(0, 0.4, D / 2 + 0.02, M.logDark, M.shingle));
  // waterwheel (axis along z, turning on the building's -x side)
  const wheel = new THREE.Group();
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.16, 6, 18), M.logDark));
  for (let i = 0; i < 4; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.12), M.log); sp.rotation.z = (i / 4) * Math.PI; wheel.add(sp); }
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.5), M.logDark); p.position.set(Math.cos(a) * 1.3, Math.sin(a) * 1.3, 0); p.rotation.z = a; wheel.add(p); }
  wheel.position.set(-W / 2 - 0.5, 1.45, 1.0);
  wheel.traverse((o) => { o.castShadow = true; });
  g.add(wheel);
  // saw bench + blade outside
  g.add(sawhorse(2.4, 1.2, 0));
  const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.05, 16), M.iron);
  blade.rotation.x = Math.PI / 2; blade.position.set(2.4, 1.15, 1.2); blade.castShadow = true; g.add(blade);
  g.add(plankStack(2.7, -1.2, 0.2));
  g.add(woodpile(-2.6, -1.6, Math.PI / 2, 2.6));
  g.add(groundLitter(1.5, 0, 2.6, 16, M.log));
}

function buildStonecutter(g: THREE.Group): void {
  // a stonecutter's yard: an open timber-roofed shed, a cutting bench, dressed
  // blocks stacked ready, rubble and a sledge
  for (const [sx, sz] of [[-2.2, -1.7], [2.2, -1.7], [-2.2, 1.7], [2.2, 1.7]] as const)
    g.add(cylinder(0.17, 2.7, M.logDark, sx, 0, sz));
  g.add(tag(gableRoof(5.2, 4.2, 1.3, M.shingle, 0, 2.7, 0, 0.4, 0.3), 'roof'));
  // cutting bench with a half-dressed block on top
  g.add(box(2.2, 0.85, 1.0, M.stoneDark, 0, 0, -0.6));
  g.add(box(2.4, 0.14, 1.2, M.log, 0, 0.85, -0.6));
  g.add(box(0.9, 0.5, 0.7, M.stone, 0, 0.99, -0.6));
  // dressed blocks stacked, ready to haul
  g.add(box(0.9, 0.6, 0.7, M.stone, 2.0, 0, 1.4));
  g.add(box(0.9, 0.6, 0.7, M.stone, 2.0, 0.6, 1.4));
  g.add(box(0.85, 0.55, 0.65, M.stone, 1.1, 0, 1.6));
  g.add(handcart(-2.2, 1.4, 0.5));
  g.add(groundLitter(0, 0.4, 2.8, 22, M.stone));
}

export const DEFS: Record<string, BuildingDef> = {
  camp: {
    key: 'camp', name: 'Founders’ Hall', desc: 'The first hearth of the valley — the heart of the settlement. Drop off resources, shelter new settlers, and ward off wolves and bears nearby.',
    cost: {}, buildPoints: 1, popCap: 5, isDropoff: true, trains: true, radius: 8,
    defendRange: 28, defendDps: 7,
    model: { url: '/models/kaykit/barracks.gltf.glb', fitRadius: 8 },
    build: buildCamp,
  },
  hut: {
    key: 'hut', name: 'Hut', desc: 'A shepherd’s log hut. Houses 3 settlers.',
    cost: { wood: 40 }, buildPoints: 30, popCap: 3, isDropoff: false, trains: false, radius: 4,
    model: { url: '/models/kaykit/house.gltf.glb', fitRadius: 4 },
    build: buildHut,
  },
  sheepfold: {
    key: 'sheepfold', name: 'Stână (Sheepfold)', desc: 'A Carpathian shepherds’ sheepfold — mountain sheep milked and shorn for cheese, wool and mutton. A steady trickle of food.',
    cost: { wood: 45, stone: 15 }, buildPoints: 40, popCap: 0, isDropoff: false, trains: false, radius: 6.5,
    requires: ['hut', 'lumbercamp'],
    foodTrickle: 0.55, jobSlots: 1,
    model: { url: '/models/kaykit/farm_plot.gltf.glb', fitRadius: 6.5 },
    build: buildSheepfold,
  },
  lumbercamp: {
    key: 'lumbercamp', name: 'Lumber Camp',
    desc: 'A sawpit in the woods. Its woodcutters fell nearby trees and stack the timber. Place it among the forest.',
    cost: { wood: 30 }, buildPoints: 28, popCap: 0, isDropoff: true, trains: false, radius: 5,
    boosts: 'wood', boostRange: 42, jobSlots: 3,
    model: { url: '/models/kaykit/lumbermill.gltf.glb', fitRadius: 5 },
    build: buildLumberCamp,
  },
  quarry: {
    key: 'quarry', name: 'Quarry',
    desc: 'Worked rock face. Its masons cut nearby stone. Place it by an outcrop.',
    cost: { wood: 50 }, buildPoints: 36, popCap: 0, isDropoff: true, trains: false, radius: 5.5,
    requires: ['hut', 'lumbercamp'],
    boosts: 'stone', boostRange: 42, jobSlots: 3,
    model: { url: '/models/kaykit/mine.gltf.glb', fitRadius: 5.5 },
    build: buildQuarry,
  },
  forager: {
    key: 'forager', name: 'Forager’s Hut',
    desc: 'Berry-pickers’ camp. Its foragers gather berries from nearby thickets.',
    cost: { wood: 30 }, buildPoints: 26, popCap: 0, isDropoff: true, trains: false, radius: 4.5,
    requires: ['hut', 'lumbercamp'],
    boosts: 'food', boostRange: 40, jobSlots: 2,
    model: { url: '/models/kaykit/well.gltf.glb', fitRadius: 4.5 },
    build: buildForager,
  },
  hunters: {
    key: 'hunters', name: 'Hunter’s Lodge',
    desc: 'Trappers and marksmen. Brings in game meat, and shoots wolves and bears that stray within range.',
    cost: { wood: 55, stone: 25 }, buildPoints: 50, popCap: 0, isDropoff: false, trains: false, radius: 5,
    requires: ['hut', 'lumbercamp'],
    foodTrickle: 0.4, defendRange: 50, defendDps: 17, jobSlots: 1,
    model: { url: '/models/kaykit/archeryrange.gltf.glb', fitRadius: 5 },
    build: buildHunters,
  },
  fishery: {
    key: 'fishery', name: 'Fisherman’s Hut',
    desc: 'A stilted hut and jetty on the Prahova. A steady catch of fish feeds the settlement. Build it at the water’s edge.',
    cost: { wood: 40, stone: 20 }, buildPoints: 38, popCap: 0, isDropoff: false, trains: false, radius: 4.5,
    requires: ['hut', 'lumbercamp'],
    needsWater: true,
    foodTrickle: 0.7, jobSlots: 1,
    model: { url: '/models/kaykit/mill.gltf.glb', fitRadius: 4.5 },
    build: buildFishery,
  },
  stana: {
    key: 'stana', name: 'Cattle Dairy',
    desc: 'A mountain byre and paddock. Cattle graze and are milked for butter and cheese — a strong, steady supply of food. Best on open meadow.',
    cost: { wood: 50, stone: 30 }, buildPoints: 44, popCap: 0, isDropoff: false, trains: false, radius: 7,
    requires: ['hut', 'lumbercamp'],
    foodTrickle: 0.85, jobSlots: 2,
    build: buildStana,
  },
  sawmill: {
    key: 'sawmill', name: 'Sawmill',
    desc: 'A water-powered joagăr. Steadily saws stockpiled timber into planks — needed for finer buildings.',
    cost: { wood: 50, stone: 30 }, buildPoints: 46, popCap: 0, isDropoff: false, trains: false, radius: 5,
    requires: ['hut', 'lumbercamp'],
    produces: { input: { wood: 2 }, output: { planks: 1 }, interval: 2.5 }, jobSlots: 2,
    model: { url: '/models/kaykit/watermill.gltf.glb', fitRadius: 5 },
    build: buildSawmill,
  },
  stonecutter: {
    key: 'stonecutter', name: 'Stonecutter’s Yard',
    desc: 'Masons dress rough stone into building blocks — needed for the monastery and grand houses.',
    cost: { wood: 55, stone: 35 }, buildPoints: 50, popCap: 0, isDropoff: false, trains: false, radius: 5,
    requires: ['quarry'],
    produces: { input: { stone: 2 }, output: { block: 1 }, interval: 3 }, jobSlots: 2,
    model: { url: '/models/kaykit/market.gltf.glb', fitRadius: 5 },
    build: buildStonecutter,
  },
  bridge: {
    key: 'bridge', name: 'Bridge',
    desc: 'A timber crossing over the Prahova, linking the two banks. Place it across the river.',
    cost: { wood: 60, planks: 10 }, buildPoints: 60, popCap: 0, isDropoff: false, trains: false, radius: 4,
    requires: ['hut', 'lumbercamp'],
    noFoundation: true,
    model: { url: '/models/kaykit/bridge.gltf.glb', fitRadius: 6 },
    build: buildBridge,
  },
  // upgrade-only (not in the build toolbar): the cost is the price to rebuild a
  // finished timber Bridge in dressed stone, charged by the panel's upgrade button.
  bridge_stone: {
    key: 'bridge_stone', name: 'Stone Bridge',
    desc: 'A permanent dressed-stone crossing of the Prahova.',
    cost: { stone: 60, block: 20 }, buildPoints: 60, popCap: 0, isDropoff: false, trains: false, radius: 4,
    noFoundation: true,
    build: buildBridgeStone,
  },
  monastery: {
    key: 'monastery', name: 'Sinaia Monastery', desc: 'Mihail Cantacuzino’s vow — the seed from which a town will grow. Pilgrims’ offerings fill the treasury.',
    cost: { wood: 260, stone: 200, planks: 60, block: 45 }, buildPoints: 420, popCap: 5, isDropoff: true, trains: true, radius: 19,
    coinTrickle: 0.5,
    // placeholder: the KayKit castle stands in for the monastery until a proper
    // church/monastery hero model is authored (see R5 follow-up)
    model: { url: '/models/kaykit/castle.gltf.glb', fitRadius: 16 },
    build: buildMonastery,
  },
  oldinn: {
    key: 'oldinn', name: 'Pilgrims’ Inn', desc: 'Lodging for travelers crossing the Predeal pass — their tolls swell the treasury. Its fine carpentry calls for sawn planks.',
    cost: { wood: 100, stone: 50, planks: 24, block: 12, coin: 60 }, buildPoints: 120, popCap: 4, isDropoff: false, trains: false, radius: 7,
    coinTrickle: 0.7,
    model: { url: '/models/kaykit/market.gltf.glb', fitRadius: 7 },
    build: buildInn,
  },
};

let nextId = 1;

export class Building {
  id = nextId++;
  def: BuildingDef;
  x: number; z: number;
  phase: BuildingPhase;
  progress = 0;
  group = new THREE.Group();
  structure = new THREE.Group();
  siteMarker: THREE.Group | null = null;
  foundationDone = false; // terrain under the footprint has been flattened
  trainQueue: number[] = []; // remaining seconds per queued villager
  foodAccum = 0;
  coinAccum = 0;
  prodAccum = 0;
  producing = false; // a refining building actively converting (vs waiting on inputs)
  workers: Villager[] = []; // villagers assigned to this workplace
  desired = 0; // how many workers the player wants here (auto-assignment target)
  plotKey: string | null = null;
  private heroModel: THREE.Group | null = null; // authored glTF, once loaded

  constructor(defKey: string, x: number, z: number, phase: BuildingPhase, scene: THREE.Scene, rotY = 0) {
    this.def = DEFS[defKey];
    this.desired = this.def.jobSlots ?? 0; // new job buildings request a full crew by default
    this.x = x; this.z = z;
    this.phase = phase;
    // sit on the rendered mesh surface, not the full-res DEM, so buildings don't
    // float on bumps or sink into dips (same fix as villagers — see surfaceHeight)
    this.group.position.set(x, surfaceHeight(x, z), z);
    this.group.rotation.y = rotY;
    this.def.build(this.structure);
    this.applyEraStyle(G.eraIndex); // skin walls/roof to the current age
    this.group.add(this.structure);
    this.group.userData.building = this;
    this.structure.traverse((o) => { o.userData.building = this; });
    scene.add(this.group);
    G.buildings.push(this);

    if (phase === 'done') {
      this.addFoundation();
      this.finish(true);
    } else {
      this.structure.visible = false;
      this.makeSiteMarker(phase);
      if (phase === 'site') this.addFoundation();
    }
    if (this.def.model) this.loadHeroModel();
  }

  // load the authored glTF and swap it in for the procedural mesh; on any
  // failure (missing file, bad model) the procedural fallback simply stays
  private loadHeroModel(): void {
    const m = this.def.model!;
    loadModel(m.url).then((g) => {
      const fitted = fitModel(g, { fitRadius: m.fitRadius ?? this.def.radius, scale: m.scale, rotationY: m.rotationY, yOffset: m.yOffset });
      fitted.position.y = this.structure.position.y; // sit on the same terrace lift
      fitted.traverse((o) => { o.userData.building = this; });
      this.heroModel = fitted;
      this.group.add(fitted);
      const show = this.phase === 'done';
      fitted.visible = show;
      if (show) this.structure.visible = false;
    }).catch(() => { /* keep the procedural building */ });
  }

  // Flatten the rendered terrain under the footprint (see flattenUnder) so the
  // building sits on level ground — instead of bolting a stone-drum terrace on
  // top of the slope. Then re-seat the building on the now-flattened surface.
  private addFoundation(): void {
    if (this.foundationDone || this.def.noFoundation) return;
    this.foundationDone = true;
    // The flat zone must clear the footprint by ~a full terrain cell (~16 m), or
    // the coarse mesh leaves the footprint's outer cells on the slope and the
    // building sits half-buried / half-floating. radius + 16 levels it cleanly
    // regardless of where it lands on the grid (blends out smoothly to ~1.9×).
    const flatR = this.def.flatRadius ?? Math.max(this.def.radius + 16, 18);
    const reach = flatR * 1.9 + 1;
    flattenUnder(this.x, this.z, flatR);
    // trees/rocks/berries near the footprint had their height baked in before
    // the reshape — drop them back onto the new surface so nothing floats
    reseatNodesNear(this.x, this.z, reach);
    // the ground is now level at ~the centre height; sit the building on it with
    // no extra lift (the old terrace lift is no longer needed)
    this.group.position.y = surfaceHeight(this.x, this.z);
    this.structure.position.y = 0;
    if (this.heroModel) this.heroModel.position.y = 0;
    // Merging terraces to a shared level moved the mesh under overlapping
    // neighbours (and possibly shifted their level), but each building is seated
    // only once at its own placement — so re-seat every building onto the current
    // mesh. Far ones are unaffected (their surface height is unchanged); the few
    // sharing this terrace settle onto it flush instead of buried or floating.
    for (const b of G.buildings) {
      if (b === this || b.def.noFoundation) continue;
      b.group.position.y = surfaceHeight(b.x, b.z);
    }
  }

  private makeSiteMarker(phase: BuildingPhase): void {
    const g = new THREE.Group();
    const r = this.def.radius;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.3, 20), M.dirt);
    pad.position.y = 0.15;
    pad.receiveShadow = true;
    g.add(pad);
    if (phase === 'planned') {
      // a carved waymark stone with a signpost
      g.add(box(1.2, 1.4, 1.2, M.stone, 0, 0.2, 0));
      const post = cylinder(0.12, 2.6, M.logDark, 0.9, 0.2, 0);
      g.add(post);
      g.add(box(2.2, 0.7, 0.12, M.log, 0.9, 2.2, 0));
    } else {
      // scaffolding corners
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        g.add(cylinder(0.15, 3.5, M.logDark, sx * r * 0.7, 0, sz * r * 0.7));
        g.add(box(r * 0.5, 0.15, 0.15, M.log, sx * r * 0.45, 3.3, sz * r * 0.7));
      }
    }
    g.traverse((o) => { o.userData.building = this; });
    this.group.add(g);
    this.siteMarker = g;
  }

  // a 'planned' landmark begins construction (resources already paid by caller)
  startConstruction(): void {
    if (this.phase !== 'planned') return;
    this.phase = 'site';
    if (this.siteMarker) this.group.remove(this.siteMarker);
    this.makeSiteMarker('site');
    this.addFoundation();
    this.structure.visible = true;
    this.updateRise();
  }

  addWork(points: number): boolean {
    if (this.phase !== 'site') return false;
    this.progress += points;
    this.updateRise();
    if (this.progress >= this.def.buildPoints) {
      this.finish(false);
      return true;
    }
    return false;
  }

  private updateRise(): void {
    const t = Math.min(1, this.progress / this.def.buildPoints);
    this.structure.scale.y = 0.05 + 0.95 * t;
    this.structure.visible = true;
  }

  // restore a partially-built site (used by load)
  restoreProgress(p: number): void {
    if (this.phase !== 'site') return;
    this.progress = Math.max(0, Math.min(p, this.def.buildPoints - 1));
    this.updateRise();
  }

  // ---- worker assignment (workplaces with jobSlots) ----
  // how many assigned workers have actually arrived and are working
  presentWorkers(): number {
    let n = 0;
    for (const v of this.workers) if (v.alive && v.isWorkingAt(this)) n++;
    return Math.min(n, this.def.jobSlots ?? 0);
  }

  // how many are assigned (en route or present); also prunes stale entries
  assignedWorkers(): number {
    this.workers = this.workers.filter((w) => w.alive && w.workplace === this);
    return this.workers.length;
  }

  // claim a job slot for v; false if this isn't a workplace or it's at its desired count
  assignWorker(v: Villager): boolean {
    if (!this.def.jobSlots || this.phase !== 'done') return false;
    this.workers = this.workers.filter((w) => w.alive && w.workplace === this);
    if (this.workers.includes(v)) return true;
    if (this.workers.length >= this.desired) return false;
    this.workers.push(v);
    return true;
  }

  removeWorker(v: Villager): void {
    const i = this.workers.indexOf(v);
    if (i >= 0) this.workers.splice(i, 1);
  }

  // unfilled positions = desired minus already assigned (auto-assignment target)
  openPositions(): number {
    if (!this.def.jobSlots) return 0;
    return Math.max(0, this.desired - this.assignedWorkers());
  }

  // raise/lower the desired worker count; releases extras if lowered
  setDesired(n: number): void {
    this.desired = Math.max(0, Math.min(this.def.jobSlots ?? 0, n));
    while (this.assignedWorkers() > this.desired && this.workers.length > 0) {
      this.workers[this.workers.length - 1].unassign();
    }
  }

  // how many villagers are currently building this site (auto-staffing cap)
  builderCount(): number {
    let n = 0;
    for (const v of G.villagers) if (v.isBuildingAt(this)) n++;
    return n;
  }

  // recall every worker to idle (frees the slots)
  recallWorkers(): void {
    for (const v of this.workers.slice()) v.unassign();
    this.workers.length = 0;
  }

  private finish(instant: boolean): void {
    this.phase = 'done';
    this.progress = this.def.buildPoints;
    this.structure.visible = true;
    this.structure.scale.y = 1;
    if (this.siteMarker) { this.group.remove(this.siteMarker); this.siteMarker = null; }
    // if the authored hero model is loaded, reveal it in place of the procedural mesh
    if (this.heroModel) {
      this.heroModel.position.y = this.structure.position.y;
      this.heroModel.visible = true;
      this.structure.visible = false;
    }
    G.popCap += this.def.popCap;
    if (!instant && onBuildingComplete) onBuildingComplete(this);
  }

  update(dt: number, spawnVillager: (x: number, z: number) => void): void {
    if (this.phase !== 'done') return;
    // a job building only works with assigned workers present; output scales with
    // how many are there. Buildings without jobSlots produce automatically.
    const workforce = this.def.jobSlots ? this.presentWorkers() : 1;
    if (this.def.foodTrickle && workforce > 0) {
      this.foodAccum += this.def.foodTrickle * dt * workforce;
      if (this.foodAccum >= 1) {
        const whole = Math.floor(this.foodAccum);
        this.foodAccum -= whole;
        G.resources.food += whole;
      }
    }
    if (this.def.coinTrickle) {
      this.coinAccum += this.def.coinTrickle * dt;
      if (this.coinAccum >= 1) {
        const whole = Math.floor(this.coinAccum);
        this.coinAccum -= whole;
        G.resources.coin += whole;
      }
    }
    // refining: turn raw resources into finished goods on a timer, if the inputs
    // are in the stockpile (a production chain — e.g. wood -> planks)
    const pr = this.def.produces;
    if (pr && workforce > 0) {
      this.prodAccum += dt * workforce;
      if (this.prodAccum >= pr.interval) {
        if (canAfford(pr.input)) {
          this.prodAccum -= pr.interval;
          pay(pr.input);
          for (const k of RES_KINDS) if (pr.output[k]) G.resources[k] += pr.output[k]!;
          this.producing = true;
        } else {
          this.prodAccum = pr.interval; // idle, waiting on inputs
          this.producing = false;
        }
      }
    } else if (pr) {
      this.producing = false; // no workers
    }
    if (this.trainQueue.length > 0) {
      this.trainQueue[0] -= dt;
      if (this.trainQueue[0] <= 0) {
        this.trainQueue.shift();
        spawnVillager(this.x + this.def.radius + 2, this.z + this.def.radius * 0.6);
      }
    }
  }

  // re-skin generic dwellings to a given era's style. Bespoke landmarks and the
  // starting camp keep their hand-built materials.
  applyEraStyle(eraIndex: number): void {
    if (this.plotKey || this.def.key === 'camp') return;
    const st = eraStyle(eraIndex);
    this.structure.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      const role = o.userData.role as 'wall' | 'roof' | undefined;
      if (role === 'wall') (o as THREE.Mesh).material = st.wall;
      else if (role === 'roof') (o as THREE.Mesh).material = st.roof;
    });
  }

  queueVillager(): string | null {
    if (G.villagers.length + this.trainQueue.length >= G.popCap) return 'Population limit reached — build more huts.';
    if (!canAfford({ food: 50 })) return 'Not enough food (50 needed).';
    pay({ food: 50 });
    this.trainQueue.push(14);
    return null;
  }

  // can this building be torn down? the starting camp is permanent.
  get demolishable(): boolean {
    return this.def.key !== 'camp' && this.phase !== 'planned';
  }

  // tear the building down: refund part of its cost, free its workers, and — if
  // it's a landmark — leave its planned waymark so the site can be rebuilt.
  // giveRefund=false skips the refund (used when one building replaces another,
  // e.g. upgrading a timber bridge to stone — the upgrade is paid separately).
  demolish(giveRefund = true): Partial<Record<ResKind, number>> {
    const scene = this.group.parent as THREE.Scene | null;
    for (const v of G.villagers) v.releaseFrom(this);
    if (this.phase === 'done') G.popCap -= this.def.popCap;

    const refund: Partial<Record<ResKind, number>> = {};
    const rate = this.phase === 'done' ? 0.5 : 0.75; // get more back from an unfinished site
    if (giveRefund) for (const k of RES_KINDS) {
      const amt = Math.floor((this.def.cost[k] ?? 0) * rate);
      if (amt > 0) { G.resources[k] += amt; refund[k] = amt; }
    }

    this.group.removeFromParent();
    const idx = G.buildings.indexOf(this);
    if (idx >= 0) G.buildings.splice(idx, 1);

    if (this.plotKey && scene) {
      const sign = new Building(this.def.key, this.x, this.z, 'planned', scene);
      sign.plotKey = this.plotKey;
    }
    return refund;
  }
}

export let onBuildingComplete: ((b: Building) => void) | null = null;
export function setOnBuildingComplete(fn: (b: Building) => void): void {
  onBuildingComplete = fn;
}

// gather-rate multiplier at (x,z) for a node of `kind` — 1 unless a completed
// gather camp that boosts this kind is within its range
export function gatherBonusAt(x: number, z: number, kind: GatherKind): number {
  for (const b of G.buildings) {
    if (b.phase !== 'done' || b.def.boosts !== kind) continue;
    const range = b.def.boostRange ?? 40;
    if ((b.x - x) ** 2 + (b.z - z) ** 2 < range * range) return GATHER_BONUS;
  }
  return 1;
}

// re-skin every evolving building to the current era (call on era advance)
export function reskinAllBuildings(): void {
  for (const b of G.buildings) b.applyEraStyle(G.eraIndex);
}

export function nearestDropoff(x: number, z: number): Building | null {
  let best: Building | null = null;
  let bd = Infinity;
  for (const b of G.buildings) {
    if (b.phase !== 'done' || !b.def.isDropoff) continue;
    const d = (b.x - x) ** 2 + (b.z - z) ** 2;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
