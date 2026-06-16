import { G } from './state';
import { showBanner, setEraLabel } from './ui';

// ---------------------------------------------------------------------------
// The Chronicle of Sinaia: short historical vignettes that surface as the town
// grows. Each is keyed by the building key whose *completion* reveals it (the
// landmarks set b.plotKey === b.def.key, so recordChronicle fires from
// onBuildingComplete when a landmark finishes). When a snippet first unlocks it
// pops as a banner; it is also kept in G.chronicle and can be re-read anytime
// from the Chronicle panel. Text drawn from docs/research-sinaia.md.
// ---------------------------------------------------------------------------

export interface ChronicleEntry {
  year: string;   // display label, e.g. '15 Aug 1695'
  title: string;
  text: string;
}

export const CHRONICLE: Record<string, ChronicleEntry> = {
  founding: {
    year: 'Anno 1690',
    title: 'A Vow in the Wild Valley',
    text: 'Between the cliffs of the Bucegi and the wooded Baiu ridge, a handful of shepherds and woodsmen live in scattered huts beside a cold mountain river. Spătar Mihail Cantacuzino, returned from a pilgrimage to Mount Sinai, has vowed to raise a monastery here — and around it, in time, a town that kings will call home.',
  },
  monastery: {
    year: '15 Aug 1695',
    title: 'The Monastery Is Consecrated',
    text: 'On the feast of the Assumption the church Spătar Mihail Cantacuzino vowed after his pilgrimage to Mount Sinai is consecrated. Built in the Brâncovenesc style for a brotherhood of twelve monks, it gives the valley both its faith and its name — Sinaia.',
  },
  oldinn: {
    year: 'c. 1700',
    title: 'Pilgrims on the Predeal Road',
    text: 'Travellers crossing the mountains toward Transylvania lodge at the monastery’s gate. Their tolls and offerings begin to fill a treasury — the first coin of a settlement that will one day house kings.',
  },
  station: {
    year: '1879',
    title: 'The Railway Reaches the Valley',
    text: 'The Ploiești–Predeal line opens through the Prahova gorge, and a station rises at Sinaia. The remote monastery valley is joined to Bucharest in a few hours’ journey, and the age of the mountain resort begins. A separate royal station will soon stand just to the north.',
  },
  foisor: {
    year: '1881',
    title: 'Foișor, the Royal Lodge',
    text: 'A timber hunting lodge is finished high in its own clearing above the Peleș creek. Prince Carol and Princess Elisabeta live here through the long years that Peleș is being built below them.',
  },
  cavalerilor: {
    year: 'c. 1890',
    title: 'Casa Cavalerilor',
    text: 'A lodging house for the courtiers, equerries and guests who attend the King through the summer season takes its place along the esplanade below the castle.',
  },
  economat: {
    year: 'c. 1900',
    title: 'The Royal Estate Takes Shape',
    text: 'The Economat is raised to administer the crown domain — stores, workshops and offices for the small army of staff who keep the royal household running in the hills.',
  },
  guard: {
    year: 'c. 1910',
    title: 'The Guard Corps',
    text: 'The Corpul de Gardă closes the approach to the royal complex. Sentries now stand between the town and the King’s esplanade.',
  },
  peles: {
    year: '7 Oct 1883',
    title: 'Peleș Castle Is Inaugurated',
    text: 'After a decade of work the castle of Peleș is inaugurated — grey rusticated stone, carved timber and steep slate spires above terraced Italian gardens. Lit by its own hydro-electric plant, it is among the first castles in the world with electric light. Sinaia is now the summer capital of a kingdom.',
  },
  wwi: {
    year: '1916 – 1918',
    title: 'The Valley Under Occupation',
    text: 'Romania enters the Great War in August 1916. After bitter fighting at the Predeal pass and the fall of Bucharest, German and Austro-Hungarian troops occupy the Prahova Valley. Peleș is seized and its treasures evacuated; for two long years the King’s town lies behind enemy lines, until liberation comes in November 1918.',
  },
  abdication: {
    year: '30 Dec 1947',
    title: 'The End of the Kingdom',
    text: 'Summoned from Sinaia to Bucharest, King Michael I is forced to abdicate; within months the royal domain is nationalised. The castles fall silent and the monarchy that built this town passes into history — but the valley, and its chronicle, endure.',
  },
};

// ---------------------------------------------------------------------------
// Era/year-driven beats. Unlike the landmark entries above, these are not tied
// to a building the player raises — they advance the town through the events
// that came after the castle was built. Once Peleș stands (the kingdom is
// established, 1883) an epilogue clock runs and surfaces the Great War and the
// fall of the monarchy in turn, nudging the HUD year forward as each fires.
// ---------------------------------------------------------------------------

interface TimelineBeat { id: string; after: number; yearLabel: string }
const TIMELINE: TimelineBeat[] = [
  { id: 'wwi', after: 40, yearLabel: 'Anno 1916' },
  { id: 'abdication', after: 95, yearLabel: 'Anno 1947' },
];

let epilogueClock = 0;

export function updateChronicle(dt: number): void {
  const pelesDone = G.buildings.some((b) => b.def.key === 'peles' && b.phase === 'done');
  if (!pelesDone) return; // the epilogue only opens once the castle is built
  epilogueClock += dt;
  for (const beat of TIMELINE) {
    if (epilogueClock >= beat.after && !G.chronicle.includes(beat.id)) {
      G.year = parseInt(beat.yearLabel.replace(/\D/g, ''), 10) || G.year;
      setEraLabel(beat.yearLabel);
      recordChronicle(beat.id);
    }
  }
}

let panelEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let badgeEl: HTMLElement | null = null;
let unread = 0;

export function initChronicle(): void {
  panelEl = document.getElementById('chronicle');
  listEl = document.getElementById('chr-list');
  badgeEl = document.getElementById('chr-badge');
  const btn = document.getElementById('chronicle-btn');
  const close = document.getElementById('chr-close');
  btn?.addEventListener('click', (e) => { e.stopPropagation(); toggleChronicle(); });
  close?.addEventListener('click', (e) => { e.stopPropagation(); hideChronicle(); });
  renderChronicle();
  updateBadge();
}

// re-sync the panel + badge to G.chronicle (used after a save is loaded). Also
// restores the epilogue clock + HUD year from whichever timeline beats already
// fired, so a mid-epilogue load keeps its place and year instead of snapping the
// label back to the era's default.
export function refreshChronicle(): void {
  unread = 0;
  epilogueClock = 0;
  let lastFired: TimelineBeat | null = null;
  for (const beat of TIMELINE) {
    if (G.chronicle.includes(beat.id)) {
      epilogueClock = Math.max(epilogueClock, beat.after);
      lastFired = beat;
    }
  }
  if (lastFired) {
    G.year = parseInt(lastFired.yearLabel.replace(/\D/g, ''), 10) || G.year;
    setEraLabel(lastFired.yearLabel);
  }
  renderChronicle();
  updateBadge();
}

// reveal a snippet the first time its landmark is completed. Returns true if it
// announced a new beat (banner shown), so callers can skip a redundant toast.
export function recordChronicle(id: string): boolean {
  const e = CHRONICLE[id];
  if (!e || G.chronicle.includes(id)) return false;
  G.chronicle.push(id);
  showBanner(e.year, e.title, e.text);
  if (panelEl?.style.display === 'block') {
    renderChronicle();
  } else {
    unread++;
    updateBadge();
  }
  return true;
}

function toggleChronicle(): void {
  if (!panelEl) return;
  if (panelEl.style.display === 'block') {
    hideChronicle();
  } else {
    panelEl.style.display = 'block';
    unread = 0;
    updateBadge();
    renderChronicle();
  }
}

function hideChronicle(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function updateBadge(): void {
  if (!badgeEl) return;
  badgeEl.textContent = unread ? String(unread) : '';
  badgeEl.style.display = unread ? 'inline-block' : 'none';
}

function renderChronicle(): void {
  if (!listEl) return;
  listEl.innerHTML = '';
  if (G.chronicle.length === 0) {
    const li = document.createElement('li');
    li.className = 'chr-empty';
    li.textContent = 'The chronicle is empty. Raise the valley’s landmarks to write its history.';
    listEl.appendChild(li);
    return;
  }
  for (const id of G.chronicle) {
    const e = CHRONICLE[id];
    if (!e) continue;
    const li = document.createElement('li');
    li.innerHTML =
      `<div class="chr-year">${e.year}</div>` +
      `<div class="chr-title">${e.title}</div>` +
      `<div class="chr-text">${e.text}</div>`;
    listEl.appendChild(li);
  }
}
