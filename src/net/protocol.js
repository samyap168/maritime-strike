/**
 * Wire protocol.
 *
 * Two classes of traffic:
 *   EVENTS    — reliable, ordered. Joins, kills, pickups, phase changes.
 *               Losing one of these desyncs the match, so they must arrive.
 *   SNAPSHOTS — unreliable, unordered. Positions at 15Hz.
 *               Losing one is invisible; the next arrives 66ms later.
 *
 * Snapshots are delta-compressed against the last acknowledged state: a field is
 * only sent when it has actually changed, and positions/angles are quantised.
 * With 16 players this keeps a snapshot in the low hundreds of bytes.
 */

export const MSG = {
  // client -> host
  HELLO: 'hello',
  INPUT: 'in',
  SET_NAME: 'name',
  SET_TEAM: 'team',
  SET_READY: 'rdy',
  START: 'start',
  KICK: 'kick',
  PING: 'ping',

  // host -> client
  WELCOME: 'wel',
  LOBBY: 'lob',
  SNAPSHOT: 'snap',
  EVENT: 'ev',
  PONG: 'pong',
  DENIED: 'no',
};

export const EV = {
  PHASE: 'phase',
  COUNTDOWN: 'cd',
  HIT: 'hit',
  KILL: 'kill',
  PICKUP: 'pick',
  FIRE: 'fire',
  MINE_BLOW: 'mineblow',
  RESULT: 'result',
};

// ---------------------------------------------------------------------------
// Quantisation. Positions to decimetres, angles to 1/1000 turn, HP to integers.
// ---------------------------------------------------------------------------

const qPos = (v) => Math.round(v * 10);
const dPos = (v) => v / 10;
const qAng = (v) => Math.round(((v % TAU) + TAU) % TAU * 1000 / TAU);
const dAng = (v) => v * TAU / 1000;
const TAU = Math.PI * 2;

/** Fields of a player that get delta-tracked, with their codecs. */
const PLAYER_FIELDS = [
  ['x', qPos, dPos],
  ['z', qPos, dPos],
  ['h', qAng, dAng],          // hull heading
  ['t', qAng, dAng],          // turret heading
  ['s', (v) => Math.round(v * 10), (v) => v / 10],  // speed
  ['hp', Math.round, (v) => v],
  ['v', (v) => v, (v) => v],  // vessel id (string)
  ['a', (v) => (v ? 1 : 0), (v) => !!v],  // alive
  ['d', (v) => (v ? 1 : 0), (v) => !!v],  // submerged
  ['k', Math.round, (v) => v],            // sinks
  ['de', Math.round, (v) => v],           // deaths
  ['c', (v) => (v ? 1 : 0), (v) => !!v],  // connected
];

/**
 * Build a snapshot delta. `baseline` is mutated to become the new baseline, so
 * the caller keeps exactly one baseline per receiving peer.
 */
export function encodeSnapshot(state, baseline) {
  const players = {};
  for (const id in state.players) {
    const p = state.players[id];
    const prev = baseline.players[id] || (baseline.players[id] = {});
    const out = {};
    let changed = false;
    for (const [key, enc] of PLAYER_FIELDS) {
      const q = enc(p[key]);
      if (prev[key] !== q) { out[key] = q; prev[key] = q; changed = true; }
    }
    if (changed) players[id] = out;
  }
  // Players that vanished (left the room) must be explicitly removed.
  const gone = [];
  for (const id in baseline.players) {
    if (!state.players[id]) { gone.push(id); delete baseline.players[id]; }
  }

  return {
    _: MSG.SNAPSHOT,
    t: state.tick,
    tl: Math.round(state.timeLeft * 10),
    p: players,
    g: gone.length ? gone : undefined,
    // Projectiles and mines are small and short-lived — sent whole, not delta'd.
    pr: state.projectiles.map((o) => [o.id, o.kind, qPos(o.x), qPos(o.y), qPos(o.z), qAng(o.heading)]),
    mn: state.mines.map((o) => [o.id, qPos(o.x), qPos(o.z), o.team, o.armed ? 1 : 0]),
    // Pickups change rarely; a compact active-mask is enough.
    pu: state.pickups.map((o) => (o.active ? 1 : 0)).join(''),
  };
}

/** Apply a delta onto a client-side mirror. Returns the mirror. */
export function applySnapshot(mirror, msg) {
  mirror.tick = msg.t;
  mirror.timeLeft = msg.tl / 10;

  for (const id in msg.p) {
    const patch = msg.p[id];
    const p = mirror.players[id] || (mirror.players[id] = blankPlayer(id));
    for (const [key, , dec] of PLAYER_FIELDS) {
      if (patch[key] !== undefined) p[key] = dec(patch[key]);
    }
  }
  if (msg.g) for (const id of msg.g) delete mirror.players[id];

  mirror.projectiles = msg.pr.map(([id, kind, x, y, z, h]) => ({
    id, kind, x: dPos(x), y: dPos(y), z: dPos(z), heading: dAng(h),
  }));
  mirror.mines = msg.mn.map(([id, x, z, team, armed]) => ({
    id, x: dPos(x), z: dPos(z), team, armed: !!armed,
  }));
  mirror.pickupMask = msg.pu;
  return mirror;
}

export function blankPlayer(id) {
  return {
    id, x: 0, z: 0, h: 0, t: 0, s: 0, hp: 100,
    v: 'sampan', a: true, d: false, k: 0, de: 0, c: true,
  };
}

export function newBaseline() {
  return { players: {} };
}

/** Input packet — deliberately tiny, sent 30x a second. */
export function encodeInput(seq, input) {
  return {
    _: MSG.INPUT,
    q: seq,
    th: Math.round(input.throttle * 100),
    tu: Math.round(input.turn * 100),
    a: qAng(input.aim),
    f: input.fire ? 1 : 0,
    alt: input.alt ? 1 : 0,
  };
}

export function decodeInput(msg) {
  return {
    seq: msg.q,
    throttle: msg.th / 100,
    turn: msg.tu / 100,
    aim: dAng(msg.a),
    fire: !!msg.f,
    alt: !!msg.alt,
  };
}
