import { G } from './state';
import { Building } from './buildings';

// ---------------------------------------------------------------------------
// Banished-style labour: you don't command individual people. Idle villagers
// assign themselves to the nearest place that needs them — an open job position
// (workplace whose assigned < desired) or a construction site short of builders.
// Only IDLE villagers are pulled, so a manual order is never overridden.
// ---------------------------------------------------------------------------

const MAX_BUILDERS = 3; // villagers that will pile onto one construction site

export function autoAssign(): void {
  const idle = G.villagers.filter((v) => v.alive && v.isIdle && !v.sheltered);
  if (idle.length === 0) return;
  for (const v of idle) {
    let best: Building | null = null;
    let bd = Infinity;
    let mode: 'work' | 'build' = 'work';
    for (const b of G.buildings) {
      let need = false;
      let m: 'work' | 'build' = 'work';
      if (b.phase === 'done' && b.openPositions() > 0) { need = true; m = 'work'; }
      else if (b.phase === 'site' && b.builderCount() < MAX_BUILDERS) { need = true; m = 'build'; }
      if (!need) continue;
      const d = (b.x - v.x) ** 2 + (b.z - v.z) ** 2;
      if (d < bd) { bd = d; best = b; mode = m; }
    }
    if (best) {
      if (mode === 'work') v.orderWork(best);
      else v.orderBuild(best);
    }
  }
}
