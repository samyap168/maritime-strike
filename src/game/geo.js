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

  const tri = (a, b, c) => { pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

  for (let i = 0; i < S.length - 1; i++) {
    const A = S[i], B = S[i + 1];
    for (const side of [1, -1]) {
      const flip = side === 1;
      // Bottom panel: keel centreline out to the chine.
      const k1 = [0, A.keelY, A.z], k2 = [0, B.keelY, B.z];
      const c1 = [side * A.w * 0.64, A.chineY, A.z], c2 = [side * B.w * 0.64, B.chineY, B.z];
      // Topside panel: chine up to the deck edge.
      const d1 = [side * A.w, A.deckY, A.z], d2 = [side * B.w, B.deckY, B.z];
      if (flip) { quad(k1, c1, c2, k2); quad(c1, d1, d2, c2); }
      else { quad(k1, k2, c2, c1); quad(c1, c2, d2, d1); }
    }
    // Deck surface.
    quad([-A.w, A.deckY, A.z], [A.w, A.deckY, A.z], [B.w, B.deckY, B.z], [-B.w, B.deckY, B.z]);
  }

  // Transom (flat stern face).
  const T = S[S.length - 1];
  quad([0, T.keelY, T.z], [-T.w * 0.64, T.chineY, T.z], [-T.w, T.deckY, T.z], [T.w, T.deckY, T.z]);
  tri([0, T.keelY, T.z], [T.w, T.deckY, T.z], [T.w * 0.64, T.chineY, T.z]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
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

/** Low-poly rock, faceted by jittering an icosahedron. */
export function buildRock(radius, rng) {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const s = 0.72 + rng() * 0.55;
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.72, p.getZ(i) * s);
  }
  geo.computeVertexNormals();
  return geo;
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
