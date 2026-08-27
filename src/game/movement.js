/**
 * Vessel movement — the one piece of simulation that runs in BOTH places.
 *
 * The host runs it authoritatively; every client runs the identical function on
 * its own vessel to predict ahead of the network. Because it is the same code
 * over the same inputs, prediction error stays tiny and corrections are
 * invisible. If you change handling, change it here and nowhere else.
 */

import { VESSELS, CFG } from '../config.js';
import { resolveCollision, edgePressure } from './world.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function maxSpeedOf(p) {
  return CFG.physics.baseSpeed * VESSELS[p.v].speed * (p.d ? 0.78 : 1);
}

export function stepVessel(p, input, dt) {
  const def = VESSELS[p.v];
  const maxSpeed = maxSpeedOf(p);

  // Throttle. Reverse is deliberately weak — backing out of a mangrove channel
  // should be a bad idea, not an escape route.
  const target = input.throttle >= 0
    ? input.throttle * maxSpeed
    : input.throttle * maxSpeed * CFG.physics.reverseFactor;

  const accel = CFG.physics.accel * dt;
  p.s += clamp(target - p.s, -accel, accel);

  // A boat pivots on its rudder, so it barely turns at rest and carves at speed.
  const frac = Math.min(1, Math.abs(p.s) / maxSpeed);
  const rate = CFG.physics.baseTurn * def.turn *
    (CFG.physics.turnAtRest + (1 - CFG.physics.turnAtRest) * frac);
  p.h += input.turn * rate * dt * (p.s < -0.2 ? -1 : 1);
  p.h = ((p.h % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  // Soft map edge: push back rather than wall off, and bleed speed.
  const pressure = edgePressure(p.x, p.z);
  if (pressure > 0) {
    const inward = Math.atan2(-p.x, -p.z);
    let diff = ((inward - p.h + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    p.h += diff * pressure * 1.6 * dt;
    p.s *= 1 - 0.35 * pressure * dt;
  }

  const nx = p.x + Math.sin(p.h) * p.s * dt;
  const nz = p.z + Math.cos(p.h) * p.s * dt;
  const c = resolveCollision(nx, nz, def.radius);
  if (c.hit) p.s *= 0.45;
  p.x = c.x;
  p.z = c.z;

  return c.hit;
}
