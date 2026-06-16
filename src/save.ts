import * as THREE from 'three';
import { G, ResKind } from './state';
import { Building, DEFS, BuildingPhase } from './buildings';
import { Villager, Profession } from './units';
import { ERAS } from './eras';

// ---------------------------------------------------------------------------
// Save / load to localStorage. We persist the *data* (resources, era, the list
// of buildings and villagers) and rebuild the Three.js scene from it via the
// normal constructors — meshes are never serialized. The forest/rock/bush nodes
// regenerate fresh from the seeded scatter (so the woods "regrow" on load); this
// keeps saves tiny and is a fine simplification for now.
// ---------------------------------------------------------------------------

const KEY = 'carols-legacy-save-v1';

interface SavedBuilding { key: string; x: number; z: number; phase: BuildingPhase; plotKey: string | null; rotY: number; progress: number }
interface SavedVillager { prof: Profession; x: number; z: number; hp: number }
interface SaveData {
  v: number;
  resources: Record<string, number>;
  eraIndex: number; year: number; time: number; speed: number;
  objectives: boolean[];
  chronicle: string[];
  buildings: SavedBuilding[];
  villagers: SavedVillager[];
}

export function hasSave(): boolean { return localStorage.getItem(KEY) !== null; }
export function clearSave(): void { localStorage.removeItem(KEY); }

export function saveGame(): boolean {
  try {
    const data: SaveData = {
      v: 1,
      resources: { ...G.resources },
      eraIndex: G.eraIndex, year: G.year, time: G.time, speed: G.speed,
      objectives: ERAS[G.eraIndex].objectives.map((o) => o.done),
      chronicle: [...G.chronicle],
      buildings: G.buildings.map((b) => ({
        key: b.def.key, x: b.x, z: b.z, phase: b.phase,
        plotKey: b.plotKey, rotY: b.group.rotation.y, progress: b.progress,
      })),
      villagers: G.villagers.map((v) => ({ prof: v.profession, x: v.x, z: v.z, hp: v.hp })),
    };
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

// Rebuild the whole settlement from a save. Returns false if there is no valid
// save. The caller is responsible for refreshing the HUD/objectives afterwards.
export function loadGame(scene: THREE.Scene): boolean {
  const raw = localStorage.getItem(KEY);
  if (!raw) return false;
  let data: SaveData;
  try { data = JSON.parse(raw); } catch { return false; }
  if (!data || data.v !== 1) return false;

  // tear down the current world entities
  for (const b of G.buildings.slice()) b.group.removeFromParent();
  G.buildings.length = 0;
  for (const v of G.villagers.slice()) v.group.removeFromParent();
  G.villagers.length = 0;
  for (const bear of G.bears.slice()) bear.group.removeFromParent();
  G.bears.length = 0;
  G.selected = [];
  G.selectedBuilding = null;
  G.popCap = 0; // re-accrued as finished buildings are rebuilt

  // scalar state
  for (const k of Object.keys(G.resources) as ResKind[]) G.resources[k] = data.resources[k] ?? 0;
  G.eraIndex = data.eraIndex;
  G.year = data.year;
  G.time = data.time;
  G.speed = data.speed || 1;
  G.gameOver = false;
  G.chronicle = Array.isArray(data.chronicle) ? [...data.chronicle] : [];

  // buildings (popCap re-accrues through each finished building's finish())
  for (const sb of data.buildings) {
    if (!DEFS[sb.key]) continue;
    const b = new Building(sb.key, sb.x, sb.z, sb.phase, scene, sb.rotY);
    b.plotKey = sb.plotKey;
    if (sb.phase === 'site') b.restoreProgress(sb.progress);
  }
  // villagers
  for (const sv of data.villagers) {
    const v = new Villager(sv.x, sv.z, scene, sv.prof);
    v.hp = Math.max(1, Math.min(v.maxHp, sv.hp));
  }
  // era objective flags
  const objs = ERAS[G.eraIndex].objectives;
  for (let i = 0; i < objs.length && i < data.objectives.length; i++) objs[i].done = data.objectives[i];

  return true;
}
