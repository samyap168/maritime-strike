/**
 * Optional GLB asset slots.
 *
 * Every visible thing in this game has a procedural version that always works.
 * This module lets a hand-made or AI-generated GLB model OVERRIDE any of them,
 * without the game ever depending on one existing.
 *
 * The rules that make that safe:
 *
 *   1. Loading is asynchronous and non-blocking. The match starts on procedural
 *      geometry; models swap in as they arrive. Nobody waits on a download.
 *   2. A missing, corrupt, or slow file is not an error. It logs once and the
 *      procedural version stands. Sixteen people on venue wifi must never be
 *      staring at a loading bar because one file is 40MB.
 *   3. Models are normalised on load — recentred, scaled to the gameplay size
 *      the collision system already assumes, and oriented bow-forward — so a
 *      model exported at any scale or axis convention still drops in correctly.
 *
 * To add a model: export a GLB, drop it at the path in MANIFEST below, reload.
 * See assets/README.md for the full workflow.
 */

import * as THREE from 'three';
import { VESSELS } from '../config.js';

/**
 * Asset slots. `length` is the gameplay size the model is normalised to along
 * its forward axis; collision already assumes it, so a model must match.
 */
export const MANIFEST = {
  // --- vessels: forward is +Z, waterline at y=0 ---------------------------
  'vessel.sampan': { url: 'assets/vessels/sampan.glb', length: VESSELS.sampan.length, axis: 'z' },
  'vessel.patrol': { url: 'assets/vessels/patrol-boat.glb', length: VESSELS.patrol.length, axis: 'z' },
  'vessel.destroyer': { url: 'assets/vessels/destroyer.glb', length: VESSELS.destroyer.length, axis: 'z' },
  'vessel.submarine': { url: 'assets/vessels/submarine.glb', length: VESSELS.submarine.length, axis: 'z' },
  'vessel.minelayer': { url: 'assets/vessels/minelayer.glb', length: VESSELS.minelayer.length, axis: 'z' },

  // --- Singapore landmarks: base at y=0, height is the normalising axis ---
  'landmark.mbs': { url: 'assets/landmarks/marina-bay-sands.glb', height: 84, axis: 'y' },
  'landmark.supertrees': { url: 'assets/landmarks/supertrees.glb', height: 52, axis: 'y' },
  'landmark.flyer': { url: 'assets/landmarks/singapore-flyer.glb', height: 58, axis: 'y' },
  'landmark.artscience': { url: 'assets/landmarks/artscience-museum.glb', height: 20, axis: 'y' },
  'landmark.esplanade': { url: 'assets/landmarks/esplanade.glb', height: 16, axis: 'y' },
  'landmark.merlion': { url: 'assets/landmarks/merlion.glb', height: 14, axis: 'y' },
  'landmark.cableCar': { url: 'assets/landmarks/cable-car-pylon.glb', height: 52, axis: 'y' },
  'landmark.cruiseTerminal': { url: 'assets/landmarks/cruise-terminal.glb', height: 12, axis: 'y' },

  // --- PSA port ------------------------------------------------------------
  'port.quayCrane': { url: 'assets/port/quay-crane.glb', height: 46, axis: 'y' },
  'port.container': { url: 'assets/port/container.glb', length: 12.4, axis: 'z' },
  'port.containerShip': { url: 'assets/port/container-ship.glb', length: 190, axis: 'z' },
  'port.tanker': { url: 'assets/port/tanker.glb', length: 230, axis: 'z' },
  'port.cruiseShip': { url: 'assets/port/cruise-ship.glb', length: 260, axis: 'z' },

  // --- terrain and objectives ---------------------------------------------
  'terrain.island': { url: 'assets/terrain/island.glb', length: 100, axis: 'z' },
  'terrain.rock': { url: 'assets/terrain/rock.glb', length: 30, axis: 'z' },
  'terrain.mangrove': { url: 'assets/terrain/mangrove.glb', length: 30, axis: 'z' },
  'pickup.crate': { url: 'assets/pickups/weapon-crate.glb', length: 5, axis: 'z' },
  'pickup.buoy': { url: 'assets/pickups/buoy.glb', height: 4.2, axis: 'y' },
};

const loaded = new Map();       // key -> normalised THREE.Group template
const failed = new Set();
let loader = null;
let listeners = [];

/** Fired as each model arrives, so live objects can swap themselves out. */
export function onAssetLoaded(cb) { listeners.push(cb); }

export function getAsset(key) {
  const t = loaded.get(key);
  return t ? t.clone(true) : null;
}

export function hasAsset(key) { return loaded.has(key); }

export function assetStatus() {
  return {
    total: Object.keys(MANIFEST).length,
    loaded: loaded.size,
    missing: failed.size,
    keys: [...loaded.keys()],
  };
}

/**
 * Recentre, rescale and reorient a loaded model to the gameplay dimensions the
 * rest of the engine already assumes.
 *
 * Without this a model exported in centimetres, or Z-up, or with its origin at
 * the artist's world centre, would appear the wrong size, lying on its side, or
 * nowhere near the hull it represents. Every image-to-3D service produces at
 * least one of those problems, so normalising is not optional.
 */
function normalise(root, spec) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);

  if (size.x === 0 || size.y === 0 || size.z === 0) return null;

  const wrapper = new THREE.Group();

  // Many exporters are Y-up with the model's long axis on X. If the footprint
  // is clearly longer across X than Z, rotate it bow-forward.
  if (spec.axis === 'z' && size.x > size.z * 1.4) {
    root.rotation.y = Math.PI / 2;
    const t = size.x; size.x = size.z; size.z = t;
  }

  const target = spec.axis === 'y' ? spec.height : spec.length;
  const current = spec.axis === 'y' ? size.y : size.z;
  const scale = target / current;

  root.position.sub(centre);
  root.scale.setScalar(scale);
  root.position.multiplyScalar(scale);

  // Vessels sit with the waterline at y=0; landmarks sit on their base.
  const scaledHalfHeight = (size.y * scale) / 2;
  root.position.y += spec.axis === 'y' ? scaledHalfHeight : scaledHalfHeight * 0.25;

  wrapper.add(root);
  wrapper.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    // Imported materials are frequently double-sided and unlit-bright; bring
    // them into line with the rest of the scene.
    if (o.material) {
      o.material.side = THREE.FrontSide;
      if (o.material.map) o.material.map.colorSpace = THREE.SRGBColorSpace;
    }
  });
  return wrapper;
}

/**
 * Start loading whatever models are present. Safe to call once at boot; it
 * never rejects and never blocks.
 */
export async function preloadAssets({ quiet = false } = {}) {
  // Ask assets/manifest.json which models are actually present before trying
  // any of them. Blind-loading the whole slot list produces one console 404 per
  // slot, which looks like a broken build even though missing models are the
  // normal case.
  let available = null;
  try {
    const res = await fetch('assets/manifest.json', { cache: 'no-cache' });
    if (res.ok) available = await res.json();
  } catch { /* no manifest: nothing to load */ }

  if (!available || !Array.isArray(available.present) || !available.present.length) {
    if (!quiet) console.info('[assets] No GLB manifest — running fully procedural.');
    return assetStatus();
  }

  if (!loader) {
    try {
      const mod = await import('../../vendor/jsm/loaders/GLTFLoader.js');
      loader = new mod.GLTFLoader();
    } catch (e) {
      if (!quiet) console.info('[assets] GLTFLoader unavailable — procedural geometry only.');
      return assetStatus();
    }
  }

  const wanted = Object.entries(MANIFEST).filter(([key]) => available.present.includes(key));
  await Promise.all(wanted.map(([key, spec]) => new Promise((resolve) => {
    loader.load(
      spec.url,
      (gltf) => {
        try {
          const norm = normalise(gltf.scene, spec);
          if (norm) {
            loaded.set(key, norm);
            for (const cb of listeners) { try { cb(key); } catch { /* listener's problem */ } }
          } else {
            failed.add(key);
          }
        } catch (e) {
          // A model that cannot be normalised is treated exactly like a missing
          // one. Never let a bad export take the game down.
          failed.add(key);
        }
        resolve();
      },
      undefined,
      () => { failed.add(key); resolve(); }   // 404 is the normal case, not an error
    );
  })));

  const s = assetStatus();
  if (!quiet && s.loaded > 0) {
    console.info(`[assets] ${s.loaded}/${s.total} GLB models loaded; the rest are procedural.`);
  }
  return s;
}
