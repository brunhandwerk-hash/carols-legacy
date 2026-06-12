import { MAP } from './config';
import { terrainHeight, terrainSlope, riverX, SNOWLINE } from './terrain';
import { PLOTS } from './plots';
import { G } from './state';
import { forestedAt } from './world';

let W = 210, H = 242; // canvas pixels, set from the map aspect in init
let base: ImageData | null = null;
let ctx: CanvasRenderingContext2D;

const toPx = (x: number): number => ((x - MAP.minX) / MAP.width) * W;
const toPy = (z: number): number => ((z - MAP.minZ) / MAP.depth) * H;
const toWorldX = (px: number): number => MAP.minX + (px / W) * MAP.width;
const toWorldZ = (py: number): number => MAP.minZ + (py / H) * MAP.depth;

export function initMinimap(onJump: (x: number, z: number) => void): void {
  const canvas = document.getElementById('minimap') as HTMLCanvasElement;
  W = 210;
  H = Math.round(W * (MAP.depth / MAP.width));
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx = canvas.getContext('2d')!;
  // pre-render terrain colors from the real DEM
  base = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const x = toWorldX(px), z = toWorldZ(py);
      const h = terrainHeight(x, z);
      const slope = terrainSlope(x, z);
      let r = 130, g = 158, b = 88; // grass
      if (forestedAt(x, z)) { r = 62; g = 96; b = 60; } // conifer forest
      if (slope > 0.55 && h > SNOWLINE - 220) { r = 138; g = 132; b = 120; } // high rock
      if (h > SNOWLINE) { r = 228; g = 232; b = 235; } // alpine snow
      const shade = Math.max(0.55, Math.min(1.3, 0.85 + h * 0.0009 + slope * 0.1));
      r *= shade; g *= shade; b *= shade;
      if (Math.abs(x - riverX(z)) < 18) { r = 93; g = 143; b = 168; }
      const i = (py * W + px) * 4;
      base.data[i] = r; base.data[i + 1] = g; base.data[i + 2] = b; base.data[i + 3] = 255;
    }
  }
  const jump = (e: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * H;
    onJump(toWorldX(px), toWorldZ(py));
  };
  canvas.addEventListener('mousedown', (e) => {
    jump(e);
    const move = (ev: MouseEvent): void => jump(ev);
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

export function drawMinimap(camTarget: { x: number; z: number }, camYaw: number, viewSpan: number): void {
  if (!base) return;
  ctx.putImageData(base, 0, 0);
  // landmark plots
  for (const p of PLOTS) {
    if (p.era > G.eraIndex) continue;
    ctx.strokeStyle = '#d4a843';
    ctx.beginPath();
    ctx.arc(toPx(p.x), toPy(p.z), 3.4, 0, Math.PI * 2);
    ctx.stroke();
  }
  // buildings
  for (const b of G.buildings) {
    ctx.fillStyle = b.phase === 'done' ? '#e8d49a' : '#a8854a';
    ctx.fillRect(toPx(b.x) - 2, toPy(b.z) - 2, 4, 4);
  }
  // villagers
  for (const v of G.villagers) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(toPx(v.x) - 1, toPy(v.z) - 1, 2.5, 2.5);
  }
  // camera footprint
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.save();
  ctx.translate(toPx(camTarget.x), toPy(camTarget.z));
  ctx.rotate(-camYaw);
  const s = Math.max(6, (viewSpan / MAP.width) * W);
  ctx.strokeRect(-s / 2, -s / 2.6, s, s / 1.3);
  ctx.restore();
}
