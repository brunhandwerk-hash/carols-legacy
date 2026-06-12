// Map coordinates: +x = east, +z = south, y = up. Units ~ metres (stylized).
export const MAP = {
  minX: -260, maxX: 260,
  minZ: -340, maxZ: 340,
  width: 520, depth: 680,
};

export const PALETTE = {
  sky: 0xbdd2e0,
  fog: 0xd8e0e2,
  sun: 0xfff1d6,
  grassLow: 0x8fae5a,
  grassHigh: 0x7d9c54,
  meadow: 0xa3bd6a,
  forestFloor: 0x5d7a42,
  rock: 0x8d8678,
  rockHigh: 0xa8a298,
  snow: 0xeef2f4,
  water: 0x5d8fa8,
  dirt: 0x9c7e58,
  pineDark: 0x3d5e3a,
  pineMid: 0x4c7045,
  trunk: 0x6e5238,
};

export const START = {
  wood: 80,
  stone: 0,
  food: 80,
  villagers: 4,
  // hamlet on the valley floor, south of the future park, west bank of the Prahova
  camp: { x: 30, z: 105 },
};
