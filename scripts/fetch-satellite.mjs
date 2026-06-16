// Fetch a real satellite image of the Sinaia map bbox (Esri World Imagery) and
// save it to public/satellite.jpg, to drape over the terrain as a reference
// layer in the dev annotation tool. Uses the bbox from public/dem.json so the
// image lines up exactly with the terrain mesh. Esri imagery © Esri et al.
//
// Run: node scripts/fetch-satellite.mjs

import { writeFileSync, readFileSync } from 'node:fs';

const meta = JSON.parse(readFileSync('public/dem.json', 'utf8'));
const { minLon, minLat, maxLon, maxLat, widthM, depthM } = meta;

// plate-carrée (EPSG:4326) export: rows linear in latitude, matching how the
// game maps lat -> world z, so UVs align corner-to-corner with the terrain.
const W = 1500;
const H = Math.round(W * (depthM / widthM)); // keep ground pixels ~square
const url = 'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?'
  + new URLSearchParams({
    bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
    bboxSR: '4326', imageSR: '4326',
    size: `${W},${H}`, format: 'jpg', f: 'image',
  });

console.log(`requesting ${W}x${H} for bbox ${minLon},${minLat},${maxLon},${maxLat}`);
const r = await fetch(url, { headers: { 'User-Agent': 'carols-legacy/1.0 (dev reference overlay)' } });
if (!r.ok) throw new Error(`HTTP ${r.status}`);
const ct = r.headers.get('content-type') || '';
if (!/image/.test(ct)) throw new Error(`not an image (${ct}): ${(await r.text()).slice(0, 200)}`);
const buf = Buffer.from(await r.arrayBuffer());
writeFileSync('public/satellite.jpg', buf);
console.log(`wrote public/satellite.jpg (${(buf.length / 1024).toFixed(0)} kB)`);
