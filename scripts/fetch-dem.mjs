// Fetch real elevation data for the Sinaia valley from the AWS Terrain Tiles
// (terrarium encoding, Copernicus/SRTM derived, ~10m at this zoom) and bake it
// into public/dem.bin (Int16 metres, row-major north->south) + public/dem.json.
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'fs';

// bounding box around Sinaia: Bucegi slopes west, Baiu slope east
const BBOX = { minLat: 45.32, maxLat: 45.385, minLon: 25.50, maxLon: 25.58 };
const ZOOM = 14;

const n = 2 ** ZOOM;
const lon2x = (lon) => ((lon + 180) / 360) * n;
const lat2y = (lat) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
};

const xMin = Math.floor(lon2x(BBOX.minLon));
const xMax = Math.floor(lon2x(BBOX.maxLon));
const yMin = Math.floor(lat2y(BBOX.maxLat)); // tile y grows southward
const yMax = Math.floor(lat2y(BBOX.minLat));

console.log(`tiles x ${xMin}..${xMax}, y ${yMin}..${yMax} at z${ZOOM}`);

async function fetchTile(x, y) {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${ZOOM}/${x}/${y}.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return PNG.sync.read(buf);
}

const tilesW = xMax - xMin + 1;
const tilesH = yMax - yMin + 1;
const stitchW = tilesW * 256;
const stitchH = tilesH * 256;
const elev = new Float32Array(stitchW * stitchH);

for (let ty = yMin; ty <= yMax; ty++) {
  for (let tx = xMin; tx <= xMax; tx++) {
    const png = await fetchTile(tx, ty);
    const ox = (tx - xMin) * 256;
    const oy = (ty - yMin) * 256;
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

// crop to the exact bbox in pixel space
const px0 = Math.round((lon2x(BBOX.minLon) - xMin) * 256);
const px1 = Math.round((lon2x(BBOX.maxLon) - xMin) * 256);
const py0 = Math.round((lat2y(BBOX.maxLat) - yMin) * 256);
const py1 = Math.round((lat2y(BBOX.minLat) - yMin) * 256);
const W = px1 - px0;
const H = py1 - py0;

const out = new Int16Array(W * H);
let min = Infinity, max = -Infinity;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const v = elev[(py0 + y) * stitchW + (px0 + x)];
    out[y * W + x] = Math.round(v);
    if (v < min) min = v;
    if (v > max) max = v;
  }
}

// metric extents at the bbox centre latitude
const midLat = (BBOX.minLat + BBOX.maxLat) / 2;
const mPerDegLat = 111132.954 - 559.822 * Math.cos((2 * midLat * Math.PI) / 180);
const mPerDegLon = 111319.49 * Math.cos((midLat * Math.PI) / 180);
const widthM = (BBOX.maxLon - BBOX.minLon) * mPerDegLon;
const depthM = (BBOX.maxLat - BBOX.minLat) * mPerDegLat;

mkdirSync('public', { recursive: true });
writeFileSync('public/dem.bin', Buffer.from(out.buffer));
const meta = { ...BBOX, w: W, h: H, widthM: Math.round(widthM), depthM: Math.round(depthM), minElev: Math.round(min), maxElev: Math.round(max) };
writeFileSync('public/dem.json', JSON.stringify(meta, null, 2));
console.log('wrote public/dem.bin + dem.json', meta);

// sanity: elevation at a few known places
const sample = (lat, lon) => {
  const fx = ((lon2x(lon) - xMin) * 256 - px0);
  const fy = ((lat2y(lat) - yMin) * 256 - py0);
  return out[Math.round(fy) * W + Math.round(fx)];
};
console.log('monastery ~', sample(45.3559, 25.5479), 'm (expect ~870)');
console.log('station   ~', sample(45.3497, 25.5506), 'm (expect ~795)');
console.log('peles     ~', sample(45.3604, 25.5421), 'm (expect ~950)');
console.log('furnica peak ~', sample(45.345, 25.505), 'm (expect ~1800-2100)');
