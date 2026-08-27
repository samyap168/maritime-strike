/**
 * Input, aim assist and the camera rig.
 *
 * Aim assist is the difference between a designer who has never played a
 * shooter having fun in the first thirty seconds and quietly giving up. It
 * biases toward a nearby enemy and leads moving targets — but only blends 45%,
 * so someone who actually aims still beats someone who does not.
 */

import * as THREE from 'three';
import { CFG, VESSELS, WEAPONS } from '../config.js';
import { lineBlocked } from './world.js';

const KEYMAP = {
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'alt', ShiftRight: 'alt', Space: 'alt',
};

export class Controls {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.keys = {};
    this.mouse = new THREE.Vector2(0, 0);
    this.firing = false;
    this.enabled = false;
    this.aimPoint = new THREE.Vector3();
    this.lockedTarget = null;

    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this._onKey = (e, down) => {
      const slot = KEYMAP[e.code];
      if (slot) { this.keys[slot] = down; e.preventDefault(); }
    };
    window.addEventListener('keydown', (e) => this._onKey(e, true));
    window.addEventListener('keyup', (e) => this._onKey(e, false));
    // Release everything when focus or visibility is lost. Without this, a host
    // who alt-tabs mid-throttle leaves the throttle pinned and drives their own
    // boat into a rock while the match keeps running for everyone else.
    const release = () => { this.keys = {}; this.firing = false; };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    });
    canvas.addEventListener('mousedown', (e) => { if (e.button === 0) this.firing = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.firing = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Where the mouse ray meets the water plane. */
  updateAimPoint() {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.plane, this.aimPoint)) {
      this.aimPoint.set(0, 0, 0);
      return false;
    }
    return true;
  }

  /**
   * Build this frame's input packet.
   * `self` is the local predicted vessel; `others` the full render player set.
   */
  sample(self, others) {
    if (!this.enabled || !self || !self.a) {
      return { throttle: 0, turn: 0, aim: self ? self.t : 0, fire: false, alt: false };
    }

    this.updateAimPoint();
    const rawAim = Math.atan2(this.aimPoint.x - self.x, this.aimPoint.z - self.z);
    const aim = this.applyAimAssist(self, others, rawAim);

    return {
      throttle: (this.keys.fwd ? 1 : 0) - (this.keys.back ? 1 : 0),
      // Increasing heading rotates the hull toward screen-LEFT under the chase
      // camera, so A must produce the positive value. Getting this backwards is
      // the single most disorienting bug a driving game can ship.
      turn: (this.keys.left ? 1 : 0) - (this.keys.right ? 1 : 0),
      aim,
      fire: this.firing,
      alt: !!this.keys.alt,
    };
  }

  applyAimAssist(self, others, rawAim) {
    const weapon = WEAPONS[VESSELS[self.v].weapon];
    if (weapon.kind === 'mine') { this.lockedTarget = null; return rawAim; }

    let best = null, bestScore = Infinity;
    for (const id in others) {
      const t = others[id];
      if (id === self.id || !t.a || t.hp <= 0 || t.team === self.team) continue;
      if (t.d) continue;                      // a submerged sub cannot be assisted onto
      const dx = t.x - self.x, dz = t.z - self.z;
      const dist = Math.hypot(dx, dz);
      if (dist > CFG.combat.aimAssistRange || dist > weapon.range * 1.15) continue;

      const toTarget = Math.atan2(dx, dz);
      const off = Math.abs(((toTarget - rawAim + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (off > CFG.combat.aimAssistCone) continue;
      if (lineBlocked(self.x, self.z, t.x, t.z)) continue;

      const score = off * 2.2 + dist / CFG.combat.aimAssistRange;
      if (score < bestScore) { bestScore = score; best = t; }
    }

    this.lockedTarget = best ? best.id : null;
    if (!best) return rawAim;

    // Lead the target by its own velocity over the projectile's flight time.
    const dist = Math.hypot(best.x - self.x, best.z - self.z);
    const flight = dist / weapon.speed;
    const lead = Math.min(flight, 2.5);
    const px = best.x + Math.sin(best.h) * best.s * lead;
    const pz = best.z + Math.cos(best.h) * best.s * lead;
    const assisted = Math.atan2(px - self.x, pz - self.z);

    const diff = ((assisted - rawAim + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    return rawAim + diff * CFG.combat.aimAssistBlend;
  }
}

/**
 * Third-person chase camera.
 *
 * Sits behind and above the hull, angled down enough to read the surrounding
 * water without becoming a top-down map. Distance scales with vessel size so a
 * destroyer does not fill the frame, and eases on transformation so upgrading
 * feels like the boat grew under you.
 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pos = new THREE.Vector3(0, 60, 0);
    this.look = new THREE.Vector3();
    this.dist = 34;
  }

  update(self, aimPoint, dt, shake = 0) {
    if (!self) return;
    const def = VESSELS[self.v];
    const wantDist = 25 + def.length * 1.05;
    const wantHeight = 17 + def.length * 0.80;
    this.dist += (wantDist - this.dist) * Math.min(1, dt * 2.4);

    // Yaw follows the hull, but lags, so hard turns swing the camera.
    const diff = ((self.h - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.yaw += diff * Math.min(1, dt * 4.2);

    // Bias the camera slightly toward where you are aiming.
    // Bias the look-at toward the aim point, but only a little: at long range a
    // strong bias drags your own hull off the bottom of the screen.
    let lookX = self.x, lookZ = self.z;
    if (aimPoint) {
      const dx = aimPoint.x - self.x, dz = aimPoint.z - self.z;
      const d = Math.hypot(dx, dz) || 1;
      const reach = Math.min(d, 90) * 0.30;
      lookX += (dx / d) * reach;
      lookZ += (dz / d) * reach;
    }

    const target = new THREE.Vector3(
      self.x - Math.sin(this.yaw) * this.dist,
      wantHeight,
      self.z - Math.cos(this.yaw) * this.dist
    );
    this.pos.lerp(target, Math.min(1, dt * 6.5));

    if (shake > 0) {
      const s = shake * 1.5;
      this.pos.x += (Math.random() - 0.5) * s;
      this.pos.y += (Math.random() - 0.5) * s;
      this.pos.z += (Math.random() - 0.5) * s;
    }

    this.camera.position.copy(this.pos);
    this.look.lerp(new THREE.Vector3(lookX, 1.5, lookZ), Math.min(1, dt * 7));
    this.camera.lookAt(this.look);
  }

  /** Slow orbit used for the lobby backdrop and for spectating. */
  orbit(t, center = { x: 0, z: 0 }, radius = 260, height = 90) {
    this.camera.position.set(center.x + Math.sin(t * 0.06) * radius, height, center.z + Math.cos(t * 0.06) * radius);
    this.camera.lookAt(center.x, 0, center.z);
  }
}
