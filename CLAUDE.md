# Carol's Legacy

Browser RTS about Sinaia, Romania (1690–1947): the town grows from forest hamlet to royal summer residence. Three.js + TypeScript + Vite, no game engine, all geometry procedural and all textures generated at runtime (no binary asset files).

## Commands
- `npm run dev` — Vite dev server (port 5173)
- `npm run build` — type-check (`tsc --noEmit`) + production build

## Design rules
- **History first**: landmark buildings stand on fixed plots ([src/plots.ts](src/plots.ts)) matching real Sinaia geography. Dates/events come from [docs/research-sinaia.md](docs/research-sinaia.md) — check it before adding eras or buildings.
- **Conflict** is historical events only (WWI 1916 defense chapter), never a rival AI base.
- **Art style**: grounded **stylized realism** (reference: Manor Lords / Foundation / Valheim) — believable building proportions and materials, not flat boxes. Use **`MeshStandardMaterial` (PBR)** lit by an environment map, **ACES Filmic tone-mapping** + sRGB output, soft shadows, and atmospheric fog. Surfaces get tactile **procedurally-generated textures + normal maps** (canvas noise at runtime — wood, stone, thatch, plaster); **no image files**. Terrain keeps vertex colors but gains a subtle procedural normal/roughness. Avoid plain untextured `MeshLambertMaterial`. Shared building materials live in `M` ([src/buildings.ts](src/buildings.ts)); shared texture/material helpers in `src/materials.ts`.
- UI language: English.

## Architecture
- `src/terrain.ts` — terrain from the **real Sinaia DEM** (`public/dem.bin` + `dem.json`, baked by `node scripts/fetch-dem.mjs` from AWS terrarium tiles, bbox 45.32–45.385N / 25.50–25.58E, 1 unit = 1 m, heights relative to 745 m a.s.l.). `loadDem()` must complete before anything samples terrain (async `boot()` in main.ts). `terrainHeight(x,z)` is the single source of truth for gameplay; plots are flattened via `registerFlatSpot` *before* the mesh is built; the Prahova course is auto-traced along the DEM's valley floor. Landmarks are georeferenced lat/lon in `src/plots.ts` (`initPlots()` converts to world coords). **`surfaceHeight(x,z)`** reconstructs the *rendered* coarse mesh's triangle (the mesh is far lower-res than the DEM) — villagers and buildings sit on it so they don't sink/float; gameplay (slope, pathing) still uses `terrainHeight`. `buildRoadMesh()` drapes a cobbled ribbon along the `ROADS` polylines. A wide-area low-res **backdrop DEM** (`public/backdrop.bin` + `backdrop.json`, baked by `node scripts/fetch-backdrop.mjs`, bbox ~45.20–45.52N / 25.34–25.74E) is rendered by `buildBackdropMesh()` as the real surrounding massifs (Bucegi W/SW up to Omu, Băiului E) ringing the playable map with the same lon/lat→world projection (central footprint left hollow for the detailed mesh). It needs the far camera plane (70 km, main.ts) + long fog (world.ts).
- `src/materials.ts` — runtime-generated PBR materials (albedo+normal maps drawn from value noise; wood/stone/brick/thatch/tile/plaster/cobble). No image files.
- `src/world.ts` — scene, lights, backdrop peaks, instanced trees (no shadows)/rocks/bushes; each instance is a `ResourceNode` in `G.nodes`. PBR pipeline (ACES tone-map, env map) is set up in `main.ts`.
- `src/state.ts` — global mutable state `G` (resources incl. `coin`, villagers, buildings, era). Exposed as `window.G`; `window.scene`/`rig`/`terrain` also exposed for debugging.
- `src/buildings.ts` — `BuildingDef` registry + procedural mesh builders (gable roofs, footings, chimneys, framed openings); phases planned → site → done. Each building terraces its ground (`addFoundation`), can be `demolish()`ed, and **re-skins by era** (`eraStyle` bands: log/thatch → plaster/tile → brick/slate; `reskinAllBuildings()` on era advance; builders `tag()` wall/roof meshes).
- `src/units.ts` — villager task state machine (idle/move/gather/build); each villager has a `Profession` with a distinct outfit + tool.
- `src/eras.ts` — era objectives & progression; spawns 'planned' signposts per era; calls `reskinAllBuildings()` on advance.
- `src/input.ts` — RTS camera, click/box selection, right-click commands, ghost placement.
- Coordinates: +x east, +z south, metres; map 6258×7224 m centred on the bbox. Don't hardcode world positions — derive them from lat/lon via `lonLatToWorld`.
