/**
 * The map: a stylised Singapore-inspired combat arena.
 *
 * Explicitly NOT a geographic digital twin — it is a combat space that happens
 * to be recognisably Singapore. Every zone is designed around three rules:
 * cover to break line of sight, at least two approach routes, and a reason to
 * fight over it (usually a weapon pickup).
 *
 * Generation is fully deterministic (fixed anchors + a seeded PRNG), so the
 * host's collision world and every client's predicted movement agree exactly
 * without ever sending map data over the wire.
 */

import * as THREE from 'three';
import { mat, mesh, box, cyl, cone, buildRock, buildPalm, buildHull, mulberry32 } from './geo.js';
import { CFG } from '../config.js';

const HALF = CFG.map.half;

export const ZONES = [
  { id: 'marina',    name: 'MARINA BAY',   x: 300,  z: -300 },
  { id: 'keppel',    name: 'KEPPEL YARDS', x: -350, z: 40 },
  { id: 'kranji',    name: 'KRANJI SHOALS', x: -60, z: -420 },
  { id: 'sisters',   name: 'SISTERS ROCKS', x: 40,  z: 30 },
  { id: 'palawan',   name: 'PALAWAN CAY',  x: 170,  z: 330 },
  { id: 'anchorage', name: 'THE ANCHORAGE', x: 400, z: 170 },
  { id: 'merlion',   name: 'MERLION CAY',  x: -190, z: -160 },
];

/**
 * Collision circles. Everything solid in the world reduces to one of these,
 * which keeps host physics and client prediction cheap and identical.
 */
export const OBSTACLES = [];
const push = (x, z, r, type, extra = {}) => { OBSTACLES.push({ x, z, r, type, ...extra }); return OBSTACLES[OBSTACLES.length - 1]; };

const rng = mulberry32(0x5EA10FF);

/**
 * A long vessel is a CHAIN of collision circles, not one big one.
 *
 * A single circle around a 150m container ship would wall off a huge disc of
 * open water and still not feel like a ship. A line of small circles gives
 * cover that is long and thin — you can run its length, break line of sight,
 * and come out the far end — which is exactly the kind of cover a naval fight
 * wants. Only the first circle carries the visual; it renders at the ship's
 * true centre via cx/cz.
 */
function pushShip(x, z, angle, length, beam, extra = {}) {
  const r = beam / 2;
  const n = Math.max(2, Math.round((length - beam) / (r * 1.35)) + 1);
  const step = n > 1 ? (length - beam) / (n - 1) : 0;
  for (let i = 0; i < n; i++) {
    const d = -length / 2 + r + i * step;
    OBSTACLES.push({
      x: x + Math.sin(angle) * d,
      z: z + Math.cos(angle) * d,
      r,
      type: 'ship',
      render: i === 0,
      cx: x, cz: z, angle, length, beam,
      ...extra,
    });
  }
}

// --- MARINA BAY: long sight-lines, the destroyer's ground ---------------------
const marinaIsle = push(300, -300, 88, 'island', { h: 7 });
push(205, -388, 26, 'island', { h: 5, wheel: true });

// --- KEPPEL YARDS: the best hard cover on the map, a maze at water level ------
push(-400, 40, 76, 'quay', { h: 6 });
push(-318, -50, 54, 'quay', { h: 6 });
push(-318, 130, 54, 'quay', { h: 6 });
// Two container ships berthed alongside — long, solid, and the best cover on
// the map to fight around.
pushShip(-232, -40, 0.12, 190, 30, { h: 9, containers: true });
pushShip(-230, 132, -0.10, 165, 28, { h: 8.5, containers: true });

// --- KRANJI SHOALS: tight winding channels, ambush country --------------------
for (let i = 0; i < 15; i++) {
  const a = (i / 15) * Math.PI * 2 + rng() * 0.7;
  const d = 45 + rng() * 135;
  push(-60 + Math.cos(a) * d * 1.45, -420 + Math.sin(a) * d * 0.66, 18 + rng() * 21, 'mangrove', { h: 5.5 + rng() * 3.5, seed: rng() });
}

// --- SISTERS ROCKS: broken sight-lines through the middle --------------------
for (let i = 0; i < 11; i++) {
  const a = (i / 11) * Math.PI * 2 + rng() * 0.9;
  const d = 55 + rng() * 175;
  push(40 + Math.cos(a) * d * 1.1, 30 + Math.sin(a) * d * 0.92, 15 + rng() * 15, 'rock', { h: 8 + rng() * 12, seed: rng() });
}

// --- PALAWAN CAY: southern resort island -------------------------------------
push(175, 340, 94, 'island', { h: 8, palms: true });
push(175, 238, 11, 'jetty', { h: 2 });

// --- THE ANCHORAGE: cover in open water, so mid-map is not a kill zone --------
// Moored shipping: the reason the middle of the map is worth fighting over.
pushShip(410, 170, 0.35, 230, 36, { h: 11, tanker: true });
pushShip(470, 300, -0.25, 175, 30, { h: 9, containers: true });
pushShip(320, 265, 1.05, 150, 26, { h: 8, containers: true });
pushShip(470, 70, -0.70, 160, 28, { h: 9, tanker: true });

// --- MERLION CAY --------------------------------------------------------------
push(-195, -165, 30, 'island', { h: 5, merlion: true });

// --- Scattered outlying rocks, to soften the map edges ------------------------
for (let i = 0; i < 9; i++) {
  const a = rng() * Math.PI * 2, d = 330 + rng() * 210;
  const x = Math.cos(a) * d, z = Math.sin(a) * d;
  if (Math.abs(x) > HALF - 60 || Math.abs(z) > HALF - 60) continue;
  push(x, z, 12 + rng() * 13, 'rock', { h: 7 + rng() * 9, seed: rng() });
}

// Two derelicts in otherwise empty water, so no crossing is a completely naked run.
pushShip(-420, 330, 0.8, 170, 28, { h: 8, containers: true });
pushShip(120, -140, -0.5, 145, 26, { h: 8, tanker: true });

/** Non-colliding navigation buoys: orientation aids and micro-cover. */
export const BUOYS = [];
for (let i = 0; i < 26; i++) {
  BUOYS.push({ x: (rng() - 0.5) * 2 * (HALF - 50), z: (rng() - 0.5) * 2 * (HALF - 50), t: rng() });
}

/**
 * Move a point to the nearest clear water.
 *
 * Obstacle sizes get tuned constantly, and without this, enlarging an island
 * silently swallows a weapon pickup or a spawn slot and nobody notices until a
 * match is underway. The spiral is deterministic, so every client resolves the
 * identical position without any of it going over the wire.
 */
export function nudgeToClearWater(x, z, clearance) {
  const isClear = (px, pz) => {
    if (Math.abs(px) > HALF - clearance || Math.abs(pz) > HALF - clearance) return false;
    for (const o of OBSTACLES) {
      const dx = px - o.x, dz = pz - o.z;
      const min = o.r + clearance;
      if (dx * dx + dz * dz < min * min) return false;
    }
    return true;
  };
  if (isClear(x, z)) return { x, z };
  for (let ring = 1; ring <= 40; ring++) {
    const radius = ring * 11;
    const steps = 8 + ring * 4;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const px = x + Math.cos(a) * radius;
      const pz = z + Math.sin(a) * radius;
      if (isClear(px, pz)) return { x: px, z: pz };
    }
  }
  return { x, z };   // nowhere clear within range; better than looping forever
}

/** Twelve pickup spawns, weighted toward contested ground and away from spawns. */
export const PICKUP_SPOTS = [
  { x: 0, z: 0, kind: 'rifle' },
  { x: -150, z: -300, kind: 'missile' },
  { x: 205, z: -150, kind: 'torpedo' },
  { x: -205, z: 200, kind: 'mine' },
  { x: 150, z: 100, kind: 'rifle' },
  { x: -350, z: -185, kind: 'torpedo' },
  { x: 350, z: -100, kind: 'missile' },
  { x: -100, z: 380, kind: 'rifle' },
  { x: 300, z: 355, kind: 'mine' },
  { x: -430, z: 250, kind: 'torpedo' },
  { x: 60, z: -455, kind: 'rifle' },
  { x: 455, z: -345, kind: 'missile' },
];

// Keep every crate reachable, whatever the terrain around it has grown into.
for (const spot of PICKUP_SPOTS) {
  const clear = nudgeToClearWater(spot.x, spot.z, 18);
  spot.x = clear.x;
  spot.z = clear.z;
}

/** Team spawn areas — open water, diagonally opposed, with cover on the routes. */
export const SPAWNS = {
  red: { x: -430, z: -430, facing: Math.PI * 0.75 },
  blue: { x: 430, z: 430, facing: -Math.PI * 0.25 },
};

// ---------------------------------------------------------------- collision

/**
 * Push a circle of `radius` out of any obstacle it overlaps, and off the map
 * edge. Returns {x, z, hit} — `hit` drives collision audio and a speed penalty.
 */
export function resolveCollision(x, z, radius) {
  let hit = false;
  for (const o of OBSTACLES) {
    const dx = x - o.x, dz = z - o.z;
    const min = o.r + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      x = o.x + (dx / d) * min;
      z = o.z + (dz / d) * min;
      hit = true;
    }
  }
  const lim = HALF - 8;
  if (x > lim) { x = lim; hit = true; }
  if (x < -lim) { x = -lim; hit = true; }
  if (z > lim) { z = lim; hit = true; }
  if (z < -lim) { z = -lim; hit = true; }
  return { x, z, hit };
}

/** True if the straight line a->b is blocked — used for missile lock and AI-free LOS checks. */
export function lineBlocked(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-6) return false;
  for (const o of OBSTACLES) {
    const t = Math.max(0, Math.min(1, ((o.x - ax) * dx + (o.z - az) * dz) / len2));
    const px = ax + dx * t - o.x, pz = az + dz * t - o.z;
    if (px * px + pz * pz < o.r * o.r) return true;
  }
  return false;
}

/** How far outside the soft edge a position is, 0..1. Drives the turn-back warning. */
export function edgePressure(x, z) {
  const m = Math.max(Math.abs(x), Math.abs(z));
  const start = HALF - CFG.map.softEdge;
  return m <= start ? 0 : Math.min(1, (m - start) / CFG.map.softEdge);
}

// ------------------------------------------------------------------ rendering

const C = {
  sand: 0xdcc9a0, grass: 0x4f8a52, rock: 0x77786f, rockDark: 0x585a52,
  mangrove: 0x2f6b46, concrete: 0xb9bcc0, steel: 0x8e959c, dark: 0x3a4048,
  glassTower: 0x9fc4d8, gold: 0xd6b45a, white: 0xeceff1,
};

const CONTAINER_COLORS = [0xc0392b, 0x2980b9, 0xd68910, 0x27ae60, 0x7f8c8d, 0x8e44ad];

function buildIslandMesh(o, r2) {
  const g = new THREE.Group();
  const seg = 13;
  // Beach shelf just above the waterline, then the landmass on top.
  const beach = new THREE.CylinderGeometry(o.r, o.r * 1.04, 1.2, seg);
  jitterRing(beach, r2, o.r * 0.09);
  g.add(mesh(beach, mat(C.sand), 0, 0.35, 0));

  const land = new THREE.CylinderGeometry(o.r * 0.72, o.r * 0.94, o.h, seg);
  jitterRing(land, r2, o.r * 0.1);
  g.add(mesh(land, mat(o.merlion ? C.concrete : C.grass), 0, o.h / 2 + 0.6, 0));
  return g;
}

/** Jitter the ring vertices so islands read as hand-made low-poly, not extruded circles. */
function jitterRing(geo, r2, amount) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    if (Math.abs(x) + Math.abs(z) < 1e-3) continue;
    const s = 1 + (r2() - 0.5) * (amount / Math.max(1, Math.hypot(x, z))) * 2;
    p.setXYZ(i, x * s, p.getY(i), z * s);
  }
  geo.computeVertexNormals();
}

/** Marina Bay: three towers under a sky-deck, plus an observation wheel. */
function buildMarinaSkyline(r2) {
  const g = new THREE.Group();
  const towerH = [52, 58, 54];
  for (let i = 0; i < 3; i++) {
    const t = mesh(box(13, towerH[i], 15), mat(C.glassTower, { emissive: 0x1c3d52, emissiveIntensity: 0.35 }), (i - 1) * 26, towerH[i] / 2, 0);
    t.rotation.y = (i - 1) * 0.05;
    g.add(t);
    // Banded floors give the towers scale and stop them reading as plain slabs.
    for (let band = 1; band < 5; band++) {
      g.add(mesh(box(13.3, 0.9, 15.3), mat(C.white), (i - 1) * 26, (towerH[i] / 5) * band, 0));
    }
  }
  // The sky-deck across the top is the single most recognisable line in the city.
  const deck = mesh(box(78, 3.4, 19), mat(C.white), 0, 58, 0);
  g.add(deck);
  g.add(mesh(box(74, 0.8, 13), mat(0x4fb3d9), 0, 60.2, 0));
  g.add(mesh(cyl(1.2, 1.2, 9, 6), mat(C.white), 30, 63, 0));

  // Waterfront shophouse blocks so the shoreline is not bare.
  for (let i = 0; i < 7; i++) {
    const h = 6 + r2() * 9;
    g.add(mesh(box(9 + r2() * 6, h, 8), mat(i % 2 ? 0xd8cfc0 : 0xc7b9a4), -46 + i * 15, h / 2, 34 + r2() * 8));
  }
  return g;
}

function buildWheel() {
  const g = new THREE.Group();
  const R = 26;
  const rim = new THREE.TorusGeometry(R, 0.7, 5, 24);
  const wheel = mesh(rim, mat(C.steel), 0, R + 6, 0);
  g.add(wheel);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const spoke = mesh(box(0.35, R * 2, 0.35), mat(C.steel), 0, R + 6, 0);
    spoke.rotation.z = a;
    g.add(spoke);
    g.add(mesh(box(2.0, 2.0, 2.4), mat(C.glassTower), Math.cos(a) * R, R + 6 + Math.sin(a) * R, 0));
  }
  for (const dx of [-9, 9]) {
    const leg = mesh(cyl(0.8, 1.3, R + 8, 5), mat(C.steel), dx, (R + 8) / 2, 0);
    leg.rotation.z = dx > 0 ? -0.18 : 0.18;
    g.add(leg);
  }
  g.userData.wheel = wheel;
  return g;
}

function buildMerlion() {
  const g = new THREE.Group();
  g.add(mesh(cyl(6, 7, 2.4, 10), mat(C.concrete), 0, 1.2, 0));
  const body = mesh(cone(3.2, 9, 8), mat(C.white), 0, 6.5, 0);
  g.add(body);
  g.add(mesh(box(2.6, 2.6, 3.4), mat(C.white), 0, 11.6, 0.6));   // head
  g.add(mesh(cyl(2.1, 2.4, 1.0, 9), mat(C.white), 0, 12.4, 0.2)); // mane
  g.add(mesh(box(0.7, 0.7, 1.4), mat(0x9fd8e8, { emissive: 0x2a6f88, emissiveIntensity: 0.4 }), 0, 11.3, 2.3));
  return g;
}

function buildCrane() {
  const g = new THREE.Group();
  const H = 34;
  for (const dx of [-9, 9]) for (const dz of [-7, 7]) {
    g.add(mesh(box(1.5, H, 1.5), mat(0xd8892b), dx, H / 2, dz));
  }
  g.add(mesh(box(22, 2.6, 18), mat(0xd8892b), 0, H, 0));
  g.add(mesh(box(3.2, 3.0, 62), mat(0xd8892b), 0, H + 3.6, 8));       // boom
  g.add(mesh(box(4.4, 5.0, 6.0), mat(C.dark), 0, H - 3.5, 12));       // operator cab
  g.add(mesh(box(1.2, 8.0, 1.2), mat(C.steel), 0, H + 8, -2));
  return g;
}

/**
 * A moored merchant ship — the map's long-form cover.
 *
 * Built on the same parametric hull as the player vessels, just at a very
 * different scale, so the shipping and the fleet look like they belong to one
 * world. Two fits: a container ship stacked high enough to break line of sight
 * completely, and a lower tanker you can shoot over but not through.
 */
function buildMooredShip(o, r2) {
  const g = new THREE.Group();
  const L = o.length, B = o.beam;

  const hull = mesh(buildHull({
    length: L, beam: B,
    draft: o.h * 0.42, freeboard: o.h * 0.85,
    sternFullness: 0.93, sheer: B * 0.05, bowRise: 0.5, stations: 22,
  }), mat(o.tanker ? 0x2f4f6d : 0x7a4038));
  g.add(hull);

  const deckY = o.h * 0.85;
  // No boot-topping stripe: a straight box cannot follow this hull's taper, so
  // at any length that reads as a stripe it also pokes out past the bow and
  // stern as a black bar floating on the water. The hull colour carries it.
  

  // Deckhouse and funnel, aft, where they always are.
  const houseH = o.h * 1.5;
  g.add(mesh(box(B * 0.66, houseH, L * 0.09), mat(0xe6e8ea), 0, deckY + houseH / 2, -L * 0.38));
  g.add(mesh(box(B * 0.70, 0.6, L * 0.10), mat(0x2b313a), 0, deckY + houseH, -L * 0.38));
  g.add(mesh(box(B * 0.60, 1.0, 0.5), mat(0x2a4a63, { emissive: 0x0d1c28 }), 0, deckY + houseH * 0.78, -L * 0.335));
  g.add(mesh(box(B * 0.26, o.h * 0.9, B * 0.22), mat(0x22262b), 0, deckY + houseH + o.h * 0.45, -L * 0.44));
  g.add(mesh(cyl(0.12, 0.12, o.h * 1.1, 5), mat(0xb9bcc0), 0, deckY + houseH + o.h * 0.55, -L * 0.38));

  if (o.tanker) {
    // Pipework and manifold along an otherwise flat deck.
    g.add(mesh(box(B * 0.10, 0.7, L * 0.62), mat(0xc9ccce), 0, deckY + 0.7, L * 0.04));
    for (let i = 0; i < 7; i++) {
      const z = -L * 0.24 + (i / 6) * L * 0.56;
      g.add(mesh(cyl(B * 0.14, B * 0.14, 1.0, 10), mat(0xd8dbde), 0, deckY + 0.5, z));
      if (i % 2 === 0) g.add(mesh(box(B * 0.5, 0.5, 0.5), mat(0xa8adb2), 0, deckY + 1.1, z));
    }
    g.add(mesh(box(B * 0.8, 1.4, 2.0), mat(0xd8892b), 0, deckY + 1.4, L * 0.06));
  } else {
    // Container stacks: the actual line-of-sight blocker.
    const colors = [0xc0392b, 0x2980b9, 0xd68910, 0x27ae60, 0x7f8c8d, 0x8e44ad, 0x16a085];
    const bays = Math.max(4, Math.round(L / (B * 0.75)));
    for (let bay = 0; bay < bays; bay++) {
      const z = -L * 0.30 + (bay / (bays - 1)) * L * 0.62;
      const across = 3;
      for (let c = 0; c < across; c++) {
        const stack = 2 + Math.floor(r2() * 3);
        for (let k = 0; k < stack; k++) {
          g.add(mesh(
            box(B * 0.26, 2.6, L / bays * 0.82),
            mat(colors[Math.floor(r2() * colors.length)]),
            (c - (across - 1) / 2) * B * 0.29,
            deckY + 1.4 + k * 2.7,
            z
          ));
        }
      }
    }
    // Deck cranes forward.
    for (const cz of [L * 0.30, L * 0.14]) {
      const c = new THREE.Group();
      c.position.set(0, deckY, cz);
      c.add(mesh(cyl(B * 0.06, B * 0.09, o.h * 1.5, 6), mat(0xd8892b), 0, o.h * 0.75, 0));
      const boom = mesh(box(1.0, 1.0, L * 0.18), mat(0xd8892b), 0, o.h * 1.5, L * 0.06);
      boom.rotation.x = -0.5;
      c.add(boom);
      g.add(c);
    }
  }

  g.rotation.y = o.angle;
  return g;
}

/** Container stacks — instanced, because there are hundreds of them. */
function buildContainerField(r2, spots) {
  const geo = box(6.2, 2.7, 12.4);
  const groups = [];
  for (const color of CONTAINER_COLORS) {
    groups.push({ color, xs: [] });
  }
  for (const s of spots) {
    for (let i = 0; i < s.count; i++) {
      const gx = s.x + ((i % 4) - 1.5) * 7.0;
      const layer = Math.floor(i / 4);
      const gz = s.z + (Math.floor((i % 8) / 4) - 0.5) * 13.2;
      const stack = 1 + Math.floor(r2() * 3);
      for (let k = 0; k < stack; k++) {
        const bucket = groups[Math.floor(r2() * groups.length)];
        bucket.xs.push([gx, s.y + 1.4 + k * 2.75 + layer * 0.0, gz]);
      }
    }
  }
  const out = new THREE.Group();
  for (const b of groups) {
    if (!b.xs.length) continue;
    const im = new THREE.InstancedMesh(geo, mat(b.color), b.xs.length);
    const m = new THREE.Matrix4();
    b.xs.forEach((p, i) => { m.makeTranslation(p[0], p[1], p[2]); im.setMatrixAt(i, m); });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true;
    out.add(im);
  }
  return out;
}

/**
 * Build the whole world. `quality` drops decoration on weak hardware without
 * ever changing collision — the map plays identically at any quality level.
 */
export function buildWorld(quality = 'high') {
  const root = new THREE.Group();
  root.name = 'world';
  const r2 = mulberry32(0xB0A7C0DE);
  const detail = quality === 'high';

  for (const o of OBSTACLES) {
    let node = null;

    if (o.type === 'island') {
      node = buildIslandMesh(o, r2);
      if (o.merlion) { const m = buildMerlion(); m.position.y = o.h + 0.6; node.add(m); }
      if (o.palms && detail) {
        for (let i = 0; i < 14; i++) {
          const a = r2() * Math.PI * 2, d = r2() * o.r * 0.62;
          const p = buildPalm(r2);
          p.position.set(Math.cos(a) * d, o.h + 0.4, Math.sin(a) * d);
          node.add(p);
        }
        // Resort blocks along the shore.
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const h = 5 + r2() * 5;
          node.add(mesh(box(11, h, 9), mat(0xe7dccb), Math.cos(a) * o.r * 0.55, o.h + h / 2 + 0.4, Math.sin(a) * o.r * 0.55));
        }
      }
      if (o === marinaIsle) { const sk = buildMarinaSkyline(r2); sk.position.y = o.h + 0.6; node.add(sk); }
      if (o.wheel) { const w = buildWheel(); w.position.y = o.h + 0.6; node.add(w); root.userData.wheel = w; }
    }

    else if (o.type === 'rock') {
      node = new THREE.Group();
      const rr = mulberry32(Math.floor(o.seed * 1e6));
      // A single low boulder reads as a grey slab lying in the water. Stack two
      // or three of decreasing size and lift them clear of the surface, and the
      // same geometry reads as an outcrop worth hiding behind.
      // Sized against the hulls that hide behind them: an outcrop should stand
      // clearly above a destroyer's superstructure without becoming a sea stack
      // that dwarfs the whole fight.
      const main = mesh(buildRock(o.r * 0.86, rr), mat(C.rock), 0, o.r * 0.18, 0);
      main.scale.y = 0.66 + rr() * 0.24;
      node.add(main);
      const peaks = detail ? (o.r > 13 ? 3 : 2) : 1;
      for (let i = 1; i < peaks; i++) {
        const a = rr() * Math.PI * 2, d = o.r * (0.3 + rr() * 0.3);
        const sub = mesh(buildRock(o.r * (0.42 - i * 0.08), rr), mat(C.rockDark),
          Math.cos(a) * d, o.r * (0.24 + rr() * 0.2), Math.sin(a) * d);
        sub.scale.y = 0.85 + rr() * 0.4;
        node.add(sub);
      }
      // Wet rubble skirt at the waterline ties the outcrop to the sea.
      node.add(mesh(cyl(o.r * 0.98, o.r * 1.06, 0.9, 9), mat(0x5f6259), 0, 0.15, 0));
    }

    else if (o.type === 'mangrove') {
      node = new THREE.Group();
      node.add(mesh(cyl(o.r * 0.72, o.r * 0.95, 1.4, 9), mat(0x6b6247), 0, 0.4, 0));
      const clumps = detail ? 7 : 3;
      for (let i = 0; i < clumps; i++) {
        const a = r2() * Math.PI * 2, d = r2() * o.r * 0.6;
        const h = o.h * (0.7 + r2() * 0.6);
        const c = mesh(cone(o.r * (0.28 + r2() * 0.2), h, 6), mat(0x2f6b46), Math.cos(a) * d, h / 2 + 0.6, Math.sin(a) * d);
        node.add(c);
      }
      node.add(mesh(cyl(o.r * 0.5, o.r * 0.5, 0.5, 8), mat(0x3d5a3f), 0, 1.1, 0));
    }

    else if (o.type === 'quay') {
      node = new THREE.Group();
      node.add(mesh(cyl(o.r, o.r * 1.02, o.h, 10), mat(C.concrete), 0, o.h / 2 - 0.4, 0));
      node.add(mesh(cyl(o.r * 1.03, o.r * 1.03, 0.8, 10), mat(C.dark), 0, o.h - 0.5, 0));
      if (detail) {
        node.add(buildContainerField(r2, [
          { x: -o.r * 0.3, z: 0, y: o.h - 0.4, count: 10 },
          { x: o.r * 0.35, z: o.r * 0.25, y: o.h - 0.4, count: 8 },
        ]));
        const crane = buildCrane();
        crane.position.set(0, o.h - 0.4, -o.r * 0.35);
        crane.rotation.y = Math.PI / 2;
        node.add(crane);
      }
    }

    else if (o.type === 'ship') {
      // Only the chain's anchor circle carries the mesh; the rest are collision.
      if (!o.render) continue;
      node = buildMooredShip(o, r2);
    }

    else if (o.type === 'jetty') {
      node = new THREE.Group();
      node.add(mesh(box(o.r * 1.4, 0.7, o.r * 3.2), mat(0x9c7b52), 0, 1.6, 0));
      for (let i = 0; i < 6; i++) {
        for (const dx of [-o.r * 0.5, o.r * 0.5]) {
          node.add(mesh(cyl(0.4, 0.4, 4, 5), mat(0x6d4c29), dx, 0, -o.r * 1.3 + i * o.r * 0.52));
        }
      }
    }

    if (node) {
      node.position.x = o.type === 'ship' ? o.cx : o.x;
      node.position.z = o.type === 'ship' ? o.cz : o.z;
      node.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      root.add(node);
    }
  }

  // Navigation buoys, instanced.
  const buoyGeo = cone(1.5, 4.2, 6);
  const buoyRed = new THREE.InstancedMesh(buoyGeo, mat(0xd83a3a, { emissive: 0x5a1010, emissiveIntensity: 0.4 }), BUOYS.length);
  const buoyGrn = new THREE.InstancedMesh(buoyGeo, mat(0x2fae5a, { emissive: 0x0d3d20, emissiveIntensity: 0.4 }), BUOYS.length);
  const m4 = new THREE.Matrix4();
  let nr = 0, ng = 0;
  for (const b of BUOYS) {
    m4.makeTranslation(b.x, 1.6, b.z);
    if (b.t > 0.5) buoyRed.setMatrixAt(nr++, m4); else buoyGrn.setMatrixAt(ng++, m4);
  }
  buoyRed.count = nr; buoyGrn.count = ng;
  buoyRed.instanceMatrix.needsUpdate = true;
  buoyGrn.instanceMatrix.needsUpdate = true;
  root.add(buoyRed, buoyGrn);

  return root;
}

/**
 * A greyscale footprint of every landmass, used by the water shader to draw
 * foam where water meets shore. Far cheaper than any depth-buffer technique
 * and it looks better than a hard edge.
 */
export function buildShoreMask(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const toPx = (v) => ((v + HALF) / (HALF * 2)) * size;

  // Overlapping landmasses should reinforce, not overwrite each other.
  ctx.globalCompositeOperation = 'lighter';

  const ring = (px, pz, inner, outer, channel) => {
    const g = ctx.createRadialGradient(px, pz, inner, px, pz, outer);
    g.addColorStop(0, channel === 'r' ? 'rgba(255,0,0,1)' : 'rgba(0,255,0,1)');
    g.addColorStop(0.55, channel === 'r' ? 'rgba(255,0,0,0.5)' : 'rgba(0,255,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, pz, outer, 0, Math.PI * 2);
    ctx.fill();
  };

  for (const o of OBSTACLES) {
    // Moored ships float; they do not create shallows or a beach.
    if (o.type === 'ship') continue;
    const px = toPx(o.x), pz = toPx(o.z);
    const pr = (o.r / (HALF * 2)) * size;
    // GREEN: the wide shallow shelf that turns the water turquoise.
    ring(px, pz, pr * 0.85, pr * 2.2, 'g');
    // RED: a tight band right at the waterline, where foam belongs.
    ring(px, pz, pr * 0.92, pr * 1.28, 'r');
  }

  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** A spawn position for a team, spread so 8 vessels do not stack on each other. */
export function spawnFor(team, index) {
  const base = SPAWNS[team] || SPAWNS.red;
  const ring = Math.floor(index / 4);
  const a = base.facing + ((index % 4) - 1.5) * 0.5;
  const d = CFG.player.spawnSpread * (0.55 + ring * 0.5);
  const x = base.x + Math.cos(a) * d;
  const z = base.z + Math.sin(a) * d;
  // Clear water, not merely "pushed out of the hull" — spawning flush against a
  // moored ship is barely better than spawning inside it.
  const clear = nudgeToClearWater(x, z, 16);
  return { x: clear.x, z: clear.z, heading: Math.atan2(-base.x, -base.z) };
}
