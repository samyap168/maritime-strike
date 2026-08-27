/**
 * Client-side smoothing.
 *
 * Two problems, two different solutions:
 *
 *   YOUR vessel must respond the instant you press a key, so it is simulated
 *   locally with the same movement code the host runs, and gently corrected
 *   toward the authoritative position as snapshots arrive.
 *
 *   OTHER vessels must move smoothly despite arriving at 15Hz, so they are
 *   rendered ~100ms in the past and interpolated between the two snapshots
 *   that bracket that moment. A little latency you never notice, in exchange
 *   for motion that never stutters or teleports.
 *
 * We correct rather than replay inputs. Full rollback reconciliation buys very
 * little at boat speeds and costs a lot of the complexity budget — and on
 * demo day, code that cannot desync beats code that is theoretically optimal.
 */

import { CFG } from '../config.js';
import { applySnapshot, blankPlayer } from './protocol.js';
import { stepVessel } from '../game/movement.js';

const SNAP_THRESHOLD = 14;   // metres of error beyond which we hard-snap
const EASE_RATE = 5.5;       // how fast small errors are absorbed

const shortestAngle = (from, to) => ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
const lerpAngle = (a, b, t) => a + shortestAngle(a, b) * t;

export class ClientSync {
  constructor(localId) {
    this.localId = localId;
    this.mirror = { players: {}, projectiles: [], mines: [], pickupMask: '', tick: 0, timeLeft: 0 };
    this.buffer = [];          // [{ at, players: {id: {x,z,h,t,d,s}} }]
    this.local = null;         // locally predicted copy of your own vessel
    this.render = { players: {}, projectiles: [], mines: [] };
    this.lastSnapAt = 0;
  }

  onSnapshot(msg) {
    applySnapshot(this.mirror, msg);
    this.lastSnapAt = performance.now();

    // Keep only what interpolation needs.
    const frame = { at: this.lastSnapAt, players: {} };
    for (const id in this.mirror.players) {
      const p = this.mirror.players[id];
      frame.players[id] = { x: p.x, z: p.z, h: p.h, t: p.t, d: p.d, s: p.s };
    }
    this.buffer.push(frame);
    while (this.buffer.length > 24) this.buffer.shift();

    const auth = this.mirror.players[this.localId];
    if (!auth) return;

    if (!this.local) {
      this.local = { ...auth };
      return;
    }
    // Keep authoritative facts (health, vessel, alive) exactly as the host says.
    this.local.hp = auth.hp;
    this.local.v = auth.v;
    this.local.a = auth.a;
    this.local.k = auth.k;
    this.local.de = auth.de;

    const err = Math.hypot(auth.x - this.local.x, auth.z - this.local.z);
    if (err > SNAP_THRESHOLD) {
      // Big divergence means a collision or a respawn we did not predict.
      this.local.x = auth.x; this.local.z = auth.z;
      this.local.h = auth.h; this.local.s = auth.s;
    } else {
      this._pendingCorrection = { x: auth.x - this.local.x, z: auth.z - this.local.z, h: shortestAngle(this.local.h, auth.h) };
    }
  }

  /** Run local prediction for one frame. Called every rendered frame. */
  predict(input, dt) {
    if (!this.local || !this.local.a) return;
    stepVessel(this.local, input, dt);
    this.local.t = input.aim;

    // Bleed off accumulated correction rather than jumping.
    const c = this._pendingCorrection;
    if (c) {
      const k = Math.min(1, EASE_RATE * dt);
      this.local.x += c.x * k; c.x -= c.x * k;
      this.local.z += c.z * k; c.z -= c.z * k;
      this.local.h += c.h * k; c.h -= c.h * k;
      if (Math.abs(c.x) + Math.abs(c.z) < 0.02) this._pendingCorrection = null;
    }
  }

  /**
   * Build the state to draw this frame: your predicted vessel, everyone else
   * interpolated in the recent past.
   */
  sample() {
    const target = performance.now() - CFG.net.interpDelayMs;
    const out = this.render;
    out.projectiles = this.mirror.projectiles;
    out.mines = this.mirror.mines;

    // Find the two frames that bracket the render time.
    let a = null, b = null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].at <= target) { a = this.buffer[i]; b = this.buffer[i + 1] || null; break; }
    }
    if (!a) a = this.buffer[0];
    const alpha = a && b && b.at > a.at ? (target - a.at) / (b.at - a.at) : 1;

    for (const id in this.mirror.players) {
      const auth = this.mirror.players[id];
      const dst = out.players[id] || (out.players[id] = blankPlayer(id));

      // Authoritative, never interpolated — these must not lag behind.
      dst.hp = auth.hp; dst.v = auth.v; dst.a = auth.a;
      dst.k = auth.k; dst.de = auth.de; dst.c = auth.c; dst.team = auth.team;

      if (id === this.localId && this.local) {
        dst.x = this.local.x; dst.z = this.local.z;
        dst.h = this.local.h; dst.t = this.local.t;
        dst.s = this.local.s; dst.d = this.local.d;
        continue;
      }

      const fa = a && a.players[id];
      const fb = b && b.players[id];
      if (fa && fb) {
        dst.x = fa.x + (fb.x - fa.x) * alpha;
        dst.z = fa.z + (fb.z - fa.z) * alpha;
        dst.h = lerpAngle(fa.h, fb.h, alpha);
        dst.t = lerpAngle(fa.t, fb.t, alpha);
        dst.s = fa.s + (fb.s - fa.s) * alpha;
        dst.d = fb.d;
      } else if (fa) {
        dst.x = fa.x; dst.z = fa.z; dst.h = fa.h; dst.t = fa.t; dst.s = fa.s; dst.d = fa.d;
      } else {
        dst.x = auth.x; dst.z = auth.z; dst.h = auth.h; dst.t = auth.t; dst.s = auth.s; dst.d = auth.d;
      }
    }

    for (const id in out.players) if (!this.mirror.players[id]) delete out.players[id];
    return out;
  }

  /** The host runs no prediction — it simply reads its own authoritative state. */
  static fromHost(sim, localId) {
    const s = new ClientSync(localId);
    s.isHostView = true;
    s.readHost = () => {
      s.render.players = sim.players;
      s.render.projectiles = sim.projectiles;
      s.render.mines = sim.mines;
      return s.render;
    };
    return s;
  }
}
