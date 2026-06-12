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
  { key: 'monastery',  name: 'Sinaia Monastery',      x: -90,  z: -120, r: 22, era: 0 },
  { key: 'oldinn',     name: 'Pilgrims’ Inn',    x: -52,  z: -75,  r: 9,  era: 1 },
  { key: 'economat',   name: 'Economat',              x: -200, z: -260, r: 10, era: 2 },
  { key: 'cavalerilor',name: 'Casa Cavalerilor',      x: -240, z: -300, r: 9,  era: 2 },
  { key: 'guard',      name: 'Corpul de Gardă',  x: -275, z: -340, r: 8,  era: 2 },
  { key: 'foisor',     name: 'Foișor Lodge',     x: -290, z: -545, r: 11, era: 2 },
  { key: 'peles',      name: 'Peleș Castle',     x: -400, z: -430, r: 20, era: 2 },
  { key: 'station',    name: 'Royal Railway Station', x: 170,  z: 90,   r: 12, era: 2 },
  { key: 'furnica',    name: 'Hotel Furnica',         x: -160, z: -200, r: 11, era: 3 },
  { key: 'pelisor',    name: 'Pelișor Castle',   x: -350, z: -470, r: 12, era: 3 },
  { key: 'caraiman',   name: 'Hotel Caraiman',        x: 30,   z: 120,  r: 11, era: 3 },
  { key: 'palace',     name: 'Hotel Palace',          x: 40,   z: 40,   r: 11, era: 3 },
  { key: 'casino',     name: 'Sinaia Casino',         x: 75,   z: 95,   r: 13, era: 3 },
  { key: 'townhall',   name: 'Town Hall',             x: -10,  z: 170,  r: 9,  era: 3 },
  { key: 'villa1',     name: 'Villa Luminiș',    x: 290,  z: -100, r: 8,  era: 5 },
  { key: 'villa2',     name: 'Interwar Villa',        x: -60,  z: 280,  r: 8,  era: 5 },
  { key: 'villa3',     name: 'Interwar Villa',        x: 40,   z: 420,  r: 8,  era: 5 },
];

export function plotByKey(key: string): Plot {
  const p = PLOTS.find((p) => p.key === key);
  if (!p) throw new Error(`unknown plot ${key}`);
  return p;
}
