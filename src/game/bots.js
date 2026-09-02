/**
 * Bot captains.
 *
 * Bots exist only on the host, and they drive the SAME input struct a human
 * does — throttle, turn, aim, fire, alt. They get no extra speed, no perfect
 * aim, no seeing through islands. That matters for two reasons: the simulation
 * cannot tell a bot from a player so nothing special-cases them, and a human
 * who loses to one has actually been outplayed rather than cheated.
 *
 * The behaviour is a small state machine, chosen fresh a few times a second:
 *
 *   HUNT     no target worth chasing — head for the nearest useful pickup
 *   ENGAGE   an enemy in range and in sight — close, aim, shoot
 *   EVADE    badly damaged — break contact and put terrain in the way
 *   UNSTICK  ground or wedged — reverse out
 *
 * Aim is deliberately imperfect: a lead prediction with an error that shrinks
 * with skill, plus a reaction delay. Perfect leading on a 40 m/s boat would be
 * unbeatable, and being beaten by something unbeatable is not fun.
 */

import { CFG, VESSELS, WEAPONS, PICKUP_TO_VESSEL } from '../config.js';
import { OBSTACLES, lineBlocked, PICKUP_SPOTS } from './world.js';

const NICKS = [
  'CPO TAN', 'LT WONG', 'CDR LIM', 'PO KUMAR', 'LT ONG', 'MID RAJU',
  'CPO CHUA', 'LT GOH', 'CDR NAIR', 'PO SIM', 'LT YEO', 'MID DAS',
  'CPO HENG', 'LT SOH', 'CDR ABDUL', 'PO TOH',
];

/** Difficulty presets. `aimError` is radians of bias; lower is deadlier. */
export const BOT_SKILL = {
  easy:   { aimError: 0.135, reaction: 0.75, engageRange: 0.62, throttle: 0.78, evadeAt: 0.55 },
  normal: { aimError: 0.070, reaction: 0.42, engageRange: 0.80, throttle: 0.92, evadeAt: 0.38 },
  hard:   { aimError: 0.032, reaction: 0.22, engageRange: 0.95, throttle: 1.00, evadeAt: 0.24 },
};

let nickCursor = 0;
export function botName() {
  const n = NICKS[nickCursor % NICKS.length];
  nickCursor++;
  return nickCursor > NICKS.length ? `${n} ${Math.floor(nickCursor / NICKS.length) + 1}` : n;
}

const angleTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
const wrapPi = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

export function createBotState(skill = 'normal') {
  const s = BOT_SKILL[skill] || BOT_SKILL.normal;
  return {
    skill: s,
    mode: 'hunt',
    think: Math.random() * 0.3,
    targetId: null,
    goal: null,
    aimBias: (Math.random() - 0.5) * 2 * s.aimError,
    aimNoiseAt: 0,
    reactionLeft: 0,
    stuckFor: 0,
    lastX: 0,
    lastZ: 0,
    wanderAngle: Math.random() * Math.PI * 2,
  };
}

/**
 * One bot's decision for this tick. Returns the same input shape a client sends,
 * so hostSim.applyInput treats it identically to a human's.
 */
export function stepBot(bot, self, players, mines, pickups, dt) {
  const b = bot;
  const def = VESSELS[self.v];
  const weapon = WEAPONS[def.weapon];

  // --- stuck detection: compare travel against what throttle implies -------
  const moved = Math.hypot(self.x - b.lastX, self.z - b.lastZ);
  b.lastX = self.x; b.lastZ = self.z;
  if (moved < 0.25 && Math.abs(self.s) > 1.5) b.stuckFor += dt;
  else b.stuckFor = Math.max(0, b.stuckFor - dt * 2);

  b.think -= dt;
  b.reactionLeft = Math.max(0, b.reactionLeft - dt);

  if (b.think <= 0) {
    b.think = 0.22 + Math.random() * 0.18;
    decide(b, self, players, pickups);
  }

  if (b.stuckFor > 0.9) b.mode = 'unstick';

  switch (b.mode) {
    case 'unstick': return unstick(b, self, dt);
    case 'engage': return engage(b, self, players, weapon, def, dt);
    case 'evade': return evade(b, self, players, def);
    default: return hunt(b, self, pickups, def);
  }
}

function decide(b, self, players, pickups) {
  const hpFrac = self.hp / CFG.player.maxHp;

  // Where the enemy fleet actually is, whether or not we can see it.
  //
  // Without this bots never fight: both teams spawn in opposite corners, each
  // hunts the pickups nearest itself, and the nearest enemy sits ~900m away
  // forever — well outside detection range. A team needs a reason to ADVANCE,
  // not just to shop locally.
  let ex = 0, ez = 0, en = 0;
  for (const id in players) {
    const e = players[id];
    if (!e.team || e.team === self.team || !e.a || e.hp <= 0) continue;
    ex += e.x; ez += e.z; en++;
  }
  b.enemyCentre = en ? { x: ex / en, z: ez / en } : null;

  // Pick the best enemy: near, in sight, and not submerged.
  let best = null, bestScore = Infinity;
  for (const id in players) {
    const e = players[id];
    if (!e.team || e.team === self.team || !e.a || e.hp <= 0 || e.d) continue;
    const d = Math.hypot(e.x - self.x, e.z - self.z);
    if (d > 620) continue;
    if (lineBlocked(self.x, self.z, e.x, e.z)) continue;
    // Prefer the closest, and prefer a wounded one — bots should finish kills.
    const score = d * (0.55 + (e.hp / CFG.player.maxHp) * 0.75);
    if (score < bestScore) { bestScore = score; best = id; }
  }

  if (hpFrac < b.skill.evadeAt && best) {
    b.mode = 'evade';
    b.targetId = best;
    return;
  }
  if (best) {
    if (b.targetId !== best) b.reactionLeft = b.skill.reaction;
    b.mode = 'engage';
    b.targetId = best;
    return;
  }

  b.targetId = null;
  b.mode = 'hunt';

  // Head for a pickup that would actually change what we are — preferring one
  // that also carries us toward the enemy, so re-arming and advancing are the
  // same trip rather than competing goals.
  const myDistToEnemy = b.enemyCentre
    ? Math.hypot(b.enemyCentre.x - self.x, b.enemyCentre.z - self.z) : 0;
  let goal = null, bestCost = Infinity;
  for (let i = 0; i < pickups.length; i++) {
    const pu = pickups[i];
    if (!pu.active) continue;
    if (PICKUP_TO_VESSEL[pu.kind] === self.v) continue;   // already that hull
    const d = Math.hypot(pu.x - self.x, pu.z - self.z);
    if (d > 620) continue;                                // not worth the trek
    let cost = d;
    if (b.enemyCentre) {
      const puToEnemy = Math.hypot(b.enemyCentre.x - pu.x, b.enemyCentre.z - pu.z);
      cost -= (myDistToEnemy - puToEnemy) * 0.55;         // reward forward progress
    }
    if (cost < bestCost) { bestCost = cost; goal = pu; }
  }
  b.goal = goal;
}

/** Steer toward a heading, avoiding whatever terrain is directly ahead. */
function steerTo(b, self, wantHeading, def) {
  // Whisker probes: if terrain sits close ahead, bias the turn away from it.
  const probe = 26 + Math.abs(self.s) * 1.1;
  let avoid = 0;
  for (const o of OBSTACLES) {
    const dx = o.x - self.x, dz = o.z - self.z;
    const d = Math.hypot(dx, dz);
    if (d > o.r + probe) continue;
    const rel = wrapPi(Math.atan2(dx, dz) - self.h);
    if (Math.abs(rel) > 1.1) continue;                    // not ahead
    const urgency = 1 - (d - o.r) / probe;
    avoid -= Math.sign(rel || 1) * urgency * 1.6;
  }

  let diff = wrapPi(wantHeading - self.h) + avoid;
  const turn = Math.max(-1, Math.min(1, diff * 2.2));
  return turn;
}

function hunt(b, self, pickups, def) {
  let want;
  if (b.goal) {
    want = angleTo(self, b.goal);
  } else if (b.enemyCentre) {
    // Nothing to collect: go and find the enemy. Wander a little around the
    // bearing so a whole team does not advance in a single straight line.
    b.wanderAngle += (Math.random() - 0.5) * 0.12;
    want = angleTo(self, b.enemyCentre) + Math.sin(b.wanderAngle) * 0.35;
  } else {
    const fromCentre = Math.hypot(self.x, self.z);
    if (fromCentre > CFG.map.half - 120) b.wanderAngle = Math.atan2(-self.x, -self.z);
    else b.wanderAngle += (Math.random() - 0.5) * 0.25;
    want = b.wanderAngle;
  }
  return {
    throttle: b.skill.throttle,
    turn: steerTo(b, self, want, def),
    aim: self.h,
    fire: false,
    alt: false,
  };
}

function engage(b, self, players, weapon, def, dt) {
  const t = players[b.targetId];
  if (!t) { b.mode = 'hunt'; return hunt(b, self, [], def); }

  const dist = Math.hypot(t.x - self.x, t.z - self.z);
  const ideal = weapon.range * b.skill.engageRange;

  // Slow-firing hulls stand off; rapid-fire hulls close in.
  const closing = dist > ideal ? 1 : dist < ideal * 0.45 ? -0.55 : 0.25;

  // Lead the target, then spoil it slightly. The bias drifts so a bot does not
  // sit on a fixed offset a human could learn to exploit.
  if (performance.now() > b.aimNoiseAt) {
    b.aimNoiseAt = performance.now() + 400 + Math.random() * 700;
    b.aimBias = (Math.random() - 0.5) * 2 * b.skill.aimError;
  }
  const flight = Math.min(dist / weapon.speed, 2.6);
  const px = t.x + Math.sin(t.h) * t.s * flight;
  const pz = t.z + Math.cos(t.h) * t.s * flight;
  const aim = angleTo(self, { x: px, z: pz }) + b.aimBias;

  const aligned = Math.abs(wrapPi(aim - self.h)) < 1.4;
  const canSee = !lineBlocked(self.x, self.z, t.x, t.z);
  const inRange = dist < weapon.range * 1.02;

  // Minelayers have no direct fire: they run the enemy's line and drop mines.
  const isMiner = def.weapon === 'mine';
  const fire = isMiner
    ? dist < 130
    : (b.reactionLeft <= 0 && canSee && inRange && aligned);

  return {
    throttle: b.skill.throttle * closing,
    turn: steerTo(b, self, isMiner ? angleTo(self, t) : aim, def),
    aim,
    fire,
    alt: isMiner,
  };
}

function evade(b, self, players, def) {
  const t = players[b.targetId];
  const away = t ? angleTo(t, self) : b.wanderAngle;
  return {
    throttle: b.skill.throttle,
    turn: steerTo(b, self, away, def),
    aim: t ? angleTo(self, t) : self.h,          // keep guns on them while running
    fire: !!t && Math.hypot(t.x - self.x, t.z - self.z) < 200,
    alt: self.v === 'submarine',                 // dive if we can
  };
}

function unstick(b, self, dt) {
  // Reverse and swing the rudder; reversing inverts steering, which is what
  // actually walks a hull off an obstacle.
  b.stuckFor -= dt * 0.6;
  if (b.stuckFor <= 0.2) b.mode = 'hunt';
  return {
    throttle: -1,
    turn: b.aimBias > 0 ? 1 : -1,
    aim: self.h,
    fire: false,
    alt: false,
  };
}

/** Spread bot spawns across the map's pickup ring so they do not clump. */
export function botSpawnHint(index) {
  const spot = PICKUP_SPOTS[index % PICKUP_SPOTS.length];
  return { x: spot.x, z: spot.z };
}
