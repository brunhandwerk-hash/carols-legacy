import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { START } from './config';
import { buildWorld, updateForestReveal } from './world';
import { G } from './state';
import { Building, setOnBuildingComplete } from './buildings';
import { Villager } from './units';
import { initEras, updateEras } from './eras';
import { initInput, CameraRig } from './input';
import { initMinimap, drawMinimap } from './minimap';
import { updateHud, refreshSelectionPanel, refreshObjectives, toast, setSelection, updateSelectionStatus, initBuildBar, setCameraJump } from './ui';
import { loadDem, loadBackdrop, lonLatToWorld, setRoads, updateWater } from './terrain';
import { initWildlife, updateWildlife } from './wildlife';
import { autoAssign } from './labor';
import { updatePopulation, setPopulationCallbacks } from './population';
import { saveGame, loadGame } from './save';
import { initChronicle, recordChronicle, refreshChronicle, updateChronicle } from './chronicle';
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
renderer.toneMappingExposure = 0.9; // slightly dimmer than 1.05 (HDRI was a touch bright)

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbdd2e0); // sky-colour fallback until the HDRI dome loads
// far plane reaches past the backdrop massifs (~17 km out) so the real Bucegi
// and Baiului peaks are not clipped on the horizon
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 1, 70000);

// Image-based lighting. A neutral RoomEnvironment is the immediate fallback so
// PBR materials aren't black on the first frames; the real alpine sky HDRI then
// loads and drives BOTH the skybox and the IBL — the single biggest step toward a
// lit, "game" look (replaces the tiny 0.04 room bounce).
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
renderer.setRenderTarget(null); // PMREM can leave its offscreen target bound

new RGBELoader().load('/hdri/sky_2k.hdr', (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const envRT = pmrem.fromEquirectangular(hdr);
  scene.environment = envRT.texture;   // realistic sky bounce for every PBR surface
  scene.background = hdr;               // painted sky dome behind the peaks
  scene.environmentIntensity = 1.0;
  pmrem.dispose();
  renderer.setRenderTarget(null);
});

// ---- post-processing: ground-contact AO + a touch of bloom, filmic output ----
// GTAO darkens crevices and where forms meet (eaves, walls, foundations) so the
// buildings read as solid masses, not flat boxes. World-space AO radius is small
// (~0.5 m) so the distant mountains pick up no AO artefacts. A gentle bloom lifts
// highlights (snow, water, lamps) for atmosphere. OutputPass does the ACES + sRGB.
// HDR + 4x MSAA target: HalfFloat keeps bloom smooth (no banding), samples keep
// edges crisp (the composer otherwise bypasses the renderer's antialiasing)
const hdrTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
  type: THREE.HalfFloatType, samples: 4,
});
const composer = new EffectComposer(renderer, hdrTarget);
composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
gtao.output = GTAOPass.OUTPUT.Default;
gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1, thickness: 1, scale: 1.4, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
composer.addPass(gtao);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.16, 0.5, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// final colour grade: a gentle saturation lift (ACES tends to desaturate) for a
// richer, less washed-out "game" look. Runs after OutputPass (sRGB output).
const gradePass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, saturation: { value: 1.18 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; uniform float saturation; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = dot(c.rgb, vec3(0.2125,0.7154,0.0721)); c.rgb = mix(vec3(l), c.rgb, saturation); gl_FragColor = c; }',
});
composer.addPass(gradePass);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

let rig: CameraRig;

async function boot(): Promise<void> {
  await loadDem();
  await loadBackdrop();
  initPlots();
  const camp = lonLatToWorld(CAMP_GEO.lon, CAMP_GEO.lat);
  START.camp.x = camp.x;
  START.camp.z = camp.z;

  // no pre-built roads — the player lays roads themselves. (The road system
  // stays in place for that; we just start with an empty network.)
  setRoads([]);

  const world = buildWorld(scene);

  // ---- starting state ----
  G.resources.wood = START.wood;
  G.resources.stone = START.stone;
  G.resources.food = START.food;
  G.resources.water = START.water;
  G.resources.coin = START.coin;

  new Building('camp', START.camp.x, START.camp.z, 'done', scene, 0.4);
  for (let i = 0; i < START.villagers; i++) {
    spawnVillager(START.camp.x + 8 + (i % 2) * 3, START.camp.z + 6 + Math.floor(i / 2) * 3);
  }

  setOnBuildingComplete((b: Building) => {
    toast(`${b.def.name} is complete.`);
    recordChronicle(b.def.key); // landmark completions write a page of the town's history
    refreshObjectives();
    refreshSelectionPanel();
  });

  initEras(scene);
  initWildlife(scene);
  setPopulationCallbacks(
    () => toast('A new settler has come of age in Sinaia.'),
    () => toast('A villager has starved — the larder is empty!'),
    () => toast('Villagers are freezing — they need firewood (wood).'),
    () => toast('Villagers are parched — build a Fântână (Well) for water.'),
  );

  rig = initInput(canvas, camera, world); // opens on the hardcoded view (see rig defaults)
  initMinimap((x, z) => rig.jumpTo(x, z));
  setCameraJump((x, z) => rig.jumpTo(x, z)); // build-bar landmarks fly the camera to their plot
  initIdleCycler();

  // ---- no intro: load straight into the map (re-add the title screen later) ----
  G.paused = false;
  G.started = true;

  initControls();
  initBuildBar();
  initChronicle();
  recordChronicle('founding'); // open the chronicle with the 1690 founding so it's never empty
  updateHud();
  requestAnimationFrame(frame);

  // debug / test hooks
  const dbg = window as unknown as Record<string, unknown>;
  dbg.G = G;
  dbg.rig = rig;
  dbg.scene = scene;
  dbg.camera = camera;
  import('./terrain').then((t) => { dbg.terrain = t; });
  dbg.__render = () => { composer.render(); return renderer.info.render.calls; };
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

// ---- pause / speed controls, save & load ----
const $ = (id: string): HTMLElement => document.getElementById(id)!;

function setSpeed(n: number): void {
  G.speed = n;
  for (const s of [1, 2, 3]) $(`spd-${s}`).classList.toggle('on', s === n);
}

function togglePause(): void {
  if (!G.started || G.gameOver) return;
  G.paused = !G.paused;
  $('btn-pause').textContent = G.paused ? '▶' : '⏸';
  $('btn-pause').classList.toggle('on', G.paused);
}

function doSave(): void {
  if (!G.started) { toast('Start the game first.'); return; }
  toast(saveGame() ? 'Game saved.' : 'Could not save.');
}

function doLoad(): void {
  if (!loadGame(scene)) { toast('No saved game found.'); return; }
  G.started = true;
  G.paused = false;
  G.gameOver = false;
  $('gameover').style.display = 'none';
  setSpeed(G.speed);
  $('btn-pause').textContent = '⏸';
  $('btn-pause').classList.remove('on');
  setSelection([], null);
  updateHud();
  refreshObjectives();
  refreshSelectionPanel();
  refreshChronicle();
  if (G.buildings.length) rig.jumpTo(G.buildings[0].x - 20, G.buildings[0].z - 30);
  toast('Game loaded.');
}

function initControls(): void {
  $('btn-pause').addEventListener('click', togglePause);
  for (const s of [1, 2, 3]) $(`spd-${s}`).addEventListener('click', () => setSpeed(s));
  $('btn-save').addEventListener('click', doSave);
  $('btn-load').addEventListener('click', doLoad);
  $('gameover-load').addEventListener('click', () => { $('gameover').style.display = 'none'; doLoad(); });
  $('gameover-restart').addEventListener('click', () => window.location.reload());
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key === '1') setSpeed(1);
    else if (e.key === '2') setSpeed(2);
    else if (e.key === '3') setSpeed(3);
  });
}

let autoSaveTimer = 0;
let laborTimer = 0;

// the settlement is wiped out — every villager has died (e.g. to bears)
function checkGameOver(): void {
  if (G.gameOver || !G.started) return;
  if (G.popCap > 0 && G.villagers.length === 0) {
    G.gameOver = true;
    G.paused = true;
    $('gameover').style.display = 'flex';
  }
}

// ---- main loop ----
const SIM_SCALE = 0.5; // global game-pace factor (half-speed base)
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

  if (!G.paused && !G.gameOver) {
    // overall game pace: the sim runs at half real-time at 1×, so the world feels
    // calmer. The 1/2/3 buttons still scale on top (1× = 0.5, 2× = 1.0, 3× = 1.5).
    const steps = Math.max(1, Math.min(3, Math.round(G.speed)));
    const sdt = dt * SIM_SCALE;
    for (let s = 0; s < steps; s++) {
      G.time += sdt;
      for (const v of G.villagers) v.update(sdt);
      for (const b of G.buildings) b.update(sdt, spawnVillager);
      updateWildlife(sdt);
      updatePopulation(sdt, spawnVillager);
      updateEras(sdt);
      updateChronicle(sdt);
    }
    checkGameOver();
    laborTimer += sdt * steps;
    if (laborTimer > 1.2) { laborTimer = 0; autoAssign(); }
    autoSaveTimer += sdt * steps;
    if (autoSaveTimer > 30) { autoSaveTimer = 0; saveGame(); }
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
    updateForestReveal(rig.target.x, rig.target.z, rig.dist);
  }

  composer.render();
}

boot();
