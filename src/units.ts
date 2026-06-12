import * as THREE from 'three';
import { terrainHeight, walkable } from './terrain';
import { G, ResourceNode } from './state';
import { Building, nearestDropoff } from './buildings';
import { hideNode } from './world';

type Task =
  | { kind: 'idle' }
  | { kind: 'move'; x: number; z: number }
  | { kind: 'gather'; node: ResourceNode; sub: 'go' | 'work' | 'return' }
  | { kind: 'build'; building: Building; sub: 'go' | 'work' };

const bodyMat = new THREE.MeshLambertMaterial({ color: 0xcfc4a8 }); // homespun wool
const coatMat = new THREE.MeshLambertMaterial({ color: 0x7d6649 });
const headMat = new THREE.MeshLambertMaterial({ color: 0xd9b08c });
const hatMat = new THREE.MeshLambertMaterial({ color: 0x4a3a28 });
const ringMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
const carryMats: Record<string, THREE.MeshLambertMaterial> = {
  wood: new THREE.MeshLambertMaterial({ color: 0x6e5238 }),
  stone: new THREE.MeshLambertMaterial({ color: 0x9a958c }),
  food: new THREE.MeshLambertMaterial({ color: 0xc2773a }),
};

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
  private workTimer = 0;
  private bobPhase = Math.random() * Math.PI * 2;

  constructor(x: number, z: number, scene: THREE.Scene) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 1.7, 7), bodyMat);
    body.position.y = 0.85;
    body.castShadow = true;
    this.body = body;
    const coat = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.8, 0.8, 7), coatMat);
    coat.position.y = 0.55;
    coat.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 7), headMat);
    head.position.y = 2.0;
    head.castShadow = true;
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.46, 0.42, 7), hatMat);
    hat.position.y = 2.35;
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
    this.group.position.set(x, terrainHeight(x, z), z);
    this.group.userData.villager = this;
    for (const c of [body, coat, head, hat]) c.userData.villager = this;
    scene.add(this.group);
    G.villagers.push(this);
  }

  get x(): number { return this.group.position.x; }
  get z(): number { return this.group.position.z; }

  setSelected(sel: boolean): void { this.ring.visible = sel; }

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
      // slide along: try x-only then z-only
      if (walkable(nx, this.z)) { nz = this.z; }
      else if (walkable(this.x, nz)) { nx = this.x; }
      else return true; // stuck — give up on this leg
    }
    this.group.position.set(nx, terrainHeight(nx, nz), nz);
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
          if (this.stepToward(t.node.x, t.node.z, dt)) { t.sub = 'work'; this.workTimer = 0; }
        } else if (t.sub === 'work') {
          this.workTimer += dt;
          // chopping sway
          this.body.rotation.x = Math.sin(this.workTimer * 7) * 0.25;
          if (this.workTimer >= 0.9) {
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
    }
    if (t.kind !== 'gather' || t.sub !== 'work') this.body.rotation.x *= 0.8;
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
