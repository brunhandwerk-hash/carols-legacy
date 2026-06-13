import * as YUKA from 'yuka';
import { MAP } from './config';
import { walkable } from './terrain';
import { G } from './state';

// ---------------------------------------------------------------------------
// Grid A* pathfinding (Yuka) so units route AROUND buildings and impassable
// slopes instead of bumping and deflecting. The grid is built locally per
// request — only over the bounding box of start↔goal (plus a margin), with an
// adaptive cell size so the node count stays ~1600 regardless of distance. This
// keeps every query cheap and never explores the whole 6×7 km map.
// ---------------------------------------------------------------------------

const MARGIN = 120;

function inBuilding(x: number, z: number): boolean {
  for (const b of G.buildings) {
    if (b.phase === 'planned' || b.def.noFoundation) continue; // bridges are crossable
    const r = b.def.radius + 1.5;
    if ((b.x - x) ** 2 + (b.z - z) ** 2 < r * r) return true;
  }
  return false;
}

function clear(x: number, z: number): boolean {
  return walkable(x, z) && !inBuilding(x, z);
}

// line-of-sight: every sampled point along the segment is clear ground
function los(ax: number, az: number, bx: number, bz: number): boolean {
  const d = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(d / 6));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!clear(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
  }
  return true;
}

// Waypoints from (sx,sz) to (tx,tz) that avoid obstacles. The last point is the
// exact target. If the straight line is already clear — or no path is found —
// returns just [target] so the caller falls back to a direct walk.
export function findPath(sx: number, sz: number, tx: number, tz: number): { x: number; z: number }[] {
  if (los(sx, sz, tx, tz)) return [{ x: tx, z: tz }];

  const minX = Math.max(MAP.minX, Math.min(sx, tx) - MARGIN);
  const maxX = Math.min(MAP.maxX, Math.max(sx, tx) + MARGIN);
  const minZ = Math.max(MAP.minZ, Math.min(sz, tz) - MARGIN);
  const maxZ = Math.min(MAP.maxZ, Math.max(sz, tz) + MARGIN);
  const bw = maxX - minX, bh = maxZ - minZ;
  const cell = Math.min(60, Math.max(12, Math.max(bw, bh) / 40));
  const cols = Math.max(2, Math.ceil(bw / cell));
  const rows = Math.max(2, Math.ceil(bh / cell));
  const cw = bw / cols, ch = bh / rows;
  const wx = (c: number): number => minX + (c + 0.5) * cw;
  const wz = (r: number): number => minZ + (r + 0.5) * ch;
  const idx = (c: number, r: number): number => r * cols + c;

  const graph = new YUKA.Graph();
  graph.digraph = true;
  const ok: boolean[] = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(c, r);
      const x = wx(c), z = wz(r);
      ok[i] = clear(x, z);
      graph.addNode(new YUKA.NavNode(i, new YUKA.Vector3(x, 0, z)));
    }
  }
  const NB: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!ok[idx(c, r)]) continue;
      for (const [dc, dr] of NB) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || !ok[idx(nc, nr)]) continue;
        graph.addEdge(new YUKA.Edge(idx(c, r), idx(nc, nr), Math.hypot(dc * cw, dr * ch)));
      }
    }
  }

  const nearestWalkable = (px: number, pz: number): number => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < cols * rows; i++) {
      if (!ok[i]) continue;
      const n = graph.getNode(i);
      const d = (n.position.x - px) ** 2 + (n.position.z - pz) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const s = nearestWalkable(sx, sz), t = nearestWalkable(tx, tz);
  if (s < 0 || t < 0) return [{ x: tx, z: tz }];

  const astar = new YUKA.AStar(graph, s, t);
  astar.search();
  if (!astar.found) return [{ x: tx, z: tz }];

  const pts = (astar.getPath() as number[]).map((i) => {
    const n = graph.getNode(i);
    return { x: n.position.x, z: n.position.z };
  });
  pts.push({ x: tx, z: tz });

  // string-pull: collapse the grid path to as few corners as line-of-sight allows
  const out: { x: number; z: number }[] = [];
  let ax = sx, az = sz, j = 0;
  while (j < pts.length) {
    let k = pts.length - 1;
    while (k > j && !los(ax, az, pts[k].x, pts[k].z)) k--;
    out.push(pts[k]);
    ax = pts[k].x; az = pts[k].z; j = k + 1;
  }
  return out;
}
