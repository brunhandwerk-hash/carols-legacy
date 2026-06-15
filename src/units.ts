import * as THREE from 'three';
import { terrainHeight, surfaceHeight, walkable, terrainSlope, inMap } from './terrain';
import { G, ResourceNode, GatherKind } from './state';
import { Building, nearestDropoff, gatherBonusAt } from './buildings';
import { hideNode } from './world';
import { findPath } from './pathfind';
import type { Bear } from './wildlife';

type Task =
  | { kind: 'idle' }
  | { kind: 'move'; x: number; z: number }
  | { kind: 'gather'; node: ResourceNode; sub: 'go' | 'work' | 'return' }
  | { kind: 'build'; building: Building; sub: 'go' | 'work' }
  | { kind: 'work'; building: Building; sub: 'go' | 'in' }
  | { kind: 'shelter'; building: Building; sub: 'go' | 'in' }
  | { kind: 'fight'; bear: Bear; sub: 'go' | 'work' };

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
  autoGather = false; // gathering as a labor fallback (interruptible) vs a manual order
  workplace: Building | null = null; // assigned workplace, if any
  // what to go back to once a bear scare passes (auto-resume)
  private resume: { kind: 'work'; b: Building } | { kind: 'gather'; node: ResourceNode } | { kind: 'build'; b: Building } | null = null;
  private shelterTimer = 0;
  profession: Profession;
  private workTimer = 0;
  private bobPhase = Math.random() * Math.PI * 2;
  private path: { x: number; z: number }[] = []; // current nav waypoints
  private pathI = 0;
  private navTX = NaN; private navTZ = NaN; // target the path was computed for
  private stuck = false;        // set by navToward when the final target is unreachable
  private bestD = Infinity;     // closest we've come to the current nav target
  private noProgressT = 0;      // time since we last got meaningfully closer to it
  private repathed = false;     // whether we've already tried a fresh route this stall
  private gSkip = new Set<ResourceNode>(); // nodes this worker can't reach — skip them
  private gNode: ResourceNode | null = null; // node a gather-camp worker is harvesting
  private bSkip = new Map<Building, number>(); // buildings we couldn't reach → game-time to retry
  private forceDist = 0; // metres clipped through unwalkable terrain at the current obstacle

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
      case 'idle': return 'Idle — looking for work';
      case 'move': return `Walking${load}`;
      case 'gather': {
        const what = { wood: 'timber', stone: 'stone', food: 'berries' }[t.node.kind];
        if (t.sub === 'return') return `Hauling ${what} to the drop-off`;
        if (t.sub === 'go') return `Going to gather ${what}`;
        return `Gathering ${what}${load}`;
      }
      case 'build':
        return t.sub === 'go' ? `Walking to ${t.building.def.name}` : `Building the ${t.building.def.name}`;
      case 'work':
        return t.sub === 'go' ? `Heading to the ${t.building.def.name}` : `Working at the ${t.building.def.name}`;
      case 'shelter': return t.sub === 'in' ? 'Sheltering indoors' : 'Running for refuge!';
      case 'fight': return t.sub === 'go' ? 'Closing on the beast' : 'Fighting off the beast!';
    }
  }

  setSelected(sel: boolean): void { this.ring.visible = sel; }

  // react to a wild animal: villagers always flee to the nearest building — they
  // never fight. With no buildings to shelter in, they carry on (and stay exposed).
  alarm(_bear: Bear): void {
    if (this.sheltered) return;
    if (this.task.kind === 'shelter') return;
    const refuge = this.nearestRefuge();
    if (!refuge) return;
    // remember what we were doing so we can return to it once the coast is clear
    const t = this.task;
    if (t.kind === 'work') this.resume = { kind: 'work', b: t.building };
    else if (t.kind === 'gather') this.resume = { kind: 'gather', node: t.node };
    else if (t.kind === 'build') this.resume = { kind: 'build', b: t.building };
    this.leaveWork(); this.clearPath();
    this.task = { kind: 'shelter', building: refuge, sub: 'go' };
  }

  // return to the pre-scare job if it's still valid, otherwise stand down
  private resumeOrIdle(): void {
    const r = this.resume;
    this.resume = null;
    if (r) {
      if (r.kind === 'work' && r.b.phase === 'done' && G.buildings.indexOf(r.b) >= 0) { this.orderWork(r.b); return; }
      if (r.kind === 'gather' && r.node.alive) { this.orderGather(r.node); return; }
      if (r.kind === 'build' && r.b.phase === 'site') { this.orderBuild(r.b); return; }
    }
    this.task = { kind: 'idle' };
  }

  // nearest finished building to flee into — no range cap, since villagers always
  // run for shelter when a beast appears (they never stand and fight).
  private nearestRefuge(): Building | null {
    let best: Building | null = null, bd = Infinity;
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
    this.resumeOrIdle();
  }

  takeDamage(d: number): void {
    if (!this.alive) return;
    this.hp -= d;
    if (this.hp <= 0) this.die();
  }

  private die(): void {
    this.alive = false;
    this.leaveWork();
    this.group.removeFromParent();
    const i = G.villagers.indexOf(this); if (i >= 0) G.villagers.splice(i, 1);
    const s = G.selected.indexOf(this); if (s >= 0) G.selected.splice(s, 1);
  }

  // stop building/working/approaching a structure that's being demolished
  releaseFrom(b: Building): void {
    if (this.workplace === b) this.leaveWork();
    if ((this.task.kind === 'build' || this.task.kind === 'work') && this.task.building === b) this.task = { kind: 'idle' };
  }

  orderGather(node: ResourceNode): void {
    this.leaveWork(); this.clearPath();
    if (this.carry > 0 && this.carryKind !== node.kind) this.carry = 0;
    this.task = { kind: 'gather', node, sub: 'go' };
    this.autoGather = false; // a manual order by default; labor.ts marks auto-gather
  }
  orderBuild(b: Building): void { this.leaveWork(); this.clearPath(); this.task = { kind: 'build', building: b, sub: 'go' }; }

  // a finished construction: if it's a workplace with a free slot, stay on and
  // work it; otherwise stand down
  private afterBuild(b: Building): void {
    this.body.rotation.x = 0;
    if (b.def.jobSlots && b.assignWorker(this)) {
      this.workplace = b;
      this.task = { kind: 'work', building: b, sub: 'go' };
    } else {
      this.task = { kind: 'idle' };
    }
  }

  // assign to a workplace; if its job slots are full, just walk over
  orderWork(b: Building): void {
    this.leaveWork(); this.clearPath();
    if (b.assignWorker(this)) { this.workplace = b; this.task = { kind: 'work', building: b, sub: 'go' }; }
    else this.task = { kind: 'move', x: b.x + b.def.radius + 1, z: b.z + b.def.radius + 1 };
  }

  // give up the current workplace (frees its job slot)
  leaveWork(): void {
    if (this.workplace) { this.workplace.removeWorker(this); this.workplace = null; }
    this.gNode = null;
    if (this.carryMesh) this.carryMesh.visible = false;
  }

  // recalled from work — free the slot and stand down
  unassign(): void {
    this.leaveWork();
    if (this.task.kind === 'work') this.task = { kind: 'idle' };
  }

  // mark a building as unreachable for this villager for a while, so labour gives
  // it a different job instead of re-sending it to (e.g.) a quarry across the
  // river. The mark expires so a later bridge re-opens the route.
  private skipUnreachable(b: Building): void { this.bSkip.set(b, G.time + 30); }
  cannotReach(b: Building): boolean {
    const until = this.bSkip.get(b);
    if (until === undefined) return false;
    if (G.time >= until) { this.bSkip.delete(b); return false; }
    return true;
  }

  // is this villager present and working at building b? (drives production)
  isWorkingAt(b: Building): boolean {
    if (this.task.kind !== 'work' || this.task.building !== b) return false;
    if (b.def.boosts) return true; // gather-camp workers count as working while roaming
    return this.task.sub === 'in';
  }

  isBuildingAt(b: Building): boolean {
    return this.task.kind === 'build' && this.task.building === b;
  }

  private stepToward(tx: number, tz: number, dt: number): boolean {
    const dx = tx - this.x, dz = tz - this.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.6) return true;
    // If we're standing on unwalkable ground (pushed onto a steep slope, terrain
    // sampled differently from the coarse pathfinding grid, or a bad spawn), the
    // normal step below can't help — every candidate cell is likely blocked too,
    // so we'd freeze forever. Escape toward the nearest open ground first.
    if (!walkable(this.x, this.z)) { this.unstick(dt); return false; }
    const slope = Math.max(0, terrainHeight(tx, tz) - terrainHeight(this.x, this.z)) / Math.max(dist, 0.01);
    const sp = this.speed * Math.max(0.45, 1 - slope * 0.5);
    const step = Math.min(dist, sp * dt);
    let nx = this.x + (dx / dist) * step;
    let nz = this.z + (dz / dist) * step;
    if (walkable(nx, nz)) {
      this.forceDist = 0; // back on open ground — refresh the clip-through budget
    } else {
      // steer around the obstacle: try progressively wider deflections off the
      // direct heading before declaring the leg stuck
      const base = Math.atan2(dx, dz);
      let moved = false;
      for (const off of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.5, -2.5]) {
        const a = base + off;
        const tnx = this.x + Math.sin(a) * step;
        const tnz = this.z + Math.cos(a) * step;
        if (walkable(tnx, tnz)) { nx = tnx; nz = tnz; moved = true; this.forceDist = 0; break; }
      }
      // Boxed in on every side — a flatten rim around a building pad, a pocket
      // between tightly-packed buildings, rocks crowding the gap. Rather than
      // freeze, take a reduced forced step STRAIGHT at the target to clip through.
      // But only for a short distance (FORCE_BUDGET): enough to squeeze past a
      // building or rim, NOT enough to wade across a wide river. Once the budget
      // is spent we hold, so the stall detector declares the leg stuck and the
      // task is abandoned — e.g. a quarry on the far bank with no bridge.
      if (!moved) {
        const FORCE_BUDGET = 8; // metres
        if (this.forceDist >= FORCE_BUDGET) return false;
        const fstep = step * 0.6;
        this.forceDist += fstep;
        nx = this.x + (dx / dist) * fstep;
        nz = this.z + (dz / dist) * fstep;
      }
    }
    this.group.position.set(nx, surfaceHeight(nx, nz), nz);
    this.group.rotation.y = Math.atan2(dx, dz);
    // walk bob
    this.bobPhase += dt * 11;
    this.body.position.y = 0.85 + Math.abs(Math.sin(this.bobPhase)) * 0.1;
    return false;
  }

  // Escape a stuck/unwalkable spot: sample directions around us and move toward
  // the one that lands on the most-walkable nearby ground (an actually-walkable
  // cell wins; otherwise the gentlest slope). Bypasses the normal walkable gate
  // for this single step so the villager can climb back out of a bad pocket.
  private unstick(dt: number): void {
    const step = Math.max(this.speed * dt, 0.4);
    let bestA = 0, bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const px = this.x + Math.sin(a) * step;
      const pz = this.z + Math.cos(a) * step;
      if (!inMap(px, pz)) continue;
      const score = (walkable(px, pz) ? 1000 : 0) - terrainSlope(px, pz);
      if (score > bestScore) { bestScore = score; bestA = a; }
    }
    const nx = this.x + Math.sin(bestA) * step;
    const nz = this.z + Math.cos(bestA) * step;
    if (!inMap(nx, nz)) return;
    this.group.position.set(nx, surfaceHeight(nx, nz), nz);
    this.group.rotation.y = bestA;
    this.bobPhase += dt * 11;
    this.body.position.y = 0.85 + Math.abs(Math.sin(this.bobPhase)) * 0.1;
  }

  // move toward a (static) destination along an obstacle-avoiding path. Computes
  // the path once per destination (recomputed only if the target moves), then
  // walks the waypoints. Returns true on arrival at the final target.
  private navToward(tx: number, tz: number, dt: number): boolean {
    this.stuck = false;
    const sameTarget = (this.navTX - tx) ** 2 + (this.navTZ - tz) ** 2 <= 9; // NaN ⇒ false
    if (!sameTarget) {
      // brand-new destination: fresh path + fresh stall window
      this.navTX = tx; this.navTZ = tz;
      this.path = findPath(this.x, this.z, tx, tz);
      this.pathI = 0;
      this.bestD = Math.hypot(this.x - tx, this.z - tz); this.noProgressT = 0; this.repathed = false;
    } else if (this.path.length === 0) {
      // same target but the path ran out / was cleared — rebuild, keep the window
      this.path = findPath(this.x, this.z, tx, tz);
      this.pathI = 0;
    }

    let arrived = false;
    if (this.path.length === 0) arrived = this.stepToward(tx, tz, dt);
    else {
      const wp = this.path[Math.min(this.pathI, this.path.length - 1)];
      if (this.stepToward(wp.x, wp.z, dt)) {
        this.pathI++;
        if (this.pathI >= this.path.length) { this.path = []; arrived = true; }
      }
    }
    if (arrived) { this.navTX = NaN; return true; }

    // Stuck detection by progress TOWARD THE GOAL (not raw displacement): a
    // villager sliding along a barrier — wall-following up a riverbank that has
    // no crossing, say — keeps "moving" but never gets closer, and raw-distance
    // checks would never flag it. So we track the closest we've come; whenever we
    // beat it we're making headway, otherwise the no-progress clock runs. One
    // fresh route is tried first; sustained no-progress declares the leg stuck so
    // the caller bails (e.g. abandons a quarry on the far side of the river). A
    // real detour around an obstacle still closes distance within the window.
    const distNow = Math.hypot(this.x - tx, this.z - tz);
    if (distNow < this.bestD - 2) {
      this.bestD = distNow; this.noProgressT = 0; this.repathed = false;
    } else {
      this.noProgressT += dt;
      if (!this.repathed && this.noProgressT >= 3) {
        this.path = findPath(this.x, this.z, tx, tz); this.pathI = 0; this.repathed = true;
      } else if (this.noProgressT >= 8) {
        this.stuck = true; this.navTX = NaN; this.path = [];
      }
    }
    return false;
  }

  private clearPath(): void { this.path = []; this.navTX = NaN; }

  // a gather-camp worker (lumber/quarry/forager): harvest the nearest matching
  // node around the camp and haul it back — fully automatic, no orders needed
  private campGather(camp: Building, kind: GatherKind, dt: number): void {
    if (this.carry >= 10) {
      this.carryMesh.visible = true;
      this.carryMesh.material = carryMats[this.carryKind];
      if ((this.x - camp.x) ** 2 + (this.z - camp.z) ** 2 < (camp.def.radius + 2) ** 2) {
        G.resources[this.carryKind] += this.carry;
        this.carry = 0; this.carryMesh.visible = false; this.clearPath();
      } else this.navToward(camp.x, camp.z, dt);
      return;
    }
    if (!this.gNode || !this.gNode.alive) {
      // only reset the path when the node actually changes — clearing it every
      // tick (e.g. when no node is found) would keep resetting nav progress and
      // the worker could never be declared stuck / give up an unreachable camp
      const next = this.findCampNode(camp, kind);
      if (next !== this.gNode) { this.gNode = next; this.clearPath(); }
    }
    const node = this.gNode;
    // the whole site is cut off if we can't even get near the camp itself (e.g. a
    // quarry on the far bank of an un-bridged river) — give it up so labour can
    // re-task us elsewhere instead of leaving us pinned at the water's edge
    const giveUpCamp = (): void => { this.skipUnreachable(camp); this.leaveWork(); this.task = { kind: 'idle' }; };
    const farFromCamp = (): boolean =>
      (this.x - camp.x) ** 2 + (this.z - camp.z) ** 2 > (camp.def.boostRange ?? 50) ** 2;
    if (!node) {
      if ((this.x - camp.x) ** 2 + (this.z - camp.z) ** 2 > (camp.def.radius + 3) ** 2) {
        this.navToward(camp.x, camp.z, dt);
        if (this.stuck) giveUpCamp();
      }
      return;
    }
    if ((this.x - node.x) ** 2 + (this.z - node.z) ** 2 > 3.5 * 3.5) {
      this.navToward(node.x, node.z, dt);
      // can't reach this node — blacklist it and pick another next tick so the
      // worker doesn't get pinned against the river/cliff in front of it; but if
      // we never even made it to the camp, the site itself is unreachable.
      if (this.stuck) {
        this.gSkip.add(node); this.gNode = null;
        if (farFromCamp()) giveUpCamp();
      }
      return;
    }
    // at the node: harvest
    this.workTimer += dt;
    this.body.rotation.x = Math.sin(this.workTimer * 7) * 0.25;
    const interval = 0.9 / gatherBonusAt(node.x, node.z, kind);
    if (this.workTimer >= interval) {
      this.workTimer = 0;
      this.carryKind = kind;
      this.carry += 2;
      node.amount -= 2;
      this.gSkip.clear(); // we're clearly able to reach nodes — forget old skips
      if (node.amount <= 0) { node.alive = false; hideNode(node); this.gNode = null; }
    }
  }

  private findCampNode(camp: Building, kind: GatherKind): ResourceNode | null {
    // Harvest the nearest matching node, with NO hard range cap: a camp placed
    // just outside the trees (e.g. next to base storage, on the rim of the big
    // starting clearing) would otherwise find nothing inside boostRange and leave
    // its workers standing idle. Walking a bit further beats not working at all;
    // truly unreachable nodes are still blacklisted via gSkip / the stuck logic.
    // (Nearby nodes win automatically since we keep the closest, and the boost
    // bonus still only applies within boostRange via gatherBonusAt.)
    let best: ResourceNode | null = null, bd = Infinity;
    for (const n of G.nodes) {
      if (!n.alive || n.kind !== kind || this.gSkip.has(n)) continue;
      const d = (n.x - camp.x) ** 2 + (n.z - camp.z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    // every in-range node is currently blacklisted as unreachable — clear the
    // skip list and retry from scratch (terrain/obstacles may have changed)
    if (!best && this.gSkip.size) { this.gSkip.clear(); return this.findCampNode(camp, kind); }
    return best;
  }

  update(dt: number): void {
    const t = this.task;
    switch (t.kind) {
      case 'idle':
        break;
      case 'move':
        if (this.navToward(t.x, t.z, dt) || this.stuck) this.task = { kind: 'idle' };
        break;
      case 'gather': {
        if (!t.node.alive) {
          const next = this.findNearbyNode(t.node);
          if (next) { t.node = next; t.sub = this.carry >= 10 ? 'return' : 'go'; }
          else if (this.carry > 0) { t.sub = 'return'; }
          else { this.task = { kind: 'idle' }; break; }
        }
        if (t.sub === 'go') {
          if (this.navToward(t.node.x, t.node.z, dt)) { t.sub = 'work'; this.workTimer = 0; }
          else if (this.stuck) this.task = { kind: 'idle' }; // can't reach this node
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
          if (this.navToward(drop.x, drop.z, dt) ||
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
        if (b.phase === 'done') { this.afterBuild(b); break; }
        if (t.sub === 'go') {
          const done = this.navToward(b.x, b.z, dt);
          const near = (this.x - b.x) ** 2 + (this.z - b.z) ** 2 < (b.def.radius + 2.5) ** 2;
          if (done || near) { t.sub = 'work'; this.workTimer = 0; }
          else if (this.stuck) { this.skipUnreachable(b); this.task = { kind: 'idle' }; } // can't reach the site
        } else {
          this.workTimer += dt;
          this.body.rotation.x = Math.sin(this.workTimer * 8) * 0.2;
          if (b.phase === 'planned') { this.task = { kind: 'idle' }; break; }
          if (b.addWork(dt * 4)) this.afterBuild(b); // 4 build points/sec per villager
        }
        break;
      }
      case 'work': {
        const b = t.building;
        if (b.phase !== 'done' || G.buildings.indexOf(b) < 0) { this.leaveWork(); this.task = { kind: 'idle' }; break; }
        if (b.def.boosts) {
          // a gather-camp worker: harvest nearby nodes and haul to the camp
          this.campGather(b, b.def.boosts, dt);
        } else if (t.sub === 'go') {
          const done = this.navToward(b.x, b.z, dt);
          const near = (this.x - b.x) ** 2 + (this.z - b.z) ** 2 < (b.def.radius + 1.5) ** 2;
          if (done || near) { t.sub = 'in'; this.workTimer = 0; }
        } else {
          // present at a production/food building: a small working sway (output is
          // handled by the building, which counts present workers)
          this.workTimer += dt;
          this.body.rotation.x = Math.sin(this.workTimer * 5) * 0.12;
          this.group.rotation.y = Math.atan2(b.x - this.x, b.z - this.z);
        }
        break;
      }
      case 'shelter': {
        const b = t.building;
        if (b.phase !== 'done' || G.buildings.indexOf(b) < 0) { this.emerge(); break; }
        if (t.sub === 'go') {
          const arrived = this.navToward(b.x, b.z, dt) ||
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
        if (!bear.alive) { this.body.rotation.x = 0; this.resumeOrIdle(); break; }
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
    const swinging = (t.kind === 'gather' && t.sub === 'work') || (t.kind === 'fight' && t.sub === 'work') || (t.kind === 'work' && t.sub === 'in');
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
