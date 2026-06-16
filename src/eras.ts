import type * as THREE from 'three';
import { G, pop } from './state';
import { Building, DEFS, reskinAllBuildings } from './buildings';
import { PLOTS } from './plots';
import { showBanner, refreshObjectives, toast } from './ui';

export interface Objective {
  id: string;
  text: string;
  check: () => boolean;
  done: boolean;
}

export interface Era {
  yearLabel: string;
  enterYear: number;
  name: string;
  introTitle: string;
  introText: string;
  objectives: Objective[];
}

function obj(id: string, text: string, check: () => boolean): Objective {
  return { id, text, check, done: false };
}

function landmarkDone(key: string): boolean {
  return G.buildings.some((b) => b.plotKey === key && b.phase === 'done');
}

function hasGatherCamp(): boolean {
  return G.buildings.some(
    (b) => b.phase === 'done' && (b.def.key === 'lumbercamp' || b.def.key === 'quarry' || b.def.key === 'forager'),
  );
}

function hasRefinery(): boolean {
  return G.buildings.some(
    (b) => b.phase === 'done' && (b.def.key === 'sawmill' || b.def.key === 'stonecutter'),
  );
}

function hasBridge(): boolean {
  return G.buildings.some(
    (b) => b.phase === 'done' && (b.def.key === 'bridge' || b.def.key === 'bridge_stone'),
  );
}

function builtDone(key: string): boolean {
  return G.buildings.some((b) => b.phase === 'done' && b.def.key === key);
}

export const ERAS: Era[] = [
  {
    yearLabel: 'Anno 1690', enterYear: 1690,
    name: 'The Hermits’ Valley',
    introTitle: 'The Hermits’ Valley',
    introText: 'Spătar Mihail Cantacuzino has vowed to raise a monastery in this wild valley, named for holy Mount Sinai. Gather timber and stone — then raise a Stonecutter’s Yard to dress rough stone into the blocks a monastery needs, and a Sawmill to saw planks for finer work.',
    objectives: [
      obj('gathercamp', 'Raise a Lumber Camp or Quarry to work the land faster', () => hasGatherCamp()),
      obj('refine', 'Raise a Sawmill or Stonecutter’s Yard to refine raw goods', () => hasRefinery()),
      obj('bridge', 'Bridge the Prahova to reach the far bank', () => hasBridge()),
      obj('monastery', 'Build the Sinaia Monastery (needs dressed stone blocks)', () => landmarkDone('monastery')),
      obj('pop8', 'Grow the settlement to 8 souls', () => pop() >= 8),
      obj('food100', 'Stockpile 100 food for the consecration feast', () => G.resources.food >= 100),
    ],
  },
  {
    yearLabel: '1695 – 1866', enterYear: 1695,
    name: 'The Monastery Village',
    introTitle: 'The Monastery Is Consecrated',
    introText: 'On the feast of the Assumption, 1695, the bells ring for the first time. The monastery’s offerings begin to fill a treasury of coin — wealth that, with the tolls of pilgrims lodging over the Predeal pass, will one day raise a town fit for kings.',
    objectives: [
      obj('treasury', 'Let the monastery’s offerings fill the treasury to 100 coin', () => G.resources.coin >= 100),
      obj('inn', 'Build the Pilgrims’ Inn beside the monastery (60 coin)', () => landmarkDone('oldinn')),
      obj('pop14', 'Grow the village to 14 souls', () => pop() >= 14),
      obj('wood300', 'Stockpile 300 wood for the village’s growth', () => G.resources.wood >= 300),
    ],
  },
  {
    yearLabel: 'Anno 1866', enterYear: 1866,
    name: 'The King Arrives',
    introTitle: 'A Prince at the Monastery Gate',
    introText: 'August 1866. Prince Carol of Hohenzollern, newly called to Romania’s throne, lodges at the monastery — and falls in love with the valley. First bring industry to the town: a lime kiln and a nail forge to feed the railway and the castle. Then raise the Royal Station, the lodge and estate houses, and at last Peleș itself.',
    objectives: [
      obj('industry', 'Bring industry to Sinaia — raise a Lime Kiln and a Nail Forge', () => builtDone('limekiln') && builtDone('nailforge')),
      obj('station', 'Build the Royal Railway Station to bring the King’s train', () => landmarkDone('station')),
      obj('foisor', 'Raise Foișor Lodge for the royal household', () => landmarkDone('foisor')),
      obj('estate', 'Complete the estate service buildings (Economat, Casa Cavalerilor, Corpul de Gardă)',
        () => landmarkDone('economat') && landmarkDone('cavalerilor') && landmarkDone('guard')),
      obj('peles', 'Build Peleș Castle — the crown of the valley', () => landmarkDone('peles')),
      obj('pop30', 'Grow the town to 30 souls', () => pop() >= 30),
    ],
  },
];

let sceneRef: THREE.Scene | null = null;

export function initEras(scene: THREE.Scene): void {
  sceneRef = scene;
  spawnEraPlots(0);
  refreshObjectives();
}

// place 'planned' signposts for every landmark of the era that has a definition
function spawnEraPlots(eraIdx: number): void {
  if (!sceneRef) return;
  for (const p of PLOTS) {
    if (p.era !== eraIdx) continue;
    spawnPlot(p.key);
  }
}

// drop a single landmark's 'planned' signpost on the map (idempotent). Returns
// true only the first time it actually spawns, so callers can announce it once.
function spawnPlot(key: string): boolean {
  if (!sceneRef) return false;
  const p = PLOTS.find((pp) => pp.key === key);
  if (!p || !DEFS[key]) return false;                       // later-era landmarks not yet implemented
  if (G.buildings.some((b) => b.plotKey === key)) return false;
  const b = new Building(key, p.x, p.z, 'planned', sceneRef);
  b.plotKey = key;
  return true;
}

let bannerCooldown = 0;

export function updateEras(dt: number): void {
  bannerCooldown -= dt;
  // The Pilgrims' Inn sits right beside the monastery, so make it buildable the
  // moment the monastery stands — rather than waiting for the whole era to turn
  // over. (Landmarks are placed by clicking their signpost, not from the build
  // bar, so without this the player has no way to start it.)
  if (landmarkDone('monastery') && spawnPlot('oldinn')) {
    toast('The Pilgrims’ Inn can now be raised beside the monastery — select its signpost to begin.');
  }
  const era = ERAS[G.eraIndex];
  let changed = false;
  for (const o of era.objectives) {
    if (!o.done && o.check()) {
      o.done = true;
      changed = true;
      toast(`Objective complete: ${o.text}`);
    }
  }
  if (changed) refreshObjectives();
  if (era.objectives.every((o) => o.done) && G.eraIndex < ERAS.length - 1 && bannerCooldown <= 0) {
    advanceEra();
  }
}

function advanceEra(): void {
  G.eraIndex++;
  bannerCooldown = 8;
  const era = ERAS[G.eraIndex];
  G.year = era.enterYear;
  reskinAllBuildings(); // dwellings age into the new era's style (wood→plaster→brick)
  spawnEraPlots(G.eraIndex);
  showBanner(era.yearLabel, era.introTitle, era.introText);
  refreshObjectives();
}
