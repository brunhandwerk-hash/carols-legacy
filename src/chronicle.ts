import { G } from './state';
import { showBanner } from './ui';

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
};

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

// re-sync the panel + badge to G.chronicle (used after a save is loaded)
export function refreshChronicle(): void {
  unread = 0;
  renderChronicle();
  updateBadge();
}

// reveal a snippet the first time its landmark is completed
export function recordChronicle(id: string): void {
  const e = CHRONICLE[id];
  if (!e || G.chronicle.includes(id)) return;
  G.chronicle.push(id);
  showBanner(e.year, e.title, e.text);
  if (panelEl?.style.display === 'block') {
    renderChronicle();
  } else {
    unread++;
    updateBadge();
  }
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
