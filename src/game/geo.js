/**
 * Procedural geometry kit.
 *
 * Every visible object in this game is generated in code — there are no model
 * files to download, so nothing can fail to load, the art direction stays
 * consistent, and any asset can be changed by editing a few numbers. That last
 * point is the whole reason this game exists as a demo.
 *
 * The centrepiece is buildHull(): a parametric boat hull. All five vessels come
 * out of it with different parameters, which is why they all read as real craft
 * rather than as boxes with a pointy end.
 */

import * as THREE from 'three';

const smoothstep = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** The workhorse material: cheapest lit material that still flat-shades. */
export function mat(color, opts = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });
}

export function mesh(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  return m;
}

export const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rt, rb, h, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, false);
export const cone = (r, h, seg = 7) => new THREE.ConeGeometry(r, h, seg);
export const sphere = (r, seg = 8) => new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1));

/**
 * Parametric boat hull.
 *
 * Length runs along +Z (bow at +Z/2, stern at -Z/2). Waterline sits at y=0, so
 * a hull can be dropped straight into the scene without fiddling.
 */
export function buildHull({
  length = 10,
  beam = 3,
  draft = 0.9,          // how far below the waterline
  freeboard = 0.9,      // how far above it
  sternFullness = 0.78, // 1 = square transom, 0.5 = tapered canoe stern
  sheer = 0.55,         // upward curve of the deck line toward the ends
  bowRise = 0.85,       // how much the keel lifts at the bow
  stations = 16,
} = {}) {
  const halfBeam = beam / 2;
  const pos = [];
  // UVs run along the hull (u) and up from keel to deck (v). Without them a
  // hull cannot take a plating or weathering map at all, which is most of what
  // separates a flat-shaded shape from something that reads as built metal.
  const uv = [];

  const widthAt = (t) => {
    if (t < 0.55) return 0.05 + 0.95 * Math.pow(smoothstep(clamp01(t / 0.55)), 0.75);
    return 1 - (1 - sternFullness) * smoothstep(clamp01((t - 0.55) / 0.45));
  };
  const keelAt = (t) => {
    let k = 1;
    if (t < 0.2) k = 1 - bowRise * (1 - smoothstep(clamp01(t / 0.2)));
    else if (t > 0.9) k = 1 - 0.28 * smoothstep(clamp01((t - 0.9) / 0.1));
    return -draft * k;
  };
  const deckAt = (t) => freeboard + sheer * (Math.pow(1 - t, 2.2) * 1.0 + Math.pow(t, 2.4) * 0.35);

  // Sample the hull into cross-sections, bow (t=0) to stern (t=1).
  const S = [];
  for (let i = 0; i < stations; i++) {
    const t = i / (stations - 1);
    const w = halfBeam * widthAt(t);
    const keelY = keelAt(t);
    const deckY = deckAt(t);
    S.push({
      z: length / 2 - t * length,
      w,
      keelY,
      chineY: keelY + (deckY - keelY) * 0.3,
      deckY,
    });
  }

  // Texture repeats: a few plate courses along the length, one span keel-to-deck.
  const uRepeat = Math.max(2, Math.round(length / 6));
  const tri = (a, b, c) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    uv.push(a[3], a[4], b[3], b[4], c[3], c[4]);
  };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

  for (let i = 0; i < S.length - 1; i++) {
    const A = S[i], B = S[i + 1];
    const uA = (i / (S.length - 1)) * uRepeat;
    const uB = ((i + 1) / (S.length - 1)) * uRepeat;
    for (const side of [1, -1]) {
      const flip = side === 1;
      // Bottom panel: keel centreline out to the chine.
      const k1 = [0, A.keelY, A.z, uA, 0], k2 = [0, B.keelY, B.z, uB, 0];
      const c1 = [side * A.w * 0.64, A.chineY, A.z, uA, 0.42], c2 = [side * B.w * 0.64, B.chineY, B.z, uB, 0.42];
      // Topside panel: chine up to the deck edge.
      const d1 = [side * A.w, A.deckY, A.z, uA, 1], d2 = [side * B.w, B.deckY, B.z, uB, 1];
      if (flip) { quad(k1, c1, c2, k2); quad(c1, d1, d2, c2); }
      else { quad(k1, k2, c2, c1); quad(c1, c2, d2, d1); }
    }
    // Deck surface.
    quad([-A.w, A.deckY, A.z, uA, 0], [A.w, A.deckY, A.z, uA, 1],
         [B.w, B.deckY, B.z, uB, 1], [-B.w, B.deckY, B.z, uB, 0]);
  }

  // Transom (flat stern face).
  const T = S[S.length - 1];
  const uT = uRepeat;
  quad([0, T.keelY, T.z, uT, 0], [-T.w * 0.64, T.chineY, T.z, uT, 0.42],
       [-T.w, T.deckY, T.z, uT, 1], [T.w, T.deckY, T.z, uT, 1]);
  tri([0, T.keelY, T.z, uT, 0], [T.w, T.deckY, T.z, uT, 1], [T.w * 0.64, T.chineY, T.z, uT, 0.42]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** A stubby gun barrel on a rotating mount — reused by several vessels. */
export function buildGunMount(scale, colors) {
  const g = new THREE.Group();
  g.add(mesh(cyl(0.55 * scale, 0.7 * scale, 0.5 * scale, 8), mat(colors.metal), 0, 0.25 * scale, 0));
  const house = mesh(box(0.9 * scale, 0.7 * scale, 1.1 * scale), mat(colors.light), 0, 0.85 * scale, 0);
  g.add(house);
  const barrel = mesh(cyl(0.12 * scale, 0.14 * scale, 2.4 * scale, 6), mat(colors.dark), 0, 0.95 * scale, 1.5 * scale);
  barrel.rotation.x = Math.PI / 2;
  g.add(barrel);
  return g;
}

/**
 * A run of guard rail: two horizontal rails on stanchions.
 *
 * Cheap geometry, and the single detail that most makes a hull read as a real
 * vessel rather than a solid lump — the eye reads the gap between rail and deck
 * as scale. Runs along +/-Z, place and rotate as needed.
 */
export function buildRailing(length, height, posts, color = 0xd6dade) {
  const g = new THREE.Group();
  const m = mat(color);
  g.add(mesh(box(0.07, 0.07, length), m, 0, height, 0));
  g.add(mesh(box(0.05, 0.05, length), m, 0, height * 0.55, 0));
  for (let i = 0; i < posts; i++) {
    const z = -length / 2 + (i / Math.max(1, posts - 1)) * length;
    g.add(mesh(box(0.07, height, 0.07), m, 0, height / 2, z));
  }
  return g;
}

/** Mooring bollard / deck cleat. */
export function buildBollard(scale = 1, color = 0x4a5158) {
  return mesh(cyl(0.13 * scale, 0.17 * scale, 0.5 * scale, 6), mat(color), 0, 0.25 * scale, 0);
}

/** A ring of fenders or a coil of rope — small, round, and very "boat". */
export function buildRing(radius, tube, color) {
  return new THREE.Mesh(
    new THREE.TorusGeometry(radius, tube, 4, 10),
    mat(color)
  );
}

/** Radar / mast assembly. */
export function buildMast(h, colors) {
  const g = new THREE.Group();
  g.add(mesh(cyl(0.08, 0.14, h, 5), mat(colors.metal), 0, h / 2, 0));
  const dish = mesh(box(1.9, 0.12, 0.5), mat(colors.light), 0, h * 0.92, 0);
  g.add(dish);
  g.userData.spin = dish;
  return g;
}

/** Simple stylised palm, used on the southern cay. */
export function buildPalm(rng) {
  const g = new THREE.Group();
  const h = 5 + rng() * 4;
  const trunk = mesh(cyl(0.18, 0.34, h, 5), mat(0x8a6f4a), 0, h / 2, 0);
  trunk.rotation.z = (rng() - 0.5) * 0.25;
  g.add(trunk);
  const fronds = 6;
  for (let i = 0; i < fronds; i++) {
    const f = mesh(box(3.4, 0.14, 0.9), mat(0x3f7d44));
    f.position.set(Math.cos((i / fronds) * Math.PI * 2) * 1.5, h, Math.sin((i / fronds) * Math.PI * 2) * 1.5);
    f.rotation.y = (i / fronds) * Math.PI * 2;
    f.rotation.z = -0.42;
    g.add(f);
  }
  return g;
}

/**
 * Low-poly rock, faceted by jittering an icosahedron.
 *
 * The jitter range matters more than it looks: displacing each vertex
 * independently over a wide range turns the solid into a starburst of shards.
 * Kept tight, the same operation reads as a weathered rock mass.
 */
export function buildRock(radius, rng) {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const p = geo.attributes.position;
  // Displace along shared directions rather than per-vertex, so neighbouring
  // vertices move together into facets instead of apart into spikes.
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const lobe = 0.90 + 0.16 * Math.sin(x * 0.35 + rng() * 0.001) * Math.cos(z * 0.31);
    const s = lobe * (0.96 + rng() * 0.10);
    p.setXYZ(i, x * s, y * s * 0.80, z * s);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Collapse a built vessel's static parts into one mesh per material.
 *
 * Detail is cheap in triangles and expensive in DRAW CALLS, and draw calls are
 * what actually kills integrated laptop GPUs. A detailed hull is ~80 separate
 * meshes; sixteen of those is ~1300 draw calls per frame before anything else
 * is drawn. Merging by material takes each vessel to a handful.
 *
 * Anything that has to move independently — the turret, spinning radar dishes —
 * is passed in `keep` and left alone.
 */
export function mergeStatic(root, keep = []) {
  root.updateMatrixWorld(true);

  const keepSet = new Set(keep.filter(Boolean));
  const isKept = (obj) => {
    for (let n = obj; n; n = n.parent) if (keepSet.has(n)) return true;
    return false;
  };

  const buckets = new Map();
  const doomed = [];

  root.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || isKept(obj)) return;
    const m = obj.material;
    // Materials differing in any of these cannot share a draw call. The map's
    // identity is part of that: merging a textured mesh with an untextured one
    // would silently drop the texture from whichever lost.
    const key = [
      m.color.getHex(), m.emissive ? m.emissive.getHex() : 0,
      m.emissiveIntensity ?? 1, m.transparent ? 1 : 0, m.opacity,
      m.map ? m.map.uuid : 'nomap',
    ].join('|');

    let bucket = buckets.get(key);
    if (!bucket) { bucket = { material: m, pos: [], nrm: [], uv: [] }; buckets.set(key, bucket); }

    const geo = (obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone());
    geo.applyMatrix4(obj.matrixWorld);   // root sits at identity while building
    const pos = geo.attributes.position.array;
    const nrm = geo.attributes.normal ? geo.attributes.normal.array : null;
    const uvA = geo.attributes.uv ? geo.attributes.uv.array : null;
    for (let i = 0; i < pos.length; i++) bucket.pos.push(pos[i]);
    if (nrm) for (let i = 0; i < nrm.length; i++) bucket.nrm.push(nrm[i]);
    else for (let i = 0; i < pos.length; i++) bucket.nrm.push(0);
    // A geometry with no UVs still needs entries, or the attribute lengths
    // diverge and the merged mesh renders garbage.
    const verts = pos.length / 3;
    if (uvA) for (let i = 0; i < uvA.length; i++) bucket.uv.push(uvA[i]);
    else for (let i = 0; i < verts * 2; i++) bucket.uv.push(0);
    geo.dispose();
    doomed.push(obj);
  });

  for (const obj of doomed) obj.removeFromParent();

  for (const bucket of buckets.values()) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uv, 2));
    geo.computeBoundingSphere();
    const merged = new THREE.Mesh(geo, bucket.material);
    merged.castShadow = true;
    root.add(merged);
  }
  return root;
}

/** Deterministic PRNG so every browser generates an identical map. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
