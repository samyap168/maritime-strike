/**
 * The five vessel classes, built entirely from procedural geometry.
 *
 * Design rule: silhouette beats detail. At 200 metres on a projector nobody
 * sees a railing, but everyone can tell a low open sampan from a slab-sided
 * destroyer. Each hull therefore gets a distinct profile, height and mass.
 *
 * Every builder returns a Group whose waterline sits at y=0, with:
 *   userData.turret   — group to rotate toward the aim direction
 *   userData.spinners — meshes to idle-rotate (radar dishes)
 *   userData.wake     — local position where the wake trail is emitted
 */

import * as THREE from 'three';
import {
  mat, mesh, box, cyl, cone, sphere,
  buildHull, buildGunMount, buildMast, buildRailing, buildBollard, buildRing, mergeStatic,
} from './geo.js';
import { VESSELS } from '../config.js';

const PALETTE = {
  wood: 0x9c7047, woodDark: 0x6d4c29, canvas: 0xd9cbb0,
  hullWhite: 0xe8eaed, hullGrey: 0x76808c, hullDark: 0x2f3740,
  navy: 0x1f3a5f, orange: 0xe8622a, metal: 0x9aa4ad, dark: 0x353c44,
  deck: 0x5d6670, glass: 0x2a4a63, black: 0x1b1f24, rust: 0x8a5a3c,
};

/** Team identity: a hull stripe and a flag, never a fully repainted boat. */
function addTeamMarkings(group, teamColor, length, beam, deckY) {
  const stripeMat = mat(teamColor, { emissive: teamColor, emissiveIntensity: 0.32 });
  for (const side of [1, -1]) {
    const stripe = mesh(box(0.14, 0.34, length * 0.6), stripeMat, side * (beam / 2 + 0.02), deckY, -length * 0.05);
    group.add(stripe);
  }
  // Stern flag, the clearest team read from behind — which is where you
  // usually see a teammate.
  const pole = mesh(cyl(0.05, 0.05, 2.2, 4), mat(PALETTE.metal), 0, deckY + 1.1, -length * 0.44);
  group.add(pole);
  const flag = mesh(box(1.5, 0.85, 0.06), stripeMat, 0.75, deckY + 1.75, -length * 0.44);
  group.add(flag);
  group.userData.flag = flag;
}

function finish(group, kind, teamColor) {
  const def = VESSELS[kind];
  group.userData.kind = kind;
  group.userData.spinners = group.userData.spinners || [];
  group.userData.wake = group.userData.wake || new THREE.Vector3(0, 0.1, -def.length * 0.45);

  // Fold the static hull and fittings into one mesh per material. The turret
  // and any spinning radar have to keep their own transforms, so they are
  // excluded. This is what lets the vessels carry real detail without the
  // draw-call cost landing on a laptop GPU.
  mergeStatic(group, [group.userData.turret, ...group.userData.spinners]);

  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  return group;
}

// ---------------------------------------------------------------- 1. SAMPAN

function buildSampan(teamColor) {
  const g = new THREE.Group();
  const L = VESSELS.sampan.length, B = VESSELS.sampan.beam;

  const hull = mesh(buildHull({
    length: L, beam: B, draft: 0.55, freeboard: 0.62,
    sternFullness: 0.6, sheer: 0.5, bowRise: 0.95,
  }), mat(PALETTE.wood));
  g.add(hull);

  // Painted sheer strake — the detail that makes it read as a wooden bumboat.
  for (const side of [1, -1]) {
    g.add(mesh(box(0.1, 0.2, L * 0.72), mat(0x2f5d4a), side * (B / 2 - 0.05), 0.95, 0));
  }

  // Canvas canopy amidships on bent hoops.
  const canopy = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const hoop = mesh(cyl(0.05, 0.05, B * 0.92, 4), mat(PALETTE.woodDark), 0, 1.35, -0.6 + i * 0.62);
    hoop.rotation.z = Math.PI / 2;
    canopy.add(hoop);
  }
  canopy.add(mesh(box(B * 0.94, 0.09, 2.5), mat(PALETTE.canvas), 0, 1.42, 0.35));
  g.add(canopy);

  // Thwarts and a stern outboard.
  for (let i = 0; i < 3; i++) g.add(mesh(box(B * 0.8, 0.09, 0.34), mat(PALETTE.woodDark), 0, 0.72, -1.6 + i * 1.6));
  g.add(mesh(box(0.5, 0.75, 0.55), mat(PALETTE.black), 0, 0.75, -L * 0.44));
  g.add(mesh(cyl(0.1, 0.1, 0.9, 5), mat(PALETTE.metal), 0, 0.2, -L * 0.5));

  // Pintle-mounted rifle at the bow.
  const turret = new THREE.Group();
  turret.position.set(0, 0.85, L * 0.24);
  turret.add(mesh(cyl(0.2, 0.26, 0.42, 6), mat(PALETTE.metal), 0, 0.2, 0));
  const barrel = mesh(cyl(0.075, 0.085, 1.7, 5), mat(PALETTE.black), 0, 0.5, 0.8);
  barrel.rotation.x = Math.PI / 2;
  turret.add(barrel);
  turret.add(mesh(box(0.3, 0.22, 0.5), mat(PALETTE.woodDark), 0, 0.46, -0.15));
  g.add(turret);
  g.userData.turret = turret;

  // Working-boat clutter: the details that say "someone fishes off this".
  g.add(mesh(box(0.14, 0.16, L * 0.86), mat(PALETTE.woodDark), 0, 1.02, 0));   // rubbing strake
  for (const side of [1, -1]) {
    g.add(mesh(box(0.1, 0.16, L * 0.86), mat(PALETTE.woodDark), side * (B / 2 + 0.02), 0.55, 0));
  }
  const coil = buildRing(0.34, 0.09, 0xcbb78a);
  coil.rotation.x = -Math.PI / 2;
  coil.position.set(0.5, 0.8, L * 0.34);
  g.add(coil);
  for (const s2 of [1, -1]) {                                    // stowed oars
    const oar = mesh(box(0.08, 0.08, 3.4), mat(PALETTE.woodDark), s2 * 0.85, 0.86, -0.4);
    oar.rotation.x = 0.05;
    g.add(oar);
    g.add(mesh(box(0.26, 0.04, 0.9), mat(PALETTE.woodDark), s2 * 0.85, 0.86, -2.3));
  }
  g.add(mesh(box(0.7, 0.45, 0.5), mat(0xbfa878), -0.6, 0.94, -1.9));  // fish crates
  g.add(mesh(box(0.7, 0.45, 0.5), mat(0xbfa878), 0.55, 0.94, -2.4));
  g.add(mesh(cyl(0.05, 0.05, 2.6, 4), mat(PALETTE.woodDark), -1.0, 1.9, 0.6));  // bamboo pole
  g.add(mesh(box(0.26, 0.3, 0.26), mat(0xffd98a, { emissive: 0xd89a20, emissiveIntensity: 0.7 }), 0, 1.55, -L * 0.4));
  g.add(mesh(box(B * 0.7, 0.3, 0.07), mat(0xb03a2e), 0, 0.98, -L * 0.47));      // name board

  addTeamMarkings(g, teamColor, L, B, 0.75);
  return finish(g, 'sampan', teamColor);
}

// ----------------------------------------------------- 2. COAST GUARD PATROL

function buildPatrol(teamColor) {
  const g = new THREE.Group();
  const L = VESSELS.patrol.length, B = VESSELS.patrol.beam;

  g.add(mesh(buildHull({
    length: L, beam: B, draft: 0.75, freeboard: 1.5,
    sternFullness: 0.94, sheer: 0.7, bowRise: 0.7,
  }), mat(PALETTE.hullWhite)));

  // Coast-guard diagonal flash: instantly recognisable, and it is the one place
  // a strong colour is allowed that is not the team accent.
  for (const side of [1, -1]) {
    const flash = mesh(box(0.12, 1.15, 3.1), mat(PALETTE.orange), side * (B / 2 - 0.02), 1.35, L * 0.2);
    flash.rotation.x = 0.42;
    g.add(flash);
    g.add(mesh(box(0.12, 0.3, 2.0), mat(PALETTE.navy), side * (B / 2 - 0.02), 1.35, L * 0.02));
  }

  // Wheelhouse with a raked windscreen.
  const house = mesh(box(B * 0.72, 1.5, 4.0), mat(PALETTE.hullWhite), 0, 2.6, -0.6);
  g.add(house);
  const screen = mesh(box(B * 0.68, 1.05, 0.16), mat(PALETTE.glass, { emissive: 0x0d1c28 }), 0, 2.95, 1.45);
  screen.rotation.x = -0.3;
  g.add(screen);
  g.add(mesh(box(B * 0.76, 0.14, 4.2), mat(PALETTE.navy), 0, 3.4, -0.6));

  // Mast, light bar, radar.
  const mast = buildMast(2.6, { metal: PALETTE.metal, light: PALETTE.hullWhite });
  mast.position.set(0, 3.45, -1.4);
  g.add(mast);
  g.add(mesh(box(1.5, 0.26, 0.3), mat(0x2a6fd6, { emissive: 0x1a4fa0, emissiveIntensity: 0.6 }), 0, 3.62, 0.6));

  // Twin autocannon forward.
  const turret = new THREE.Group();
  turret.position.set(0, 1.55, L * 0.28);
  const mount = buildGunMount(0.85, { metal: PALETTE.metal, light: PALETTE.hullWhite, dark: PALETTE.black });
  turret.add(mount);
  for (const dx of [-0.24, 0.24]) {
    const b = mesh(cyl(0.09, 0.1, 2.3, 5), mat(PALETTE.black), dx, 0.8, 1.5);
    b.rotation.x = Math.PI / 2;
    turret.add(b);
  }
  g.add(turret);
  g.userData.turret = turret;
  g.userData.spinners = [mast.userData.spin];

  // Foredeck rails, and the working gear a real patrol boat carries.
  for (const side of [1, -1]) {
    const rail = buildRailing(L * 0.32, 0.85, 5);
    rail.position.set(side * (B / 2 - 0.15), 1.55, L * 0.22);
    g.add(rail);
    const r2 = buildRailing(L * 0.26, 0.85, 4);
    r2.position.set(side * (B / 2 - 0.2), 1.55, -L * 0.30);
    g.add(r2);
    // Fenders down the side.
    for (let i = 0; i < 3; i++) {
      const f = buildRing(0.30, 0.10, 0x1f2429);
      f.position.set(side * (B / 2 + 0.04), 1.05, -1.4 + i * 2.1);
      g.add(f);
    }
    g.add(mesh(box(0.5, 0.34, 0.06), mat(PALETTE.glass, { emissive: 0x0d1c28 }), side * (B / 2 - 0.02), 1.0, 1.6));
  }
  // Rigid inflatable on the aft deck, on a davit.
  const rhib = new THREE.Group();
  rhib.position.set(0, 1.7, -L * 0.30);
  rhib.add(mesh(buildHull({ length: 3.6, beam: 1.5, draft: 0.3, freeboard: 0.4, sternFullness: 0.95, sheer: 0.2 }), mat(0x3b4148)));
  for (const s2 of [1, -1]) rhib.add(mesh(cyl(0.19, 0.19, 3.2, 6), mat(0x22262b), s2 * 0.72, 0.35, 0));
  g.add(rhib);
  const davit = mesh(box(0.14, 1.5, 0.14), mat(PALETTE.metal), 0, 2.5, -L * 0.42);
  g.add(davit);
  g.add(mesh(box(1.4, 0.14, 0.14), mat(PALETTE.metal), 0, 3.2, -L * 0.38));
  // Life rings, whip antennae, exhaust.
  for (const s2 of [1, -1]) {
    const ring = buildRing(0.38, 0.09, 0xff6b35);
    ring.position.set(s2 * (B / 2 - 0.25), 2.6, 0.9);
    g.add(ring);
    g.add(mesh(cyl(0.03, 0.03, 2.2, 4), mat(0x22262b), s2 * 0.7, 4.5, -1.9));
    g.add(mesh(cyl(0.16, 0.16, 0.6, 6), mat(0x22262b), s2 * 0.9, 1.75, -L * 0.44));
  }
  g.add(mesh(sphere(0.5, 8), mat(0xe8eaed), 0, 4.35, -1.4));   // radar dome
  for (const dz of [L * 0.4, -L * 0.44]) g.add(mesh(box(0.5, 0.3, 0.5), mat(PALETTE.metal), 0, 1.62, dz));

  addTeamMarkings(g, teamColor, L, B, 1.55);
  return finish(g, 'patrol', teamColor);
}

// ------------------------------------------------------- 3. MISSILE DESTROYER

function buildDestroyer(teamColor) {
  const g = new THREE.Group();
  const L = VESSELS.destroyer.length, B = VESSELS.destroyer.beam;

  g.add(mesh(buildHull({
    length: L, beam: B, draft: 1.6, freeboard: 2.4,
    sternFullness: 0.82, sheer: 1.5, bowRise: 0.55, stations: 20,
  }), mat(PALETTE.hullGrey)));

  // Boot topping at the waterline gives the hull visual weight.
  for (const side of [1, -1]) {
    g.add(mesh(box(0.14, 0.5, L * 0.86), mat(PALETTE.hullDark), side * (B / 2 - 0.05), 0.05, 0));
  }

  // Stepped superstructure — the destroyer's defining silhouette.
  const tiers = [
    { w: 0.78, h: 2.2, d: 9.0, y: 3.6, z: -1.0 },
    { w: 0.62, h: 1.9, d: 6.2, y: 5.6, z: -0.2 },
    { w: 0.44, h: 1.6, d: 3.6, y: 7.3, z: 0.6 },
  ];
  for (const t of tiers) {
    g.add(mesh(box(B * t.w, t.h, t.d), mat(PALETTE.hullGrey), 0, t.y, t.z));
  }
  g.add(mesh(box(B * 0.46, 0.9, 3.2), mat(PALETTE.glass, { emissive: 0x0d1c28 }), 0, 5.9, 2.6));

  // Funnel and mast.
  const funnel = mesh(box(B * 0.34, 2.4, 2.2), mat(PALETTE.hullDark), 0, 5.4, -5.2);
  funnel.rotation.x = -0.12;
  g.add(funnel);
  const mast = buildMast(4.4, { metal: PALETTE.metal, light: PALETTE.hullGrey });
  mast.position.set(0, 8.1, 0.4);
  g.add(mast);
  g.userData.spinners = [mast.userData.spin];

  // Vertical launch cells on the foredeck — where the missiles visibly come from.
  const vls = new THREE.Group();
  vls.position.set(0, 2.5, L * 0.2);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      vls.add(mesh(box(0.62, 0.16, 0.62), mat(PALETTE.dark), (c - 1) * 0.78, 0.1, (r - 1.5) * 0.78));
    }
  }
  g.add(vls);
  g.userData.vls = vls;

  // Main gun forward of the VLS.
  const turret = new THREE.Group();
  turret.position.set(0, 2.55, L * 0.36);
  const mount = buildGunMount(1.25, { metal: PALETTE.hullGrey, light: PALETTE.hullGrey, dark: PALETTE.black });
  turret.add(mount);
  g.add(turret);
  g.userData.turret = turret;

  // Helipad aft.
  g.add(mesh(box(B * 0.8, 0.2, 5.0), mat(PALETTE.deck), 0, 2.5, -L * 0.36));
  g.add(mesh(cyl(1.5, 1.5, 0.06, 12), mat(0xd8dde2), 0, 2.63, -L * 0.36));

  // Warship furniture: bridge wings, close-in gun, boats, ground tackle.
  for (const side of [1, -1]) {
    g.add(mesh(box(B * 0.14, 0.9, 2.2), mat(PALETTE.hullGrey), side * B * 0.44, 5.9, 2.0));  // bridge wing
    const rail = buildRailing(L * 0.26, 0.9, 6, 0x9aa4ad);
    rail.position.set(side * (B / 2 - 0.25), 2.55, L * 0.30);
    g.add(rail);
    const rail2 = buildRailing(L * 0.24, 0.9, 5, 0x9aa4ad);
    rail2.position.set(side * (B / 2 - 0.3), 2.55, -L * 0.36);
    g.add(rail2);
    // Ship's boats under davits.
    const boat = mesh(buildHull({ length: 4.6, beam: 1.7, draft: 0.35, freeboard: 0.5, sternFullness: 0.9, sheer: 0.25 }), mat(0xe0e4e8));
    boat.position.set(side * B * 0.42, 4.2, -3.2);
    g.add(boat);
    g.add(mesh(box(0.16, 1.6, 0.16), mat(PALETTE.metal), side * B * 0.5, 5.0, -2.2));
    g.add(mesh(box(0.16, 1.6, 0.16), mat(PALETTE.metal), side * B * 0.5, 5.0, -4.2));
    g.add(mesh(box(0.4, 0.5, 0.9), mat(PALETTE.hullDark), side * (B / 2 - 0.1), 2.0, L * 0.44));  // hawse/anchor
    g.add(mesh(cyl(0.04, 0.04, 3.0, 4), mat(0x22262b), side * 1.2, 9.6, 0.0));
  }
  g.add(mesh(box(B * 0.7, 0.55, 0.4), mat(PALETTE.hullGrey), 0, 2.75, L * 0.30));   // breakwater
  // Close-in weapon system above the helipad.
  const ciws = new THREE.Group();
  ciws.position.set(0, 4.4, -L * 0.22);
  ciws.add(mesh(cyl(0.7, 0.85, 0.9, 8), mat(PALETTE.hullGrey), 0, 0.45, 0));
  ciws.add(mesh(sphere(0.75, 8), mat(0xe8eaed), 0, 1.3, 0));
  const cb = mesh(cyl(0.16, 0.16, 1.6, 6), mat(PALETTE.black), 0, 1.2, 0.9);
  cb.rotation.x = Math.PI / 2;
  ciws.add(cb);
  g.add(ciws);
  // Aft mast and a couple of deck houses.
  g.add(mesh(cyl(0.1, 0.16, 3.4, 5), mat(PALETTE.metal), 0, 7.0, -6.4));
  g.add(mesh(box(1.6, 0.12, 0.4), mat(PALETTE.hullGrey), 0, 8.4, -6.4));
  for (const dz of [-8.2, -10.0]) g.add(mesh(box(B * 0.5, 0.7, 1.2), mat(PALETTE.hullGrey), 0, 2.85, dz));

  addTeamMarkings(g, teamColor, L, B, 2.55);
  return finish(g, 'destroyer', teamColor);
}

// ------------------------------------------------------------- 4. SUBMARINE

function buildSubmarine(teamColor) {
  const g = new THREE.Group();
  const L = VESSELS.submarine.length, B = VESSELS.submarine.beam;
  const R = B / 2;

  // A pressure hull, not a boat hull — a capsule with a tapered tail.
  const body = mesh(cyl(R, R, L * 0.72, 12), mat(PALETTE.hullDark), 0, 0.1, -L * 0.02);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const nose = mesh(sphere(R, 12), mat(PALETTE.hullDark), 0, 0.1, L * 0.34);
  nose.scale.set(1, 1, 1.5);
  g.add(nose);
  const tail = mesh(cone(R, L * 0.26, 12), mat(PALETTE.hullDark), 0, 0.1, -L * 0.49);
  tail.rotation.x = -Math.PI / 2;
  g.add(tail);

  // Casing walkway along the top so the silhouette is not a bare tube.
  g.add(mesh(box(B * 0.34, 0.18, L * 0.7), mat(PALETTE.black), 0, R + 0.08, -L * 0.02));

  // Sail (conning tower) with periscopes and dive planes.
  const sail = new THREE.Group();
  sail.position.set(0, R + 0.1, L * 0.1);
  sail.add(mesh(box(B * 0.36, 2.5, 3.6), mat(PALETTE.hullDark), 0, 1.25, 0));
  sail.add(mesh(box(B * 0.9, 0.16, 0.9), mat(PALETTE.hullDark), 0, 1.9, -0.3));  // planes
  sail.add(mesh(cyl(0.07, 0.07, 1.5, 4), mat(PALETTE.metal), -0.2, 3.2, 0.3));
  sail.add(mesh(cyl(0.07, 0.07, 1.1, 4), mat(PALETTE.metal), 0.2, 3.0, -0.1));
  g.add(sail);

  // Cruciform stern planes.
  for (const rot of [0, Math.PI / 2]) {
    const fin = mesh(box(B * 1.5, 0.16, 2.0), mat(PALETTE.hullDark), 0, 0.1, -L * 0.4);
    fin.rotation.z = rot;
    g.add(fin);
  }

  // Bow torpedo tubes double as the aiming reference.
  const turret = new THREE.Group();
  turret.position.set(0, 0.1, L * 0.3);
  for (const dx of [-0.7, 0.7]) turret.add(mesh(cyl(0.3, 0.3, 0.5, 8), mat(PALETTE.black), dx, -0.2, 0.7));
  g.add(turret);
  g.userData.turret = turret;

  // Casing detail: flood ports, cleats, planes, and a shrouded screw.
  for (const side of [1, -1]) {
    for (let i = 0; i < 7; i++) {
      g.add(mesh(box(0.06, 0.34, 0.9), mat(0x14171b), side * (R - 0.05), R * 0.35, -L * 0.28 + i * L * 0.085));
    }
    g.add(mesh(box(B * 0.85, 0.14, 1.5), mat(PALETTE.hullDark), side * R * 0.8, -0.2, L * 0.24));  // bow planes
  }
  for (const dz of [L * 0.24, -L * 0.20]) {
    const bol = buildBollard(0.9, 0x14171b);
    bol.position.set(0, R + 0.14, dz);
    g.add(bol);
  }
  sail.add(mesh(box(B * 0.30, 0.42, 0.08), mat(PALETTE.glass, { emissive: 0x0d1c28 }), 0, 2.1, 1.75));
  sail.add(mesh(box(B * 0.34, 0.12, 3.7), mat(0x14171b), 0, 2.52, 0));
  // Towed-array fairing and propulsor shroud.
  g.add(mesh(box(0.3, 0.24, L * 0.42), mat(0x14171b), 0, -R * 0.55, -L * 0.16));
  const shroud = mesh(cyl(R * 0.62, R * 0.62, 1.4, 12, 1), mat(0x1b1f24), 0, 0.1, -L * 0.56);
  shroud.rotation.x = Math.PI / 2;
  g.add(shroud);

  addTeamMarkings(g, teamColor, L * 0.8, B * 0.9, R + 0.3);
  return finish(g, 'submarine', teamColor);
}

// ------------------------------------------------------------- 5. MINELAYER

function buildMinelayer(teamColor) {
  const g = new THREE.Group();
  const L = VESSELS.minelayer.length, B = VESSELS.minelayer.beam;

  g.add(mesh(buildHull({
    length: L, beam: B, draft: 1.2, freeboard: 1.8,
    sternFullness: 0.96, sheer: 0.9, bowRise: 0.65,
  }), mat(PALETTE.rust)));
  for (const side of [1, -1]) {
    g.add(mesh(box(0.14, 0.4, L * 0.8), mat(PALETTE.black), side * (B / 2 - 0.04), 0.1, 0));
  }

  // Wheelhouse pushed forward, leaving a long working deck aft — the shape of
  // every real buoy tender and minelayer.
  g.add(mesh(box(B * 0.66, 2.0, 3.4), mat(PALETTE.canvas), 0, 2.8, L * 0.24));
  g.add(mesh(box(B * 0.62, 0.85, 0.16), mat(PALETTE.glass, { emissive: 0x0d1c28 }), 0, 3.3, L * 0.24 + 1.75));
  g.add(mesh(box(B * 0.7, 0.14, 3.6), mat(PALETTE.black), 0, 3.85, L * 0.24));
  g.add(mesh(cyl(0.5, 0.6, 1.6, 6), mat(PALETTE.black), 0, 3.6, L * 0.06));

  // Open aft deck with mine rails and a stern gantry.
  g.add(mesh(box(B * 0.86, 0.16, L * 0.44), mat(PALETTE.deck), 0, 1.85, -L * 0.22));
  for (const side of [1, -1]) {
    g.add(mesh(box(0.16, 0.16, L * 0.42), mat(PALETTE.metal), side * B * 0.28, 2.02, -L * 0.22));
    g.add(mesh(cyl(0.12, 0.12, 2.6, 5), mat(PALETTE.orange), side * B * 0.3, 3.2, -L * 0.42));
  }
  g.add(mesh(box(B * 0.72, 0.2, 0.2), mat(PALETTE.orange), 0, 4.45, -L * 0.42));

  // Live mines visible on the rails — telegraphs the vessel's whole job.
  const mineMat = mat(PALETTE.black);
  const hornMat = mat(PALETTE.orange);
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Group();
    m.position.set(0, 2.55, -L * 0.06 - i * 2.4);
    m.add(mesh(sphere(0.62, 8), mineMat));
    for (let h = 0; h < 4; h++) {
      const a = (h / 4) * Math.PI * 2;
      m.add(mesh(cyl(0.06, 0.06, 0.45, 4), hornMat, Math.cos(a) * 0.36, 0.5, Math.sin(a) * 0.36));
    }
    g.add(m);
  }

  // No gun: the "turret" is the stern chute mines roll off, so aiming still
  // has something to point with.
  const turret = new THREE.Group();
  turret.position.set(0, 1.9, -L * 0.44);
  turret.add(mesh(box(1.1, 0.5, 1.6), mat(PALETTE.metal), 0, 0, -0.4));
  g.add(turret);
  g.userData.turret = turret;

  // Working deck: bulwark, winch, fenders, more mines on the rails.
  for (const side of [1, -1]) {
    g.add(mesh(box(0.16, 0.9, L * 0.46), mat(PALETTE.rust), side * B * 0.42, 2.3, -L * 0.20));   // bulwark
    for (let i = 0; i < 4; i++) {
      const f = buildRing(0.42, 0.13, 0x1f2429);
      f.position.set(side * (B / 2 + 0.05), 1.15, -3.4 + i * 2.4);
      g.add(f);
    }
    const rail = buildRailing(L * 0.20, 0.8, 4, 0xcfd3d6);
    rail.position.set(side * (B / 2 - 0.2), 1.9, L * 0.40);
    g.add(rail);
  }
  const winch = mesh(cyl(0.55, 0.55, B * 0.7, 8), mat(PALETTE.metal), 0, 2.5, L * 0.06);
  winch.rotation.z = Math.PI / 2;   // drum lies athwartships
  g.add(winch);
  g.add(mesh(box(B * 0.5, 0.16, 1.6), mat(PALETTE.metal), 0, 1.95, L * 0.14));     // hatch cover
  g.add(mesh(cyl(0.18, 0.18, 0.9, 6), mat(0x22262b), B * 0.2, 4.1, L * 0.10));     // exhaust
  // Three more mines, so the rails look loaded rather than nearly empty.
  const mineMat2 = mat(PALETTE.black);
  const hornMat2 = mat(PALETTE.orange);
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Group();
    m.position.set(B * 0.22, 2.55, -L * 0.06 - i * 2.4);
    m.add(mesh(sphere(0.58, 8), mineMat2));
    for (let h = 0; h < 4; h++) {
      const a = (h / 4) * Math.PI * 2;
      m.add(mesh(cyl(0.055, 0.055, 0.42, 4), hornMat2, Math.cos(a) * 0.34, 0.47, Math.sin(a) * 0.34));
    }
    g.add(m);
  }

  addTeamMarkings(g, teamColor, L, B, 1.9);
  return finish(g, 'minelayer', teamColor);
}

const BUILDERS = {
  sampan: buildSampan,
  patrol: buildPatrol,
  destroyer: buildDestroyer,
  submarine: buildSubmarine,
  minelayer: buildMinelayer,
};

export function buildVessel(kind, teamColor) {
  return (BUILDERS[kind] || buildSampan)(teamColor);
}

export const VESSEL_KINDS = Object.keys(BUILDERS);
