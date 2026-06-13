import { G } from './state';
import { START } from './config';

// ---------------------------------------------------------------------------
// Banished-style population: settlers aren't trained — the town grows on its
// own. Every villager eats from the food stockpile; while there's a food
// surplus AND free housing (pop < popCap), new settlers arrive over time. If the
// larder runs dry, villagers starve. (Times are in game-seconds.)
// ---------------------------------------------------------------------------

const EAT_RATE = 0.05;      // food per villager per second
const GROW_RESERVE = 25;    // food cushion needed before the town grows
const GROW_RATE = 1 / 22;   // new settlers per second of sustained surplus
const STARVE_INTERVAL = 18; // seconds of famine before someone starves

let growthAccum = 0;
let starveTimer = 0;
let onBirth: (() => void) | null = null;
let onStarve: (() => void) | null = null;

export function setPopulationCallbacks(birth: () => void, starve: () => void): void {
  onBirth = birth; onStarve = starve;
}

export function updatePopulation(dt: number, spawn: (x: number, z: number) => void): void {
  const pop = G.villagers.length;
  if (pop === 0) return;

  const eat = pop * EAT_RATE * dt;
  if (G.resources.food >= eat) {
    G.resources.food -= eat;
    starveTimer = 0;
    // grow while there's a cushion of food and a roof to spare
    if (G.resources.food > GROW_RESERVE && pop < G.popCap) {
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
  } else {
    // famine — the stockpile is empty
    G.resources.food = 0;
    growthAccum = 0;
    starveTimer += dt;
    if (starveTimer >= STARVE_INTERVAL) {
      starveTimer = 0;
      const v = G.villagers[G.villagers.length - 1];
      if (v) v.takeDamage(999); // the weakest succumbs
      onStarve?.();
    }
  }
}
