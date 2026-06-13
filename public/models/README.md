# Hero models (authored glTF for landmark buildings)

Drop authored `.glb` files here, named by building key, and the matching landmark
will swap its procedural mesh for the model automatically (see the `model` field
on a `BuildingDef` in [../../src/buildings.ts](../../src/buildings.ts) and the loader in
[../../src/models.ts](../../src/models.ts)).

Currently wired:

| File                  | Building            | Notes                                  |
|-----------------------|---------------------|----------------------------------------|
| `monastery.glb`       | Sinaia Monastery    | auto-fit to ~16 m footprint radius     |

If a file is missing or fails to load, the procedural building is used as a
fallback — nothing breaks.

## Requirements
- Format: **`.glb`** (binary glTF). If the model uses **Draco** compression we
  must also wire up `DRACOLoader` (not set up yet) — prefer uncompressed `.glb`.
- Orientation: +Y up, "front" facing +Z is ideal (use `model.rotationY` to spin).
- The loader auto-centres on the footprint and rests the base on the terrace, and
  auto-scales to the `fitRadius`. Override with `scale` / `yOffset` per building.

## Sourcing (CC0 / permissively licensed)
- **Poly Pizza** (poly.pizza) — lots of CC0 low-to-mid-poly buildings, direct `.glb`.
- **Quaternius** (quaternius.com) — CC0 modular building/medieval packs.
- **Sketchfab** — filter by *Downloadable* + CC0/CC-BY (mind attribution).
- **Kenney** (kenney.nl) — CC0 building kits (stylised).

Keep a `CREDITS.md` here if a model needs attribution (CC-BY).
