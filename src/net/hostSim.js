/**
 * The authoritative simulation. Runs on exactly one machine: the host.
 *
 * Clients send inputs and render snapshots; they never decide anything that
 * matters. Damage, pickups, deaths and score are all resolved here, so a
 * modified client cannot claim a kill it did not earn.
 */

import { CFG, VESSELS, WEAPONS, PICKUP_TO_VESSEL, TEAMS } from '../config.js';
import { PICKUP_SPOTS, spawnFor, lineBlocked } from '../game/world.js';
import { stepVessel } from '../game/movement.js';
import {
  createProjectile, stepProjectile, rollDamage, splashTargets,
  createMine, stepMine, muzzleOffset,
} from '../game/weapons.js';
import { EV } from './protocol.js';
import { createBotState, stepBot, botName } from '../game/bots.js';

export const PHASE = { LOBBY: 'lobby', COUNTDOWN: 'countdown', MATCH: 'match', END: 'end' };

export class HostSim {
  constructor() {
    this.phase = PHASE.LOBBY;
    this.tick = 0;
    this.timeLeft = CFG.match.duration;
    this.countdown = 0;
    this.players = {};
    this.projectiles = [];
    this.mines = [];
    this.pickups = PICKUP_SPOTS.map((s, i) => ({
      id: i, kind: s.kind, x: s.x, z: s.z, active: true, respawnIn: 0,
    }));
    this.events = [];
    this.result = null;
  }

  // ------------------------------------------------------------------ lobby

  /**
   * Add a bot. It is a normal player with a brain attached — same struct, same
   * physics, same weapon rules — so nothing downstream needs to know.
   */
  addBot(skill = 'normal', team = null) {
    const id = `BOT${this.nextBotId = (this.nextBotId || 0) + 1}`;
    const p = this.addPlayer(id, botName());
    p.bot = createBotState(skill);
    p.ready = true;
    if (team) p.team = team;
    return p;
  }

  removeBot() {
    const ids = Object.keys(this.players).filter((id) => this.players[id].bot);
    if (!ids.length) return false;
    // Drop from the larger side so removing one does not unbalance the match.
    const counts = this.teamCounts();
    const heavier = counts.red >= counts.blue ? 'red' : 'blue';
    const pick = ids.find((id) => this.players[id].team === heavier) || ids[ids.length - 1];
    delete this.players[pick];
    return true;
  }

  botCount() {
    return Object.keys(this.players).filter((id) => this.players[id].bot).length;
  }

  addPlayer(id, name) {
    if (this.players[id]) { this.players[id].c = true; return this.players[id]; }
    // Keep teams balanced on join; ties break randomly so it is not always red.
    const counts = this.teamCounts();
    let team;
    if (counts.red < counts.blue) team = 'red';
    else if (counts.blue < counts.red) team = 'blue';
    else team = Math.random() < 0.5 ? 'red' : 'blue';

    const p = {
      id, name: this.uniqueName(name, id), team, ready: false,
      x: 0, z: 0, h: 0, t: 0, s: 0, hp: CFG.player.maxHp,
      v: 'sampan', a: false, d: false, k: 0, de: 0, c: true,
      cd: 0, heat: 0, lockedUntil: 0, liveMines: 0,
      input: { throttle: 0, turn: 0, aim: 0, fire: false, alt: false },
      lastSeq: 0, spectating: null,
    };
    this.players[id] = p;
    return p;
  }

  removePlayer(id) {
    const p = this.players[id];
    if (!p) return;
    if (this.phase === PHASE.MATCH && p.a) {
      // Leaving mid-match counts as being out, or the enemy team can never win.
      p.a = false;
      p.hp = 0;
      p.c = false;
      this.pushEvent(EV.KILL, { killer: null, victim: p.name, victimId: p.id, team: p.team, weapon: 'disconnect' });
      this.checkWin();
    } else {
      delete this.players[id];
    }
  }

  teamCounts() {
    const c = { red: 0, blue: 0 };
    for (const id in this.players) if (this.players[id].c) c[this.players[id].team]++;
    return c;
  }

  setName(id, name) {
    const p = this.players[id];
    if (p) p.name = this.uniqueName(name, id);
  }

  /**
   * Names must be unique. The random pool is only twenty callsigns, so with a
   * full room a collision is close to certain — and two MARINAGHOSTs in the kill
   * feed makes the scoreboard useless for the people it exists to serve.
   */
  uniqueName(raw, ownerId) {
    const base = sanitizeName(raw);
    const taken = new Set(
      Object.values(this.players).filter((p) => p.id !== ownerId).map((p) => p.name)
    );
    if (!taken.has(base)) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base.slice(0, 10)}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }

  setTeam(id, team) {
    const p = this.players[id];
    if (!p || this.phase !== PHASE.LOBBY || !TEAMS[team] || p.team === team) return;
    const c = this.teamCounts();
    // Block a switch that would unbalance by more than one.
    if (c[team] + 1 - (c[p.team] - 1) > 1) return;
    p.team = team;
    p.ready = false;
  }

  setReady(id, ready) { const p = this.players[id]; if (p) p.ready = !!ready; }

  /** Why the host cannot start yet, or null if they can. */
  startBlocker() {
    const ids = Object.keys(this.players).filter((id) => this.players[id].c);
    if (ids.length < CFG.match.minPlayers) return `Need at least ${CFG.match.minPlayers} players`;
    if (!ids.some((id) => !this.players[id].bot)) return 'Need at least one human';
    const notReady = ids.filter((id) => !this.players[id].ready && !this.players[id].bot).length;
    if (notReady > 0) return `${notReady} player${notReady > 1 ? 's' : ''} not ready`;
    const c = this.teamCounts();
    if (Math.abs(c.red - c.blue) > 1) return 'Teams are unbalanced';
    if (c.red === 0 || c.blue === 0) return 'Both teams need a player';
    return null;
  }

  start() {
    if (this.startBlocker()) return false;
    this.phase = PHASE.COUNTDOWN;
    this.countdown = CFG.match.countdown + 1;
    this.pushEvent(EV.PHASE, { phase: this.phase });
    return true;
  }

  beginMatch() {
    this.phase = PHASE.MATCH;
    this.timeLeft = CFG.match.duration;
    this.projectiles.length = 0;
    this.mines.length = 0;
    this.result = null;
    for (const p of this.pickups) { p.active = true; p.respawnIn = 0; }

    const index = { red: 0, blue: 0 };
    for (const id in this.players) {
      const p = this.players[id];
      const spot = spawnFor(p.team, index[p.team]++);
      Object.assign(p, {
        x: spot.x, z: spot.z, h: spot.heading, t: spot.heading, s: 0,
        hp: CFG.player.maxHp, v: 'sampan', a: p.c, d: false,
        k: 0, de: 0, cd: 0, heat: 0, liveMines: 0, spectating: null,
      });
    }
    this.pushEvent(EV.PHASE, { phase: this.phase });
  }

  returnToLobby() {
    this.phase = PHASE.LOBBY;
    this.projectiles.length = 0;
    this.mines.length = 0;
    this.result = null;
    for (const id in this.players) {
      const p = this.players[id];
      if (!p.c) { delete this.players[id]; continue; }
      p.ready = !!p.bot;
      p.a = false;
      p.v = 'sampan';
      p.hp = CFG.player.maxHp;
      if (p.bot) p.bot = createBotState(p.bot.skillName || 'normal');
    }
    this.pushEvent(EV.PHASE, { phase: this.phase });
  }

  // ------------------------------------------------------------------ input

  applyInput(id, input) {
    const p = this.players[id];
    if (!p || !p.a) return;
    if (input.seq <= p.lastSeq) return;   // stale or duplicated packet
    p.lastSeq = input.seq;
    p.input.throttle = Math.max(-1, Math.min(1, input.throttle));
    p.input.turn = Math.max(-1, Math.min(1, input.turn));
    p.input.aim = input.aim;
    p.input.fire = input.fire;
    p.input.alt = input.alt;
  }

  // -------------------------------------------------------------------- tick

  step(dt) {
    this.tick++;

    if (this.phase === PHASE.COUNTDOWN) {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown);
      if (n !== this._lastCount) { this._lastCount = n; this.pushEvent(EV.COUNTDOWN, { n }); }
      if (this.countdown <= 0) this.beginMatch();
      return;
    }

    if (this.phase !== PHASE.MATCH) return;

    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; this.endMatch('time'); return; }

    this.stepPlayers(dt);
    this.stepProjectiles(dt);
    this.stepMines(dt);
    this.stepPickups(dt);
  }

  stepPlayers(dt) {
    for (const id in this.players) {
      const p = this.players[id];
      if (!p.a) continue;

      // Bots produce the same input a client would send, so everything below
      // this line — movement, firing, cooldowns — is identical for both.
      if (p.bot) {
        const input = stepBot(p.bot, p, this.players, this.mines, this.pickups, dt);
        p.input.throttle = Math.max(-1, Math.min(1, input.throttle));
        p.input.turn = Math.max(-1, Math.min(1, input.turn));
        p.input.aim = input.aim;
        p.input.fire = input.fire;
        p.input.alt = input.alt;
      }

      // Submarine dive is a hold, and only the submarine has it.
      p.d = p.v === 'submarine' && p.input.alt;

      stepVessel(p, p.input, dt);
      p.t = p.input.aim;

      p.cd = Math.max(0, p.cd - dt);
      const w = WEAPONS[VESSELS[p.v].weapon];
      if (w.coolRate) p.heat = Math.max(0, p.heat - w.coolRate * dt);
      if (p.lockedUntil > 0) p.lockedUntil = Math.max(0, p.lockedUntil - dt);

      const wantsFire = p.v === 'minelayer' ? (p.input.fire || p.input.alt) : p.input.fire;
      if (wantsFire) this.tryFire(p);
    }
  }

  tryFire(p) {
    const weaponId = VESSELS[p.v].weapon;
    const w = WEAPONS[weaponId];
    if (p.cd > 0 || p.lockedUntil > 0) return;
    if (p.d) return;                       // cannot shoot while submerged

    if (weaponId === 'mine') {
      if (p.liveMines >= w.maxLive) return;
      // Mines drop off the stern, behind the vessel that laid them.
      const back = VESSELS[p.v].length * 0.55;
      this.mines.push(createMine(p.id, p.team, p.x - Math.sin(p.h) * back, p.z - Math.cos(p.h) * back));
      p.liveMines++;
      p.cd = w.cooldown;
      this.pushEvent(EV.FIRE, { id: p.id, weapon: weaponId });
      return;
    }

    if (w.heatPerShot) {
      p.heat += w.heatPerShot;
      if (p.heat >= 1) { p.heat = 1; p.lockedUntil = w.overheatLock; }
    }

    const off = muzzleOffset(p.v);
    const x = p.x + Math.sin(p.t) * off.forward;
    const z = p.z + Math.cos(p.t) * off.forward;
    const target = weaponId === 'missile' ? this.softLock(p) : null;
    this.projectiles.push(createProjectile(weaponId, p.id, p.team, x, off.height, z, p.t, target));
    p.cd = w.cooldown;
    this.pushEvent(EV.FIRE, { id: p.id, weapon: weaponId, x, z, h: p.t });
  }

  /** Nearest enemy roughly ahead and in line of sight — the missile's soft lock. */
  softLock(p) {
    let best = null, bestScore = Infinity;
    for (const id in this.players) {
      const t = this.players[id];
      if (!t.a || t.team === p.team || t.hp <= 0 || t.d) continue;
      const dx = t.x - p.x, dz = t.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > WEAPONS.missile.range) continue;
      const ang = Math.abs(((Math.atan2(dx, dz) - p.t + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (ang > 0.55) continue;
      if (lineBlocked(p.x, p.z, t.x, t.z)) continue;
      const score = dist * (1 + ang);
      if (score < bestScore) { bestScore = score; best = id; }
    }
    if (best) this.pushEvent(EV.HIT, { lock: true, target: best });
    return best;
  }

  stepProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      const out = stepProjectile(pr, dt, this.players);
      if (!out) continue;

      this.projectiles.splice(i, 1);
      const w = WEAPONS[pr.kind];

      if (out.type === 'hit') {
        const { damage, crit } = rollDamage(w.damage);
        this.damage(out.targetId, damage, crit, pr.owner, pr.kind, pr.x, pr.z);
      }
      if (out.type !== 'expired' || pr.kind === 'missile') {
        this.pushEvent(EV.MINE_BLOW, { x: pr.x, y: pr.y, z: pr.z, kind: pr.kind, small: pr.kind === 'bullet' });
      }
      // Splash damage lands on everyone nearby, hit or miss.
      if (w.splash) {
        for (const s of splashTargets(pr.x, pr.z, w.splashRadius, pr.team, this.players)) {
          if (out.type === 'hit' && s.id === out.targetId) continue;
          const { damage, crit } = rollDamage(w.splash * s.falloff);
          if (damage > 0) this.damage(s.id, damage, crit, pr.owner, pr.kind, pr.x, pr.z);
        }
      }
    }
  }

  stepMines(dt) {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      const victim = stepMine(m, dt, this.players);
      if (victim || m.life <= 0) {
        this.mines.splice(i, 1);
        const owner = this.players[m.owner];
        if (owner) owner.liveMines = Math.max(0, owner.liveMines - 1);
        if (victim) {
          const { damage, crit } = rollDamage(WEAPONS.mine.damage);
          this.damage(victim, damage, crit, m.owner, 'mine', m.x, m.z);
          this.pushEvent(EV.MINE_BLOW, { x: m.x, y: 0.5, z: m.z, kind: 'mine' });
        }
      }
    }
  }

  stepPickups(dt) {
    for (const pu of this.pickups) {
      if (!pu.active) {
        pu.respawnIn -= dt;
        if (pu.respawnIn <= 0) pu.active = true;
        continue;
      }
      for (const id in this.players) {
        const p = this.players[id];
        if (!p.a || p.hp <= 0) continue;
        const dx = p.x - pu.x, dz = p.z - pu.z;
        const reach = 11 + VESSELS[p.v].radius;
        if (dx * dx + dz * dz > reach * reach) continue;

        const vessel = PICKUP_TO_VESSEL[pu.kind];
        if (p.v === vessel) continue;      // no point collecting what you already are

        p.v = vessel;
        p.cd = 0.6;                        // brief beat so the transform reads
        p.heat = 0;
        p.liveMines = 0;
        p.d = false;
        pu.active = false;
        pu.respawnIn = 25;
        this.pushEvent(EV.PICKUP, { id, kind: pu.kind, vessel, x: pu.x, z: pu.z, name: p.name });
        break;
      }
    }
  }

  // ---------------------------------------------------------------- outcomes

  damage(targetId, amount, crit, attackerId, weapon, x, z) {
    const t = this.players[targetId];
    if (!t || !t.a || t.hp <= 0) return;
    t.hp = Math.max(0, t.hp - amount);
    this.pushEvent(EV.HIT, { target: targetId, by: attackerId, amount, crit, x: x ?? t.x, z: z ?? t.z });

    if (t.hp > 0) return;

    t.a = false;
    t.de++;
    const killer = this.players[attackerId];
    if (killer && killer.team !== t.team) killer.k++;
    this.pushEvent(EV.KILL, {
      killer: killer ? killer.name : null,
      killerId: killer ? killer.id : null,
      killerTeam: killer ? killer.team : null,
      victim: t.name, victimId: t.id, team: t.team, weapon,
    });
    this.checkWin();
  }

  checkWin() {
    const alive = { red: 0, blue: 0 };
    for (const id in this.players) {
      const p = this.players[id];
      if (p.a && p.hp > 0) alive[p.team]++;
    }
    if (alive.red === 0 && alive.blue === 0) this.endMatch('draw');
    else if (alive.red === 0) this.endMatch('blue');
    else if (alive.blue === 0) this.endMatch('red');
  }

  endMatch(reason) {
    if (this.phase === PHASE.END) return;
    this.phase = PHASE.END;

    const score = { red: 0, blue: 0 };
    const board = [];
    for (const id in this.players) {
      const p = this.players[id];
      score[p.team] += p.k;
      board.push({ id, name: p.name, team: p.team, sinks: p.k, deaths: p.de, vessel: p.v, alive: p.a });
    }
    board.sort((a, b) => b.sinks - a.sinks || a.deaths - b.deaths);

    let winner = reason;
    if (reason === 'time') {
      winner = score.red > score.blue ? 'red' : score.blue > score.red ? 'blue' : 'draw';
      if (winner === 'draw') {
        // Tie on sinks: fewest losses takes it.
        const lost = { red: 0, blue: 0 };
        for (const b of board) if (!b.alive) lost[b.team]++;
        winner = lost.red < lost.blue ? 'red' : lost.blue < lost.red ? 'blue' : 'draw';
      }
    }

    this.result = { winner, reason, score, board, mvp: board[0] || null };
    this.pushEvent(EV.RESULT, this.result);
    this.pushEvent(EV.PHASE, { phase: this.phase });
  }

  // ------------------------------------------------------------------ output

  pushEvent(type, data) { this.events.push({ type, ...data }); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  /** The shape encodeSnapshot() expects. */
  snapshotState() {
    return {
      tick: this.tick,
      timeLeft: this.timeLeft,
      players: this.players,
      projectiles: this.projectiles,
      mines: this.mines,
      pickups: this.pickups,
    };
  }

  /** Full lobby view — small, so it is just sent whole whenever it changes. */
  lobbyState(hostId, pings) {
    const players = Object.values(this.players).map((p) => ({
      id: p.id, name: p.name, team: p.team, ready: p.ready,
      connected: p.c, ping: pings.get(p.id) || 0, isHost: p.id === hostId,
      bot: !!p.bot,
    }));
    return { players, blocker: this.startBlocker(), phase: this.phase };
  }
}

function sanitizeName(name) {
  return String(name || 'PLAYER').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 12).toUpperCase() || 'PLAYER';
}
