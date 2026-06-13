import * as THREE from 'three';
import { surfaceHeight } from './terrain';
import { G, ResKind, RES_KINDS, GatherKind, pay, canAfford } from './state';
import { woodMaterial, stoneMaterial, thatchMaterial, tileMaterial, plasterMaterial, earthMaterial, brickMaterial } from './materials';

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
  boosts?: GatherKind;  // speeds up gathering of this kind within boostRange
  boostRange?: number;  // metres
  build: (g: THREE.Group) => void;
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
  log: woodMaterial(0x7a5b3a, 11),
  logDark: woodMaterial(0x5e4429, 12),
  thatch: thatchMaterial(0xb09455),
  shingle: tileMaterial(0x6b4f3a, 44),      // wooden shingles
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
};

ERA_STYLES = [
  { wall: M.log, roof: M.thatch },        // 1690–1865 — log & thatch
  { wall: M.whitewash, roof: M.roofRed },  // 1866–1918 — plastered & tiled
  { wall: M.brick, roof: M.roofGray },     // interbellic — brick & slate
];

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
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
}

function buildCamp(g: THREE.Group): void {
  // a woodsmen's camp: log cabin, log pile, fire
  g.add(box(5.0, 0.4, 3.6, M.stone, -1.5, 0, 0));
  g.add(box(4.6, 2.0, 3.2, M.log, -1.5, 0.4, 0));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    g.add(cylinder(0.2, 2.35, M.logDark, -1.5 + sx * 2.3, 0.3, sz * 1.6));
  }
  g.add(gableRoof(4.6, 3.2, 1.5, M.shingle, -1.5, 2.4, 0, 0.45, 0.45));
  g.add(door(-1.5, 0.4, 1.62, M.logDark, M.shingle));
  const logGeo = new THREE.CylinderGeometry(0.35, 0.35, 3, 6);
  for (let i = 0; i < 3; i++) {
    const l = new THREE.Mesh(logGeo, M.logDark);
    l.rotation.z = Math.PI / 2;
    l.position.set(2.6, 0.35 + i * 0.45, 1.4 - i * 0.1);
    l.castShadow = true;
    g.add(l);
  }
  g.add(cylinder(0.5, 0.5, M.fire, 2.4, 0, -1.6));
  g.add(box(3, 0.25, 3, M.dirt, 2.4, -0.05, -1.6));
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
  // saw trestle
  g.add(box(2.6, 0.2, 0.5, M.log, 0.4, 0.8, -1));
  g.add(box(0.18, 0.8, 0.5, M.logDark, -0.6, 0, -1));
  g.add(box(0.18, 0.8, 0.5, M.logDark, 1.4, 0, -1));
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
}

export const DEFS: Record<string, BuildingDef> = {
  camp: {
    key: 'camp', name: 'Woodsmen’s Camp', desc: 'The first hearth of the valley. Drop off resources and shelter new settlers.',
    cost: {}, buildPoints: 1, popCap: 5, isDropoff: true, trains: true, radius: 6, build: buildCamp,
  },
  hut: {
    key: 'hut', name: 'Hut', desc: 'A shepherd’s log hut. Houses 3 settlers.',
    cost: { wood: 40 }, buildPoints: 30, popCap: 3, isDropoff: false, trains: false, radius: 4, build: buildHut,
  },
  sheepfold: {
    key: 'sheepfold', name: 'Sheepfold', desc: 'Mountain sheep — a steady trickle of food.',
    cost: { wood: 50 }, buildPoints: 40, popCap: 0, isDropoff: false, trains: false, radius: 6.5,
    foodTrickle: 0.55, build: buildSheepfold,
  },
  lumbercamp: {
    key: 'lumbercamp', name: 'Lumber Camp',
    desc: 'A sawpit in the woods. Drop off timber here, and nearby felling goes faster.',
    cost: { wood: 30 }, buildPoints: 28, popCap: 0, isDropoff: true, trains: false, radius: 5,
    boosts: 'wood', boostRange: 42, build: buildLumberCamp,
  },
  quarry: {
    key: 'quarry', name: 'Quarry',
    desc: 'Worked rock face. Drop off stone here, and nearby cutting goes faster. Place it by an outcrop.',
    cost: { wood: 45 }, buildPoints: 36, popCap: 0, isDropoff: true, trains: false, radius: 5.5,
    boosts: 'stone', boostRange: 42, build: buildQuarry,
  },
  forager: {
    key: 'forager', name: 'Forager’s Hut',
    desc: 'Berry-pickers’ camp. Drop off food here, and nearby foraging goes faster.',
    cost: { wood: 30 }, buildPoints: 26, popCap: 0, isDropoff: true, trains: false, radius: 4.5,
    boosts: 'food', boostRange: 40, build: buildForager,
  },
  monastery: {
    key: 'monastery', name: 'Sinaia Monastery', desc: 'Mihail Cantacuzino’s vow — the seed from which a town will grow. Pilgrims’ offerings fill the treasury.',
    cost: { wood: 220, stone: 160 }, buildPoints: 320, popCap: 5, isDropoff: true, trains: true, radius: 19,
    coinTrickle: 0.5, build: buildMonastery,
  },
  oldinn: {
    key: 'oldinn', name: 'Pilgrims’ Inn', desc: 'Lodging for travelers crossing the Predeal pass — their tolls swell the treasury.',
    cost: { wood: 120, stone: 40, coin: 60 }, buildPoints: 120, popCap: 4, isDropoff: false, trains: false, radius: 7,
    coinTrickle: 0.7, build: buildInn,
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
  foundation: THREE.Group | null = null;
  trainQueue: number[] = []; // remaining seconds per queued villager
  foodAccum = 0;
  coinAccum = 0;
  plotKey: string | null = null;

  constructor(defKey: string, x: number, z: number, phase: BuildingPhase, scene: THREE.Scene, rotY = 0) {
    this.def = DEFS[defKey];
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
  }

  // terrace the ground under the footprint: a flat earthen cap with a stone
  // retaining skirt that drops into the slope, so a building sits level on a
  // hillside instead of floating or sinking. Cheap, and leaves the real terrain
  // (and villager pathing height) untouched.
  private addFoundation(): void {
    if (this.foundation) return;
    const baseY = this.group.position.y;
    const padR = this.def.radius + 1.2;
    // how far the downhill side drops below the building base (on the visible mesh)
    let lowest = 0;
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const sx = this.x + Math.cos(ang) * padR, sz = this.z + Math.sin(ang) * padR;
      lowest = Math.min(lowest, surfaceHeight(sx, sz) - baseY);
    }
    const top = 0.3;
    const bottom = Math.max(-18, Math.min(-0.8, lowest - 1.2));
    const h = top - bottom;
    const g = new THREE.Group();
    // battered stone retaining wall (a touch wider at the base)
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(padR, padR * 1.06, h, 28), M.stone);
    skirt.position.y = bottom + h / 2;
    skirt.castShadow = true;
    skirt.receiveShadow = true;
    g.add(skirt);
    // a darker course capping the wall, then the flattened grass platform
    const course = new THREE.Mesh(new THREE.CylinderGeometry(padR + 0.15, padR + 0.15, 0.35, 28), M.stoneDark);
    course.position.y = top - 0.25;
    course.receiveShadow = true;
    g.add(course);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(padR - 0.2, padR + 0.1, 0.5, 28), M.grass);
    cap.position.y = top - 0.05;
    cap.receiveShadow = true;
    g.add(cap);
    g.traverse((o) => { o.userData.building = this; });
    this.foundation = g;
    this.group.add(g);
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

  private finish(instant: boolean): void {
    this.phase = 'done';
    this.progress = this.def.buildPoints;
    this.structure.visible = true;
    this.structure.scale.y = 1;
    if (this.siteMarker) { this.group.remove(this.siteMarker); this.siteMarker = null; }
    G.popCap += this.def.popCap;
    if (!instant && onBuildingComplete) onBuildingComplete(this);
  }

  update(dt: number, spawnVillager: (x: number, z: number) => void): void {
    if (this.phase !== 'done') return;
    if (this.def.foodTrickle) {
      this.foodAccum += this.def.foodTrickle * dt;
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
  demolish(): Partial<Record<ResKind, number>> {
    const scene = this.group.parent as THREE.Scene | null;
    for (const v of G.villagers) v.releaseFrom(this);
    if (this.phase === 'done') G.popCap -= this.def.popCap;

    const refund: Partial<Record<ResKind, number>> = {};
    const rate = this.phase === 'done' ? 0.5 : 0.75; // get more back from an unfinished site
    for (const k of RES_KINDS) {
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
