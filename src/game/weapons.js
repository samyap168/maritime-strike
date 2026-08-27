/**
 * Weapon logic — pure simulation, no rendering.
 *
 * This module runs ONLY on the host. Clients render what the host reports.
 * Keeping it free of Three.js means the whole combat model is readable and
 * tweakable in one place, and could run headless if this ever needed a
 * dedicated server.
 */

import { WEAPONS, VESSELS, CFG } from '../config.js';
import { OBSTACLES } from './world.js';

let nextProjectileId = 1;

/**
 * Spawn a projectile. `targetId` is the soft lock captured at trigger pull —
 * only the missile actually uses it to steer.
 */
export function createProjectile(kind, owner, team, x, y, z, heading, targetId = null) {
  const w = WEAPONS[kind];
  const spread = w.spread ? (Math.random() - 0.5) * 2 * w.spread : 0;
  return {
    id: nextProjectileId++,
    kind,
    owner,
    team,
    x, y, z,
    heading: heading + spread,
    speed: w.speed,
    life: w.range / w.speed,
    maxLife: w.range / w.speed,
    targetId,
    vy: kind === 'missile' ? 7.5 : 0,
  };
}

/**
 * Advance one projectile. Returns null if it is still flying, otherwise an
 * outcome describing what to do about it.
 */
export function stepProjectile(p, dt, players) {
  const w = WEAPONS[p.kind];

  if (p.kind === 'missile') {
    // Steer toward the locked target at a bounded turn rate, so a missile can
    // be dodged by a fast boat but not simply outrun by a destroyer.
    const target = p.targetId && players[p.targetId];
    if (target && target.a && target.hp > 0) {
      const want = Math.atan2(target.x - p.x, target.z - p.z);
      let diff = ((want - p.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const max = w.homingRate * dt;
      p.heading += Math.max(-max, Math.min(max, diff));
    }
    // A visible ballistic arc: up out of the cells, then down onto the target.
    const phase = 1 - p.life / p.maxLife;
    p.vy -= 9.0 * dt;
    p.y = Math.max(0.6, p.y + p.vy * dt);
    if (phase < 0.18) p.y = Math.max(p.y, 0.6 + phase * w.arcHeight * 5);
  } else if (p.kind === 'torpedo') {
    p.y = -0.35;   // runs just under the surface, leaving a visible wake line
  } else {
    p.y = 1.1;
  }

  // Sweep, do not teleport. At 210 m/s a round covers 7 m per 30Hz tick while a
  // sampan's hit radius is under 5 m, so a point test at the new position lets
  // fast rounds pass clean through targets. Every hit test below is therefore
  // against the SEGMENT travelled this tick.
  const fromX = p.x, fromZ = p.z;
  p.x += Math.sin(p.heading) * p.speed * dt;
  p.z += Math.cos(p.heading) * p.speed * dt;
  p.life -= dt;

  // Terrain. A torpedo runs under barges and jetties, but not through rock.
  for (const o of OBSTACLES) {
    if (p.kind === 'torpedo' && (o.type === 'barge' || o.type === 'jetty')) continue;
    if (segmentHitsCircle(fromX, fromZ, p.x, p.z, o.x, o.z, o.r)) return { type: 'terrain' };
  }

  if (Math.abs(p.x) > CFG.map.half || Math.abs(p.z) > CFG.map.half) return { type: 'expired' };

  // Player hit test. Submerged submarines are immune to everything but
  // torpedoes — going under is real protection, paid for by not being able to
  // shoot while you are down there.
  let best = null, bestT = Infinity;
  for (const id in players) {
    const t = players[id];
    if (!t.a || t.hp <= 0 || t.team === p.team || id === p.owner) continue;
    if (t.d && p.kind !== 'torpedo') continue;
    const r = VESSELS[t.v].radius + 1.2;
    const at = segmentHitsCircle(fromX, fromZ, p.x, p.z, t.x, t.z, r);
    // If the sweep crosses two enemies, the nearer one is hit.
    if (at !== false && at < bestT) { bestT = at; best = id; }
  }
  if (best !== null) {
    // Detonate where it actually struck, not at the end of the sweep, so the
    // explosion and the damage number land on the hull.
    p.x = fromX + (p.x - fromX) * bestT;
    p.z = fromZ + (p.z - fromZ) * bestT;
    return { type: 'hit', targetId: best };
  }

  if (p.life <= 0) return { type: 'expired' };
  return null;
}

/**
 * Does the segment a->b pass within `radius` of c? Returns the fraction along
 * the segment at closest approach, or false. Cheap: one dot product and a clamp.
 */
function segmentHitsCircle(ax, az, bx, bz, cx, cz, radius) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((cx - ax) * dx + (cz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - cx, pz = az + dz * t - cz;
  return px * px + pz * pz <= radius * radius ? t : false;
}

/** Damage roll. Criticals are a flat chance on every hit, including splash. */
export function rollDamage(base) {
  const crit = Math.random() < CFG.combat.critChance;
  return { damage: Math.round(base * (crit ? CFG.combat.critMultiplier : 1)), crit };
}

/** Everyone inside the splash radius of an explosion, excluding the firer's team. */
export function splashTargets(x, z, radius, team, players) {
  const out = [];
  for (const id in players) {
    const t = players[id];
    if (!t.a || t.hp <= 0 || t.team === team) continue;
    const dx = t.x - x, dz = t.z - z;
    const d = Math.hypot(dx, dz);
    if (d < radius) out.push({ id, falloff: 1 - d / radius });
  }
  return out;
}

let nextMineId = 1;

export function createMine(owner, team, x, z) {
  return {
    id: nextMineId++,
    owner, team, x, z,
    armed: false,
    armIn: WEAPONS.mine.armDelay,
    life: WEAPONS.mine.life,
  };
}

/** Returns the id of the first enemy to blunder into an armed mine, or null. */
export function stepMine(mine, dt, players) {
  mine.life -= dt;
  if (!mine.armed) {
    mine.armIn -= dt;
    if (mine.armIn <= 0) mine.armed = true;
    return null;
  }
  const r = WEAPONS.mine.triggerRadius;
  for (const id in players) {
    const t = players[id];
    if (!t.a || t.hp <= 0 || t.team === mine.team) continue;
    const dx = t.x - mine.x, dz = t.z - mine.z;
    const reach = r + VESSELS[t.v].radius * 0.5;
    if (dx * dx + dz * dz < reach * reach) return id;
  }
  return null;
}

/** Muzzle offset so projectiles leave the gun, not the middle of the boat. */
export function muzzleOffset(vesselKind) {
  const def = VESSELS[vesselKind];
  return { forward: def.length * 0.42, height: vesselKind === 'submarine' ? 0.4 : 1.6 };
}
