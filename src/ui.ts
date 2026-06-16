import * as THREE from 'three';
import { G, canAfford, pay, ResKind } from './state';
import { Building, DEFS, prereqsMet, BuildingDef } from './buildings';
import { EAT_RATE, WARM_RATE, DRINK_RATE } from './population';
import { riverX } from './terrain';
import type { Villager } from './units';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

export function updateHud(): void {
  $('r-wood').textContent = String(Math.floor(G.resources.wood));
  $('r-planks').textContent = String(Math.floor(G.resources.planks));
  $('r-stone').textContent = String(Math.floor(G.resources.stone));
  $('r-block').textContent = String(Math.floor(G.resources.block));
  $('r-lime').textContent = String(Math.floor(G.resources.lime));
  $('r-nails').textContent = String(Math.floor(G.resources.nails));
  $('r-food').textContent = String(Math.floor(G.resources.food));
  $('r-water').textContent = String(Math.floor(G.resources.water));
  $('r-coin').textContent = String(Math.floor(G.resources.coin));
  $('r-pop').textContent = `${G.villagers.length}/${G.popCap}`;
  // per-capita upkeep: villagers eat food, burn wood (firewood) and drink water
  const pop = G.villagers.length;
  $('rate-food').textContent = pop ? `−${(pop * EAT_RATE).toFixed(2)}/s` : '';
  $('rate-wood').textContent = pop ? `−${(pop * WARM_RATE).toFixed(2)}/s` : '';
  $('rate-water').textContent = pop ? `−${(pop * DRINK_RATE).toFixed(2)}/s` : '';
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
  const chips = (['wood', 'planks', 'stone', 'block', 'lime', 'nails', 'food', 'water', 'coin'] as ResKind[])
    .filter((k) => cost[k])
    .map((k) => `<span class="ci"><span class="cdot ${k}"></span>${cost[k]}</span>`);
  return chips.join('');
}

// human-readable resource names, used where the colored dot alone isn't clear
const RES_NAMES: Record<ResKind, string> = {
  wood: 'Wood', planks: 'Planks', stone: 'Stone', block: 'Stone block',
  lime: 'Lime', nails: 'Nails',
  food: 'Food', water: 'Water', coin: 'Coin',
};

// like costChips, but spells out the resource name next to each amount
function costChipsLabeled(cost: Partial<Record<ResKind, number>>): string {
  const chips = (['wood', 'planks', 'stone', 'block', 'lime', 'nails', 'food', 'water', 'coin'] as ResKind[])
    .filter((k) => cost[k])
    .map((k) => `<span class="ci"><span class="cdot ${k}"></span>${cost[k]} ${RES_NAMES[k]}</span>`);
  return chips.join('');
}

// 26×26 line icons, one per build action — keep them simple and monochrome
const ICONS: Record<string, string> = {
  hut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 11 L12 4 L20.5 11"/><rect x="6" y="11" width="12" height="8"/><rect x="10.3" y="14" width="3.4" height="5"/></svg>',
  sheepfold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><ellipse cx="10.5" cy="12" rx="6" ry="4.6"/><circle cx="17" cy="10.2" r="2.6"/><line x1="8" y1="16" x2="8" y2="19"/><line x1="13" y1="16" x2="13" y2="19"/></svg>',
  lumbercamp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="15.5" r="3.3"/><circle cx="15" cy="15.5" r="3.3"/><circle cx="11.5" cy="9" r="3.3"/></svg>',
  quarry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="3.5" y="13" width="7" height="6"/><rect x="13.5" y="13" width="7" height="6"/><rect x="8.5" y="6" width="7" height="6"/></svg>',
  forager: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 C12 3 6 10 6 14.5 a6 6 0 0 0 12 0 C18 10 12 3 12 3 Z"/><path d="M9.5 14.5 a2.5 2.5 0 0 0 2.5 2.5"/></svg>',
  hunters: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.4"/><line x1="12" y1="1.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22.5" y2="12"/></svg>',
  fishery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12 C8 6 15 6 19 12 C15 18 8 18 4 12 Z"/><path d="M19 12 L22.5 9 L22.5 15 Z"/><circle cx="8.5" cy="11" r="0.9" fill="currentColor" stroke="none"/></svg>',
  bridge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9 C8 16 16 16 22 9"/><line x1="2" y1="9" x2="2" y2="15"/><line x1="22" y1="9" x2="22" y2="15"/><line x1="8" y1="13.2" x2="8" y2="17"/><line x1="16" y1="13.2" x2="16" y2="17"/><line x1="12" y1="14" x2="12" y2="17.4"/></svg>',
  stana: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7 C4 4 7 5 8 8"/><path d="M20 7 C20 4 17 5 16 8"/><path d="M6 8 C6 14 9 17 12 17 C15 17 18 14 18 8 C15 6.5 9 6.5 6 8 Z"/><ellipse cx="12" cy="13.7" rx="3.4" ry="2.4"/><circle cx="10" cy="11" r="0.7" fill="currentColor" stroke="none"/><circle cx="14" cy="11" r="0.7" fill="currentColor" stroke="none"/></svg>',
  sawmill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="13" r="5"/><circle cx="9" cy="13" r="1.2"/><path d="M9 8 v-2 M9 18 v2 M4 13 h-2 M14 13 h6 l2 2 v3 h-6"/></svg>',
  stonecutter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="13" width="8" height="6"/><path d="M3.5 13 l2 -2.5 h8 l-2 2.5 M11.5 13 l2 -2.5 v6 l-2 2.5"/><path d="M15 6 l4 4 l-2 2 l-4 -4 z"/></svg>',
  limekiln: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20 V11 a6 6 0 0 1 12 0 v9 Z"/><path d="M9.5 20 v-4 h5 v4"/><path d="M12 5 V2 M9 4 l-1.5 -2 M15 4 l1.5 -2"/></svg>',
  nailforge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14 h8 l-1.5 -3 h-5 z"/><path d="M8 14 v5"/><path d="M14 7 l5 5 l-2 2 l-5 -5 z"/><path d="M13 4 a3 3 0 0 1 4 0"/></svg>',
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
      // landmarks are raised via the Build ▸ Landmarks menu (placed on this site),
      // not a panel button — see initBuildBar / placeGhost
      sub.textContent = b.def.desc;
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11.5px;opacity:0.7;margin-top:4px';
      hint.textContent = 'Open Build ▸ Landmarks and place it on this site.';
      actions.appendChild(hint);
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
        const got = (['wood', 'planks', 'stone', 'block', 'lime', 'nails', 'food', 'water', 'coin'] as ResKind[])
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
// Buildings are grouped by function into tabs so the menu isn't an overwhelming
// flat list. 'landmark' categories don't free-place: clicking flies the camera to
// the landmark's fixed plot and selects its signpost (Begin construction in place).
interface BuildCategory { id: string; label: string; keys: string[]; landmark?: boolean }
const CATEGORIES: BuildCategory[] = [
  { id: 'housing', label: 'Housing',        keys: ['hut'] },
  { id: 'gather',  label: 'Gathering',      keys: ['lumbercamp', 'quarry'] },
  { id: 'food',    label: 'Food',           keys: ['sheepfold', 'hunters', 'fishery', 'stana'] },
  { id: 'refine',  label: 'Refining',       keys: ['sawmill', 'stonecutter', 'limekiln', 'nailforge'] },
  { id: 'infra',   label: 'Infrastructure', keys: ['forager', 'bridge'] },
  { id: 'landmarks', label: 'Landmarks',    keys: ['monastery', 'oldinn', 'station', 'foisor', 'economat', 'cavalerilor', 'guard', 'peles'], landmark: true },
];
const ALL_KEYS = CATEGORIES.flatMap((c) => c.keys);
const catOf: Record<string, BuildCategory> = {};
for (const c of CATEGORIES) for (const k of c.keys) catOf[k] = c;

const buildBtns: Record<string, HTMLButtonElement> = {};
const catTabs: Record<string, HTMLButtonElement> = {};
let activeCat = CATEGORIES[0].id; // which category tab is showing

// camera fly-to (wired to rig.jumpTo in main.ts) — focuses a landmark's plot
let cameraJump: (x: number, z: number) => void = () => {};
export function setCameraJump(fn: (x: number, z: number) => void): void { cameraJump = fn; }

// the planned signpost for a landmark key, if it currently exists (startable)
function landmarkSignpost(key: string): Building | null {
  return G.buildings.find((b) => b.plotKey === key && b.phase === 'planned') ?? null;
}

// the names of prerequisites still missing (not yet built) — what we still need
function unmetReqNames(def: { requires?: string[] }): string {
  return (def.requires ?? [])
    .filter((k) => !G.buildings.some((b) => b.def.key === k && b.phase === 'done'))
    .map((k) => DEFS[k]?.name ?? k)
    .join(', ');
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
  if (def.waterTrickle) tags.push(`<span class="d-tag"><span class="cdot water"></span>Water +${def.waterTrickle}/s</span>`);
  if (def.coinTrickle) tags.push(`<span class="d-tag"><span class="cdot coin"></span>Coin +${def.coinTrickle}/s</span>`);
  if (def.boosts) tags.push(`<span class="d-tag">Speeds nearby ${def.boosts} gathering</span>`);
  if (def.popCap) tags.push(`<span class="d-tag">Houses ${def.popCap}</span>`);
  if (def.jobSlots) tags.push(`<span class="d-tag">${def.jobSlots} job${def.jobSlots > 1 ? 's' : ''}</span>`);
  if (tags.length) parts.push(`<div class="d-tags">${tags.join('')}</div>`);
  const cost = costChipsLabeled(def.cost);
  parts.push(`<div class="d-cost"><span class="d-lbl">Upfront cost</span>${cost || '<span class="d-free">none</span>'}</div>`);
  if (!prereqsMet(def)) parts.push(`<div class="d-req">🔒 Still need: ${unmetReqNames(def)}</div>`);
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

  // category tabs (one group of buildings shown at a time)
  const tabs = document.createElement('div');
  tabs.className = 'bb-tabs';

  const scroll = document.createElement('div');
  scroll.className = 'bb-scroll';

  bar.appendChild(detail);
  bar.appendChild(head);
  bar.appendChild(tabs);
  bar.appendChild(scroll);

  for (const c of CATEGORIES) {
    const tab = document.createElement('button');
    tab.className = 'bb-tab';
    tab.textContent = c.label;
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      activeCat = c.id;
      refreshBuildBar();
    });
    tabs.appendChild(tab);
    catTabs[c.id] = tab;
  }

  for (const key of ALL_KEYS) {
    const def = DEFS[key];
    const btn = document.createElement('button');
    btn.className = 'bb';
    btn.innerHTML =
      `<span class="bb-thumb"><span class="ic">${ICONS[key] ?? ''}</span></span>` +
      `<span class="cost">${costChips(def.cost)}</span>`;
    const show = () => { detail.innerHTML = buildDetail(def); detail.classList.remove('hidden'); };
    btn.addEventListener('mouseenter', show);
    btn.addEventListener('focus', show);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (catOf[key]?.landmark) {
        // landmarks keep their fixed historical plot — fly to the site and start a
        // ghost the player drops onto it (placement is valid only over the plot).
        // Locked (site not unlocked yet) → tell the player what's still needed.
        const sign = landmarkSignpost(key);
        if (sign) { cameraJump(sign.x, sign.z); ghostRequest(key); }
        else toast(`${def.name} needs ${unmetReqNames(def)} first.`);
      } else if (!prereqsMet(def)) {
        // shown but locked — tell the player what to build first
        toast(`${def.name} needs ${unmetReqNames(def)} first.`);
      } else {
        ghostRequest(key);
      }
    });
    scroll.appendChild(btn);
    buildBtns[key] = btn;
  }

  // hide the detail card when the pointer leaves the whole bar
  bar.addEventListener('mouseleave', () => detail.classList.add('hidden'));

  refreshBuildBar();

  // render a 3D preview thumbnail for each building (incl. landmarks) into the cards
  void renderBuildingThumbnails(ALL_KEYS, (key, url) => {
    thumbs[key] = url;
    const slot = buildBtns[key]?.querySelector('.bb-thumb');
    if (slot) slot.innerHTML = `<img src="${url}" alt="">`;
  });
}

export function refreshBuildBar(): void {
  for (const key of ALL_KEYS) {
    const def = DEFS[key];
    const btn = buildBtns[key];
    if (!btn) continue;
    const cat = catOf[key];
    const isLandmark = !!cat?.landmark;
    const inActive = cat?.id === activeCat;
    // Every building shows in its tab; locked ones (prereqs unmet) are greyed and
    // their detail card lists what's still needed. Landmarks behave the same, but
    // "unlocked" means their fixed-plot signpost is planted (the era gate), and the
    // entry drops out once the landmark is actually placed (site/done).
    let show: boolean, locked: boolean, disabled: boolean;
    if (isLandmark) {
      const placed = G.buildings.some((b) => b.plotKey === key && b.phase !== 'planned');
      const unlocked = landmarkSignpost(key) !== null;
      show = inActive && !placed;
      locked = !unlocked;
      disabled = unlocked && !canAfford(def.cost); // unlocked: gate on cost like the rest
    } else {
      const unlocked = prereqsMet(def);
      show = inActive;
      locked = !unlocked;
      disabled = !locked && !canAfford(def.cost);
    }
    btn.style.display = show ? '' : 'none';
    btn.classList.toggle('locked', locked);
    // locked buttons stay enabled so hover still reveals the "Still need:" detail
    // and their click toasts the requirement; cost-disabled ones are inert.
    btn.disabled = disabled;
    btn.title = def.name;
  }
  // reflect the active tab
  for (const c of CATEGORIES) catTabs[c.id]?.classList.toggle('active', c.id === activeCat);
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
