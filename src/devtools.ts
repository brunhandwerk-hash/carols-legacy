import * as THREE from 'three';
import { MAP } from './config';
import { surfaceHeight, worldToLonLat, TERR_SEG_X, TERR_SEG_Z, buildDemPointsMesh } from './terrain';
import { toast } from './ui';
import type { WorldRefs } from './world';

// ---------------------------------------------------------------------------
// Map-annotation devtool. Toggle with the backtick (`) key. Drop pins, draw
// polylines and polygons on the terrain and label each with a note — a way to
// mark "put X here" directly on the map. Annotations carry both world metres and
// real lon/lat, persist to localStorage, and are exposed on window.devNotes (+
// window.dumpDevNotes()) so they can be read straight out of the running game.
// Dev-only: it never touches gameplay state.
// ---------------------------------------------------------------------------

interface APoint { x: number; z: number; lon: number; lat: number }
interface Annotation { id: number; kind: 'pin' | 'line' | 'polygon'; text: string; points: APoint[] }
type Mode = 'off' | 'pin' | 'line' | 'polygon';

const STORE_KEY = 'carols-legacy-devnotes-v1';
const COL = { pin: 0xffcf3f, line: 0x4fd0ff, polygon: 0x8cff6a, draft: 0xff5fae, sel: 0xffffff };

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
function apoint(x: number, z: number): APoint {
  const { lon, lat } = worldToLonLat(x, z);
  return { x: round(x), z: round(z), lon: round(lon, 6), lat: round(lat, 6) };
}

export function initDevtools(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera, world: WorldRefs): { update: () => void } {
  let notes: Annotation[] = load();
  let mode: Mode = 'off';
  let selectedId: number | null = null;
  let draft: APoint[] = [];           // in-progress line/polygon vertices
  let cursor: { x: number; z: number } | null = null; // last terrain point under mouse
  let nextId = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;

  // expose for live reading from outside (e.g. preview eval)
  const w = window as unknown as Record<string, unknown>;
  w.devNotes = notes;
  w.dumpDevNotes = () => JSON.stringify(notes, null, 2);

  // ---- scene gizmos ----
  const gizmos = new THREE.Group();
  gizmos.renderOrder = 999;
  world.scene.add(gizmos);
  const draftGroup = new THREE.Group();
  world.scene.add(draftGroup);
  const matCache = new Map<number, THREE.Material>();
  const mat = (c: number) => { let m = matCache.get(c); if (!m) { m = new THREE.MeshBasicMaterial({ color: c }); matCache.set(c, m); } return m; };
  const lineMat = (c: number) => new THREE.LineBasicMaterial({ color: c });

  function clearGroup(g: THREE.Group): void {
    for (const o of g.children.slice()) {
      g.remove(o);
      (o as THREE.Mesh).geometry?.dispose?.();
    }
  }

  function pinMesh(p: APoint, color: number): THREE.Group {
    const g = new THREE.Group();
    const base = surfaceHeight(p.x, p.z);
    const poleH = 7;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, poleH, 8), mat(color));
    pole.position.set(p.x, base + poleH / 2, p.z);
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.3, 14, 10), mat(color));
    head.position.set(p.x, base + poleH + 0.5, p.z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.4, 24), mat(color));
    ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, base + 0.2, p.z);
    g.add(pole, head, ring);
    return g;
  }

  // sample the terrain surface along the path so the line hugs the ground
  function drape(pts: APoint[], close: boolean): THREE.Vector3[] {
    const seq = close && pts.length > 1 ? [...pts, pts[0]] : pts;
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i], b = seq[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.floor(len / 8));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        out.push(new THREE.Vector3(x, surfaceHeight(x, z) + 0.8, z));
      }
    }
    const last = seq[seq.length - 1];
    if (last) out.push(new THREE.Vector3(last.x, surfaceHeight(last.x, last.z) + 0.8, last.z));
    return out;
  }

  function pathMesh(pts: APoint[], color: number, close: boolean): THREE.Group {
    const g = new THREE.Group();
    if (pts.length >= 2) {
      const geo = new THREE.BufferGeometry().setFromPoints(drape(pts, close));
      g.add(new THREE.Line(geo, lineMat(color)));
    }
    for (const p of pts) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), mat(color));
      dot.position.set(p.x, surfaceHeight(p.x, p.z) + 0.8, p.z);
      g.add(dot);
    }
    return g;
  }

  function rebuildGizmos(): void {
    clearGroup(gizmos);
    for (const n of notes) {
      const color = n.id === selectedId ? COL.sel : COL[n.kind];
      gizmos.add(n.kind === 'pin' ? pinMesh(n.points[0], color)
        : pathMesh(n.points, color, n.kind === 'polygon'));
    }
    rebuildLabels();
  }

  function rebuildDraft(): void {
    clearGroup(draftGroup);
    if (mode === 'off' || (mode !== 'line' && mode !== 'polygon')) return;
    const pts = cursor ? [...draft, apoint(cursor.x, cursor.z)] : draft;
    if (pts.length) draftGroup.add(pathMesh(pts, COL.draft, mode === 'polygon' && pts.length > 2));
  }

  // ---- HTML label overlay ----
  const labelBox = document.getElementById('dev-labels')!;
  const labelEls = new Map<number, HTMLElement>();
  function rebuildLabels(): void {
    labelBox.innerHTML = '';
    labelEls.clear();
    for (const n of notes) {
      const el = document.createElement('div');
      el.className = 'dev-label' + (n.id === selectedId ? ' sel' : '');
      el.textContent = n.text || `(${n.kind})`;
      labelBox.appendChild(el);
      labelEls.set(n.id, el);
    }
  }
  function anchor(n: Annotation): THREE.Vector3 {
    const p = n.points;
    if (n.kind === 'pin') return new THREE.Vector3(p[0].x, surfaceHeight(p[0].x, p[0].z) + 8.5, p[0].z);
    const cx = p.reduce((s, q) => s + q.x, 0) / p.length;
    const cz = p.reduce((s, q) => s + q.z, 0) / p.length;
    return new THREE.Vector3(cx, surfaceHeight(cx, cz) + 3, cz);
  }
  const v = new THREE.Vector3();
  function update(): void {
    const r = canvas.getBoundingClientRect();
    for (const n of notes) {
      const el = labelEls.get(n.id);
      if (!el) continue;
      v.copy(anchor(n)).project(camera);
      if (v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.left = `${r.left + (v.x + 1) / 2 * r.width}px`;
      el.style.top = `${r.top + (1 - v.y) / 2 * r.height}px`;
    }
  }

  // ---- persistence ----
  function save(): void {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(notes)); } catch { /* ignore */ }
    w.devNotes = notes;
  }
  function load(): Annotation[] {
    try { const r = localStorage.getItem(STORE_KEY); if (r) return JSON.parse(r); } catch { /* ignore */ }
    return [];
  }

  // ---- raycast terrain ----
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function groundAt(cx: number, cy: number): { x: number; z: number } | null {
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(world.terrain, true)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }

  // ---- actions ----
  function select(id: number | null): void {
    selectedId = id;
    const note = notes.find((n) => n.id === id) ?? null;
    textInput.value = note?.text ?? '';
    textInput.disabled = !note;
    rebuildGizmos();
    renderList();
    if (note) textInput.focus();
  }

  function placePoint(g: { x: number; z: number }): void {
    if (mode === 'pin') {
      const n: Annotation = { id: nextId++, kind: 'pin', text: '', points: [apoint(g.x, g.z)] };
      notes.push(n); save(); select(n.id);
    } else if (mode === 'line' || mode === 'polygon') {
      draft.push(apoint(g.x, g.z)); rebuildDraft();
    }
  }

  function finishDraft(): void {
    if (mode !== 'line' && mode !== 'polygon') return;
    const min = mode === 'polygon' ? 3 : 2;
    if (draft.length >= min) {
      const n: Annotation = { id: nextId++, kind: mode, text: '', points: draft.slice() };
      notes.push(n); save();
      draft = []; rebuildDraft(); select(n.id);
    } else {
      toast('Need more points first.');
    }
  }

  function deleteNote(id: number): void {
    notes = notes.filter((n) => n.id !== id);
    if (selectedId === id) selectedId = null;
    save(); rebuildGizmos(); renderList();
  }

  // ---- panel UI ----
  const panel = document.getElementById('devtools')!;
  const modeBtns: Record<string, HTMLButtonElement> = {};
  const textInput = document.getElementById('dev-text') as HTMLInputElement;
  const listEl = document.getElementById('dev-list')!;

  function setMode(m: Mode): void {
    if ((m === 'line' || m === 'polygon') && (mode === 'line' || mode === 'polygon') && draft.length) finishDraft();
    mode = m;
    draft = []; rebuildDraft();
    for (const k of Object.keys(modeBtns)) modeBtns[k].classList.toggle('on', k === m);
    canvas.style.cursor = m === 'off' ? '' : 'crosshair';
    document.getElementById('dev-finish')!.style.display = (m === 'line' || m === 'polygon') ? '' : 'none';
  }

  function renderList(): void {
    listEl.innerHTML = '';
    notes.forEach((n) => {
      const row = document.createElement('div');
      row.className = 'dev-item' + (n.id === selectedId ? ' sel' : '');
      const label = n.text || `(unlabelled ${n.kind})`;
      row.innerHTML = `<span class="di-k ${n.kind}">${n.kind[0].toUpperCase()}</span>` +
        `<span class="di-t">${label}</span><button class="di-x" title="Delete">✕</button>`;
      row.addEventListener('click', (e) => { if ((e.target as HTMLElement).className !== 'di-x') select(n.id); });
      row.querySelector('.di-x')!.addEventListener('click', (e) => { e.stopPropagation(); deleteNote(n.id); });
      listEl.appendChild(row);
    });
  }

  const menuBtn = document.getElementById('devmenu-btn') as HTMLButtonElement;
  function togglePanel(force?: boolean): void {
    const open = force ?? panel.style.display !== 'block';
    panel.style.display = open ? 'block' : 'none';
    labelBox.style.display = open ? 'block' : 'none';
    menuBtn.classList.toggle('on', open);
    if (!open) setMode('off');
  }
  menuBtn.addEventListener('click', () => togglePanel());

  // wire panel controls
  (['pin', 'line', 'polygon'] as Mode[]).forEach((m) => {
    const b = document.getElementById(`dev-${m}`) as HTMLButtonElement;
    modeBtns[m] = b;
    b.addEventListener('click', () => setMode(mode === m ? 'off' : m));
  });
  textInput.addEventListener('input', () => {
    const n = notes.find((x) => x.id === selectedId);
    if (n) { n.text = textInput.value; save(); const el = labelEls.get(n.id); if (el) el.textContent = n.text || `(${n.kind})`; renderList(); }
  });
  textInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') textInput.blur(); });
  document.getElementById('dev-finish')!.addEventListener('click', finishDraft);
  document.getElementById('dev-export')!.addEventListener('click', () => {
    const json = JSON.stringify(notes, null, 2);
    void navigator.clipboard?.writeText(json).catch(() => {});
    console.log('[devnotes]\n' + json);
    toast(`Copied ${notes.length} annotation(s) to clipboard (also logged to console).`);
  });
  document.getElementById('dev-clear')!.addEventListener('click', () => {
    if (!notes.length) return;
    if (!confirm('Delete all annotations?')) return;
    notes = []; selectedId = null; save(); rebuildGizmos(); renderList();
  });
  document.getElementById('dev-close')!.addEventListener('click', () => togglePanel(false));

  // ---- satellite reference overlay (real imagery draped over the terrain) ----
  let satMesh: THREE.Mesh | null = null;
  let satOpacity = 0.9;
  const satBtn = document.getElementById('dev-sat-toggle') as HTMLButtonElement;
  const satOp = document.getElementById('dev-sat-op') as HTMLInputElement;

  // build a draped grid over the whole map and texture it with /satellite.jpg.
  // UVs map world fraction -> image (image top row = north), so it lines up with
  // the terrain (DEM cropped to the same bbox). Built once, on first enable.
  //
  // Grid resolution MATCHES the rendered terrain mesh (TERR_SEG_X/Z) and samples
  // the same surfaceHeight: the drape's triangles then coincide horizontally with
  // the terrain's, so it sits a uniform `lift` above the surface everywhere and the
  // terrain can never poke through. (A coarser grid chord-sags below the fine
  // terrain on steep slopes, letting the dark shadowed terrain bleed through as
  // black patches.) depthTest stays on so the map self-occludes correctly at
  // oblique angles; the small `lift` + polygonOffset keep it just above the ground.
  function buildSatellite(): void {
    const NX = TERR_SEG_X, NZ = TERR_SEG_Z;
    const lift = 3.0;
    const cols = NX + 1, rows = NZ + 1;
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    const idx = new Uint32Array(NX * NZ * 6);
    for (let j = 0; j < rows; j++) {
      const fz = j / NZ;
      const z = MAP.minZ + fz * MAP.depth;
      for (let i = 0; i < cols; i++) {
        const fx = i / NX;
        const x = MAP.minX + fx * MAP.width;
        const p = (j * cols + i) * 3, u = (j * cols + i) * 2;
        pos[p] = x; pos[p + 1] = surfaceHeight(x, z) + lift; pos[p + 2] = z;
        // image bbox == terrain bbox (degree-aspect tile), so map corner-to-corner
        uv[u] = fx; uv[u + 1] = 1 - fz;
      }
    }
    let t = 0;
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx[t] = a; idx[t + 1] = c; idx[t + 2] = b;
      idx[t + 3] = b; idx[t + 4] = c; idx[t + 5] = d;
      t += 6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    // GTAO (the post-process AO pass) needs vertex normals — without them it reads
    // the drape as fully occluded and multiplies it to pure black. Real vertex
    // normals (mostly up) make it well-behaved under AO.
    geo.computeVertexNormals();
    const tex = new THREE.TextureLoader().load('/satellite.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    // The scene renders into the composer's HDR target, so per-material toneMapped
    // is ignored — OutputPass runs ACES (exposure 0.9) over the whole frame. The
    // satellite is already dark forest imagery (linear ~0.03–0.05); a >1 linear gain
    // lifts it so it reads like the real photo. (colour multiplies the texture in
    // linear space.)
    const m = new THREE.MeshBasicMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: satOpacity, side: THREE.DoubleSide, depthWrite: false });
    m.color.setScalar(2.2);
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
    satMesh = new THREE.Mesh(geo, m);
    satMesh.renderOrder = 4;
    world.scene.add(satMesh);
  }

  function setSatellite(on: boolean): void {
    if (on && !satMesh) buildSatellite();
    if (satMesh) satMesh.visible = on;
    satBtn.classList.toggle('on', on);
  }
  satBtn.addEventListener('click', () => setSatellite(!(satMesh?.visible)));
  satOp.addEventListener('input', () => {
    satOpacity = parseFloat(satOp.value);
    if (satMesh) (satMesh.material as THREE.MeshBasicMaterial).opacity = satOpacity;
  });

  // ---- terrain debug views ----
  function terrainMesh(): THREE.Mesh | null {
    let t: THREE.Mesh | null = null;
    world.scene.traverse((o) => { if (o.name === 'terrain') t = o as THREE.Mesh; });
    return t;
  }
  let origTerrainMat: THREE.Material | null = null;
  let flatMat: THREE.MeshStandardMaterial | null = null;
  let wireOn = false, flatOn = false;
  let demPts: THREE.Points | null = null;
  const wireBtn = document.getElementById('dev-wireframe') as HTMLButtonElement;
  const flatBtn = document.getElementById('dev-flat') as HTMLButtonElement;
  const demBtn = document.getElementById('dev-dempts') as HTMLButtonElement;

  // keep the wireframe flag applied to whichever material is currently on the mesh
  function applyWire(): void {
    const t = terrainMesh(); if (!t) return;
    (t.material as THREE.Material & { wireframe: boolean }).wireframe = wireOn;
  }
  wireBtn?.addEventListener('click', () => {
    wireOn = !wireOn; applyWire(); wireBtn.classList.toggle('on', wireOn);
  });
  flatBtn?.addEventListener('click', () => {
    const t = terrainMesh(); if (!t) return;
    flatOn = !flatOn;
    if (flatOn) {
      if (!origTerrainMat) origTerrainMat = t.material as THREE.Material;
      // plain matte material: keeps the mesh's (analytic) normals, drops all texture
      // so you see pure geometry shading — isolates geometry vs. texture artifacts
      if (!flatMat) flatMat = new THREE.MeshStandardMaterial({ color: 0x5f7d44, roughness: 1, metalness: 0 });
      t.material = flatMat;
    } else if (origTerrainMat) {
      t.material = origTerrainMat;
    }
    applyWire();
    flatBtn.classList.toggle('on', flatOn);
  });
  demBtn?.addEventListener('click', () => {
    if (!demPts) { demPts = buildDemPointsMesh(); world.scene.add(demPts); }
    else { demPts.visible = !demPts.visible; }
    demBtn.classList.toggle('on', demPts.visible);
  });

  // ---- pointer interception (capture phase on window pre-empts input.ts) ----
  let down: { x: number; y: number } | null = null;
  window.addEventListener('pointerdown', (e) => {
    if (mode === 'off' || e.target !== canvas || e.button !== 0 || e.ctrlKey || e.altKey) return;
    down = { x: e.clientX, y: e.clientY };
    e.stopPropagation();
  }, true);
  window.addEventListener('pointerup', (e) => {
    if (mode === 'off' || e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6;
    down = null;
    e.stopPropagation();
    if (moved) return; // a drag, not a click — ignore
    const g = groundAt(e.clientX, e.clientY);
    if (g) placePoint(g);
  }, true);
  // track the cursor's ground point for the rubber-band preview
  window.addEventListener('pointermove', (e) => {
    if (mode !== 'line' && mode !== 'polygon') return;
    if (e.target !== canvas) return;
    cursor = groundAt(e.clientX, e.clientY);
    rebuildDraft();
  });
  canvas.addEventListener('dblclick', (e) => {
    if (mode === 'line' || mode === 'polygon') { e.stopPropagation(); finishDraft(); }
  }, true);
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === textInput) return;
    if (e.key === '`') { togglePanel(); }
    else if (e.key === 'Enter' && (mode === 'line' || mode === 'polygon')) finishDraft();
    else if (e.key === 'Escape' && draft.length) { draft = []; rebuildDraft(); }
  });

  rebuildGizmos();
  renderList();
  return { update };
}
