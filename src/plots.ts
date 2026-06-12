// Fixed landmark sites at their real coordinates in Sinaia. World x/z are
// computed from lat/lon once the DEM is loaded (initPlots).
import { lonLatToWorld } from './terrain';

export interface Plot {
  key: string;
  name: string;
  lat: number; lon: number;
  x: number; z: number;   // filled by initPlots()
  r: number;              // flattened radius
  era: number;            // era index in which it becomes buildable
}

const def = (key: string, name: string, lat: number, lon: number, r: number, era: number): Plot =>
  ({ key, name, lat, lon, x: 0, z: 0, r, era });

export const PLOTS: Plot[] = [
  def('monastery',   'Sinaia Monastery',      45.3559, 25.5479, 22, 0),
  def('oldinn',      'Pilgrims’ Inn',    45.3548, 25.5492, 9,  1),
  def('economat',    'Economat',              45.3590, 25.5450, 10, 2),
  def('cavalerilor', 'Casa Cavalerilor',      45.3596, 25.5443, 9,  2),
  def('guard',       'Corpul de Gardă',  45.3601, 25.5436, 8,  2),
  def('foisor',      'Foișor Lodge',     45.3555, 25.5375, 11, 2),
  def('peles',       'Peleș Castle',     45.3604, 25.5421, 20, 2),
  def('station',     'Royal Railway Station', 45.3497, 25.5506, 12, 2),
  def('furnica',     'Hotel Furnica',         45.3548, 25.5458, 11, 3),
  def('pelisor',     'Pelișor Castle',   45.3590, 25.5414, 12, 3),
  def('caraiman',    'Hotel Caraiman',        45.3516, 25.5491, 11, 3),
  def('palace',      'Hotel Palace',          45.3527, 25.5484, 11, 3),
  def('casino',      'Sinaia Casino',         45.3522, 25.5478, 13, 3),
  def('townhall',    'Town Hall',             45.3504, 25.5483, 9,  3),
  def('villa1',      'Villa Luminiș',    45.3585, 25.5570, 8,  5),
  def('villa2',      'Interwar Villa',        45.3460, 25.5520, 8,  5),
  def('villa3',      'Interwar Villa',        45.3430, 25.5535, 8,  5),
];

// the starting hamlet: valley floor by the Prahova, south of the future town
export const CAMP_GEO = { lat: 45.3455, lon: 25.5525 };

export function initPlots(): void {
  for (const p of PLOTS) {
    const w = lonLatToWorld(p.lon, p.lat);
    p.x = w.x; p.z = w.z;
  }
}

export function plotByKey(key: string): Plot {
  const p = PLOTS.find((p) => p.key === key);
  if (!p) throw new Error(`unknown plot ${key}`);
  return p;
}
