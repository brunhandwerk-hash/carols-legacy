import { G, canAfford, pay, ResKind } from './state';
import { Building, DEFS } from './buildings';
import type { Villager } from './units';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

export function updateHud(): void {
  $('r-wood').textContent = String(Math.floor(G.resources.wood));
  $('r-stone').textContent = String(Math.floor(G.resources.stone));
  $('r-food').textContent = String(Math.floor(G.resources.food));
  $('r-pop').textContent = `${G.villagers.length}/${G.popCap}`;
}

export function setEraLabel(text: string): void {
  $('era-label').textContent = text;
}

// ---- objectives ----
import { ERAS } from './eras';
export function refreshObjectives(): void {
  const era = ERAS[G.eraIndex];
  $('obj-title').textContent = `${era.name} · ${era.yearLabel}`;
  setEraLabel(era.yearLabel);
  const list = $('obj-list');
  list.innerHTML = '';
  for (const o of era.objectives) {
    const li = document.createElement('li');
    li.textContent = o.text;
    if (o.done) li.classList.add('done');
    list.appendChild(li);
  }
}

// ---- banner + toast ----
let bannerTimer: number | undefined;
export function showBanner(year: string, title: string, text: string): void {
  const b = $('banner');
  (b.querySelector('.year') as HTMLElement).textContent = year;
  (b.querySelector('.title') as HTMLElement).textContent = title;
  (b.querySelector('.text') as HTMLElement).textContent = text;
  b.style.opacity = '1';
  window.clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => { b.style.opacity = '0'; }, 9000);
}

let toastTimer: number | undefined;
export function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.style.opacity = '0'; }, 3200);
}

// ---- selection panel ----
export type GhostRequest = (defKey: string) => void;
let ghostRequest: GhostRequest = () => {};
export function setGhostRequest(fn: GhostRequest): void { ghostRequest = fn; }

function costText(cost: Partial<Record<ResKind, number>>): string {
  const parts: string[] = [];
  if (cost.wood) parts.push(`${cost.wood} wood`);
  if (cost.stone) parts.push(`${cost.stone} stone`);
  if (cost.food) parts.push(`${cost.food} food`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

export function refreshSelectionPanel(): void {
  const panel = $('selpanel');
  const name = $('sel-name');
  const sub = $('sel-sub');
  const actions = $('sel-actions');
  actions.innerHTML = '';

  const b = G.selectedBuilding;
  if (b) {
    panel.style.display = 'block';
    name.textContent = b.def.name;
    if (b.phase === 'planned') {
      sub.textContent = `${b.def.desc} — Cost${costText(b.def.cost)}`;
      addButton(actions, `Begin construction${costText(b.def.cost)}`, !canAfford(b.def.cost), () => {
        if (!canAfford(b.def.cost)) { toast('Not enough resources.'); return; }
        pay(b.def.cost);
        b.startConstruction();
        toast(`Construction of ${b.def.name} has begun — send villagers to build (right-click the site).`);
        refreshSelectionPanel();
      });
    } else if (b.phase === 'site') {
      const pct = Math.floor((b.progress / b.def.buildPoints) * 100);
      sub.textContent = `Under construction — ${pct}%. Right-click with villagers selected to build.`;
    } else {
      sub.textContent = b.def.desc;
      if (b.def.trains) {
        addButton(actions, 'Train villager (50 food)', false, () => {
          const err = b.queueVillager();
          if (err) toast(err); else toast('A new settler is on the way.');
          refreshSelectionPanel();
        });
        if (b.trainQueue.length > 0) {
          const span = document.createElement('span');
          span.style.fontSize = '12.5px';
          span.style.opacity = '0.8';
          span.textContent = `Training: ${b.trainQueue.length} queued`;
          actions.appendChild(span);
        }
      }
    }
    return;
  }

  const sel = G.selected;
  if (sel.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  name.textContent = sel.length === 1 ? 'Villager' : `${sel.length} Villagers`;
  sub.textContent = 'Right-click: move · gather trees, rocks, berries · build a site';
  for (const key of ['hut', 'sheepfold'] as const) {
    const def = DEFS[key];
    addButton(actions, `Build ${def.name}${costText(def.cost)}`, !canAfford(def.cost), () => {
      ghostRequest(key);
    });
  }
}

function addButton(parent: HTMLElement, label: string, disabled: boolean, onClick: () => void): void {
  const btn = document.createElement('button');
  btn.className = 'act';
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  parent.appendChild(btn);
}

export function setSelection(villagers: Villager[], building: Building | null): void {
  for (const v of G.selected) v.setSelected(false);
  G.selected = villagers;
  for (const v of villagers) v.setSelected(true);
  G.selectedBuilding = building;
  refreshSelectionPanel();
}
