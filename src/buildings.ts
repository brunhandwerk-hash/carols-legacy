import * as THREE from 'three';
import { terrainHeight } from './terrain';
import { G, ResKind, pay, canAfford } from './state';

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
  build: (g: THREE.Group) => void;
}

// ---- shared materials ----
const M = {
  log: new THREE.MeshLambertMaterial({ color: 0x7a5b3a }),
  logDark: new THREE.MeshLambertMaterial({ color: 0x5e4429 }),
  thatch: new THREE.MeshLambertMaterial({ color: 0xb09455 }),
  shingle: new THREE.MeshLambertMaterial({ color: 0x6b4f3a }),
  whitewash: new THREE.MeshLambertMaterial({ color: 0xf2ecdd }),
  roofRed: new THREE.MeshLambertMaterial({ color: 0x9c4a38 }),
  roofGray: new THREE.MeshLambertMaterial({ color: 0x707a82 }),
  stone: new THREE.MeshLambertMaterial({ color: 0x9a958c }),
  gold: new THREE.MeshLambertMaterial({ color: 0xd4a843 }),
  dirt: new THREE.MeshLambertMaterial({ color: 0x8a6f4d }),
  fire: new THREE.MeshBasicMaterial({ color: 0xe8853a }),
};

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

function cross(x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.18, 1.6, 0.18, M.gold, 0, 0, 0));
  g.add(box(0.9, 0.18, 0.18, M.gold, 0, 1.0, 0));
  g.position.set(x, y, z);
  return g;
}

// ---- building constructors (all sized in world units) ----
function buildHut(g: THREE.Group): void {
  g.add(box(4.2, 2.6, 3.4, M.log));
  g.add(pyramid(3.6, 2.2, M.thatch, 0, 2.6, 0));
  g.add(box(0.9, 1.5, 0.2, M.logDark, 0, 0, 1.71));
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
  g.add(box(2.6, 1.8, 2.2, M.log, 0, 0, -3.2));
  g.add(pyramid(2.2, 1.4, M.thatch, 0, 1.8, -3.2));
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
  // a woodsmen's camp: lean-to, log pile, fire
  g.add(box(4.6, 2.2, 3.2, M.log, -1.5, 0, 0));
  g.add(pyramid(3.4, 1.8, M.thatch, -1.5, 2.2, 0));
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

function buildInn(g: THREE.Group): void {
  g.add(box(8, 3, 5.5, M.whitewash));
  g.add(box(8.6, 0.3, 6.1, M.log, 0, 3, 0));
  g.add(box(7.4, 2.4, 5, M.log, 0, 3.3, 0));
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 4.4, 2.6, 4), M.shingle);
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(1.35, 1, 0.9);
  roof.position.y = 7;
  roof.castShadow = true;
  g.add(roof);
  g.add(box(1.1, 1.8, 0.2, M.logDark, 0, 0, 2.81));
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
  monastery: {
    key: 'monastery', name: 'Sinaia Monastery', desc: 'Mihail Cantacuzino’s vow — the seed from which a town will grow.',
    cost: { wood: 220, stone: 160 }, buildPoints: 320, popCap: 5, isDropoff: true, trains: true, radius: 19, build: buildMonastery,
  },
  oldinn: {
    key: 'oldinn', name: 'Pilgrims’ Inn', desc: 'Lodging for travelers crossing the Predeal pass.',
    cost: { wood: 120, stone: 40 }, buildPoints: 120, popCap: 4, isDropoff: false, trains: false, radius: 7, build: buildInn,
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
  trainQueue: number[] = []; // remaining seconds per queued villager
  foodAccum = 0;
  plotKey: string | null = null;

  constructor(defKey: string, x: number, z: number, phase: BuildingPhase, scene: THREE.Scene, rotY = 0) {
    this.def = DEFS[defKey];
    this.x = x; this.z = z;
    this.phase = phase;
    this.group.position.set(x, terrainHeight(x, z), z);
    this.group.rotation.y = rotY;
    this.def.build(this.structure);
    this.group.add(this.structure);
    this.group.userData.building = this;
    this.structure.traverse((o) => { o.userData.building = this; });
    scene.add(this.group);
    G.buildings.push(this);

    if (phase === 'done') {
      this.finish(true);
    } else {
      this.structure.visible = false;
      this.makeSiteMarker(phase);
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
    if (this.trainQueue.length > 0) {
      this.trainQueue[0] -= dt;
      if (this.trainQueue[0] <= 0) {
        this.trainQueue.shift();
        spawnVillager(this.x + this.def.radius + 2, this.z + this.def.radius * 0.6);
      }
    }
  }

  queueVillager(): string | null {
    if (G.villagers.length + this.trainQueue.length >= G.popCap) return 'Population limit reached — build more huts.';
    if (!canAfford({ food: 50 })) return 'Not enough food (50 needed).';
    pay({ food: 50 });
    this.trainQueue.push(14);
    return null;
  }
}

export let onBuildingComplete: ((b: Building) => void) | null = null;
export function setOnBuildingComplete(fn: (b: Building) => void): void {
  onBuildingComplete = fn;
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
