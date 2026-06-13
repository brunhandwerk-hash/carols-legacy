import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { START } from './config';
import { buildWorld, updateForestLOD } from './world';
import { G } from './state';
import { Building, setOnBuildingComplete } from './buildings';
import { Villager } from './units';
import { initEras, updateEras, ERAS } from './eras';
import { initInput, CameraRig } from './input';
import { initMinimap, drawMinimap } from './minimap';
import { updateHud, refreshSelectionPanel, refreshObjectives, showBanner, toast, setSelection, updateSelectionStatus } from './ui';
import { loadDem, lonLatToWorld, setRoads, updateWater } from './terrain';
import { initWildlife, updateWildlife } from './wildlife';
import { PLOTS, CAMP_GEO, initPlots, plotByKey } from './plots';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// stylized-realism pipeline: filmic tone-mapping + sRGB so PBR materials read right
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 16000);

// soft image-based lighting so PBR materials catch ambient sky/ground bounce
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();
renderer.setRenderTarget(null); // PMREM can leave its offscreen target bound

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

let rig: CameraRig;

async function boot(): Promise<void> {
  await loadDem();
  initPlots();
  const camp = lonLatToWorld(CAMP_GEO.lon, CAMP_GEO.lat);
  START.camp.x = camp.x;
  START.camp.z = camp.z;

  // historical roads as polylines between the real landmark sites
  const P = (key: string): [number, number] => {
    const p = plotByKey(key);
    return [p.x, p.z];
  };
  setRoads([
    [[camp.x, camp.z], P('townhall'), P('palace'), P('monastery')],
    [P('monastery'), P('furnica'), P('economat'), P('cavalerilor'), P('guard'), P('peles')],
    [P('guard'), P('pelisor')],
    [P('pelisor'), P('foisor')],
    [P('palace'), P('casino'), P('caraiman'), P('station')],
    [P('townhall'), P('villa2'), P('villa3')],
    [P('station'), P('villa1')],
  ]);

  const world = buildWorld(scene);

  // ---- starting state ----
  G.resources.wood = START.wood;
  G.resources.stone = START.stone;
  G.resources.food = START.food;
  G.resources.coin = START.coin;

  new Building('camp', START.camp.x, START.camp.z, 'done', scene, 0.4);
  for (let i = 0; i < START.villagers; i++) {
    spawnVillager(START.camp.x + 8 + (i % 2) * 3, START.camp.z + 6 + Math.floor(i / 2) * 3);
  }

  setOnBuildingComplete((b: Building) => {
    toast(`${b.def.name} is complete.`);
    refreshObjectives();
    refreshSelectionPanel();
  });

  initEras(scene);
  initWildlife(scene);

  rig = initInput(canvas, camera, world);
  rig.jumpTo(START.camp.x - 30, START.camp.z - 40);
  initMinimap((x, z) => rig.jumpTo(x, z));
  initIdleCycler();

  // ---- intro ----
  document.getElementById('start-btn')!.addEventListener('click', () => {
    document.getElementById('intro')!.style.display = 'none';
    G.paused = false;
    const era = ERAS[0];
    showBanner(era.yearLabel, era.introTitle, era.introText);
  });

  updateHud();
  requestAnimationFrame(frame);

  // debug / test hooks
  const dbg = window as unknown as Record<string, unknown>;
  dbg.G = G;
  dbg.rig = rig;
  dbg.scene = scene;
  import('./terrain').then((t) => { dbg.terrain = t; });
  dbg.__render = () => { renderer.render(scene, camera); return renderer.info.render.calls; };
}

function spawnVillager(x: number, z: number): void {
  new Villager(x, z, scene);
  updateHud();
}

// ---- idle-villager cycler: jump to and select the next idle settler ----
let idleCursor = 0;
function selectNextIdle(): void {
  const idle = G.villagers.filter((v) => v.isIdle);
  if (idle.length === 0) { toast('No idle villagers.'); return; }
  const v = idle[idleCursor % idle.length];
  idleCursor++;
  setSelection([v], null);
  rig.jumpTo(v.x, v.z);
}

function initIdleCycler(): void {
  document.getElementById('idle-btn')!.addEventListener('click', selectNextIdle);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); selectNextIdle(); }
  });
}

// ---- main loop ----
let last = performance.now();
let hudTimer = 0;
let mapTimer = 0;
let panelTimer = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  tick(now);
}

// rAF is suspended in hidden tabs (incl. headless previews) — keep ticking there
setInterval(() => { if (document.hidden && rig) tick(performance.now()); }, 100);

function tick(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  rig.update(dt);

  if (!G.paused) {
    G.time += dt;
    for (const v of G.villagers) v.update(dt);
    for (const b of G.buildings) b.update(dt, spawnVillager);
    updateWildlife(dt);
    updateEras(dt);
  }
  updateWater(dt);
  if (!G.paused) {

    hudTimer += dt;
    if (hudTimer > 0.2) { hudTimer = 0; updateHud(); updateSelectionStatus(); }
    panelTimer += dt;
    if (panelTimer > 0.5) {
      panelTimer = 0;
      if (G.selectedBuilding && G.selectedBuilding.phase !== 'planned') refreshSelectionPanel();
    }
  }
  mapTimer += dt;
  if (mapTimer > 0.25) {
    mapTimer = 0;
    drawMinimap(rig.target, rig.yaw, rig.dist * 1.6);
    updateForestLOD(rig.target.x, rig.target.z);
  }

  renderer.render(scene, camera);
}

boot();
