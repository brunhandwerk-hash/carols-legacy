import { G, ResourceNode } from './state';
import { Building } from './buildings';

// ---------------------------------------------------------------------------
// Banished-style labour: you don't command individual people. Idle villagers
// assign themselves to the nearest place that needs them — an open job position
// (workplace whose assigned < desired) or a construction site short of builders.
// Only IDLE villagers are pulled, so a manual order is never overridden.
// ---------------------------------------------------------------------------

const MAX_BUILDERS = 1; // one villager per construction site (no piling on)
const CRITICAL = 25;    // below this, a resource is "in trouble" and gets priority

// nearest living node of a given kind to a point
function nearestNode(kind: 'wood' | 'food', x: number, z: number): ResourceNode | null {
  let best: ResourceNode | null = null;
  let bd = Infinity;
  for (const n of G.nodes) {
    if (!n.alive || n.kind !== kind) continue;
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

export function autoAssign(): void {
  // Available = idle OR already auto-gathering (the latter is interruptible — a
  // labour fallback, not a manual order). This lets construction pull villagers
  // off gathering. Manual gather orders (autoGather === false) are never touched.
  const avail = G.villagers.filter(
    (v) => v.alive && !v.sheltered && (v.isIdle || (v.task.kind === 'gather' && v.autoGather)),
  );
  let gatherIdx = 0; // alternates idle gatherers between wood and food
  for (const v of avail) {
    // PRIORITY 1: construction sites short of builders (recomputed per villager,
    // so builderCount reflects ones we just assigned and caps at MAX_BUILDERS).
    let best: Building | null = null;
    let bd = Infinity;
    for (const b of G.buildings) {
      if (b.phase !== 'site' || b.builderCount() >= MAX_BUILDERS || v.cannotReach(b)) continue;
      const d = (b.x - v.x) ** 2 + (b.z - v.z) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    if (best) { v.orderBuild(best); continue; }

    // PRIORITY 2: open job positions at finished workplaces (skip ones this
    // villager has found unreachable — e.g. a quarry across an un-bridged river).
    bd = Infinity;
    for (const b of G.buildings) {
      if (b.phase !== 'done' || b.openPositions() <= 0 || v.cannotReach(b)) continue;
      const d = (b.x - v.x) ** 2 + (b.z - v.z) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    if (best) { v.orderWork(best); continue; }

    // PRIORITY 3: gather wood/food (only assign IDLE villagers a NEW gather — an
    // already-auto-gathering villager just keeps going, no churn). Critically-low
    // resource first, otherwise split idle gatherers evenly between wood and food.
    if (!v.isIdle) continue; // already auto-gathering and nothing better to do
    const wood = G.resources.wood, food = G.resources.food;
    let kind: 'wood' | 'food';
    if (food < CRITICAL && food <= wood) kind = 'food';
    else if (wood < CRITICAL && wood < food) kind = 'wood';
    else kind = (gatherIdx % 2 === 0) ? 'wood' : 'food';
    let node = nearestNode(kind, v.x, v.z);
    if (!node) node = nearestNode(kind === 'wood' ? 'food' : 'wood', v.x, v.z); // none of that kind left
    if (node) { v.orderGather(node); v.autoGather = true; gatherIdx++; }
  }

  // GUARANTEE: every commissioned construction site gets at least one builder.
  // The loop above only moves idle/auto-gathering hands, so a fully-staffed town
  // (everyone working a job) would leave a started landmark — e.g. the monastery —
  // sitting at 0%. If a reachable site still has nobody building it, pull the
  // nearest job-worker off their post to build it. Capped at MAX_BUILDERS and
  // skipped once a builder is en route, so there's no churn.
  for (const b of G.buildings) {
    if (b.phase !== 'site' || b.builderCount() >= MAX_BUILDERS) continue;
    let worker: typeof G.villagers[number] | null = null;
    let bd = Infinity;
    for (const v of G.villagers) {
      if (!v.alive || v.sheltered || v.task.kind !== 'work' || v.cannotReach(b)) continue;
      const d = (b.x - v.x) ** 2 + (b.z - v.z) ** 2;
      if (d < bd) { bd = d; worker = v; }
    }
    if (worker) worker.orderBuild(b);
  }
}
