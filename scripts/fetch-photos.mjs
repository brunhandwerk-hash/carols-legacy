// Fetch freely-licensed historical photos from Wikimedia Commons for the
// Chronicle. Public-domain results are preferred (they bias toward genuine
// period images); CC is accepted as a fallback. Downloads a ~720px thumbnail to
// public/photos/<id>.jpg and writes public/photos/credits.json with attribution.
//
// Run: node scripts/fetch-photos.mjs
// These are placeholders — swap in your own files under public/photos/ later;
// the chronicle keeps using <id>.jpg, so just overwrite the file.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'photos');

// chronicle id -> Commons search query (aimed at period imagery)
// id -> { q: search query, must: regex the file title must match (relevance guard
// so an unrelated free image can't win on license alone) }
const QUERIES = {
  founding:    { q: 'Sinaia Monastery 1860',        must: /sinaia|mân|monaster/i },
  monastery:   { q: 'Sinaia Monastery old',         must: /sinaia|mân|monaster/i },
  oldinn:      { q: 'Sinaia hotel historic',        must: /sinaia|caraiman|hotel/i },
  station:     { q: 'Sinaia railway station',       must: /sinaia|railway|gară|gar/i },
  foisor:      { q: 'Foișor Peleș Sinaia',          must: /foi[șs]or|sinaia|pele/i },
  cavalerilor: { q: 'Casa Cavalerilor Sinaia',      must: /cavaleri|oaspeti|sinaia/i },
  economat:    { q: 'Economat Sinaia',              must: /economat|sina|woning/i },
  guard:       { q: 'Corpul de Gardă Peleș',        must: /gard|guard|pele|sinaia/i },
  peles:       { q: 'Castelul Peleș Sinaia',        must: /pele/i },
  wwi:         { q: 'Romania World War I 1916',      must: /romania|român|1916|war/i },
  abdication:  { q: 'Michael I of Romania king',     must: /michael|mihai|romania/i },
};

const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'carols-legacy/1.0 (chronicle photo fetch; educational game)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET with retry/backoff on 429 (Commons rate-limits bursts)
async function getRetry(url, { json = false, tries = 5 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return json ? r.json() : r;
  }
  throw new Error('rate-limited (429) after retries');
}

const strip = (s) => (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const isFree = (lic) => /public domain|^pd|cc[ -]?(0|by)/i.test(lic || '');
const isPD = (lic) => /public domain|^pd|cc0/i.test(lic || '');

async function searchPhotos(query, must) {
  const url = `${API}?${new URLSearchParams({
    action: 'query', format: 'json', generator: 'search',
    gsrsearch: query, gsrnamespace: '6', gsrlimit: '12',
    prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '720',
  })}`;
  const j = await getRetry(url, { json: true });
  const pages = Object.values(j?.query?.pages ?? {});
  const cands = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii || !/image\/(jpeg|png)/.test(ii.mime || '')) continue;
    if (must && !must.test(p.title)) continue; // relevance guard
    const lic = strip(ii.extmetadata?.LicenseShortName?.value);
    if (!isFree(lic)) continue;
    const artist = strip(ii.extmetadata?.Artist?.value) || 'Unknown';
    cands.push({
      title: p.title, thumb: ii.thumburl, descUrl: ii.descriptionurl,
      lic, artist, pd: isPD(lic),
    });
  }
  cands.sort((a, b) => Number(b.pd) - Number(a.pd)); // public-domain first
  return cands;
}

async function download(thumb, dest) {
  const r = await getRetry(thumb);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const only = process.argv[2]; // optional: fetch just one id
  // merge into any existing credits so a targeted re-run never drops others
  let credits = {};
  try { credits = JSON.parse(await readFile(join(OUT, 'credits.json'), 'utf8')); } catch {}
  const entries = Object.entries(QUERIES).filter(([id]) => !only || id === only);
  for (const [id, { q, must }] of entries) {
    try {
      const cands = await searchPhotos(q, must);
      if (!cands.length) { console.log(`✗ ${id}: no free image for "${q}"`); continue; }
      const pick = cands[0];
      const bytes = await download(pick.thumb, join(OUT, `${id}.jpg`));
      credits[id] = {
        file: `photos/${id}.jpg`,
        credit: `${pick.artist} · ${pick.lic} · Wikimedia Commons`,
        source: pick.descUrl,
        title: pick.title,
      };
      console.log(`✓ ${id}: ${pick.title} [${pick.lic}] ${(bytes / 1024).toFixed(0)}kB`);
    } catch (e) {
      console.log(`✗ ${id}: ${e.message}`);
    }
    await sleep(1500); // be polite to the API
  }
  await writeFile(join(OUT, 'credits.json'), JSON.stringify(credits, null, 2));
  console.log(`\nWrote ${Object.keys(credits).length} photos + credits.json`);
}

main();
