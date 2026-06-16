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

// A coursed-masonry retaining wall. Because terrace walls vary wildly in size
// (a 4 m hut pad vs a 40 m monastery terrace), a fixed texture repeat would
// stretch the blocks. We generate the masonry texture ONCE, then per wall clone
// the textures (sharing the canvas, cheap) and set a repeat derived from the
// wall's real circumference/height so blocks stay ~1.4 m everywhere.
let WALL_TEX: { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture } | null = null;
function wallTex(): { map: THREE.CanvasTexture; normalMap: THREE.CanvasTexture } {
  if (WALL_TEX) return WALL_TEX;
  const c = new THREE.Color(0x8f897e);
  const bw = 30, bh = 16; // big quarried blocks
  WALL_TEX = buildSurface({
    seed: 27, size: 256,
    height: (x, y, n) => {
      const row = Math.floor(y / bh);
      const offX = (row % 2) * (bw / 2);
      const inMortar = ((x + offX) % bw) < 3.5 || (y % bh) < 3.5;
      return inMortar ? 0.12 : 0.62 + 0.38 * n(x * 1.3, y * 1.3);
    },
    color: (x, y, _h, n) => {
      const row = Math.floor(y / bh);
      const offX = (row % 2) * (bw / 2);
      const inMortar = ((x + offX) % bw) < 3.5 || (y % bh) < 3.5;
      if (inMortar) return [120, 114, 104];
      const v = n(x * 1.9 + row * 5, y * 1.9);
      const shade = mix(0.7, 1.16, v);
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 4.0,
  });
  return WALL_TEX;
}

export function retainingWallMaterial(circumference: number, height: number): THREE.MeshStandardMaterial {
  const t = wallTex();
  const block = 1.4; // metres per texture tile
  const rx = Math.max(3, Math.round(circumference / block));
  const ry = Math.max(1, Math.round(height / block));
  const map = t.map.clone(); map.needsUpdate = true;
  map.wrapS = map.wrapT = THREE.RepeatWrapping; map.repeat.set(rx, ry); map.anisotropy = 4;
  const normalMap = t.normalMap.clone(); normalMap.needsUpdate = true;
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping; normalMap.repeat.set(rx, ry);
  return new THREE.MeshStandardMaterial({
    map, normalMap, normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.96, metalness: 0,
  });
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

// flowing river water: a rippled normal map over a translucent blue albedo.
// Reflective (low roughness, slight metalness) so the env map paints sky onto it
// and it reads clearly as water. Animate by scrolling normalMap.offset each frame.
export function waterMaterial(base = 0x2f6d86, seed = 91): THREE.MeshStandardMaterial {
  const c = new THREE.Color(base);
  const tex = buildSurface({
    seed,
    height: (x, y, n) => 0.5 + 0.5 * (0.6 * n(x * 0.5, y * 1.4) + 0.4 * Math.sin((x + n(x, y) * 30) * 0.13)),
    color: (x, y, h, n) => {
      const shade = mix(0.82, 1.18, h * 0.5 + n(x, y) * 0.5);
      return [c.r * 255 * shade, c.g * 255 * shade, c.b * 255 * shade];
    },
    normalStrength: 1.5,
  });
  tex.map.repeat.set(6, 22);
  tex.normalMap.repeat.set(6, 22);
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap,
    normalScale: new THREE.Vector2(0.22, 0.22), // subtle ripples, no iridescent glare
    color: 0x4a93b8,   // river blue
    roughness: 0.5,
    metalness: 0.0,    // matte water — avoids the rainbow sky-reflection artefact
    transparent: true,
    opacity: 0.88,
  });
  return mat;
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

// ---- splat-blended terrain ground (image-based PBR) ----------------------
// Real photographic CC0 ground textures (grass/forest-floor/dirt/rock) blended
// per-vertex by an `aSplat` weight attribute baked in buildTerrainMesh. Injected
// into MeshStandardMaterial via onBeforeCompile so shadows / HDRI env / fog / ACES
// all keep working. The existing per-vertex `color` survives as a light tint, so
// snow/water/road/biome colouring still reads. Rock uses triplanar projection so
// cliffs don't stretch. Textures are sampled raw (Linear) and linearised in the
// shader (pow 2.2), since custom texture2D calls bypass three's sRGB auto-decode.
let groundMat: THREE.MeshStandardMaterial | null = null;
// shared uniform so the dev menu can fade the ground texture out (1 = textured,
// 0 = flat splat-tone) without recompiling the material
const groundTexUniform = { value: 1.0 };
export function setGroundTexture(on: boolean): void { groundTexUniform.value = on ? 1.0 : 0.0; }
export function terrainGroundMaterial(): THREE.MeshStandardMaterial {
  if (groundMat) return groundMat;
  const loader = new THREE.TextureLoader();
  const load = (file: string): THREE.Texture => {
    const t = loader.load('/textures/ground/' + file);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 16; // max-out aniso: cuts grazing-angle minification shimmer
    return t; // leave Linear; we linearise manually in the shader
  };
  const tGrass = load('grass_color.jpg');
  const tForest = load('forest_color.jpg');
  const tDirt = load('dirt_color.jpg');
  const tRock = load('rock_color.jpg');

  const m = new THREE.MeshStandardMaterial({ vertexColors: true, color: 0xffffff, roughness: 0.96, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tGrass = { value: tGrass };
    sh.uniforms.tForest = { value: tForest };
    sh.uniforms.tDirt = { value: tDirt };
    sh.uniforms.tRock = { value: tRock };
    sh.uniforms.uTile = { value: 1 / 9 }; // ~9 m per texture repeat
    sh.uniforms.uTexAmt = groundTexUniform; // dev toggle: fade texture detail out

    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute vec4 aSplat;\nattribute float aRiver;\nvarying vec4 vSplat;\nvarying float vRiver;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvSplat = aSplat;\nvRiver = aRiver;\nvec4 _wp = modelMatrix * vec4(transformed, 1.0);\nvWPos = _wp.xyz;\nvWNormal = normalize(mat3(modelMatrix) * normal);');

    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform sampler2D tGrass;\nuniform sampler2D tForest;\nuniform sampler2D tDirt;\nuniform sampler2D tRock;\nuniform float uTile;\nuniform float uTexAmt;\nvarying vec4 vSplat;\nvarying float vRiver;\nvarying vec3 vWPos;\nvarying vec3 vWNormal;\n' +
        // value noise (for UV domain-warp below)
        'float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\n' +
        'float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);\n' +
        '  float a=h21(i), b=h21(i+vec2(1,0)), c=h21(i+vec2(0,1)), d=h21(i+vec2(1,1));\n' +
        '  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }\n' +
        // de-tile: blend the texture with a second rotated/rescaled sample so the
        // ~9 m repeat doesn't read as an obvious grid at close range
        'vec3 detile(sampler2D t, vec2 uv){ vec3 a = texture2D(t, uv).rgb; vec3 b = texture2D(t, uv * -0.41 + vec2(0.37, 0.61)).rgb; return mix(a, b, 0.4); }')
      .replace('#include <map_fragment>', `
        // Domain-warp the sampling position with noise BEFORE tiling. A rigid
        // world-space tiling (even de-tiled) beats into a regular diagonal moiré
        // that reads as parallel lines on flat ground; warping the lookup jitters
        // the tile phase across space so the repeat never lines up. Two octaves
        // (one coarse, one fine) avoid the warp itself imprinting a single period.
        vec2 wp = vWPos.xz * 0.013;
        vec2 warp = (vec2(vnoise(wp), vnoise(wp + 17.3)) - 0.5) * 11.0;
        vec2 guv = (vWPos.xz + warp) * uTile;
        vec4 w = max(vSplat, 0.0); w /= (w.x + w.y + w.z + w.w + 1e-4);
        vec3 cG = detile(tGrass, guv);
        vec3 cF = detile(tForest, guv);
        vec3 cD = detile(tDirt, guv);
        vec3 bn = abs(normalize(vWNormal)); bn /= (bn.x + bn.y + bn.z);
        vec3 cR = texture2D(tRock, vWPos.zy * uTile).rgb * bn.x
                + texture2D(tRock, vWPos.xz * uTile).rgb * bn.y
                + texture2D(tRock, vWPos.xy * uTile).rgb * bn.z;
        vec3 blended = cG * w.x + cF * w.y + cD * w.z + cR * w.w;
        // dev texture toggle: fade to flat per-splat tones (approx texture averages)
        // so the ground keeps its grass/forest/dirt/rock regions but loses all tile
        // detail — lets you see the texture's contribution to artifacts in isolation
        if (uTexAmt < 0.999) {
          vec3 flatBlend = vec3(0.18,0.24,0.15)*w.x + vec3(0.10,0.16,0.08)*w.y
                         + vec3(0.30,0.24,0.16)*w.z + vec3(0.34,0.32,0.29)*w.w;
          blended = mix(flatBlend, blended, uTexAmt);
        }
        blended = pow(blended, vec3(2.2)); // sRGB -> linear (manual, see note)
        blended *= 1.25;                    // lift the (realistic, dark) ground to sit with the bright kit
        // large-scale variation further breaks the tile repeat
        float macro = 0.93 + 0.09 * sin(vWPos.x * 0.011 + 1.3) * sin(vWPos.z * 0.0097 - 0.7);
        blended *= macro;
        vec3 tint = mix(vec3(1.0), diffuseColor.rgb, 0.35); // diffuseColor.rgb = vColor here
        diffuseColor.rgb = blended * tint;
        // ---- the river: paint the ground itself blue along the course (vRiver=1 at
        // the channel centre, fading to 0 at the banks). Painting the terrain mesh
        // guarantees the river is always visible — it can never be buried or z-fight
        // a separate water plane. Kept a flat, uniform blue: a sine "ripple" read as
        // obvious diagonal stripes (two shades), and a low-roughness sheen reflected
        // the bright HDRI sky as a blown-out white streak — so the water stays matte
        // and a single solid colour.
        vec3 waterCol = vec3(0.02, 0.12, 0.30); // deep, clearly-blue river (linear space)
        diffuseColor.rgb = mix(diffuseColor.rgb, waterCol, vRiver);
      `);
  };
  groundMat = m;
  return m;
}
