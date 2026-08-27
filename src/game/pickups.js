/**
 * Weapon pickups and deployed mines.
 *
 * Pickups are automatic on contact — no keypress. Asking a first-time player to
 * find a prompt and hit E in the middle of a firefight breaks the flow, and the
 * flow is the entire pitch of this game.
 *
 * Each pickup throws a coloured light column visible across the map, which is
 * how a fight gets started: everyone can see the missile pod from 400 metres,
 * and everyone wants it.
 */

import * as THREE from 'three';
import { mat, mesh, box, cyl, cone, sphere } from './geo.js';
import { PICKUP_SPOTS } from './world.js';
import { WEAPONS } from '../config.js';
import { sampleWaveHeight } from './water.js';

const KIND_COLOR = {
  rifle: 0x3fd67a,
  missile: 0xff5a4d,
  torpedo: 0x36c8e8,
  mine: 0xffa726,
};

const ADD = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

/** A floating crate whose payload is visible on top, so the kind reads at range. */
function buildCrate(kind) {
  const g = new THREE.Group();
  const color = KIND_COLOR[kind];

  const raft = mesh(box(4.6, 1.0, 4.6), mat(0xe0e4e8), 0, 0.3, 0);
  g.add(raft);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    g.add(mesh(cyl(0.6, 0.6, 1.3, 6), mat(0xf0a030), dx * 2.4, 0.4, dz * 2.4));
  }
  const crate = mesh(box(3.0, 2.4, 3.0), mat(0x4a5158), 0, 2.0, 0);
  g.add(crate);
  for (const s of [1, -1]) {
    g.add(mesh(box(3.15, 0.28, 0.5), mat(color, { emissive: color, emissiveIntensity: 0.7 }), 0, 2.0, s * 1.3));
  }

  // Payload silhouette on the lid.
  const payload = new THREE.Group();
  payload.position.y = 3.9;
  const pm = mat(color, { emissive: color, emissiveIntensity: 0.85 });
  if (kind === 'rifle') {
    const b = mesh(cyl(0.18, 0.18, 3.2, 6), pm); b.rotation.z = Math.PI / 2; payload.add(b);
    payload.add(mesh(box(0.9, 0.5, 0.5), pm, -1.0, -0.3, 0));
  } else if (kind === 'missile') {
    const b = mesh(cyl(0.42, 0.42, 2.6, 8), pm); b.rotation.z = Math.PI / 2; payload.add(b);
    const n = mesh(cone(0.42, 0.9, 8), pm, 1.7, 0, 0); n.rotation.z = -Math.PI / 2; payload.add(n);
  } else if (kind === 'torpedo') {
    const b = mesh(cyl(0.5, 0.5, 3.0, 8), pm); b.rotation.z = Math.PI / 2; payload.add(b);
    payload.add(mesh(box(0.2, 1.0, 1.0), pm, -1.5, 0, 0));
  } else {
    payload.add(mesh(sphere(0.85, 8), pm));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      payload.add(mesh(cyl(0.1, 0.1, 0.6, 4), pm, Math.cos(a) * 0.5, 0.6, Math.sin(a) * 0.5));
    }
  }
  g.add(payload);

  // Light column — the map-wide "come and fight over this" signal.
  const beam = mesh(
    cyl(1.9, 3.2, 90, 9, 1),
    new THREE.MeshBasicMaterial({ color, ...ADD, opacity: 0.16, side: THREE.DoubleSide }),
    0, 45, 0
  );
  g.add(beam);
  const halo = mesh(new THREE.RingGeometry(3.2, 5.4, 18), new THREE.MeshBasicMaterial({ color, ...ADD, opacity: 0.4, side: THREE.DoubleSide }), 0, 0.3, 0);
  halo.rotation.x = -Math.PI / 2;
  g.add(halo);

  g.userData = { payload, beam, halo, color };
  return g;
}

export class PickupField {
  constructor(scene) {
    this.nodes = PICKUP_SPOTS.map((s) => {
      const n = buildCrate(s.kind);
      n.position.set(s.x, 0, s.z);
      scene.add(n);
      return n;
    });
  }

  /** `mask` is the host's active-flags string, one character per spawn. */
  update(mask, t) {
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const active = mask ? mask[i] === '1' : true;
      n.visible = active;
      if (!active) continue;
      n.position.y = sampleWaveHeight(n.position.x, n.position.z, t) - 0.3;
      n.rotation.y = t * 0.5 + i;
      n.userData.payload.rotation.y = -t * 1.4;
      n.userData.payload.position.y = 3.9 + Math.sin(t * 2 + i) * 0.18;
      n.userData.halo.scale.setScalar(1 + Math.sin(t * 2.4 + i) * 0.12);
      n.userData.beam.material.opacity = 0.13 + Math.sin(t * 1.6 + i) * 0.05;
    }
  }
}

/**
 * Deployed mines.
 *
 * Visibility is the whole design: your own team always sees them, so you do not
 * blunder into your teammate's field. Enemies see nothing until they are inside
 * revealRange, and then only a faint ripple — a fair warning, not a free pass.
 */
export class MineField {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.group = new THREE.Group();
    scene.add(this.group);
  }

  _node() {
    const g = new THREE.Group();
    const body = mesh(sphere(1.5, 9), mat(0x22262b));
    g.add(body);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      g.add(mesh(cyl(0.16, 0.16, 1.0, 4), mat(0xff7043), Math.cos(a) * 0.9, 1.2, Math.sin(a) * 0.9));
    }
    const ripple = mesh(
      new THREE.RingGeometry(2.2, 3.4, 16),
      new THREE.MeshBasicMaterial({ color: 0xffd54f, ...ADD, opacity: 0.5, side: THREE.DoubleSide }),
      0, 0.25, 0
    );
    ripple.rotation.x = -Math.PI / 2;
    g.add(ripple);
    g.userData = { body, ripple };
    this.group.add(g);
    this.pool.push(g);
    return g;
  }

  update(mines, localTeam, localPos, t) {
    for (let i = 0; i < mines.length; i++) {
      const m = mines[i];
      const node = this.pool[i] || this._node();
      const friendly = m.team === localTeam;
      const dist = Math.hypot(m.x - localPos.x, m.z - localPos.z);
      const revealed = friendly || dist < WEAPONS.mine.revealRange;

      node.visible = revealed;
      if (!revealed) continue;

      node.position.set(m.x, sampleWaveHeight(m.x, m.z, t) - 0.75, m.z);
      // Enemy mines show only the warning ripple — the hull stays hidden.
      node.userData.body.visible = friendly;
      const pulse = 0.35 + Math.sin(t * 6) * 0.22;
      node.userData.ripple.material.opacity = friendly ? 0.28 : pulse;
      node.userData.ripple.material.color.setHex(friendly ? 0x64b5f6 : 0xffd54f);
      const s = friendly ? 1 : 1 + Math.sin(t * 6) * 0.16;
      node.userData.ripple.scale.setScalar(s);
    }
    for (let i = mines.length; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  /** Closest enemy mine within warning range — drives the HUD warning tone. */
  static nearestThreat(mines, localTeam, localPos) {
    let best = Infinity;
    for (const m of mines) {
      if (m.team === localTeam) continue;
      const d = Math.hypot(m.x - localPos.x, m.z - localPos.z);
      if (d < best) best = d;
    }
    return best;
  }
}

export { KIND_COLOR };
