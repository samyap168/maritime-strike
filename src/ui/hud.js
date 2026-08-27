/**
 * In-match HUD, kill feed, scoreboard and all world-anchored overlays.
 *
 * Damage numbers, nameplates and HP bars are DOM elements projected from world
 * space rather than 3D sprites. That keeps text crisp at any resolution (it
 * matters on a projector), costs nothing on the GPU, and means restyling the
 * whole game's readability is a CSS edit.
 *
 * Everything here is pooled. Nothing is created or destroyed mid-match.
 */

import * as THREE from 'three';
import { VESSELS, WEAPONS, TEAMS } from '../config.js';
import { escapeHtml } from './lobby.js';

const $ = (id) => document.getElementById(id);

const WEAPON_LABEL = {
  rifle: 'RIFLE', autocannon: 'CANNON', missile: 'MISSILE',
  torpedo: 'TORPEDO', mine: 'MINE', disconnect: 'LEFT',
};

const ALT_HINT = {
  submarine: 'SHIFT dive (cannot fire while under)',
  minelayer: 'CLICK or SHIFT to lay a mine',
};

export class HUD {
  constructor(camera) {
    this.camera = camera;
    this.localId = null;
    this.feed = [];
    this.projected = new THREE.Vector3();
    this.scoreboardOpen = false;

    this.labelRoot = $('worldlabels');
    this.dmgPool = this._pool(48, 'wl dmg');
    this.platePool = this._pool(20, 'wl plate');

    this._buildReticle();

    // The tutorial is a full-screen modal, so while it is up it swallows every
    // click meant for the canvas. Make it trivially dismissable — a first-timer
    // who does not spot the button must never end up unable to shoot.
    $('btn-tut-ok').onclick = () => this.hideTutorial();
    $('tutorial').onclick = () => this.hideTutorial();
    window.addEventListener('keydown', () => {
      if (!$('tutorial').classList.contains('hidden')) this.hideTutorial();
    });
    this.fps = 60;
    this._frames = 0;
    this._fpsAt = performance.now();
  }

  _pool(n, className) {
    const items = [];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = className;
      el.style.display = 'none';
      this.labelRoot.appendChild(el);
      items.push({ el, active: false });
    }
    return { items, cursor: 0 };
  }

  _take(pool) {
    for (let i = 0; i < pool.items.length; i++) {
      const it = pool.items[(pool.cursor + i) % pool.items.length];
      if (!it.active) { pool.cursor = (pool.cursor + i + 1) % pool.items.length; it.active = true; it.el.style.display = ''; return it; }
    }
    const it = pool.items[pool.cursor];
    pool.cursor = (pool.cursor + 1) % pool.items.length;
    return it;
  }

  _buildReticle() {
    this.reticle = $('reticle-svg');
    this.reticle.innerHTML = `
      <g id="ret" transform="translate(-100,-100)">
        <circle r="15" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.4"/>
        <circle id="ret-lock" r="24" fill="none" stroke="#ff5a4d" stroke-width="1.8" opacity="0" stroke-dasharray="10 8"/>
        <line x1="-26" y1="0" x2="-9" y2="0" stroke="rgba(255,255,255,.75)" stroke-width="1.6"/>
        <line x1="9" y1="0" x2="26" y2="0" stroke="rgba(255,255,255,.75)" stroke-width="1.6"/>
        <line x1="0" y1="-26" x2="0" y2="-9" stroke="rgba(255,255,255,.75)" stroke-width="1.6"/>
        <line x1="0" y1="9" x2="0" y2="26" stroke="rgba(255,255,255,.75)" stroke-width="1.6"/>
        <circle r="1.8" fill="#fff"/>
      </g>`;
    this.retG = this.reticle.querySelector('#ret');
    this.retLock = this.reticle.querySelector('#ret-lock');
  }

  show(localId) {
    this.localId = localId;
    $('hud').classList.remove('hidden');
    this.reticle.classList.remove('hidden');
    $('btn-mute').classList.remove('hidden');
  }

  hide() {
    $('hud').classList.add('hidden');
    this.reticle.classList.add('hidden');
    $('sunk').classList.add('hidden');
    this.showScoreboard(false);
    for (const p of [this.dmgPool, this.platePool]) {
      for (const it of p.items) { it.active = false; it.el.style.display = 'none'; }
    }
  }

  // ------------------------------------------------------------ projection

  toScreen(x, y, z) {
    this.projected.set(x, y, z).project(this.camera);
    if (this.projected.z > 1) return null;   // behind the camera
    return {
      x: (this.projected.x * 0.5 + 0.5) * window.innerWidth,
      y: (-this.projected.y * 0.5 + 0.5) * window.innerHeight,
    };
  }

  // ------------------------------------------------------------ per-frame

  update(view, self, net, dt, mousePx, lockedTarget) {
    const now = performance.now();
    this._frames++;
    if (now - this._fpsAt > 500) {
      this.fps = Math.round((this._frames * 1000) / (now - this._fpsAt));
      this._frames = 0; this._fpsAt = now;
      $('net-fps').textContent = this.fps;
      $('net-fps').className = this.fps < 30 ? 'bad' : '';
    }

    // Score and survivors.
    const alive = { red: 0, blue: 0 };
    const sinks = { red: 0, blue: 0 };
    for (const id in view.players) {
      const p = view.players[id];
      if (!p.team) continue;
      if (p.a && p.hp > 0) alive[p.team]++;
      sinks[p.team] += p.k || 0;
    }
    $('score-red').textContent = sinks.red;
    $('score-blue').textContent = sinks.blue;
    $('alive-count').textContent = `${alive.red} v ${alive.blue} afloat`;

    const t = Math.max(0, view.timeLeft || 0);
    $('timer-val').textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    $('timer').classList.toggle('low', t < 30);

    $('net-mode').textContent = net.mode.toUpperCase();
    $('net-ping').textContent = net.ping ? `${net.ping}ms` : '--';
    $('net-ping').className = net.ping > 200 ? 'bad' : '';

    if (self) {
      const def = VESSELS[self.v];
      const weapon = WEAPONS[def.weapon];
      $('self-name').textContent = self.name || '';
      $('self-vessel').textContent = def.name;
      const pct = Math.max(0, Math.min(100, self.hp));
      const bar = $('self-hp');
      bar.firstElementChild.style.width = `${pct}%`;
      bar.lastElementChild.textContent = Math.round(self.hp);
      bar.className = `hpbar${pct <= 30 ? ' crit' : pct <= 60 ? ' hurt' : ''}`;

      $('weapon-name').textContent = weapon.name;
      $('alt-hint').textContent = ALT_HINT[self.v] || '';

      const cd = $('cooldown');
      const ready = 1 - Math.min(1, (self.cd || 0) / weapon.cooldown);
      const overheating = (self.heat || 0) > 0;
      cd.firstElementChild.style.width = `${(self.lockedUntil > 0 ? 1 - self.lockedUntil / weapon.overheatLock : ready) * 100}%`;
      cd.classList.toggle('hot', self.lockedUntil > 0 || (self.heat || 0) > 0.7);
      $('weapon-state').textContent = self.lockedUntil > 0 ? 'OVERHEATED'
        : self.d ? 'SUBMERGED — CANNOT FIRE'
        : overheating && self.heat > 0.7 ? 'BARRELS HOT'
        : '';
    }

    // Reticle follows the mouse; the ring closes when assist has a target.
    if (mousePx) {
      this.retG.setAttribute('transform', `translate(${mousePx.x},${mousePx.y})`);
      this.retLock.setAttribute('opacity', lockedTarget ? '0.95' : '0');
      if (lockedTarget) {
        const s = 1 + Math.sin(now / 90) * 0.08;
        this.retLock.setAttribute('r', String(20 * s));
      }
    }

    this.updatePlates(view, self);
    this.updateDamage(dt);
    this.updateFeed(now);
  }

  updatePlates(view, self) {
    let used = 0;
    const pool = this.platePool;
    for (const it of pool.items) it.active = false;

    for (const id in view.players) {
      const p = view.players[id];
      if (id === this.localId || !p.a || p.hp <= 0 || !p.team) continue;
      if (p.d) continue;                       // submerged subs show nothing

      const dist = self ? Math.hypot(p.x - self.x, p.z - self.z) : 0;
      if (dist > 340) continue;

      const enemy = self && p.team !== self.team;
      // Enemies only get a plate once damaged or close — otherwise the map
      // would be a wallhack.
      if (enemy && p.hp >= 100 && dist > 150) continue;
      if (used >= pool.items.length) break;

      const def = VESSELS[p.v];
      const pos = this.toScreen(p.x, def.length * 0.55 + 6, p.z);
      if (!pos) continue;

      const it = pool.items[used++];
      it.active = true;
      it.el.style.display = '';
      it.el.className = `wl plate ${p.team}${enemy ? ' enemy' : ''}`;
      it.el.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%,-50%)`;
      it.el.style.opacity = String(Math.max(0.25, 1 - dist / 380));
      it.el.innerHTML = `<div class="pn">${escapeHtml(p.name || '')}</div>` +
        (p.hp < 100 ? `<div class="pbar"><i style="width:${Math.max(0, p.hp)}%"></i></div>` : '');
    }

    for (const it of pool.items) if (!it.active) it.el.style.display = 'none';
  }

  /** Floating damage number, anchored in the world and drifting up as it fades. */
  addDamage(x, y, z, amount, crit, taken) {
    const it = this._take(this.dmgPool);
    it.el.className = `wl dmg${crit ? ' crit' : ''}${taken ? ' taken' : ''}`;
    it.el.textContent = crit ? `CRITICAL -${amount}` : `-${amount}`;
    it.world = { x: x + (Math.random() - 0.5) * 5, y: y + 3, z: z + (Math.random() - 0.5) * 5 };
    it.t = 0;
    it.life = crit ? 1.5 : 1.1;
  }

  updateDamage(dt) {
    for (const it of this.dmgPool.items) {
      if (!it.active) continue;
      it.t += dt;
      if (it.t >= it.life) { it.active = false; it.el.style.display = 'none'; continue; }
      it.world.y += dt * 7;
      const pos = this.toScreen(it.world.x, it.world.y, it.world.z);
      if (!pos) { it.el.style.display = 'none'; continue; }
      it.el.style.display = '';
      const k = it.t / it.life;
      it.el.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%,-50%) scale(${1 + (1 - k) * 0.25})`;
      it.el.style.opacity = String(1 - k * k);
    }
  }

  // -------------------------------------------------------------- kill feed

  addKill(ev) {
    const el = document.createElement('div');
    el.className = 'feed-row';
    const teamColor = ev.team === 'red' ? TEAMS.red.hex : TEAMS.blue.hex;
    const killerColor = ev.killerTeam === 'red' ? TEAMS.red.hex : TEAMS.blue.hex;
    el.style.setProperty('--k', teamColor);
    el.innerHTML = ev.killer
      ? `<span class="k" style="color:${killerColor}">${escapeHtml(ev.killer)}</span>
         <span class="w">${WEAPON_LABEL[ev.weapon] || 'SANK'}</span>
         <span class="v" style="color:${teamColor}">${escapeHtml(ev.victim)}</span>`
      : `<span class="v" style="color:${teamColor}">${escapeHtml(ev.victim)}</span>
         <span class="w">${WEAPON_LABEL[ev.weapon] || 'SUNK'}</span>`;

    $('feed').prepend(el);
    this.feed.push({ el, at: performance.now() });
    while (this.feed.length > 5) {
      const old = this.feed.shift();
      old.el.remove();
    }
  }

  updateFeed(now) {
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      const age = now - f.at;
      if (age > 6000 && !f.fading) { f.fading = true; f.el.classList.add('fading'); }
      if (age > 6600) { f.el.remove(); this.feed.splice(i, 1); }
    }
  }

  toast(line1, line2, ms = 2200) {
    const el = document.createElement('div');
    el.className = 'toast-item';
    el.innerHTML = `<div class="t1">${escapeHtml(line1)}</div><div class="t2">${escapeHtml(line2)}</div>`;
    $('toast').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .4s, transform .4s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-14px)';
      setTimeout(() => el.remove(), 420);
    }, ms);
  }

  // --------------------------------------------------------------- overlays

  countdown(n) {
    const el = $('countdown');
    el.classList.remove('hidden');
    el.innerHTML = `<span>${n > 0 ? n : 'ENGAGE'}</span>`;
    if (n <= 0) setTimeout(() => el.classList.add('hidden'), 900);
  }

  hideCountdown() { $('countdown').classList.add('hidden'); }

  setSunk(sunk, spectatingName) {
    $('sunk').classList.toggle('hidden', !sunk);
    if (sunk) {
      $('sunk-sub').textContent = spectatingName
        ? `Spectating ${spectatingName} · press SPACE to change`
        : 'Spectating · waiting for the next match';
    }
  }

  setZone(name) { $('zone').textContent = name || ''; }

  showTutorial() { $('tutorial').classList.remove('hidden'); }
  tutorialOpen() { return !$('tutorial').classList.contains('hidden'); }
  hideTutorial() {
    $('tutorial').classList.add('hidden');
    try { localStorage.setItem('ms_tutorial_seen', '1'); } catch { /* private mode */ }
  }
  static tutorialSeen() {
    try { return localStorage.getItem('ms_tutorial_seen') === '1'; } catch { return false; }
  }

  // ------------------------------------------------------------ scoreboard

  showScoreboard(open, view, localTeam) {
    this.scoreboardOpen = open;
    const el = $('scoreboard');
    el.classList.toggle('hidden', !open);
    if (!open || !view) return;

    const rows = Object.values(view.players)
      .filter((p) => p.team)
      .sort((a, b) => (b.k || 0) - (a.k || 0) || (a.de || 0) - (b.de || 0))
      .map((p) => {
        const status = !p.c ? '<span class="pill gone">Left</span>'
          : p.a && p.hp > 0 ? '<span class="pill alive">Afloat</span>'
          : '<span class="pill sunk">Sunk</span>';
        return `<tr class="${p.team}${p.a && p.hp > 0 ? '' : ' dead'}${p.id === this.localId ? ' me' : ''}">
          <td>${escapeHtml(p.name || '')}</td>
          <td style="color:var(--dim);text-transform:uppercase;font-size:12px">${VESSELS[p.v].short}</td>
          <td class="num">${p.k || 0}</td>
          <td class="num" style="color:var(--dim)">${p.de || 0}</td>
          <td>${status}</td>
        </tr>`;
      }).join('');

    const sinks = { red: 0, blue: 0 };
    for (const id in view.players) {
      const p = view.players[id];
      if (p.team) sinks[p.team] += p.k || 0;
    }

    el.innerHTML = `
      <div class="sb-head">
        <span class="r">RED ${sinks.red}</span><span class="d">&ndash;</span><span class="b">${sinks.blue} BLUE</span>
      </div>
      <table>
        <thead><tr><th>Player</th><th>Vessel</th><th>Sinks</th><th>Losses</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
}
