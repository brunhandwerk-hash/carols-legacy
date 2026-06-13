import * as THREE from 'three';
import { surfaceHeight, walkable, inMap } from './terrain';
import { MAP, START } from './config';
import { G } from './state';
import type { Villager } from './units';
import { findPath } from './pathfind';
import { toast, showBanner } from './ui';

// ---------------------------------------------------------------------------
// Wild animals. The Carpathian forests around Sinaia were (and are) brown-bear
// country — a real, periodic danger to a frontier hamlet, not a rival AI base.
// Bears prowl out of the treeline now and then, hunt villagers, and are driven
// off by the Founders' Hall and Hunter's Lodges (auto-defence) or by villagers
// the player commands to fight (see Villager.orderAttack / 'fight' task).
// ---------------------------------------------------------------------------

const BEAR_HP = 70;
const BEAR_SPEED = 18.6;       // a shade faster than a fleeing villager (18) so a
                               // persistent bear runs its quarry down over time
const BEAR_CONTACT = 3.6;      // metres at which a bear can maul its target
const BEAR_DMG = 10;           // damage per bite — ~4 bites kills a 40 hp villager
const BEAR_BITE_INTERVAL = 1.0;
const BEAR_LEASH = 340;        // keep chasing one victim until it dies or escapes this far
const BEAR_LIFETIME = 80;      // seconds before it gives up and retreats

const FIRST_ATTACK_AT = 75;    // no bears in the very first minutes
let spawnTimer = FIRST_ATTACK_AT;
let sceneRef: THREE.Scene | null = null;
let firstWarning = true;

const furMat = new THREE.MeshStandardMaterial({ color: 0x4a3526, roughness: 0.92, metalness: 0 });
const snoutMat = new THREE.MeshStandardMaterial({ color: 0x2f2218, roughness: 0.9, metalness: 0 });
const barBackMat = new THREE.MeshBasicMaterial({ color: 0x3a0d0d });
const barFillMat = new THREE.MeshBasicMaterial({ color: 0xff5a3c });

function buildBearMesh(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(1.0, 10, 8), furMat);
  body.scale.set(1.0, 0.95, 1.7); body.position.set(0, 1.15, 0); body.castShadow = true;
  g.add(body);
  const hump = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), furMat);
  hump.position.set(0, 1.7, -0.5); hump.castShadow = true; g.add(hump);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.58, 9, 7), furMat);
  head.position.set(0, 1.4, 1.45); head.castShadow = true; g.add(head);
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.34, 0.5), snoutMat);
  snout.position.set(0, 1.28, 1.95); g.add(snout);
  for (const sx of [-1, 1] as const) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5), furMat);
    ear.position.set(sx * 0.32, 1.78, 1.4); g.add(ear);
  }
  return g;
}

export class Bear {
  group = new THREE.Group();
  private legs: THREE.Mesh[] = [];
  private barFill: THREE.Mesh;
  private bar: THREE.Group;
  hp = BEAR_HP;
  maxHp = BEAR_HP;
  alive = true;
  private state: 'hunt' | 'leave' = 'hunt';
  private target: Villager | null = null;
  private biteTimer = 0;
  private life = BEAR_LIFETIME;
  private walkPhase = Math.random() * Math.PI * 2;
  private path: { x: number; z: number }[] = []; // nav waypoints around obstacles
  private pathI = 0;
  private repath = 0; private navTX = NaN; private navTZ = NaN;

  constructor(x: number, z: number, scene: THREE.Scene) {
    this.group.add(buildBearMesh());
    // four legs we can animate as it walks
    for (const [lx, lz] of [[-0.55, -0.9], [0.55, -0.9], [-0.55, 0.9], [0.55, 0.9]] as const) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.22, 1.2, 6), furMat);
      leg.position.set(lx, 0.6, lz); leg.castShadow = true;
      this.group.add(leg); this.legs.push(leg);
    }
    this.group.scale.setScalar(0.9);
    // floating health bar (hidden until hurt)
    this.bar = new THREE.Group();
    const back = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.26), barBackMat);
    this.barFill = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.26), barFillMat);
    this.barFill.position.z = 0.01;
    this.bar.add(back, this.barFill);
    this.bar.position.y = 3.0;
    this.bar.rotation.x = -0.6;
    this.bar.visible = false;
    this.group.add(this.bar);

    this.group.position.set(x, surfaceHeight(x, z), z);
    this.group.userData.bear = this;
    this.group.traverse((o) => { o.userData.bear = this; });
    scene.add(this.group);
    G.bears.push(this);
  }

  get x(): number { return this.group.position.x; }
  get z(): number { return this.group.position.z; }

  takeDamage(d: number): void {
    if (!this.alive) return;
    this.hp -= d;
    this.bar.visible = true;
    this.barFill.scale.x = Math.max(0.001, this.hp / this.maxHp);
    this.barFill.position.x = -0.9 * (1 - this.hp / this.maxHp);
    if (this.hp <= 0) this.die(true);
  }

  private die(slain: boolean): void {
    if (!this.alive) return;
    this.alive = false;
    this.group.removeFromParent();
    const i = G.bears.indexOf(this); if (i >= 0) G.bears.splice(i, 1);
    if (slain) {
      G.resources.food += 15; // the carcass is dressed for meat
      toast('A brown bear was brought down — the hunters take 15 meat.');
    }
  }

  private nearestVillager(): Villager | null {
    let best: Villager | null = null, bd = Infinity;
    for (const v of G.villagers) {
      if (!v.alive || v.sheltered) continue; // can't maul someone safe indoors
      const d = (v.x - this.x) ** 2 + (v.z - this.z) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  private stepToward(tx: number, tz: number, dt: number): number {
    const dx = tx - this.x, dz = tz - this.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return 0;
    const step = Math.min(dist, BEAR_SPEED * dt);
    let nx = this.x + (dx / dist) * step;
    let nz = this.z + (dz / dist) * step;
    if (!walkable(nx, nz)) {
      const base = Math.atan2(dx, dz);
      let moved = false;
      for (const off of [0.7, -0.7, 1.4, -1.4, 2.2, -2.2]) {
        const a = base + off;
        const tnx = this.x + Math.sin(a) * step, tnz = this.z + Math.cos(a) * step;
        if (walkable(tnx, tnz)) { nx = tnx; nz = tnz; moved = true; break; }
      }
      if (!moved) return dist;
    }
    this.group.position.set(nx, surfaceHeight(nx, nz), nz);
    this.group.rotation.y = Math.atan2(dx, dz);
    // lumbering gait
    this.walkPhase += dt * 9;
    const s = Math.sin(this.walkPhase);
    this.legs[0].rotation.x = s * 0.5; this.legs[3].rotation.x = s * 0.5;
    this.legs[1].rotation.x = -s * 0.5; this.legs[2].rotation.x = -s * 0.5;
    return dist;
  }

  // move toward a (possibly moving) target, routing around buildings/slopes. The
  // path is recomputed on a throttle, or when the target shifts a lot — and when
  // line-of-sight is clear findPath just returns the target, so an open chase is
  // a direct, responsive pursuit.
  private navToward(tx: number, tz: number, dt: number): void {
    this.repath -= dt;
    if (this.path.length === 0 || this.repath <= 0 || (this.navTX - tx) ** 2 + (this.navTZ - tz) ** 2 > 64) {
      this.navTX = tx; this.navTZ = tz;
      this.path = findPath(this.x, this.z, tx, tz);
      this.pathI = 0; this.repath = 0.4;
    }
    let wp = this.path[Math.min(this.pathI, this.path.length - 1)] || { x: tx, z: tz };
    if (Math.hypot(wp.x - this.x, wp.z - this.z) < 3 && this.pathI < this.path.length - 1) {
      this.pathI++;
      wp = this.path[this.pathI];
    }
    this.stepToward(wp.x, wp.z, dt);
  }

  update(dt: number): void {
    if (!this.alive) return;
    this.life -= dt;
    if (this.life <= 0) this.state = 'leave';

    if (this.state === 'leave') {
      // head for the nearest map edge and vanish into the forest
      const ex = this.x < 0 ? MAP.minX + 20 : MAP.maxX - 20;
      this.navToward(ex, this.z, dt);
      if (Math.abs(this.x - ex) < 6 || !inMap(this.x, this.z)) this.die(false);
      return;
    }

    // commit to one victim — only re-pick when it's dead, has taken refuge, or has
    // escaped the leash — so a determined bear runs someone down instead of dithering
    if (!this.target || !this.target.alive || this.target.sheltered ||
        (this.target.x - this.x) ** 2 + (this.target.z - this.z) ** 2 > BEAR_LEASH * BEAR_LEASH) {
      this.target = this.nearestVillager();
    }
    if (!this.target) { this.state = 'leave'; return; }
    const tx = this.target.x, tz = this.target.z;
    const d = Math.hypot(tx - this.x, tz - this.z);
    // stay glued to the victim — keep closing even at point-blank range so a
    // fleeing villager can't break contact between bites and run forever
    if (d > BEAR_CONTACT * 0.6) this.navToward(tx, tz, dt);
    else this.group.rotation.y = Math.atan2(tx - this.x, tz - this.z);
    if (d <= BEAR_CONTACT) {
      this.biteTimer += dt;
      if (this.biteTimer >= BEAR_BITE_INTERVAL) { this.biteTimer = 0; this.target.takeDamage(BEAR_DMG); }
    } else {
      this.biteTimer = Math.max(0, this.biteTimer - dt * 0.5); // decay, don't hard reset
    }
  }
}

// settlement centre, for choosing where bears emerge
function settlementCentre(): { x: number; z: number } {
  const done = G.buildings.filter((b) => b.phase === 'done');
  if (done.length === 0) return { x: START.camp.x, z: START.camp.z };
  let sx = 0, sz = 0;
  for (const b of done) { sx += b.x; sz += b.z; }
  return { x: sx / done.length, z: sz / done.length };
}

function spawnWave(): void {
  if (!sceneRef) return;
  const c = settlementCentre();
  const count = Math.min(3, 1 + Math.floor(G.villagers.length / 9));
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    // find a walkable emergence point out in the trees
    let sx = c.x, sz = c.z, ok = false;
    for (let tries = 0; tries < 24 && !ok; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 150 + Math.random() * 90;
      sx = c.x + Math.cos(a) * r; sz = c.z + Math.sin(a) * r;
      if (inMap(sx, sz) && walkable(sx, sz)) ok = true;
    }
    if (ok) { new Bear(sx, sz, sceneRef); spawned++; }
  }
  if (spawned === 0) return;
  if (firstWarning) {
    firstWarning = false;
    showBanner('Beware', 'Bears in the Valley',
      'Brown bears prowl down from the forests to raid the hamlet. Build a Hunter’s Lodge to guard your people — or order villagers to drive the beasts off (right-click a bear).');
  } else {
    toast(spawned > 1 ? `${spawned} brown bears approach from the forest!` : 'A brown bear approaches from the forest!');
  }
}

export function initWildlife(scene: THREE.Scene): void {
  sceneRef = scene;
  spawnTimer = FIRST_ATTACK_AT;
  firstWarning = true;
  for (const b of G.bears.slice()) b.group.removeFromParent();
  G.bears.length = 0;
}

export function updateWildlife(dt: number): void {
  // periodic attacks, scaling slightly once the settlement is worth raiding
  spawnTimer -= dt;
  if (spawnTimer <= 0 && G.villagers.length >= 3) {
    spawnTimer = 70 + Math.random() * 60;
    spawnWave();
  }

  for (const b of G.bears.slice()) b.update(dt);

  // villagers react to a bear that comes near: take refuge in a nearby building,
  // or stand and fight it off (see Villager.alarm)
  const ALARM = 26;
  for (const bear of G.bears) {
    for (const v of G.villagers) {
      if ((v.x - bear.x) ** 2 + (v.z - bear.z) ** 2 < ALARM * ALARM) v.alarm(bear);
    }
  }

  // building auto-defence: any completed building with a defendDps shoots bears
  // within its defendRange (Founders' Hall = weak, Hunter's Lodge = strong)
  for (const b of G.buildings) {
    if (b.phase !== 'done' || !b.def.defendDps) continue;
    const range = b.def.defendRange ?? 40;
    for (const bear of G.bears.slice()) {
      if ((b.x - bear.x) ** 2 + (b.z - bear.z) ** 2 < range * range) {
        bear.takeDamage(b.def.defendDps * dt);
      }
    }
  }
}
