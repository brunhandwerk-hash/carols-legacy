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
- `src/terrain.ts` — analytic heightfield (no heightmap asset); `terrainHeight(x,z)` is the single source of truth for elevation; plots are flattened via `registerFlatSpot` *before* the mesh is built.
- `src/world.ts` — scene, lights, backdrop peaks, instanced trees/rocks/bushes; each instance is a `ResourceNode` in `G.nodes`.
- `src/state.ts` — global mutable state `G` (resources, villagers, buildings, era). Exposed as `window.G` for debugging/smoke tests.
- `src/buildings.ts` — `BuildingDef` registry + procedural mesh builders; phases planned → site → done.
- `src/units.ts` — villager task state machine (idle/move/gather/build).
- `src/eras.ts` — era objectives & progression; spawns 'planned' signposts per era.
- `src/input.ts` — RTS camera, click/box selection, right-click commands, ghost placement.
- Coordinates: +x east, +z south; map ~520×680 units; monastery knoll near (-45,-35), hamlet (30,105), Peleș clearing (-198,-228).
