# Karol's Legacy

Browser RTS about Sinaia, Romania (1690–1947): the town grows from forest hamlet to royal summer residence. Three.js + TypeScript + Vite, no game engine, all geometry procedural (no asset files).

## Commands
- `npm run dev` — Vite dev server (port 5173)
- `npm run build` — type-check (`tsc --noEmit`) + production build

## Design rules
- **History first**: landmark buildings stand on fixed plots ([src/plots.ts](src/plots.ts)) matching real Sinaia geography. Dates/events come from [docs/research-sinaia.md](docs/research-sinaia.md) — check it before adding eras or buildings.
- **Conflict** is historical events only (WWI 1916 defense chapter), never a rival AI base.
- **Art style**: painted-postcard low-poly — warm saturated colors, fog, no textures, vertex colors on terrain.
- UI language: English.

## Architecture
- `src/terrain.ts` — terrain from the **real Sinaia DEM** (`public/dem.bin` + `dem.json`, baked by `node scripts/fetch-dem.mjs` from AWS terrarium tiles, bbox 45.32–45.385N / 25.50–25.58E, 1 unit = 1 m, heights relative to 745 m a.s.l.). `loadDem()` must complete before anything samples terrain (async `boot()` in main.ts). `terrainHeight(x,z)` is the single source of truth; plots are flattened via `registerFlatSpot` *before* the mesh is built; the Prahova course is auto-traced along the DEM's valley floor. Landmarks are georeferenced lat/lon in `src/plots.ts` (`initPlots()` converts to world coords).
- `src/world.ts` — scene, lights, backdrop peaks, instanced trees/rocks/bushes; each instance is a `ResourceNode` in `G.nodes`.
- `src/state.ts` — global mutable state `G` (resources, villagers, buildings, era). Exposed as `window.G` for debugging/smoke tests.
- `src/buildings.ts` — `BuildingDef` registry + procedural mesh builders; phases planned → site → done.
- `src/units.ts` — villager task state machine (idle/move/gather/build).
- `src/eras.ts` — era objectives & progression; spawns 'planned' signposts per era.
- `src/input.ts` — RTS camera, click/box selection, right-click commands, ghost placement.
- Coordinates: +x east, +z south, metres; map 6258×7224 m centred on the bbox. Don't hardcode world positions — derive them from lat/lon via `lonLatToWorld`.
