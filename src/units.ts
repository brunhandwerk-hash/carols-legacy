import * as THREE from 'three';
import { terrainHeight, surfaceHeight, walkable } from './terrain';
import { G, ResourceNode } from './state';
import { Building, nearestDropoff, gatherBonusAt } from './buildings';
import { hideNode } from './world';
import type { Bear } from './wildlife';

type Task =
  | { kind: 'idle' }
  | { kind: 'move'; x: number; z: number }
  | { kind: 'gather'; node: ResourceNode; sub: 'go' | 'work' | 'return' }
  | { kind: 'build'; building: Building; sub: 'go' | 'work' }
  | { kind: 'shelter'; building: Building; sub: 'go' | 'in' }
  | { kind: 'fight'; bear: Bear; sub: 'go' | 'work' };

const REFUGE_RANGE = 70; // a threatened villager runs to a building this close
const SHELTER_SAFE = 48;  // emerges once no bear has been this near for a moment

const cloth = (color: number, rough = 0.86): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
const metal = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.7 });
const toolWood = cloth(0x6e5238, 0.8);

const skinMats = [0xd9b08c, 0xc69464, 0xe3bd97].map((c) => cloth(c, 0.7));
const ringMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
const carryMats: Record<string, THREE.MeshStandardMaterial> = {
  wood: cloth(0x6e5238), stone: cloth(0x9a958c, 0.95), food: cloth(0xc2773a),
};

// a held/worn tool, built once and cloned per villager
function axeTool(): THREE.Group {
  const g = new THREE.Group();
  const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6), toolWood);
  haft.position.set(0.82, 1.05, 0.25); haft.rotation.z = 0.35;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.5), metal);
  head.position.set(1.02, 1.62, 0.25);
  g.add(haft, head);
  return g;
}
function malletTool(): THREE.Group {
  const g = new THREE.Group();
  const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 6), toolWood);
  haft.position.set(0.82, 0.9, 0.25); haft.rotation.z = 0.3;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.3), cloth(0x7a5b3a, 0.8));
  head.position.set(0.98, 1.4, 0.25);
  g.add(haft, head);
  return g;
}
function basketTool(): THREE.Group {
  const g = new THREE.Group();
  const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.32, 0.55, 8), cloth(0x7a5a32, 0.9));
  basket.position.set(0, 1.5, -0.62); // worn on the back
  g.add(basket);
  return g;
}

export type Profession = 'woodcutter' | 'mason' | 'forager' | 'builder' | 'peasant';
interface Outfit { name: Profession; tunic: THREE.Material; coat: THREE.Material; hat: THREE.Material; tool?: () => THREE.Group }
const OUTFITS: Outfit[] = [
  { name: 'woodcutter', tunic: cloth(0x6f7a46), coat: cloth(0x47381f), hat: cloth(0x3a2c18), tool: axeTool },
  { name: 'mason',      tunic: cloth(0x9a958c), coat: cloth(0x55493d), hat: cloth(0x6b5a44), tool: malletTool },
  { name: 'forager',    tunic: cloth(0xb0894a), coat: cloth(0x77562f), hat: cloth(0x8a6a3a), tool: basketTool },
  { name: 'builder',    tunic: cloth(0xc9bda0), coat: cloth(0x7d6649), hat: cloth(0x584427) },
  { name: 'peasant',    tunic: cloth(0xcabfa0), coat: cloth(0x6e5a40), hat: cloth(0x4a3a28) },
];

let nextId = 1;

export class Villager {
  id = nextId++;
  group = new THREE.Group();
  private body: THREE.Mesh;
  private ring: THREE.Mesh;
  private carryMesh: THREE.Mesh;
  task: Task = { kind: 'idle' };
  carry = 0;
  carryKind: 'wood' | 'stone' | 'food' = 'wood';
  speed = 18;
  hp = 40;
  maxHp = 40;
  alive = true;
  sheltered = false;
  private shelterTimer = 0;
  profession: Profession;
  private workTimer = 0;
  private bobPhase = Math.random() * Math.PI * 2;

  constructor(x: number, z: number, scene: THREE.Scene, profession?: Profession) {
    const outfit = profession
      ? OUTFITS.find((o) => o.name === profession)!
      : OUTFITS[Math.floor(Math.random() * OUTFITS.length)];
    this.profession = outfit.name;
    const skin = skinMats[Math.floor(Math.random() * skinMats.length)];

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 1.7, 8), outfit.tunic);
    body.position.y = 0.85;
    body.castShadow = true;
    this.body = body;
    // arms — children of the body so they swing with the work/chop animation
    for (const sx of [-1, 1] as const) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.13, 0.95, 6), outfit.coat);
      arm.position.set(sx * 0.62, 0.18, 0.18);
      arm.rotation.z = sx * 0.12;
      arm.rotation.x = -0.25;
      arm.castShadow = true;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 5), skin);
      hand.position.set(0, -0.55, 0.05);
      arm.add(hand);
      body.add(arm);
    }
    const coat = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.8, 0.8, 8), outfit.coat);
    coat.position.y = 0.55;
    coat.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 9, 7), skin);
    head.position.y = 2.0;
    head.castShadow = true;
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.46, 0.42, 8), outfit.hat);
    hat.position.y = 2.35;
    hat.castShadow = true;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 24), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.12;
    ring.visible = false;
    this.ring = ring;
    const carryMesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), carryMats.wood);
    carryMesh.position.set(0, 2.75, 0);
    carryMesh.visible = false;
    this.carryMesh = carryMesh;
    this.group.add(body, coat, head, hat, ring, carryMesh);
    if (outfit.tool) this.group.add(outfit.tool());
    this.group.position.set(x, surfaceHeight(x, z), z);
    this.group.userData.villager = this;
    for (const c of [body, coat, head, hat]) c.userData.villager = this;
    scene.add(this.group);
    G.villagers.push(this);
  }

  get x(): number { return this.group.position.x; }
  get z(): number { return this.group.position.z; }

  get isIdle(): boolean { return this.task.kind === 'idle'; }

  // human-readable description of what this villager is doing — for the panel
  describeActivity(): string {
    const t = this.task;
    const load = this.carry > 0 ? ` (carrying ${this.carry} ${this.carryKind})` : '';
    switch (t.kind) {
      case 'idle': return 'Idle — awaiting orders';
      case 'move': return `Walking${load}`;
      case 'gather': {
        const what = { wood: 'timber', stone: 'stone', food: 'berries' }[t.node.kind];
        if (t.sub === 'return') return `Hauling ${what} to the drop-off`;
        if (t.sub === 'go') return `Going to gather ${what}`;
        return `Gathering ${what}${load}`;
      }
      case 'build':
        return t.sub === 'go' ? `Walking to ${t.building.def.name}` : `Building the ${t.building.def.name}`;
      case 'shelter': return t.sub === 'in' ? 'Sheltering indoors' : 'Running for refuge!';
      case 'fight': return t.sub === 'go' ? 'Closing on the beast' : 'Fighting off the beast!';
    }
  }

  setSelected(sel: boolean): void { this.ring.visible = sel; }

  // react to a wild animal: take refuge in the nearest building if one is close,
  // otherwise stand and fight it off. A player-ordered fight is left alone.
  alarm(bear: Bear): void {
    if (this.sheltered) return;
    if (this.task.kind === 'shelter') return;
    if (this.task.kind === 'fight') return;
    const refuge = this.nearestRefuge();
    if (refuge) this.task = { kind: 'shelter', building: refuge, sub: 'go' };
    else this.task = { kind: 'fight', bear, sub: 'go' };
  }

  private nearestRefuge(): Building | null {
    let best: Building | null = null, bd = REFUGE_RANGE * REFUGE_RANGE;
    for (const b of G.buildings) {
      if (b.phase !== 'done') continue;
      const d = (b.x - this.x) ** 2 + (b.z - this.z) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  private emerge(): void {
    this.sheltered = false;
    this.group.visible = true;
    this.task = { kind: 'idle' };
  }

  takeDamage(d: number): void {
    if (!this.alive) return;
    this.hp -= d;
    if (this.hp <= 0) this.die();
  }

  private die(): void {
    this.alive = false;
    this.group.removeFromParent();
    const i = G.villagers.indexOf(this); if (i >= 0) G.villagers.splice(i, 1);
    const s = G.selected.indexOf(this); if (s >= 0) G.selected.splice(s, 1);
  }

  orderAttack(bear: Bear): void { this.task = { kind: 'fight', bear, sub: 'go' }; }

  // stop building/approaching a structure that's being demolished
  releaseFrom(b: Building): void {
    if (this.task.kind === 'build' && this.task.building === b) this.task = { kind: 'idle' };
  }

  orderMove(x: number, z: number): void { this.task = { kind: 'move', x, z }; }
  orderGather(node: ResourceNode): void {
    if (this.carry > 0 && this.carryKind !== node.kind) this.carry = 0;
    this.task = { kind: 'gather', node, sub: 'go' };
  }
  orderBuild(b: Building): void { this.task = { kind: 'build', building: b, sub: 'go' }; }

  private stepToward(tx: number, tz: number, dt: number): boolean {
    const dx = tx - this.x, dz = tz - this.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.6) return true;
    const slope = Math.max(0, terrainHeight(tx, tz) - terrainHeight(this.x, this.z)) / Math.max(dist, 0.01);
    const sp = this.speed * Math.max(0.45, 1 - slope * 0.5);
    const step = Math.min(dist, sp * dt);
    let nx = this.x + (dx / dist) * step;
    let nz = this.z + (dz / dist) * step;
    if (!walkable(nx, nz)) {
      // steer around the obstacle: try progressively wider deflections off the
      // direct heading before declaring the leg stuck
      const base = Math.atan2(dx, dz);
      let moved = false;
      for (const off of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.5, -2.5]) {
        const a = base + off;
        const tnx = this.x + Math.sin(a) * step;
        const tnz = this.z + Math.cos(a) * step;
        if (walkable(tnx, tnz)) { nx = tnx; nz = tnz; moved = true; break; }
      }
      if (!moved) return true; // genuinely boxed in — give up on this leg
    }
    this.group.position.set(nx, surfaceHeight(nx, nz), nz);
    this.group.rotation.y = Math.atan2(dx, dz);
    // walk bob
    this.bobPhase += dt * 11;
    this.body.position.y = 0.85 + Math.abs(Math.sin(this.bobPhase)) * 0.1;
    return false;
  }

  update(dt: number): void {
    const t = this.task;
    switch (t.kind) {
      case 'idle':
        break;
      case 'move':
        if (this.stepToward(t.x, t.z, dt)) this.task = { kind: 'idle' };
        break;
      case 'gather': {
        if (!t.node.alive) {
          const next = this.findNearbyNode(t.node);
          if (next) { t.node = next; t.sub = this.carry >= 10 ? 'return' : 'go'; }
          else if (this.carry > 0) { t.sub = 'return'; }
          else { this.task = { kind: 'idle' }; break; }
        }
        if (t.sub === 'go') {
          // stepToward returns true on arrival OR when stuck — only start working
          // if we actually reached the node, otherwise we'd "gather" from afar
          if (this.stepToward(t.node.x, t.node.z, dt)) {
            const near = (this.x - t.node.x) ** 2 + (this.z - t.node.z) ** 2 < 4 * 4;
            if (near) { t.sub = 'work'; this.workTimer = 0; }
            else { this.task = { kind: 'idle' }; } // blocked — can't reach this node
          }
        } else if (t.sub === 'work') {
          this.workTimer += dt;
          // chopping sway
          this.body.rotation.x = Math.sin(this.workTimer * 7) * 0.25;
          // a nearby gather camp (lumber/quarry/forager) speeds the work
          const interval = 0.9 / gatherBonusAt(t.node.x, t.node.z, t.node.kind);
          if (this.workTimer >= interval) {
            this.workTimer = 0;
            this.carryKind = t.node.kind;
            this.carry += 2;
            t.node.amount -= 2;
            if (t.node.amount <= 0) { t.node.alive = false; hideNode(t.node); }
            if (this.carry >= 10) { this.body.rotation.x = 0; t.sub = 'return'; }
          }
        } else {
          const drop = nearestDropoff(this.x, this.z);
          if (!drop) { this.task = { kind: 'idle' }; break; }
          this.carryMesh.visible = true;
          this.carryMesh.material = carryMats[this.carryKind];
          if (this.stepToward(drop.x, drop.z, dt) ||
              (this.x - drop.x) ** 2 + (this.z - drop.z) ** 2 < (drop.def.radius + 2) ** 2) {
            G.resources[this.carryKind] += this.carry;
            this.carry = 0;
            this.carryMesh.visible = false;
            t.sub = t.node.alive ? 'go' : 'go';
            if (!t.node.alive) {
              const next = this.findNearbyNode(t.node);
              if (next) t.node = next; else this.task = { kind: 'idle' };
            }
          }
        }
        break;
      }
      case 'build': {
        const b = t.building;
        if (b.phase === 'done') { this.task = { kind: 'idle' }; break; }
        if (t.sub === 'go') {
          const done = this.stepToward(b.x, b.z, dt);
          const near = (this.x - b.x) ** 2 + (this.z - b.z) ** 2 < (b.def.radius + 2.5) ** 2;
          if (done || near) { t.sub = 'work'; this.workTimer = 0; }
        } else {
          this.workTimer += dt;
          this.body.rotation.x = Math.sin(this.workTimer * 8) * 0.2;
          if (b.phase === 'planned') { this.task = { kind: 'idle' }; break; }
          if (b.addWork(dt * 4)) { // 4 build points/sec per villager
            this.body.rotation.x = 0;
            this.task = { kind: 'idle' };
          }
        }
        break;
      }
      case 'shelter': {
        const b = t.building;
        if (b.phase !== 'done' || G.buildings.indexOf(b) < 0) { this.emerge(); break; }
        if (t.sub === 'go') {
          const arrived = this.stepToward(b.x, b.z, dt) ||
            (this.x - b.x) ** 2 + (this.z - b.z) ** 2 < (b.def.radius + 1.5) ** 2;
          if (arrived) { t.sub = 'in'; this.sheltered = true; this.group.visible = false; this.shelterTimer = 0; }
        } else {
          this.shelterTimer += dt;
          let danger = false;
          for (const bear of G.bears) {
            if ((bear.x - b.x) ** 2 + (bear.z - b.z) ** 2 < SHELTER_SAFE * SHELTER_SAFE) { danger = true; break; }
          }
          if (danger) this.shelterTimer = 0;
          if (this.shelterTimer > 2.5) this.emerge();
        }
        break;
      }
      case 'fight': {
        const bear = t.bear;
        if (!bear.alive) { this.body.rotation.x = 0; this.task = { kind: 'idle' }; break; }
        const d2 = (this.x - bear.x) ** 2 + (this.z - bear.z) ** 2;
        if (t.sub === 'go') {
          this.stepToward(bear.x, bear.z, dt);
          if (d2 < 3.2 * 3.2) { t.sub = 'work'; this.workTimer = 0; }
        } else {
          if (d2 > 4.4 * 4.4) { t.sub = 'go'; this.body.rotation.x = 0; break; }
          this.group.rotation.y = Math.atan2(bear.x - this.x, bear.z - this.z);
          this.workTimer += dt;
          this.body.rotation.x = Math.sin(this.workTimer * 9) * 0.28; // jabbing
          if (this.workTimer >= 0.7) {
            this.workTimer = 0;
            bear.takeDamage(this.profession === 'woodcutter' ? 7 : 5);
          }
        }
        break;
      }
    }
    const swinging = (t.kind === 'gather' && t.sub === 'work') || (t.kind === 'fight' && t.sub === 'work');
    if (!swinging) this.body.rotation.x *= 0.8;
  }

  private findNearbyNode(like: ResourceNode): ResourceNode | null {
    let best: ResourceNode | null = null;
    let bd = 55 * 55;
    for (const n of G.nodes) {
      if (!n.alive || n.kind !== like.kind) continue;
      const d = (n.x - like.x) ** 2 + (n.z - like.z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
}
