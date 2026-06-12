import type * as THREE from 'three';
import type { Villager } from './units';
import type { Building } from './buildings';

export type ResKind = 'wood' | 'stone' | 'food';

export interface ResourceNode {
  kind: ResKind;
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
  nodes: ResourceNode[];
  selected: Villager[];
  selectedBuilding: Building | null;
  paused: boolean;
  time: number;
}

export const G: GameState = {
  resources: { wood: 0, stone: 0, food: 0 },
  popCap: 0,
  eraIndex: 0,
  year: 1690,
  villagers: [],
  buildings: [],
  nodes: [],
  selected: [],
  selectedBuilding: null,
  paused: true,
  time: 0,
};

export function canAfford(cost: Partial<Record<ResKind, number>>): boolean {
  return (['wood', 'stone', 'food'] as ResKind[]).every(
    (k) => G.resources[k] >= (cost[k] ?? 0),
  );
}

export function pay(cost: Partial<Record<ResKind, number>>): void {
  for (const k of ['wood', 'stone', 'food'] as ResKind[]) {
    G.resources[k] -= cost[k] ?? 0;
  }
}

export function pop(): number {
  return G.villagers.length;
}
