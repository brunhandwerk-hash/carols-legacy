// Fetch a WIDE, low-res elevation grid around Sinaia so the real surrounding
// massifs — the Bucegi escarpment to the west/south-west (up to Omu 2514 m) and
// the Baiului mountains to the east — can be rendered as a backdrop ring behind
// the detailed playable terrain. Same terrarium source as fetch-dem.mjs, lower
// zoom + downsampled. Writes public/backdrop.bin (Int16 m) + backdrop.json.
//
// The backdrop.json keeps the SAME metric convention as dem.json so the renderer
// can place every backdrop vertex with the playable map's lon/lat->world mapping.
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'fs';

// generous box: Bucegi plateau west (Omu/Costila/Caraiman/Vf cu Dor), Baiu east,
// Predeal approach north, Comarnic descent south
const BBOX = { minLat: 45.20, maxLat: 45.52, minLon: 25.34, maxLon: 25.74 };
const ZOOM = 12;             // ~38 m/px — plenty for distant silhouettes
const TARGET_MAX = 520;      // downsample so the longest side is ~this many cells

const n = 2 ** ZOOM;
const lon2x = (lon) => ((lon + 180) / 360) * n;
const lat2y = (lat) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
};

const xMin = Math.floor(lon2x(BBOX.minLon));
const xMax = Math.floor(lon2x(BBOX.maxLon));
const yMin = Math.floor(lat2y(BBOX.maxLat));
const yMax = Math.floor(lat2y(BBOX.minLat));
console.log(`tiles x ${xMin}..${xMax}, y ${yMin}..${yMax} at z${ZOOM}`);

async function fetchTile(x, y) {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return PNG.sync.read(Buffer.from(await res.arrayBuffer()));
}

const tilesW = xMax - xMin + 1;
const tilesH = yMax - yMin + 1;
const stitchW = tilesW * 256;
const stitchH = tilesH * 256;
const elev = new Float32Array(stitchW * stitchH);
for (let ty = yMin; ty <= yMax; ty++) {
  for (let tx = xMin; tx <= xMax; tx++) {
    const png = await fetchTile(tx, ty);
    const ox = (tx - xMin) * 256, oy = (ty - yMin) * 256;
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const i = (py * 256 + px) * 4;
        const h = png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
        elev[(oy + py) * stitchW + (ox + px)] = h;
      }
    }
    process.stdout.write('.');
  }
}
console.log('\nstitched', stitchW, 'x', stitchH);

// crop to the exact bbox in stitched-pixel space
const px0 = Math.round((lon2x(BBOX.minLon) - xMin) * 256);
const px1 = Math.round((lon2x(BBOX.maxLon) - xMin) * 256);
const py0 = Math.round((lat2y(BBOX.maxLat) - yMin) * 256);
const py1 = Math.round((lat2y(BBOX.minLat) - yMin) * 256);
const cropW = px1 - px0, cropH = py1 - py0;

// downsample by block-averaging to ~TARGET_MAX on the long side
const scale = Math.max(1, Math.round(Math.max(cropW, cropH) / TARGET_MAX));
const W = Math.floor(cropW / scale), H = Math.floor(cropH / scale);
const out = new Int16Array(W * H);
let min = Infinity, max = -Infinity;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let sum = 0, cnt = 0;
    for (let sy = 0; sy < scale; sy++) {
      for (let sx = 0; sx < scale; sx++) {
        const gx = px0 + x * scale + sx, gy = py0 + y * scale + sy;
        sum += elev[gy * stitchW + gx]; cnt++;
      }
    }
    const v = Math.round(sum / cnt);
    out[y * W + x] = v;
    if (v < min) min = v; if (v > max) max = v;
  }
}

const midLat = (BBOX.minLat + BBOX.maxLat) / 2;
const mPerDegLat = 111132.954 - 559.822 * Math.cos((2 * midLat * Math.PI) / 180);
const mPerDegLon = 111319.49 * Math.cos((midLat * Math.PI) / 180);

mkdirSync('public', { recursive: true });
writeFileSync('public/backdrop.bin', Buffer.from(out.buffer));
const meta = {
  ...BBOX, w: W, h: H,
  widthM: Math.round((BBOX.maxLon - BBOX.minLon) * mPerDegLon),
  depthM: Math.round((BBOX.maxLat - BBOX.minLat) * mPerDegLat),
  minElev: Math.round(min), maxElev: Math.round(max),
};
writeFileSync('public/backdrop.json', JSON.stringify(meta, null, 2));
console.log('wrote public/backdrop.bin + backdrop.json', meta);

const sample = (lat, lon) => {
  const fx = Math.round((((lon2x(lon) - xMin) * 256 - px0)) / scale);
  const fy = Math.round((((lat2y(lat) - yMin) * 256 - py0)) / scale);
  return out[Math.min(H - 1, Math.max(0, fy)) * W + Math.min(W - 1, Math.max(0, fx))];
};
console.log('Omu        ~', sample(45.4456, 25.4553), 'm (expect ~2500)');
console.log('Caraiman   ~', sample(45.404, 25.470), 'm (expect ~2380)');
console.log('Baiu Mare  ~', sample(45.41, 25.62), 'm (expect ~1900)');
console.log('Sinaia ctr ~', sample(45.3525, 25.54), 'm (expect ~900)');
