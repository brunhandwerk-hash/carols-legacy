import * as THREE from 'three';
import { START } from './config';
import { buildWorld } from './world';
import { G } from './state';
import { Building, setOnBuildingComplete } from './buildings';
import { Villager } from './units';
import { initEras, updateEras, ERAS } from './eras';
import { initInput } from './input';
import { initMinimap, drawMinimap } from './minimap';
import { updateHud, refreshSelectionPanel, refreshObjectives, showBanner, toast } from './ui';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 2500);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

const world = buildWorld(scene);

// ---- starting state ----
G.resources.wood = START.wood;
G.resources.stone = START.stone;
G.resources.food = START.food;

const camp = new Building('camp', START.camp.x, START.camp.z, 'done', scene, 0.4);
for (let i = 0; i < START.villagers; i++) {
  spawnVillager(START.camp.x + 8 + (i % 2) * 3, START.camp.z + 6 + Math.floor(i / 2) * 3);
}

function spawnVillager(x: number, z: number): void {
  new Villager(x, z, scene);
  updateHud();
}

setOnBuildingComplete((b: Building) => {
  toast(`${b.def.name} is complete.`);
  refreshObjectives();
  refreshSelectionPanel();
});

initEras(scene);

const rig = initInput(canvas, camera, world);
initMinimap((x, z) => rig.jumpTo(x, z));

// ---- intro ----
document.getElementById('start-btn')!.addEventListener('click', () => {
  document.getElementById('intro')!.style.display = 'none';
  G.paused = false;
  const era = ERAS[0];
  showBanner(era.yearLabel, era.introTitle, era.introText);
});

// ---- main loop ----
let last = performance.now();
let hudTimer = 0;
let mapTimer = 0;
let panelTimer = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  rig.update(dt);

  if (!G.paused) {
    G.time += dt;
    for (const v of G.villagers) v.update(dt);
    for (const b of G.buildings) b.update(dt, spawnVillager);
    updateEras(dt);

    hudTimer += dt;
    if (hudTimer > 0.2) { hudTimer = 0; updateHud(); }
    panelTimer += dt;
    if (panelTimer > 0.5) {
      panelTimer = 0;
      // live progress for selected construction sites / training queues
      if (G.selectedBuilding && G.selectedBuilding.phase !== 'planned') refreshSelectionPanel();
    }
  }
  mapTimer += dt;
  if (mapTimer > 0.25) { mapTimer = 0; drawMinimap(rig.target, rig.yaw, rig.dist * 1.6); }

  renderer.render(scene, camera);
}

updateHud();
requestAnimationFrame(frame);

// debug / test hook
(window as unknown as Record<string, unknown>).G = G;
