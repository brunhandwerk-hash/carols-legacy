import type * as THREE from 'three';
import type { Villager } from './units';
import type { Building } from './buildings';
import type { Bear } from './wildlife';

export type ResKind = 'wood' | 'stone' | 'food' | 'coin';

// canonical order — drives HUD, affordability checks, cost rendering
export const RES_KINDS: ResKind[] = ['wood', 'stone', 'food', 'coin'];

// kinds a villager can physically gather from a node (coin is building-generated)
export type GatherKind = 'wood' | 'stone' | 'food';

export interface ResourceNode {
  kind: GatherKind;
  x: number; z: number;
  amount: number;
  alive: boolean;
  // instanced-mesh bookkeeping so we can hide depleted nodes
  mesh: THREE.InstancedMesh[];
  index: number;
}

export interface GameState {
  resources: Record<ResKind, number>;
  popCap: number;
  eraIndex: number;
  year: number;
  villagers: Villager[];
  buildings: Building[];
  bears: Bear[];
  nodes: ResourceNode[];
  selected: Villager[];
  selectedBuilding: Building | null;
  paused: boolean;
  time: number;
  speed: number;      // game-speed multiplier (1 / 2 / 3)
  started: boolean;   // the intro has been dismissed and play has begun
  gameOver: boolean;
}

export const G: GameState = {
  resources: { wood: 0, stone: 0, food: 0, coin: 0 },
  popCap: 0,
  eraIndex: 0,
  year: 1690,
  villagers: [],
  buildings: [],
  bears: [],
  nodes: [],
  selected: [],
  selectedBuilding: null,
  paused: true,
  time: 0,
  speed: 1,
  started: false,
  gameOver: false,
};

export function canAfford(cost: Partial<Record<ResKind, number>>): boolean {
  return RES_KINDS.every((k) => G.resources[k] >= (cost[k] ?? 0));
}

export function pay(cost: Partial<Record<ResKind, number>>): void {
  for (const k of RES_KINDS) {
    G.resources[k] -= cost[k] ?? 0;
  }
}

export function pop(): number {
  return G.villagers.length;
}
