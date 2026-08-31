/**
 * MARITIME STRIKE — bootstrap, render loop and state machine.
 *
 * One binary, two roles. The host runs HostSim and is also a player; clients
 * send input and render snapshots. Everything below the networking boundary is
 * identical for both, which is why the game cannot tell whether it is running
 * on WebRTC or the WebSocket fallback.
 */

import * as THREE from 'three';
import { CFG, VESSELS, WEAPONS, TEAMS, makeRoomCode, randomNickname, PICKUP_LABEL } from './config.js';
import { createTransport, transportOptionsFromUrl, HOST_ID } from './net/transport.js';
import { MSG, EV, encodeSnapshot, encodeInput, decodeInput, newBaseline } from './net/protocol.js';
import { HostSim, PHASE } from './net/hostSim.js';
import { createTicker } from './net/ticker.js';
import { ClientSync } from './net/clientSync.js';
import { buildWorld, ZONES, lineBlocked } from './game/world.js';
import { Water, sampleWaveHeight, sampleWaveSlope } from './game/water.js';
import { buildVessel } from './game/vessels.js';
import { Effects } from './game/effects.js';
import { PickupField, MineField } from './game/pickups.js';
import { Controls, CameraRig } from './game/controls.js';
import { HUD } from './ui/hud.js';
import { LobbyUI } from './ui/lobby.js';
import { Audio } from './audio/audio.js';
import { Voice, PRIORITY, pickLine } from './audio/voice.js';

const HOST_PLAYER_ID = 'HOST';
const params = new URLSearchParams(location.search);

class Game {
  constructor() {
    this.role = null;              // 'host' | 'client'
    this.phase = PHASE.LOBBY;
    this.localId = null;
    this.roomCode = '';
    this.roster = {};              // id -> {name, team} learned from lobby messages
    this.vesselNodes = new Map();
    this.time = 0;
    this.inputSeq = 0;
    this.inputAccum = 0;
    this.snapAccum = 0;
    this.simAccum = 0;
    this.baselines = new Map();    // per-peer snapshot baseline
    this.quality = 'high';
    this.slowFrames = 0;
    this.spectateIndex = 0;
    this.myName = randomNickname();

    this.initRenderer();
    this.initScene();
    this.initUI();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------- rendering

  initRenderer() {
    this.canvas = document.getElementById('c');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  initScene() {
    this.scene = new THREE.Scene();
    // Fog colour and the sky dome's horizon band are deliberately identical, so
    // the ocean fades into the sky with no visible seam at the horizon.
    this.horizonColor = 0xc6e2ee;
    this.scene.fog = new THREE.Fog(this.horizonColor, 450, 1240);
    // One sun direction shared by the light, the sky and the water's specular,
    // so the highlight on the sea lines up with the sun you can actually see.
    this.sunDir = new THREE.Vector3(0.45, 0.62, 0.30).normalize();
    this.sky = buildSky(this.horizonColor, this.sunDir);
    this.scene.add(this.sky);

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.6, 3000);
    this.camera.position.set(0, 120, 260);

    // Tropical afternoon: one warm key light, cool sky bounce. Cheap and it
    // makes flat-shaded geometry read well.
    this.scene.add(new THREE.HemisphereLight(0xbfe4f5, 0x2a5a70, 1.05));
    const sun = new THREE.DirectionalLight(0xfff0d6, 1.45);
    sun.position.copy(this.sunDir).multiplyScalar(420);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    // A tight shadow cascade around the action — full-map shadows would be
    // both invisible and ruinously slow.
    const s = 130;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 700 });
    sun.shadow.bias = -0.0016;
    sun.shadow.camera.updateProjectionMatrix();
    this.sun = sun;
    this.scene.add(sun, sun.target);

    this.water = new Water(this.quality);
    this.water.uniforms.uSunDir.value.copy(this.sunDir);
    this.water.uniforms.uFogColor.value.setHex(this.horizonColor);
    this.water.uniforms.uFogNear.value = 450;
    this.water.uniforms.uFogFar.value = 1240;
    this.scene.add(this.water.mesh);
    this.world = buildWorld(this.quality);
    this.scene.add(this.world);

    this.effects = new Effects(this.scene, this.quality, this.camera);
    this.pickupField = new PickupField(this.scene);
    this.mineField = new MineField(this.scene);

    this.rig = new CameraRig(this.camera);
    this.controls = new Controls(this.canvas, this.camera);
  }

  initUI() {
    this.hud = new HUD(this.camera);
    this.audio = new Audio();
    this.voice = new Voice(this.audio);

    this.ui = new LobbyUI({
      onCreate: () => this.createGame(),
      onJoin: (code, name) => this.joinGame(code, name),
      onToggleReady: () => this.sendOrApply(MSG.SET_READY, { v: !this.meLobby()?.ready }),
      onSwitchTeam: () => {
        const me = this.meLobby();
        this.sendOrApply(MSG.SET_TEAM, { v: me && me.team === 'red' ? 'blue' : 'red' });
      },
      onSetName: (n) => { this.myName = n; this.sendOrApply(MSG.SET_NAME, { v: n }); },
      onStart: () => this.hostStart(),
      onPlayAgain: () => this.hostPlayAgain(),
      onKick: (id) => this.hostKick(id),
    });

    if (params.get('room')) {
      document.getElementById('in-code').value = params.get('room').toUpperCase();
      this.ui.show('join');
    }
    document.getElementById('in-name').value = this.myName;

    document.getElementById('btn-nettest').onclick = () => this.testConnection();

    const mute = document.getElementById('btn-mute');
    mute.onclick = () => this.toggleMute();
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') { e.preventDefault(); this.hud.showScoreboard(false); }
    });

    if (params.get('range') === '1') setTimeout(() => this.startRange(), 300);
  }

  onKeyDown(e) {
    if (e.code === 'Tab' && this.phase === PHASE.MATCH) {
      e.preventDefault();
      this.hud.showScoreboard(true, this.lastView, this.me()?.team);
    }
    if (e.code === 'KeyM' && this.phase === PHASE.MATCH) this.toggleMute();
    if (e.code === 'KeyV' && this.phase === PHASE.MATCH) this.toggleVoice();
    if (e.code === 'Space' && this.phase === PHASE.MATCH && this.me() && !this.me().a) {
      e.preventDefault();
      this.spectateIndex++;
    }
  }

  toggleMute() {
    this.audio.init();
    this.audio.setMuted(!this.audio.muted);
    this.voice.setMuted(this.audio.muted);
    document.getElementById('btn-mute').innerHTML = this.audio.muted ? '&#128263;' : '&#128266;';
    if (!this.audio.muted) {
      this.audio.startEngine();
      this.audio.startAmbience();
    } else {
      this.audio.stopAmbience();
    }
  }

  /** Voice has its own toggle: some people want the game audio but not the chatter. */
  toggleVoice() {
    this.voice.setEnabled(!this.voice.enabled);
    this.hud.toast('Ship comms', this.voice.enabled ? 'ON' : 'OFF', 1400);
  }

  /** Speak a line from the pool, if comms are up. */
  callout(key, opts = {}) {
    const text = pickLine(key);
    if (text) this.voice.say(key, text, opts);
  }

  /**
   * Report whether peer-to-peer play will work on this network, before the
   * session rather than during it.
   */
  async testConnection() {
    const btn = document.getElementById('btn-nettest');
    const out = document.getElementById('nettest-result');
    const opts = transportOptionsFromUrl();
    btn.disabled = true;
    out.style.color = '';
    out.textContent = 'Checking…';

    if (opts.mode === 'ws') {
      try {
        const t = await createTransport('ws', opts);
        await t.host('CONNTEST');
        t.close();
        out.style.color = '#6ff0a0';
        out.textContent = `Relay at ${opts.wsUrl} is reachable. You are good to go.`;
      } catch (e) {
        out.style.color = '#ff9a9a';
        out.textContent = `Relay not reachable: ${e.message}`;
      }
      btn.disabled = false;
      return;
    }

    const { probeSignalling } = await import('./net/webrtcTransport.js');
    const r = await probeSignalling();
    if (r.ok) {
      out.style.color = '#6ff0a0';
      out.textContent = 'Peer-to-peer signalling is reachable. This network should work.';
    } else {
      out.style.color = '#ff9a9a';
      out.textContent = `Peer-to-peer is blocked on this network (${r.reason}) `
        + '— run "npm start" on the host laptop and have everyone use the ?net=ws link instead.';
    }
    btn.disabled = false;
  }

  // ------------------------------------------------------------ networking

  async createGame() {
    this.ui.error('landing', '');
    this.ui.setBusy(true, 'Opening room…');
    const opts = transportOptionsFromUrl();
    this.roomCode = makeRoomCode();

    try {
      this.transport = await createTransport(opts.mode, opts);
      await this.transport.host(this.roomCode);
    } catch (err) {
      this.ui.setBusy(false);
      this.ui.error('landing', `${err.message} ${opts.mode === 'rtc' ? 'You can also run the local relay and add ?net=ws to the URL.' : ''}`);
      return;
    }

    this.role = 'host';
    this.localId = HOST_PLAYER_ID;
    this.sim = new HostSim();
    this.sim.addPlayer(HOST_PLAYER_ID, this.myName);
    this.bindTransport();
    this.startHostClock();

    this.ui.setBusy(false);
    this.ui.enterLobby(this.roomCode, this.localId, true);
    if (!HUD.tutorialSeen()) this.hud.showTutorial();
    this.broadcastLobby();
    this.audio.init();
  }

  async joinGame(code, name) {
    this.ui.error('join', '');
    this.myName = name || this.myName;
    const opts = transportOptionsFromUrl();

    document.getElementById('btn-join').disabled = true;
    try {
      this.transport = await createTransport(opts.mode, opts);
      await this.transport.join(code);
    } catch (err) {
      document.getElementById('btn-join').disabled = false;
      this.ui.error('join', err.message);
      return;
    }
    document.getElementById('btn-join').disabled = false;

    this.role = 'client';
    this.roomCode = code;
    this.bindTransport();
    this.transport.send(HOST_ID, { _: MSG.HELLO, name: this.myName }, true);
    this.audio.init();
  }

  bindTransport() {
    this.transport.on('data', (from, msg) => this.onData(from, msg));
    this.transport.on('peer:open', (id) => {
      if (this.role === 'host') this.broadcastLobby();
    });
    this.transport.on('peer:close', (id) => {
      if (this.role === 'host') {
        this.sim.removePlayer(id);
        this.baselines.delete(id);
        this.broadcastLobby();
        this.flushEvents();
      } else if (id === HOST_ID) {
        this.onHostLost();
      }
    });
    this.transport.on('error', (e) => console.warn('[net]', e));
  }

  onHostLost() {
    this.hud.hide();
    this.ui.hideAll();
    this.ui.show('landing');
    this.ui.error('landing', 'The host disconnected, so the match ended. Create or join a new game.');
    this.phase = PHASE.LOBBY;
    this.sync = null;
    this.clearVessels();
  }

  onData(from, msg) {
    if (this.role === 'host') this.onHostData(from, msg);
    else this.onClientData(msg);
  }

  onHostData(from, msg) {
    switch (msg._) {
      case MSG.HELLO: {
        const p = this.sim.addPlayer(from, msg.name);
        this.transport.send(from, { _: MSG.WELCOME, youId: from, room: this.roomCode, phase: this.sim.phase }, true);
        this.broadcastLobby();
        break;
      }
      case MSG.SET_NAME: this.sim.setName(from, msg.v); this.broadcastLobby(); break;
      case MSG.SET_TEAM: this.sim.setTeam(from, msg.v); this.broadcastLobby(); break;
      case MSG.SET_READY: this.sim.setReady(from, msg.v); this.broadcastLobby(); break;
      case MSG.INPUT: this.sim.applyInput(from, decodeInput(msg)); break;
      default: break;
    }
  }

  onClientData(msg) {
    switch (msg._) {
      case MSG.WELCOME:
        this.localId = msg.youId;
        this.roomCode = msg.room;
        this.sync = new ClientSync(this.localId);
        this.ui.enterLobby(this.roomCode, this.localId, false);
      if (!HUD.tutorialSeen()) this.hud.showTutorial();
        break;
      case MSG.LOBBY:
        for (const p of msg.players) this.roster[p.id] = { name: p.name, team: p.team };
        if (this.phase === PHASE.LOBBY || this.phase === PHASE.END) this.ui.render(msg);
        this.lastLobby = msg;
        break;
      case MSG.SNAPSHOT:
        if (this.sync) this.sync.onSnapshot(msg);
        break;
      case MSG.EVENT:
        for (const ev of msg.list) this.handleEvent(ev);
        break;
      case MSG.DENIED:
        this.transport.close();
        this.hud.hide();
        this.ui.hideAll();
        this.ui.show('landing');
        this.ui.error('landing', msg.reason === 'kicked'
          ? 'The host removed you from that room.'
          : 'The host closed the room.');
        this.phase = PHASE.LOBBY;
        this.sync = null;
        this.clearVessels();
        break;
      default: break;
    }
  }

  broadcastLobby() {
    if (this.role !== 'host') return;
    const state = this.sim.lobbyState(HOST_PLAYER_ID, this.transport.pings);
    this.transport.broadcast({ _: MSG.LOBBY, ...state }, true);
    this.lastLobby = state;
    for (const p of state.players) this.roster[p.id] = { name: p.name, team: p.team };
    if (this.phase === PHASE.LOBBY || this.phase === PHASE.END) this.ui.render(state);
  }

  flushEvents() {
    if (this.role !== 'host') return;
    const list = this.sim.drainEvents();
    if (!list.length) return;
    this.transport.broadcast({ _: MSG.EVENT, list }, true);
    for (const ev of list) this.handleEvent(ev);
  }

  sendOrApply(type, payload) {
    if (this.role === 'host') {
      if (type === MSG.SET_READY) this.sim.setReady(HOST_PLAYER_ID, payload.v);
      if (type === MSG.SET_TEAM) this.sim.setTeam(HOST_PLAYER_ID, payload.v);
      if (type === MSG.SET_NAME) this.sim.setName(HOST_PLAYER_ID, payload.v);
      this.broadcastLobby();
    } else if (this.transport) {
      this.transport.send(HOST_ID, { _: type, v: payload.v }, true);
    }
  }

  meLobby() {
    return this.lastLobby && this.lastLobby.players.find((p) => p.id === this.localId);
  }

  hostStart() { if (this.role === 'host' && this.sim.start()) this.flushEvents(); }
  hostPlayAgain() { if (this.role === 'host') { this.sim.returnToLobby(); this.flushEvents(); this.broadcastLobby(); } }
  hostKick(id) {
    if (this.role !== 'host') return;
    this.transport.send(id, { _: MSG.DENIED, reason: 'kicked' }, true);
    this.sim.removePlayer(id);
    this.baselines.delete(id);
    this.broadcastLobby();
  }

  // ------------------------------------------------------------ rehearsal

  /**
   * ?range=1 — solo free-roam with three stationary target hulks.
   * For rehearsing the demo and checking a laptop can run the game. There are
   * no AI opponents anywhere in an actual match.
   */
  startRange() {
    this.role = 'host';
    this.localId = HOST_PLAYER_ID;
    this.roomCode = 'RANGE';
    this.sim = new HostSim();
    this.transport = { pings: new Map(), broadcast() {}, send() {}, on() {}, mode: 'off', peers: new Map() };
    this.sim.addPlayer(HOST_PLAYER_ID, 'RANGE');
    this.sim.setReady(HOST_PLAYER_ID, true);

    for (let i = 0; i < 3; i++) {
      const t = this.sim.addPlayer(`TGT${i}`, `TARGET ${i + 1}`);
      t.team = this.sim.players[HOST_PLAYER_ID].team === 'red' ? 'blue' : 'red';
      t.ready = true;
    }
    this.startHostClock();
    this.sim.beginMatch();
    // Park the hulks in open water ahead of the spawn and leave them inert.
    const me = this.sim.players[HOST_PLAYER_ID];
    for (let i = 0; i < 3; i++) {
      const t = this.sim.players[`TGT${i}`];
      t.x = me.x + Math.sin(me.h) * (110 + i * 45) + (i - 1) * 55;
      t.z = me.z + Math.cos(me.h) * (110 + i * 45);
      t.isHulk = true;
    }
    this.ui.hideAll();
    this.enterMatch();
    this.hud.toast('Rehearsal range', 'Solo · three target hulks · no opponents');
  }

  // --------------------------------------------------------------- events

  handleEvent(ev) {
    switch (ev.type) {
      case EV.PHASE: this.onPhase(ev.phase); break;

      case EV.COUNTDOWN:
        if (ev.n >= 0) { this.hud.countdown(ev.n); this.audio.countdown(ev.n); }
        if (ev.n === 0) {
          this.callout('battleStations', { priority: PRIORITY.TACTICAL, cooldown: 30000 });
          this.callout('helmAhead', { cooldown: 60000 });
        }
        break;

      case EV.FIRE: {
        // Only your own vessel's weapons are worth a callout.
        if (ev.id === this.localId) {
          if (ev.weapon === 'missile') this.callout('missileAway', { cooldown: 14000 });
          else if (ev.weapon === 'torpedo') this.callout('torpedoAway', { cooldown: 14000 });
          else if (ev.weapon === 'mine') this.callout('minesLaid', { cooldown: 22000 });
        }
        if (ev.x === undefined) { this.audio.fire(ev.weapon); break; }
        const dist = this.distanceToLocal(ev.x, ev.z);
        if (dist < 460) {
          this.effects.muzzleFlash(ev.x, 2.0, ev.z, ev.weapon === 'missile' ? 2.2 : 1.0);
          if (dist < 300) this.audio.fire(ev.weapon);
        }
        break;
      }

      case EV.HIT: {
        if (ev.lock) { if (ev.target === this.localId) this.audio.lockWarning(); break; }
        const target = this.lastView && this.lastView.players[ev.target];
        const x = target ? target.x : ev.x;
        const z = target ? target.z : ev.z;
        this.hud.addDamage(x, 4, z, ev.amount, ev.crit, ev.target === this.localId);
        if (ev.by === this.localId || ev.target === this.localId) this.audio.hit(ev.crit);
        if (ev.target === this.localId) this.effects.shake = Math.min(1, this.effects.shake + (ev.crit ? 0.5 : 0.25));
        break;
      }

      case EV.KILL: {
        this.hud.addKill(ev);
        if (ev.killerId && ev.killerId === this.localId) {
          this.callout('kill', { priority: PRIORITY.TACTICAL, cooldown: 7000 });
        } else if (ev.victimId === this.localId) {
          this.callout('sunk', { priority: PRIORITY.URGENT, cooldown: 0 });
        } else if (this.me() && ev.team === this.me().team) {
          this.callout('mateLost', { cooldown: 16000 });
        }
        const victim = (this.lastView && this.lastView.players[ev.victimId]) || this.findByName(ev.victim);
        if (victim) {
          this.effects.explode(victim.x, 3, victim.z, 2.4);
          this.startSinking(ev.victimId || victim.id);
        }
        // Driven off the event, not off the render loop: a throttled or slow
        // frame must never leave the victim without the one piece of feedback
        // that explains why they have stopped responding to the controls.
        if (ev.victimId === this.localId) { this.iAmSunk = true; this.hud.setSunk(true); }
        if (ev.killerId && ev.killerId === this.localId) this.audio.kill();
        else this.audio.sink();
        break;
      }

      case EV.PICKUP: {
        this.effects.explode(ev.x, 2, ev.z, 0.9, true);
        if (ev.id === this.localId) {
          this.audio.pickup();
          this.hud.toast(`${PICKUP_LABEL[ev.kind]} acquired`, `Vessel upgraded: ${VESSELS[ev.vessel].short}`);
          this.callout('rearmed', { priority: PRIORITY.TACTICAL, cooldown: 12000 });
        }
        break;
      }

      case EV.MINE_BLOW: {
        const dist = this.distanceToLocal(ev.x, ev.z);
        if (dist < 520) {
          this.effects.explode(ev.x, ev.y || 1, ev.z, ev.small ? 0.5 : 1.6, ev.small);
          if (dist < 340 && !ev.small) this.audio.explosion(true);
        }
        break;
      }

      case EV.RESULT: this.onResult(ev); break;
      default: break;
    }
  }

  onPhase(phase) {
    this.phase = phase;
    if (phase === PHASE.COUNTDOWN) {
      this.ui.hideAll();
      this.enterMatch();
    } else if (phase === PHASE.MATCH) {
      this.controls.enabled = true;
      this.hud.hideCountdown();
      this.hud.hideTutorial();   // never leave a modal over a live match
    } else if (phase === PHASE.LOBBY) {
      this.hud.hide();
      this.controls.enabled = false;
      this.clearVessels();
      this.ui.show('lobby');
      if (this.lastLobby) this.ui.render(this.lastLobby);
    }
  }

  enterMatch() {
    this.hud.show(this.localId);
    this.controls.enabled = false;   // unlocked when the countdown ends
    this.hud.setSunk(false);
    this.iAmSunk = false;
    this.spectateIndex = 0;
    this.fireState = 0;
    this.contactSeenAt = 0;
    if (!this.audio.muted) { this.audio.startEngine(); this.audio.startAmbience(); }
  }

  onResult(result) {
    this.phase = PHASE.END;
    this.controls.enabled = false;
    this.hud.hide();
    const me = this.me();
    const won = !!(me && result.winner === me.team);
    this.audio.matchEnd(won);
    this.audio.setFireIntensity(0);
    this.callout(won ? 'victory' : 'defeat', { priority: PRIORITY.URGENT, cooldown: 0 });
    setTimeout(() => this.ui.showResult(result, me && me.team), 900);
  }

  // ----------------------------------------------------------- view helpers

  me() { return this.lastView ? this.lastView.players[this.localId] : null; }

  findByName(name) {
    if (!this.lastView) return null;
    for (const id in this.lastView.players) {
      if (this.lastView.players[id].name === name) return this.lastView.players[id];
    }
    return null;
  }

  distanceToLocal(x, z) {
    const me = this.me();
    if (!me) return 0;
    return Math.hypot(x - me.x, z - me.z);
  }

  /** Merge authoritative positions with the roster so names and teams exist. */
  buildView() {
    let view;
    if (this.role === 'host') {
      view = {
        players: this.sim.players,
        projectiles: this.sim.projectiles,
        mines: this.sim.mines,
        pickupMask: this.sim.pickups.map((p) => (p.active ? 1 : 0)).join(''),
        timeLeft: this.sim.timeLeft,
      };
    } else if (this.sync) {
      view = this.sync.sample();
      view.pickupMask = this.sync.mirror.pickupMask;
      view.timeLeft = this.sync.mirror.timeLeft;
      for (const id in view.players) {
        const r = this.roster[id];
        if (r) { view.players[id].name = r.name; view.players[id].team = r.team; }
      }
    } else {
      view = { players: {}, projectiles: [], mines: [], pickupMask: '', timeLeft: 0 };
    }
    this.lastView = view;
    return view;
  }

  // ------------------------------------------------------- vessel rendering

  clearVessels() {
    for (const node of this.vesselNodes.values()) this.scene.remove(node.group);
    this.vesselNodes.clear();
  }

  startSinking(id) {
    const node = this.vesselNodes.get(id);
    if (node && !node.sinking) { node.sinking = 0; }
  }

  syncVessels(view, dt) {
    const seen = new Set();

    for (const id in view.players) {
      const p = view.players[id];
      if (!p.team) continue;
      seen.add(id);

      let node = this.vesselNodes.get(id);
      if (!node || node.kind !== p.v || node.team !== p.team) {
        if (node) this.scene.remove(node.group);
        const group = buildVessel(p.v, TEAMS[p.team].color);
        this.scene.add(group);
        node = { group, kind: p.v, team: p.team, sinking: null, wakeDist: 0 };
        this.vesselNodes.set(id, node);
      }

      const g = node.group;

      // Sinking: list over, go under, then disappear.
      if (!p.a || p.hp <= 0) {
        if (node.sinking === null) node.sinking = 0;
        node.sinking += dt;
        const k = Math.min(1, node.sinking / 3.2);
        g.visible = k < 1;
        g.position.y = -k * VESSELS[p.v].length * 0.55;
        g.rotation.z = k * 1.15;
        g.rotation.x = k * 0.35;
        continue;
      }

      node.sinking = null;
      g.visible = true;
      g.rotation.z = 0;
      g.rotation.x = 0;

      const wave = sampleWaveHeight(p.x, p.z, this.time);
      const slope = sampleWaveSlope(p.x, p.z, this.time);
      const dive = p.d ? -VESSELS[p.v].beam * 0.85 : 0;

      g.position.set(p.x, wave + dive, p.z);
      g.rotation.y = p.h;
      // Pitch and roll off the wave slope, plus a bank into the turn.
      g.rotation.x = -(slope.dz * Math.cos(p.h) + slope.dx * Math.sin(p.h)) * 2.4;
      g.rotation.z = (slope.dx * Math.cos(p.h) - slope.dz * Math.sin(p.h)) * 2.4;

      if (g.userData.turret) {
        g.userData.turret.rotation.y = p.t - p.h;
      }
      for (const s of g.userData.spinners || []) if (s) s.rotation.y += dt * 1.6;

      // Submerged submarines fade rather than vanish, so a nearby enemy still
      // has a chance to spot one.
      const submerged = p.d;
      g.traverse((m) => {
        if (!m.isMesh) return;
        if (submerged) {
          if (!m.material.transparent) { m.material.transparent = true; }
          m.material.opacity = 0.22;
        } else if (m.material.transparent && m.material.opacity < 1 && !m.material.userData?.alwaysTransparent) {
          m.material.opacity = 1;
          m.material.transparent = false;
        }
      });

      // Burning hull. Emission is accumulated per vessel rather than spawned
      // every frame, so a burning ship costs the same on a 30fps laptop as on
      // a 144Hz one, and sixteen of them do not drown the particle pool.
      const hurt = 1 - Math.max(0, Math.min(1, p.hp / CFG.player.maxHp));
      if (hurt > 0.45 && !submerged) {
        const intensity = Math.min(1, (hurt - 0.45) / 0.55);
        node.fireAccum = (node.fireAccum || 0) + dt * (5 + intensity * 14);
        while (node.fireAccum >= 1) {
          node.fireAccum -= 1;
          this.effects.fireBurst(
            p.x, VESSELS[p.v].beam * 0.35 + 1.2, p.z,
            intensity, VESSELS[p.v].beam, p.h
          );
        }
      } else {
        node.fireAccum = 0;
      }

      // Wake foam, emitted per METRE travelled rather than per second. On a
      // timer, a faster vessel lays proportionally more foam, so doubling the
      // fleet's speed turned every wake into a solid white cloud.
      const speedFrac = Math.min(1, Math.abs(p.s) / (CFG.physics.baseSpeed * VESSELS[p.v].speed));
      node.wakeDist = (node.wakeDist || 0) + Math.abs(p.s) * dt;
      const wakeSpacing = Math.max(3.5, VESSELS[p.v].length * 0.34);
      if (!submerged && speedFrac > 0.12 && node.wakeDist > wakeSpacing) {
        node.wakeDist = 0;
        const back = VESSELS[p.v].length * 0.5;
        // Wake scales with the hull that made it — a sampan should not throw
        // the same wall of foam as a destroyer.
        const beam = VESSELS[p.v].beam;
        for (const side of [-1, 1]) {
          const ox = Math.sin(p.h + Math.PI / 2) * side * beam * 0.42;
          const oz = Math.cos(p.h + Math.PI / 2) * side * beam * 0.42;
          this.effects.wakePuff(
            p.x - Math.sin(p.h) * back + ox,
            p.z - Math.cos(p.h) * back + oz,
            beam * (0.26 + speedFrac * 0.30),
            0.10 + speedFrac * 0.20
          );
        }
      }
    }

    for (const [id, node] of this.vesselNodes) {
      if (!seen.has(id)) { this.scene.remove(node.group); this.vesselNodes.delete(id); }
    }
  }

  // -------------------------------------------------------------- main loop

  loop(nowMs) {
    requestAnimationFrame(this.loop);
    const now = nowMs / 1000;
    const dt = Math.min(0.05, this.lastFrame ? now - this.lastFrame : 0.016);
    this.lastFrame = now;
    this.time += dt;

    this.checkPerformance(dt);
    this.water.update(this.time);
    if (this.sky) this.sky.userData.material.uniforms.uTime.value = this.time;
    // Keep the ocean centred on the camera. Waves are computed from world
    // coordinates, so sliding the plane does not slide the swell — it just
    // guarantees the plane's edge is always past the fog, anywhere on the map,
    // without paying for a plane large enough to cover the whole arena.
    this.water.mesh.position.set(this.camera.position.x, 0, this.camera.position.z);
    if (this.world.userData.wheel) this.world.userData.wheel.userData.wheel.rotation.z += dt * 0.08;

    const view = this.buildView();
    const inMatch = this.phase === PHASE.MATCH || this.phase === PHASE.COUNTDOWN;

    if (inMatch) {
      // Always the merged view player: it carries the predicted position AND
      // the roster's name/team, which aim assist and friendly-fire need.
      const self = view.players[this.localId];
      const input = this.controls.sample(self, view.players);

      if (this.role === 'client' && this.sync) {
        this.sync.predict(input, dt);
        this.inputAccum += dt;
        if (this.inputAccum >= 1 / CFG.net.inputHz) {
          this.inputAccum = 0;
          this.transport.send(HOST_ID, encodeInput(++this.inputSeq, input), false);
        }
      } else if (this.role === 'host' && this.sim) {
        this.sim.applyInput(this.localId, { ...input, seq: ++this.inputSeq });
      }

      this.predictWeaponState(self, input, dt);
      this.updateMatchFrame(view, dt, input);
    } else {
      // Lobby and end screens get a slow orbit over the map as a backdrop.
      this.rig.orbit(this.time, ZONES[0], 340, 130);
    }

    this.effects.update(dt, this.time);
    this.effects.syncProjectiles(view.projectiles || []);
    this.pickupField.update(view.pickupMask, this.time);

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Local cooldown / overheat prediction for clients.
   *
   * The host owns the real values but never sends them — at 15Hz a cooldown bar
   * driven off the network would visibly lag the trigger. Since both sides use
   * the same constants, predicting locally is exact except under packet loss.
   */
  predictWeaponState(self, input, dt) {
    if (!self) return;
    if (this.role === 'host') return;   // host reads its own authoritative values

    if (this._cdVessel !== self.v) { this._cdVessel = self.v; this.predCd = 0; this.predHeat = 0; this.predLock = 0; }
    const weapon = WEAPONS[VESSELS[self.v].weapon];

    this.predCd = Math.max(0, (this.predCd || 0) - dt);
    this.predLock = Math.max(0, (this.predLock || 0) - dt);
    if (weapon.coolRate) this.predHeat = Math.max(0, (this.predHeat || 0) - weapon.coolRate * dt);

    const wantsFire = self.v === 'minelayer' ? (input.fire || input.alt) : input.fire;
    if (wantsFire && self.a && self.hp > 0 && !self.d && this.predCd <= 0 && this.predLock <= 0) {
      this.predCd = weapon.cooldown;
      if (weapon.heatPerShot) {
        this.predHeat = Math.min(1, (this.predHeat || 0) + weapon.heatPerShot);
        if (this.predHeat >= 1) this.predLock = weapon.overheatLock;
      }
    }

    self.cd = this.predCd;
    self.heat = this.predHeat || 0;
    self.lockedUntil = this.predLock || 0;
  }

  /**
   * Drive the authoritative simulation off a background-safe clock rather than
   * the render loop, so the match survives the host switching tabs.
   */
  startHostClock() {
    if (this.hostTicker) return;
    this.hostTicker = createTicker(1000 / CFG.net.simHz, () => {
      const now = performance.now() / 1000;
      const dt = Math.min(0.25, this.lastTickAt ? now - this.lastTickAt : 1 / CFG.net.simHz);
      this.lastTickAt = now;
      if (this.sim) this.stepHost(dt);
    });
    if (!this.hostTicker.backgroundSafe) {
      console.warn('[net] worker clock unavailable — keep this tab visible during the match');
    }
  }

  stepHost(dt) {
    // Fixed-step simulation, decoupled from the render rate so physics is the
    // same for a 144Hz gaming laptop and a 30fps corporate one.
    this.simAccum += dt;
    const step = 1 / CFG.net.simHz;
    let guard = 0;
    while (this.simAccum >= step && guard++ < 5) {
      this.simAccum -= step;
      this.sim.step(step);
    }
    this.flushEvents();

    const live = this.sim.phase === PHASE.MATCH || this.sim.phase === PHASE.COUNTDOWN;
    const wasLive = this._lastSimPhase === PHASE.MATCH || this._lastSimPhase === PHASE.COUNTDOWN;
    // The kill that ends a match lands in the same tick that stops the match, so
    // without this closing snapshot the final state — including the last
    // victim's own death — would never reach anybody.
    const closing = wasLive && !live;
    this._lastSimPhase = this.sim.phase;

    this.snapAccum += dt;
    if ((live && this.snapAccum >= 1 / CFG.net.snapHz) || closing) {
      this.snapAccum = 0;
      const state = this.sim.snapshotState();
      for (const peerId of this.transport.peers.keys()) {
        let base = this.baselines.get(peerId);
        if (!base) { base = newBaseline(); this.baselines.set(peerId, base); }
        this.transport.send(peerId, encodeSnapshot(state, base), false);
      }
    }
    // Paced off wall-clock, not this.time: the render loop may be throttled.
    const nowMs = performance.now();
    if (this.sim.phase === PHASE.LOBBY && nowMs - (this._lastLobbyPing || 0) > 2000) {
      this._lastLobbyPing = nowMs;
      this.broadcastLobby();   // refreshes the ping column
    }
  }

  updateMatchFrame(view, dt, input) {
    const self = view.players[this.localId];
    // `iAmSunk` is latched by the authoritative kill event. Without it, a frame
    // rendered from a snapshot older than your own death would clear the
    // overlay and leave you staring at unresponsive controls with no reason why.
    const alive = self && self.a && self.hp > 0 && !this.iAmSunk;

    this.syncVessels(view, dt);
    this.mineField.update(view.mines || [], self ? self.team : null,
      self || { x: 0, z: 0 }, this.time);

    // Camera: your own vessel while alive, a surviving teammate once sunk.
    let camTarget = self;
    if (!alive) {
      const mates = Object.values(view.players).filter(
        (p) => p.team === (self && self.team) && p.a && p.hp > 0 && p.id !== this.localId
      );
      if (mates.length) camTarget = mates[this.spectateIndex % mates.length];
      this.hud.setSunk(true, camTarget && camTarget !== self ? camTarget.name : null);
    } else {
      this.hud.setSunk(false);
    }

    if (camTarget) {
      this.rig.update(camTarget, this.controls.aimPoint, dt, this.effects.shake);
      this.sun.position.set(
        camTarget.x + this.sunDir.x * 420,
        this.sunDir.y * 420,
        camTarget.z + this.sunDir.z * 420
      );
      this.sun.target.position.set(camTarget.x, 0, camTarget.z);
      this.sun.target.updateMatrixWorld();
    }

    // Your own ship's condition: fire crackle plus escalating damage reports.
    if (alive) {
      const hurt = 1 - Math.max(0, Math.min(1, self.hp / CFG.player.maxHp));
      this.audio.setFireIntensity(hurt > 0.45 ? Math.min(1, (hurt - 0.45) / 0.55) : 0);

      // Fire once per threshold crossing, not continuously while below it.
      const state = self.hp <= 25 ? 3 : self.hp <= 45 ? 2 : self.hp <= 70 ? 1 : 0;
      if (state > (this.fireState || 0)) {
        if (state === 1) this.callout('hullBreach', { priority: PRIORITY.TACTICAL, cooldown: 20000 });
        if (state === 2) this.callout('onFire', { priority: PRIORITY.URGENT, cooldown: 18000 });
        if (state === 3) this.callout('criticalDamage', { priority: PRIORITY.URGENT, cooldown: 18000 });
      }
      this.fireState = state;

      this.checkContacts(view, self);

      // Last ship standing on your side — worth knowing without opening TAB.
      let mates = 0;
      for (const id in view.players) {
        const q = view.players[id];
        if (q.team === self.team && q.a && q.hp > 0 && id !== this.localId) mates++;
      }
      if (mates === 0 && (this._hadMates || false)) {
        this.callout('lastAfloat', { priority: PRIORITY.TACTICAL, cooldown: 60000 });
      }
      this._hadMates = mates > 0;
    } else {
      this.audio.setFireIntensity(0);
    }

    if (alive) {
      const frac = Math.min(1, Math.abs(self.s) / (CFG.physics.baseSpeed * VESSELS[self.v].speed));
      this.audio.updateEngine(frac);
      const nearest = MineField.nearestThreat(view.mines || [], self.team, self);
      if (nearest < WEAPONS.mine.revealRange) {
        this.audio.mineWarning(1 - nearest / WEAPONS.mine.revealRange);
        this.callout('minesNear', { priority: PRIORITY.URGENT, cooldown: 15000 });
      }
      this.hud.setZone(nearestZone(self.x, self.z));
    }

    const ping = this.transport
      ? (this.role === 'host'
        ? Math.round(avg([...this.transport.pings.values()]))
        : this.transport.pings.get(HOST_ID) || 0)
      : 0;

    const mousePx = {
      x: (this.controls.mouse.x * 0.5 + 0.5) * window.innerWidth,
      y: (-this.controls.mouse.y * 0.5 + 0.5) * window.innerHeight,
    };

    this.hud.update(view, self, { mode: this.transport ? this.transport.mode : 'off', ping }, dt,
      mousePx, this.controls.lockedTarget);
    if (this.hud.scoreboardOpen) this.hud.showScoreboard(true, view, self && self.team);
  }

  /**
   * Radar contact.
   *
   * Announces an enemy only when one is genuinely newly relevant: in range, in
   * line of sight, and not already called. Polled at 4Hz because the line-of-
   * sight test walks every obstacle and the answer does not change in 16ms.
   */
  checkContacts(view, self) {
    const now = performance.now();
    if (now - (this._contactCheckedAt || 0) < 250) return;
    this._contactCheckedAt = now;

    let nearest = Infinity;
    for (const id in view.players) {
      const e = view.players[id];
      if (!e.team || e.team === self.team || !e.a || e.hp <= 0 || e.d) continue;
      const d = Math.hypot(e.x - self.x, e.z - self.z);
      if (d > 320 || d >= nearest) continue;
      if (lineBlocked(self.x, self.z, e.x, e.z)) continue;
      nearest = d;
    }

    if (nearest === Infinity) {
      // Contact lost: re-arm so the next sighting is announced again.
      if (now - (this.contactSeenAt || 0) > 6000) this.contactHot = false;
      return;
    }
    this.contactSeenAt = now;
    if (this.contactHot) return;
    this.contactHot = true;
    this.callout(nearest < 110 ? 'enemyClose' : 'enemySighted',
      { priority: PRIORITY.TACTICAL, cooldown: 12000 });
  }

  /**
   * Automatic quality drop. A weak laptop should get a simpler game, never a
   * stuttering one — and never a surprise mid-demo.
   */
  checkPerformance(dt) {
    if (this.quality === 'low') return;
    if (this.time < 4) return;   // ignore load, shader compile and first world build
    if (dt * 1000 > CFG.perf.degradeFrameMs) this.slowFrames += dt * 1000;
    else this.slowFrames = Math.max(0, this.slowFrames - dt * 500);

    if (this.slowFrames > CFG.perf.degradeAfterMs) {
      this.quality = 'low';
      this.renderer.shadowMap.enabled = false;
      this.renderer.setPixelRatio(1);
      this.scene.fog.far = 900;
      console.info('[perf] dropped to low quality');
      if (this.hud) this.hud.toast('Graphics', 'Reduced for smoother play', 2600);
    }
  }
}

/**
 * Gradient sky dome with a sun and drifting cloud.
 *
 * Real geometry rather than a background texture, so the horizon band stays
 * locked to the true horizon as the camera moves — which is what lets the fog
 * and the ocean's reflection blend into it invisibly. The gradient function is
 * duplicated in the water shader deliberately; both must agree or the sea
 * reflects a sky that is not there.
 */
function buildSky(horizonHex, sunDir) {
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x2f7fb8) },
      uHorizon: { value: new THREE.Color(horizonHex) },
      uSunDir: { value: sunDir.clone().normalize() },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uSunDir;
      uniform float uTime;
      varying vec3 vPos;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        return noise(p) * 0.55 + noise(p * 2.03) * 0.28 + noise(p * 4.11) * 0.17;
      }

      void main() {
        vec3 dir = normalize(vPos);
        float h = clamp(dir.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uTop, pow(h, 0.55));

        vec3 sun = normalize(uSunDir);
        float d = max(dot(dir, sun), 0.0);
        // Broad atmospheric glow, then the disc itself.
        col += vec3(1.0, 0.86, 0.62) * pow(d, 90.0) * 0.55;
        col += vec3(1.0, 0.96, 0.88) * smoothstep(0.9985, 0.9995, d) * 2.2;

        // Cloud sheet, projected onto the dome and drifting. Faded out near the
        // horizon so it never forms a hard line against the sea.
        if (dir.y > 0.02) {
          vec2 uv = dir.xz / max(dir.y, 0.02) * 0.55 + vec2(uTime * 0.004, uTime * 0.002);
          float c = fbm(uv * 0.6);
          c = smoothstep(0.52, 0.78, c) * smoothstep(0.02, 0.30, dir.y);
          col = mix(col, vec3(1.0, 0.99, 0.97), c * 0.65);
          // A touch of sun on the cloud tops.
          col += vec3(1.0, 0.9, 0.75) * c * pow(d, 6.0) * 0.30;
        }

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 24, 14), m);
  sky.frustumCulled = false;
  sky.renderOrder = -2;
  sky.userData.material = m;
  return sky;
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

function nearestZone(x, z) {
  let best = null, bestD = 260;
  for (const zone of ZONES) {
    const d = Math.hypot(zone.x - x, zone.z - z);
    if (d < bestD) { bestD = d; best = zone; }
  }
  return best ? best.name : 'OPEN WATER';
}

window.addEventListener('error', (e) => console.error('[maritime-strike]', e.error || e.message));
// Exposed for the automated smoke tests in scripts/ and for live debugging
// from the console during a demo (`__game.lastView`).
window.__game = new Game();
