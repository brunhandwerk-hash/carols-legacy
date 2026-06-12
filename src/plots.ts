// Fixed landmark sites, laid out to match the real geography of Sinaia:
// the monastery on its knoll; the Peles complex strung along the Peles creek
// road climbing north-west; park, casino, hotels and station on the valley
// floor; interwar villas on the southern slopes.
export interface Plot {
  key: string;
  name: string;
  x: number; z: number;
  r: number;          // flattened radius
  era: number;        // era index in which it becomes buildable
}

export const PLOTS: Plot[] = [
  { key: 'monastery',  name: 'Sinaia Monastery',      x: -45,  z: -35,  r: 22, era: 0 },
  { key: 'oldinn',     name: 'Pilgrims’ Inn',    x: -18,  z: -12,  r: 9,  era: 1 },
  { key: 'economat',   name: 'Economat',              x: -95,  z: -120, r: 10, era: 2 },
  { key: 'cavalerilor',name: 'Casa Cavalerilor',      x: -113, z: -142, r: 9,  era: 2 },
  { key: 'guard',      name: 'Corpul de Gardă',  x: -128, z: -160, r: 8,  era: 2 },
  { key: 'foisor',     name: 'Foișor Lodge',     x: -152, z: -188, r: 11, era: 2 },
  { key: 'peles',      name: 'Peleș Castle',     x: -198, z: -228, r: 20, era: 2 },
  { key: 'station',    name: 'Royal Railway Station', x: 78,   z: 38,   r: 12, era: 2 },
  { key: 'furnica',    name: 'Hotel Furnica',         x: -85,  z: -68,  r: 11, era: 3 },
  { key: 'pelisor',    name: 'Pelișor Castle',   x: -172, z: -205, r: 12, era: 3 },
  { key: 'caraiman',   name: 'Hotel Caraiman',        x: 22,   z: 55,   r: 11, era: 3 },
  { key: 'palace',     name: 'Hotel Palace',          x: 8,    z: 14,   r: 11, era: 3 },
  { key: 'casino',     name: 'Sinaia Casino',         x: 32,   z: 28,   r: 13, era: 3 },
  { key: 'townhall',   name: 'Town Hall',             x: -4,   z: 78,   r: 9,  era: 3 },
  { key: 'villa1',     name: 'Villa Luminiș',    x: 35,   z: 150,  r: 8,  era: 5 },
  { key: 'villa2',     name: 'Interwar Villa',        x: -28,  z: 130,  r: 8,  era: 5 },
  { key: 'villa3',     name: 'Interwar Villa',        x: 10,   z: 195,  r: 8,  era: 5 },
];

export function plotByKey(key: string): Plot {
  const p = PLOTS.find((p) => p.key === key);
  if (!p) throw new Error(`unknown plot ${key}`);
  return p;
}
