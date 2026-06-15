import * as THREE from 'three';
import { G, canAfford, pay, ResKind } from './state';
import { Building, DEFS, prereqsMet, BuildingDef } from './buildings';
import { riverX } from './terrain';
import type { Villager } from './units';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

export function updateHud(): void {
  $('r-wood').textContent = String(Math.floor(G.resources.wood));
  $('r-planks').textContent = String(Math.floor(G.resources.planks));
  $('r-stone').textContent = String(Math.floor(G.resources.stone));
  $('r-block').textContent = String(Math.floor(G.resources.block));
  $('r-food').textContent = String(Math.floor(G.resources.food));
  $('r-coin').textContent = String(Math.floor(G.resources.coin));
  $('r-pop').textContent = `${G.villagers.length}/${G.popCap}`;
  const idle = G.villagers.filter((v) => v.isIdle).length;
  $('idle-count').textContent = String(idle);
  ($('idle-btn') as HTMLButtonElement).disabled = idle === 0;
  refreshBuildBar();
}

// ---- resource hover tooltip ----
export function showNodeTip(px: number, py: number, text: string): void {
  const tip = $('nodetip');
  tip.textContent = text;
  tip.style.left = `${px + 14}px`;
  tip.style.top = `${py + 14}px`;
  tip.style.opacity = '1';
}
export function hideNodeTip(): void {
  $('nodetip').style.opacity = '0';
}

export function setEraLabel(text: string): void {
  $('era-label').textContent = text;
}

// ---- objectives ----
import { ERAS } from './eras';
import { renderBuildingThumbnails } from './thumbnails';

// rendered building preview images, keyed by build def (filled async at startup)
const thumbs: Record<string, string> = {};
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

// cost rendered as little colored resource chips for the build cards
function costChips(cost: Partial<Record<ResKind, number>>): string {
  const chips = (['wood', 'planks', 'stone', 'block', 'food', 'coin'] as ResKind[])
    .filter((k) => cost[k])
    .map((k) => `<span class="ci"><span class="cdot ${k}"></span>${cost[k]}</span>`);
  return chips.join('');
}

// 26×26 line icons, one per build action — keep them simple and monochrome
const ICONS: Record<string, string> = {
  hut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 11 L12 4 L20.5 11"/><rect x="6" y="11" width="12" height="8"/><rect x="10.3" y="14" width="3.4" height="5"/></svg>',
  sheepfold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><ellipse cx="10.5" cy="12" rx="6" ry="4.6"/><circle cx="17" cy="10.2" r="2.6"/><line x1="8" y1="16" x2="8" y2="19"/><line x1="13" y1="16" x2="13" y2="19"/></svg>',
  lumbercamp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="15.5" r="3.3"/><circle cx="15" cy="15.5" r="3.3"/><circle cx="11.5" cy="9" r="3.3"/></svg>',
  quarry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3.5" y="13" width="7" height="6"/><rect x="13.5" y="13" width="7" height="6"/><rect x="8.5" y="6" width="7" height="6"/></svg>',
  forager: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M5 11 H19 L17 19 H7 Z"/><path d="M5 11 a7 4.5 0 0 1 14 0"/><circle cx="9" cy="8.6" r="1.4"/><circle cx="13.2" cy="8.2" r="1.4"/></svg>',
  hunters: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.4"/><line x1="12" y1="1.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22.5" y2="12"/></svg>',
  fishery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 C8 6 15 6 19 12 C15 18 8 18 4 12 Z"/><path d="M19 12 L22.5 9 L22.5 15 Z"/><circle cx="8.5" cy="11" r="0.9" fill="currentColor" stroke="none"/></svg>',
  bridge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9 C8 16 16 16 22 9"/><line x1="2" y1="9" x2="2" y2="15"/><line x1="22" y1="9" x2="22" y2="15"/><line x1="8" y1="13.2" x2="8" y2="17"/><line x1="16" y1="13.2" x2="16" y2="17"/><line x1="12" y1="14" x2="12" y2="17.4"/></svg>',
  stana: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7 C4 4 7 5 8 8"/><path d="M20 7 C20 4 17 5 16 8"/><path d="M6 8 C6 14 9 17 12 17 C15 17 18 14 18 8 C15 6.5 9 6.5 6 8 Z"/><ellipse cx="12" cy="13.7" rx="3.4" ry="2.4"/><circle cx="10" cy="11" r="0.7" fill="currentColor" stroke="none"/><circle cx="14" cy="11" r="0.7" fill="currentColor" stroke="none"/></svg>',
  sawmill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="13" r="5"/><circle cx="9" cy="13" r="1.2"/><path d="M9 8 v-2 M9 18 v2 M4 13 h-2 M14 13 h6 l2 2 v3 h-6"/></svg>',
  stonecutter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="13" width="8" height="6"/><path d="M3.5 13 l2 -2.5 h8 l-2 2.5 M11.5 13 l2 -2.5 v6 l-2 2.5"/><path d="M15 6 l4 4 l-2 2 l-4 -4 z"/></svg>',
  villager: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="7.5" r="3"/><path d="M5.5 20 c0 -4 3 -6.5 6.5 -6.5 s6.5 2.5 6.5 6.5"/></svg>',
  hammer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 6 l5 5 l-2 2 l-5 -5 z"/><line x1="11.5" y1="10.5" x2="5" y2="17" /><path d="M12 5 a3 3 0 0 1 4 0"/></svg>',
  demolish: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9 h16 M6 9 v10 h12 V9 M9 9 V6 h6 v3 M10 12.5 v3.5 M14 12.5 v3.5"/></svg>',
};

// a uniform icon + name + cost card used for every build / train / begin action
function actionCard(
  parent: HTMLElement, iconKey: string, name: string,
  cost: Partial<Record<ResKind, number>>, disabled: boolean, onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'buildbtn';
  btn.disabled = disabled;
  btn.innerHTML =
    `<span class="ic">${ICONS[iconKey] ?? ''}</span>` +
    `<span class="lbl"><span class="nm">${name}</span><span class="cost">${costChips(cost)}</span></span>`;
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  parent.appendChild(btn);
  return btn;
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
      sub.textContent = b.def.desc;
      actionCard(actions, 'hammer', 'Begin construction', b.def.cost, !canAfford(b.def.cost), () => {
        if (!canAfford(b.def.cost)) { toast('Not enough resources.'); return; }
        pay(b.def.cost);
        b.startConstruction();
        toast(`Construction of ${b.def.name} has begun — villagers will come to build it.`);
        refreshSelectionPanel();
      });
    } else if (b.phase === 'site') {
      const pct = Math.floor((b.progress / b.def.buildPoints) * 100);
      sub.textContent = `Under construction — ${pct}%. Villagers will build it.`;
    } else {
      sub.textContent = b.def.desc;
      if (b.def.jobSlots) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;margin-top:3px';
        const mkBtn = (label: string, delta: number): HTMLButtonElement => {
          const btn = document.createElement('button');
          btn.className = 'act'; btn.textContent = label; btn.style.padding = '2px 10px';
          btn.addEventListener('click', (e) => { e.stopPropagation(); b.setDesired(b.desired + delta); refreshSelectionPanel(); });
          return btn;
        };
        const minus = mkBtn('−', -1); minus.disabled = b.desired <= 0;
        const plus = mkBtn('+', 1); plus.disabled = b.desired >= (b.def.jobSlots ?? 0);
        const info = document.createElement('span');
        info.textContent = `Workers ${b.presentWorkers()} / ${b.desired}  (max ${b.def.jobSlots})`;
        row.append(minus, info, plus);
        actions.appendChild(row);
        const hint = document.createElement('span');
        hint.style.cssText = 'font-size:11.5px;opacity:0.65';
        hint.textContent = 'Villagers staff this on their own — just set how many you want.';
        actions.appendChild(hint);
      }
    }
    if (b.phase === 'done' && b.def.key === 'bridge') {
      const up = DEFS.bridge_stone;
      actionCard(actions, 'hammer', 'Upgrade to Stone Bridge', up.cost, !canAfford(up.cost), () => {
        if (!canAfford(up.cost)) { toast('Not enough resources.'); return; }
        const scene = b.group.parent as THREE.Scene | null;
        if (!scene) return;
        pay(up.cost);
        const x = b.x, z = b.z;
        // re-derive the across-river orientation exactly as bridge placement does
        const rotY = Math.atan2((riverX(z + 8) - riverX(z - 8)) / 16, 1);
        b.demolish(false); // remove the timber bridge without a refund (upgrade paid above)
        new Building('bridge_stone', x, z, 'done', scene, rotY);
        toast('The timber bridge is rebuilt in dressed stone.');
        setSelection([], null);
      });
    }
    if (b.demolishable) {
      const btn = actionCard(actions, 'demolish', 'Demolish', {}, false, () => {
        const name = b.def.name;
        const refund = b.demolish();
        const got = (['wood', 'planks', 'stone', 'block', 'food', 'coin'] as ResKind[])
          .filter((k) => refund[k]).map((k) => `${refund[k]} ${k}`).join(', ');
        toast(got ? `${name} demolished — recovered ${got}.` : `${name} demolished.`);
        setSelection([], null);
      });
      btn.classList.add('danger');
    }
    return;
  }

  const sel = G.selected;
  if (sel.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  if (sel.length === 1) {
    const v = sel[0];
    const p = v.profession;
    name.textContent = p.charAt(0).toUpperCase() + p.slice(1);
    sub.textContent = v.describeActivity();
    if (v.carry > 0) {
      const carry = document.createElement('div');
      carry.style.cssText = 'font-size:12.5px;opacity:0.8;margin-top:2px';
      carry.textContent = `Carrying ${v.carry} ${v.carryKind}`;
      actions.appendChild(carry);
    }
    return;
  }
  name.textContent = `${sel.length} Villagers`;
  sub.textContent = selectionStatusText(sel);
  // building is done from the always-on build bar, not here (see initBuildBar)
}

// ---- always-on build toolbar (build without selecting anyone) ----
const BUILD_KEYS = ['hut', 'sheepfold', 'lumbercamp', 'quarry', 'forager', 'sawmill', 'stonecutter', 'hunters', 'fishery', 'stana', 'bridge'] as const;
const buildBtns: Record<string, HTMLButtonElement> = {};
let buildSearch = ''; // live search query; locked buildings stay hidden regardless

function reqNames(def: { requires?: string[] }): string {
  return (def.requires ?? []).map((k) => DEFS[k]?.name ?? k).join(', ');
}

// Foundation-style detail card: name, description, the production chain / yields,
// and the upfront cost — shown when a build icon is hovered or focused.
function buildDetail(def: BuildingDef): string {
  const chip = (k: string, v: number) => `<span class="ci"><span class="cdot ${k}"></span>${v}</span>`;
  const pic = thumbs[def.key] ? `<img class="d-pic" src="${thumbs[def.key]}" alt="">` : `<span class="d-pic d-pic-ph">${ICONS[def.key] ?? ''}</span>`;
  const parts: string[] = [
    `<div class="d-top">${pic}<div class="d-head"><div class="d-name">${def.name}</div><div class="d-desc">${def.desc}</div></div></div>`,
  ];
  const tags: string[] = [];
  if (def.produces) {
    const out = Object.entries(def.produces.output).map(([k, v]) => chip(k, v as number)).join('');
    const inp = Object.entries(def.produces.input).map(([k, v]) => chip(k, v as number)).join('');
    tags.push(`<span class="d-tag">Produces ${out} from ${inp} every ${def.produces.interval}s</span>`);
  }
  if (def.foodTrickle) tags.push(`<span class="d-tag"><span class="cdot food"></span>Food +${def.foodTrickle}/s</span>`);
  if (def.coinTrickle) tags.push(`<span class="d-tag"><span class="cdot coin"></span>Coin +${def.coinTrickle}/s</span>`);
  if (def.boosts) tags.push(`<span class="d-tag">Speeds nearby ${def.boosts} gathering</span>`);
  if (def.popCap) tags.push(`<span class="d-tag">Houses ${def.popCap}</span>`);
  if (def.jobSlots) tags.push(`<span class="d-tag">${def.jobSlots} job${def.jobSlots > 1 ? 's' : ''}</span>`);
  if (tags.length) parts.push(`<div class="d-tags">${tags.join('')}</div>`);
  const cost = costChips(def.cost);
  parts.push(`<div class="d-cost"><span class="d-lbl">Upfront cost</span>${cost || '<span class="d-free">none</span>'}</div>`);
  if (!prereqsMet(def)) parts.push(`<div class="d-req">🔒 Requires ${reqNames(def)}</div>`);
  return parts.join('');
}

export function initBuildBar(): void {
  const bar = $('buildbar');
  bar.innerHTML = '';

  const detail = document.createElement('div');
  detail.id = 'bb-detail';
  detail.className = 'hidden';

  const head = document.createElement('div');
  head.className = 'bb-head';
  head.innerHTML = '<span class="bb-title">BUILD</span>';
  const search = document.createElement('input');
  search.className = 'bb-search';
  search.type = 'text';
  search.placeholder = 'Search buildings…';
  head.appendChild(search);

  const scroll = document.createElement('div');
  scroll.className = 'bb-scroll';

  bar.appendChild(detail);
  bar.appendChild(head);
  bar.appendChild(scroll);

  for (const key of BUILD_KEYS) {
    const def = DEFS[key];
    const btn = document.createElement('button');
    btn.className = 'bb';
    btn.innerHTML =
      `<span class="bb-thumb"><span class="ic">${ICONS[key] ?? ''}</span></span>` +
      `<span class="cost">${costChips(def.cost)}</span>`;
    const show = () => { detail.innerHTML = buildDetail(def); detail.classList.remove('hidden'); };
    btn.addEventListener('mouseenter', show);
    btn.addEventListener('focus', show);
    btn.addEventListener('click', (e) => { e.stopPropagation(); ghostRequest(key); });
    scroll.appendChild(btn);
    buildBtns[key] = btn;
  }

  // hide the detail card when the pointer leaves the whole bar
  bar.addEventListener('mouseleave', () => detail.classList.add('hidden'));
  // live filter
  search.addEventListener('click', (e) => e.stopPropagation());
  search.addEventListener('input', () => {
    buildSearch = search.value.trim().toLowerCase();
    refreshBuildBar(); // visibility is owned by refreshBuildBar (search AND unlocked)
  });

  refreshBuildBar();

  // render a 3D preview thumbnail for each building and slot it into the cards
  void renderBuildingThumbnails(BUILD_KEYS, (key, url) => {
    thumbs[key] = url;
    const slot = buildBtns[key]?.querySelector('.bb-thumb');
    if (slot) slot.innerHTML = `<img src="${url}" alt="">`;
  });
}

export function refreshBuildBar(): void {
  for (const key of BUILD_KEYS) {
    const def = DEFS[key];
    const btn = buildBtns[key];
    if (!btn) continue;
    // Locked buildings (prereqs not finished) are hidden entirely; the search box
    // can only narrow the already-unlocked set, never reveal a locked building.
    const unlocked = prereqsMet(def);
    const matches = !buildSearch || def.name.toLowerCase().includes(buildSearch);
    btn.style.display = unlocked && matches ? '' : 'none';
    btn.disabled = !canAfford(def.cost);
    btn.title = def.name;
  }
}

// what the selected villager(s) are doing — shown live under their name
function selectionStatusText(sel: Villager[]): string {
  if (sel.length === 1) return sel[0].describeActivity();
  const idle = sel.filter((v) => v.isIdle).length;
  return `${sel.length} villagers · ${idle} idle · ${sel.length - idle} working`;
}

// lightweight live refresh of the activity line (no button rebuild)
export function updateSelectionStatus(): void {
  if (G.selectedBuilding || G.selected.length === 0) return;
  $('sel-sub').textContent = selectionStatusText(G.selected);
}

export function setSelection(villagers: Villager[], building: Building | null): void {
  for (const v of G.selected) v.setSelected(false);
  G.selected = villagers;
  for (const v of villagers) v.setSelected(true);
  G.selectedBuilding = building;
  refreshSelectionPanel();
}
