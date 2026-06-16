import { G } from './state';
import { START } from './config';

// ---------------------------------------------------------------------------
// Banished-style population: settlers aren't trained — the town grows on its
// own. Every villager has needs met from the stockpiles by their very existence:
// they EAT food, BURN wood as firewood for heat, and DRINK water. While all are in
// surplus AND there's free housing (pop < popCap), new settlers arrive. An empty
// larder starves them; with no firewood OR no water they suffer and lose health
// (recovering once fed, warm and watered). (All times are in game-seconds.)
// ---------------------------------------------------------------------------

export const EAT_RATE = 0.05;   // food per villager per second
export const WARM_RATE = 0.02;  // wood (firewood) burned per villager per second
export const DRINK_RATE = 0.03; // water drunk per villager per second
const GROW_RESERVE = 25;    // food cushion needed before the town grows
const WOOD_RESERVE = 20;    // firewood cushion needed before the town grows
const WATER_RESERVE = 15;   // water cushion needed before the town grows
const GROW_RATE = 1 / 22;   // new settlers per second of sustained surplus
const STARVE_INTERVAL = 18; // seconds of famine before someone starves
const NEED_DPS = 0.5;       // hp lost per villager per second while cold OR thirsty
const RECOVER_DPS = 0.5;    // hp regained per villager per second when all needs met
const WARN_INTERVAL = 6;    // min seconds between cold/thirst warnings

let growthAccum = 0;
let starveTimer = 0;
let coldWarnTimer = 0;
let thirstWarnTimer = 0;
let onBirth: (() => void) | null = null;
let onStarve: (() => void) | null = null;
let onCold: (() => void) | null = null;
let onThirst: (() => void) | null = null;

export function setPopulationCallbacks(
  birth: () => void, starve: () => void, cold?: () => void, thirst?: () => void,
): void {
  onBirth = birth; onStarve = starve; onCold = cold ?? null; onThirst = thirst ?? null;
}

export function updatePopulation(dt: number, spawn: (x: number, z: number) => void): void {
  const pop = G.villagers.length;
  if (pop === 0) return;

  // --- food: eat from the larder; an empty larder starves the weakest ---
  let fed = true;
  const eat = pop * EAT_RATE * dt;
  if (G.resources.food >= eat) {
    G.resources.food -= eat;
    starveTimer = 0;
  } else {
    fed = false;
    G.resources.food = 0;
    starveTimer += dt;
    if (starveTimer >= STARVE_INTERVAL) {
      starveTimer = 0;
      const v = G.villagers[G.villagers.length - 1];
      if (v) v.takeDamage(999); // the weakest succumbs
      onStarve?.();
    }
  }

  // --- firewood: burn wood for heat; with none, the town goes cold ---
  let warm = true;
  const burn = pop * WARM_RATE * dt;
  if (G.resources.wood >= burn) {
    G.resources.wood -= burn;
  } else {
    warm = false;
    G.resources.wood = 0;
  }

  // --- water: drink from the supply; with none, the town goes thirsty ---
  let hydrated = true;
  const drink = pop * DRINK_RATE * dt;
  if (G.resources.water >= drink) {
    G.resources.water -= drink;
  } else {
    hydrated = false;
    G.resources.water = 0;
  }

  // --- growth: only with a cushion of ALL needs and a roof to spare ---
  if (fed && warm && hydrated && G.resources.food > GROW_RESERVE && G.resources.wood > WOOD_RESERVE
      && G.resources.water > WATER_RESERVE && pop < G.popCap) {
    growthAccum += GROW_RATE * dt;
    if (growthAccum >= 1) {
      growthAccum -= 1;
      const home = G.buildings.find((b) => b.phase === 'done' && b.def.trains)
        ?? G.buildings.find((b) => b.phase === 'done');
      const hx = home ? home.x : START.camp.x;
      const hz = home ? home.z : START.camp.z;
      const r = home ? home.def.radius + 2 : 8;
      spawn(hx + (Math.random() - 0.5) * 8, hz + r + (Math.random() - 0.5) * 4);
      onBirth?.();
    }
  } else {
    growthAccum = Math.max(0, growthAccum - dt * 0.2);
  }

  // --- suffering / recovery: cold (no firewood) or thirst (no water) drains health;
  // villagers mend once fed, warm AND watered ---
  coldWarnTimer = Math.max(0, coldWarnTimer - dt);
  thirstWarnTimer = Math.max(0, thirstWarnTimer - dt);
  if (!warm || !hydrated) {
    for (const v of G.villagers.slice()) if (v.alive) v.takeDamage(NEED_DPS * dt);
    if (!warm && coldWarnTimer === 0) { coldWarnTimer = WARN_INTERVAL; onCold?.(); }
    if (!hydrated && thirstWarnTimer === 0) { thirstWarnTimer = WARN_INTERVAL; onThirst?.(); }
  } else if (fed) {
    for (const v of G.villagers) if (v.alive && v.hp < v.maxHp) v.hp = Math.min(v.maxHp, v.hp + RECOVER_DPS * dt);
  }
}
