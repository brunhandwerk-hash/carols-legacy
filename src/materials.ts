import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Runtime-generated PBR materials. No image files: every texture (albedo +
// normal) is drawn into a canvas at startup from value noise, so surfaces get
// tactile relief and grain while the project stays asset-free. Shared by
// buildings (and later terrain/props). See the art-style rule in CLAUDE.md.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// smooth 2D value noise with a few octaves, tileable on the canvas size
function makeNoise(seed: number, size: number): (x: number, y: number) => number {
  const rng = mulberry32(seed);
  const grid = 16;
  const g = new Float32Array(grid * grid);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const at = (ix: number, iy: number): number => g[(iy & (grid - 1)) * grid + (ix & (grid - 1))];
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const sample = (x: number, y: number, freq: number): number => {
    const fx = (x / size) * freq, fy = (y / size) * freq;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = smooth(fx - ix), ty = smooth(fy - iy);
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
  return (x, y) => 0.55 * sample(x, y, 4) + 0.3 * sample(x, y, 9) + 0.15 * sample(x, y, 19);
}

interface SurfaceOpts {
  size?: number;
  // height in [0,1] for the normal map and shading
  height: (x: number, y: number, n: (x: number, y: number) => number) => number;
  // base albedo at a pixel, given its height and the noise sampler
  color: (x: number, y: number, h: number, n: (x: number, y: number) => number) => [number, number, number];
  normalStrength?: number;
  seed: number;
}

function buildSurface(o: SurfaceOpts): { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture } {
  const size = o.size ?? 256;
  const noise = makeNoise(o.seed, size);
  const heights = new Float32Array(size * size);
  const albedo = document.createElement('canvas');
  albedo.width = albedo.height = size;
  const actx = albedo.getContext('2d')!;
  const aimg = actx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = o.height(x, y, noise);
      heights[y * size + x] = h;
      const [r, g, b] = o.color(x, y, h, noise);
      const i = (y * size + x) * 4;
      aimg.data[i] = r; aimg.data[i + 1] = g; aimg.data[i + 2] = b; aimg.data[i + 3] = 255;
    }
  }
  actx.putImageData(aimg, 0, 0);

  // height field -> tangent-space normal map
  const strength = o.normalStrength ?? 2.2;
  const normal = document.createElement('canvas');
  normal.width = normal.height = size;
  const nctx = normal.getContext('2d')!;
  const nimg = nctx.createImageData(size, size);
  const H = (x: number, y: number): number => heights[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (H(x - 1, y) - H(x + 1, y)) * strength;
      const dy = (H(x, y - 1) - H(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      nimg.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 3] = 255;
    }
  }
  nctx.putImageData(nimg, 0, 0);

  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  const normalMap = new THREE.CanvasTexture(normal);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  return { map, normalMap };
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

// ---- material library ----------------------------------------------------

function pbr(
  tex: { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture },
  roughness: number, repeat: number, normalScale = 1,
): THREE.MeshStandardMaterial {
  tex.map.repeat.set(repeat, repeat);
  tex.normalMap.repeat.set(repeat, repeat);
  return new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    normalScale: new THREE.Vector2(normalScale, normalScale),
    roughness,
    metalness: 0,
  });
}

// hewn timber: horizontal log courses with grain
export function woodMaterial(base = 0x7a5b3a, seed = 11): THREE.MeshStandardMaterial {
  const c = new THREE.Color(base);
  const tex = buildSurface({
    seed,
    height: (x, y, n) => {
      const course = Math.abs(Math.sin((y / 256) * Math.PI * 5)); // log rows
      const grain = n(x * 0.4, y * 3);
      return 0.35 + 0.45 * course + 0.2 * grain;
    },
    color: (x, y, h, n) => {
      const grain = n(x * 0.5, y * 4);
      const shade = mix(0.7, 1.12, h * 0.6 + grain * 0.4);
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 2.6,
  });
  return pbr(tex, 0.82, 2, 1.1);
}

// laid brick courses with mortar lines — for the interbellic era
export function brickMaterial(base = 0x9c5b43, seed = 71): THREE.MeshStandardMaterial {
  const c = new THREE.Color(base);
  const bw = 22, bh = 11; // brick cell size in texels
  const tex = buildSurface({
    seed,
    height: (x, y, n) => {
      const row = Math.floor(y / bh);
      const offX = (row % 2) * (bw / 2);
      const inMortar = ((x + offX) % bw) < 2.5 || (y % bh) < 2.5;
      return inMortar ? 0.2 : 0.7 + 0.3 * n(x * 1.5, y * 1.5);
    },
    color: (x, y, h, n) => {
      const row = Math.floor(y / bh);
      const offX = (row % 2) * (bw / 2);
      const inMortar = ((x + offX) % bw) < 2.5 || (y % bh) < 2.5;
      if (inMortar) return [196, 190, 178]; // pale mortar
      const v = n(x * 2.1 + row * 7, y * 2.1); // per-brick tone variation
      const shade = mix(0.78, 1.14, v);
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 3.2,
  });
  return pbr(tex, 0.92, 2, 1.3);
}

// rough quarried stone / masonry blocks
export function stoneMaterial(base = 0x9a958c, seed = 23): THREE.MeshStandardMaterial {
  const c = new THREE.Color(base);
  const tex = buildSurface({
    seed,
    height: (x, y, n) => {
      const bx = Math.floor(x / 42) * 0.13 + Math.floor(y / 30) * 0.07;
      const mortarX = (x % 42) < 3 || (y % 30) < 3 ? 0.25 : 1; // recessed mortar lines
      return (0.55 + 0.45 * n(x, y)) * mortarX + bx * 0.0;
    },
    color: (x, y, h, n) => {
      const mortar = (x % 42) < 3 || (y % 30) < 3;
      const shade = mortar ? 0.72 : mix(0.78, 1.12, n(x * 0.8, y * 0.8));
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 3.4,
  });
  return pbr(tex, 0.95, 1.5, 1.4);
}

// thatch / straw roof: directional strands
export function thatchMaterial(base = 0xb09455, seed = 31): THREE.MeshStandardMaterial {
  const c = new THREE.Color(base);
  const tex = buildSurface({
    seed,
    height: (x, y, n) => 0.4 + 0.6 * n(x * 0.25, y * 6),
    color: (x, y, h, n) => {
      const strand = n(x * 0.3, y * 7);
      const shade = mix(0.72, 1.12, strand);
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 2.8,
  });
  return pbr(tex, 0.9, 3, 1.2);
}

// fired roof tiles / shingles: overlapping rows
export function tileMaterial(base = 0x9c4a38, seed = 41): THREE.MeshStandardMaterial {
  const c = new THREE.Color(base);
  const tex = buildSurface({
    seed,
    height: (x, y) => {
      const row = ((y % 22) / 22);
      const col = (Math.floor(y / 22) % 2) * 11;
      const ridge = Math.abs(Math.sin(((x + col) / 22) * Math.PI));
      return 0.3 + 0.5 * (1 - row) + 0.2 * ridge;
    },
    color: (x, y, h, n) => {
      const shade = mix(0.7, 1.12, h * 0.7 + n(x, y) * 0.3);
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 3,
  });
  return pbr(tex, 0.7, 2.5, 1.2);
}

// lime plaster / whitewash: subtle mottling
export function plasterMaterial(base = 0xf2ecdd, seed = 53): THREE.MeshStandardMaterial {
  const c = new THREE.Color(base);
  const tex = buildSurface({
    seed,
    height: (x, y, n) => 0.5 + 0.5 * n(x * 0.7, y * 0.7),
    color: (x, y, h, n) => {
      const shade = mix(0.9, 1.04, n(x, y));
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 1.1,
  });
  return pbr(tex, 0.85, 2, 0.6);
}

// rounded cobblestones for paved roads
export function cobbleMaterial(base = 0x8c8a86, seed = 83): THREE.MeshStandardMaterial {
  const c = new THREE.Color(base);
  const cell = 12;
  const tex = buildSurface({
    seed,
    height: (x, y, n) => {
      const cx = Math.floor(x / cell) * cell + cell / 2 + (n(x, y) - 0.5) * 3;
      const cy = Math.floor(y / cell) * cell + cell / 2 + (n(y, x) - 0.5) * 3;
      const d = Math.hypot(x - cx, y - cy) / (cell * 0.62);
      const bump = Math.max(0, 1 - d * d);          // domed stone
      const gap = ((x % cell) < 1.6 || (y % cell) < 1.6) ? 0.35 : 1; // recessed joints
      return 0.18 + 0.72 * bump * gap;
    },
    color: (x, y, h, n) => {
      const shade = mix(0.66, 1.12, h * 0.6 + n(x * 1.3, y * 1.3) * 0.4);
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 3.4,
  });
  return pbr(tex, 0.93, 1, 1.4);
}

// packed earth / dirt
export function earthMaterial(base = 0x8a6f4d, seed = 67): THREE.MeshStandardMaterial {
  const c = new THREE.Color(base);
  const tex = buildSurface({
    seed,
    height: (x, y, n) => n(x, y),
    color: (x, y, h, n) => {
      const shade = mix(0.78, 1.12, n(x * 0.9, y * 0.9));
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 1.6,
  });
  return pbr(tex, 0.97, 2, 0.8);
}
