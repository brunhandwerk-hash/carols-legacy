// Map coordinates: +x = east, +z = south, y = up. Units = metres.
// Real extents are set from the DEM metadata in loadDem() — these are placeholders.
export const MAP = {
  minX: -3129, maxX: 3129,
  minZ: -3612, maxZ: 3612,
  width: 6258, depth: 7224,
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
  // hamlet position is set from CAMP_GEO (plots.ts) once the DEM is loaded
  camp: { x: 0, z: 0 },
};
