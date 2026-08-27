/**
 * Procedural audio. No sound files — every effect is synthesised at runtime,
 * so there is nothing extra to download and nothing that can 404.
 *
 * Deliberately muted until the player clicks. Fifteen laptops unmuting at once
 * in a meeting room is a way to lose a room in under a second.
 */

export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = true;
    this.ready = false;
    this.engine = null;
  }

  /** Must be called from a user gesture — browsers refuse audio otherwise. */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);

    // One noise buffer, reused by every percussive sound.
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.ready = true;
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.now || this.ctx.currentTime, 0.05);
  }

  get t() { return this.ctx ? this.ctx.currentTime : 0; }

  _noise(dur, freq, gain, q = 1, sweepTo = null, delay = 0) {
    if (!this.ready || this.muted) return;
    const t0 = this.t + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = freq;
    filt.Q.value = q;
    if (sweepTo) filt.frequency.exponentialRampToValueAtTime(Math.max(30, sweepTo), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /** Sustained crackle of a burning ship, tracked to how badly it is hurt. */
  setFireIntensity(level) {
    if (!this.ready) return;
    if (level <= 0) {
      if (this.fireLoop) {
        try { this.fireLoop.src.stop(); } catch { /* already stopped */ }
        this.fireLoop = null;
      }
      return;
    }
    if (!this.fireLoop) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = 620;
      filt.Q.value = 0.5;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      src.connect(filt).connect(g).connect(this.master);
      src.start();
      this.fireLoop = { src, g };
    }
    this.fireLoop.g.gain.setTargetAtTime(0.05 + level * 0.11, this.t, 0.3);
  }

  _tone(freq, dur, type = 'sine', gain = 0.2, sweepTo = null, delay = 0) {
    if (!this.ready || this.muted) return;
    const t0 = this.t + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // ------------------------------------------------------- battle ambience

  /**
   * A distant naval engagement, synthesised in three layers: a low swell, a
   * band of wind, and gunfire and shellbursts somewhere over the horizon.
   *
   * It has to sit UNDER the game, not compete with it — the point is that a
   * quiet moment still feels like a battle is happening elsewhere. Everything
   * here is deliberately low-gain; if you can pick it out consciously it is
   * already too loud for a room full of colleagues.
   */
  startAmbience() {
    if (!this.ready || this.ambience) return;
    const t = this.t;

    // Layer 1 — ocean swell: noise pushed through a low lowpass.
    const sea = this.ctx.createBufferSource();
    sea.buffer = this.noise;
    sea.loop = true;
    const seaFilter = this.ctx.createBiquadFilter();
    seaFilter.type = 'lowpass';
    seaFilter.frequency.value = 380;
    const seaGain = this.ctx.createGain();
    seaGain.gain.value = 0.055;
    sea.connect(seaFilter).connect(seaGain).connect(this.master);
    sea.start();

    // Layer 2 — wind, slowly breathing so the bed never sits still.
    const wind = this.ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const windFilter = this.ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 820;
    windFilter.Q.value = 0.7;
    const windGain = this.ctx.createGain();
    windGain.gain.value = 0.02;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.014;
    lfo.connect(lfoGain).connect(windGain.gain);
    lfo.start();
    wind.connect(windFilter).connect(windGain).connect(this.master);
    wind.start();

    this.ambience = { sea, wind, lfo, seaGain, windGain, timer: null };
    this._scheduleDistantBattle();
  }

  /** Gunfire and shellbursts from over the horizon, at irregular intervals. */
  _scheduleDistantBattle() {
    if (!this.ambience) return;
    const gap = 2600 + Math.random() * 6500;
    this.ambience.timer = setTimeout(() => {
      if (!this.ambience) return;
      if (!this.muted && this.ready) {
        const roll = Math.random();
        if (roll < 0.45) {
          // A distant shellburst: heavily filtered, so it reads as far away.
          this._noise(1.5, 150, 0.10, 0.4, 38);
          this._tone(46, 1.1, 'sine', 0.055, 24);
        } else if (roll < 0.8) {
          // A short salvo.
          const shots = 2 + Math.floor(Math.random() * 3);
          for (let i = 0; i < shots; i++) this._noise(0.22, 320, 0.045, 0.6, 110, i * 0.19);
        } else {
          // A ship's horn, far off.
          this._tone(112, 1.3, 'sawtooth', 0.035, 108);
          this._tone(168, 1.3, 'sine', 0.022, 164);
        }
      }
      this._scheduleDistantBattle();
    }, gap);
  }

  stopAmbience() {
    if (!this.ambience) return;
    clearTimeout(this.ambience.timer);
    for (const node of [this.ambience.sea, this.ambience.wind, this.ambience.lfo]) {
      try { node.stop(); } catch { /* already stopped */ }
    }
    this.ambience = null;
  }

  /** Squelch either side of a voice line, so it reads as a radio, not a robot. */
  radioClick(tail = false) {
    if (!this.ready || this.muted) return;
    this._noise(tail ? 0.09 : 0.05, tail ? 1500 : 2300, tail ? 0.09 : 0.13, 2.0, tail ? 700 : 1400);
    if (!tail) this._tone(1750, 0.035, 'square', 0.05);
  }

  // ---------------------------------------------------------- engine loop

  startEngine() {
    if (!this.ready || this.engine) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 55;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 220;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    osc.connect(filt).connect(g).connect(this.master);
    osc.start();

    // A layer of filtered noise reads as water rushing past the hull.
    const wash = this.ctx.createBufferSource();
    wash.buffer = this.noise;
    wash.loop = true;
    const wf = this.ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 700;
    wf.Q.value = 0.6;
    const wg = this.ctx.createGain();
    wg.gain.value = 0;
    wash.connect(wf).connect(wg).connect(this.master);
    wash.start();

    this.engine = { osc, filt, g, wg };
  }

  updateEngine(speedFrac) {
    if (!this.engine) return;
    const t = this.t;
    this.engine.osc.frequency.setTargetAtTime(48 + speedFrac * 70, t, 0.15);
    this.engine.filt.frequency.setTargetAtTime(200 + speedFrac * 620, t, 0.15);
    this.engine.g.gain.setTargetAtTime(0.05 + speedFrac * 0.10, t, 0.2);
    this.engine.wg.gain.setTargetAtTime(speedFrac * 0.05, t, 0.25);
  }

  stopEngine() {
    if (!this.engine) return;
    try { this.engine.osc.stop(); } catch { /* already stopped */ }
    this.engine = null;
    this.setFireIntensity(0);
  }

  // ------------------------------------------------------------- one-shots

  fire(weapon) {
    switch (weapon) {
      case 'rifle':      this._noise(0.09, 1500, 0.25, 1.2, 500); this._tone(180, 0.07, 'square', 0.10, 70); break;
      case 'autocannon': this._noise(0.055, 2100, 0.18, 1.6, 700); break;
      case 'missile':    this._noise(0.7, 500, 0.32, 0.8, 2400); this._tone(90, 0.55, 'sawtooth', 0.18, 320); break;
      case 'torpedo':    this._noise(0.5, 320, 0.24, 0.9, 900); this._tone(140, 0.35, 'sine', 0.14, 60); break;
      case 'mine':       this._tone(300, 0.12, 'triangle', 0.16, 160); this._noise(0.2, 400, 0.14, 1.0, 180); break;
      default: break;
    }
  }

  explosion(big = true) {
    this._noise(big ? 0.85 : 0.22, big ? 260 : 900, big ? 0.5 : 0.2, 0.55, big ? 45 : 260);
    if (big) this._tone(70, 0.5, 'sine', 0.28, 26);
  }

  hit(crit) {
    this._tone(crit ? 900 : 640, crit ? 0.13 : 0.07, 'square', crit ? 0.22 : 0.13, crit ? 1500 : 820);
    if (crit) this._tone(1400, 0.16, 'triangle', 0.16, 2200, 0.03);
  }

  pickup() {
    this._tone(520, 0.1, 'triangle', 0.2, 660);
    this._tone(780, 0.14, 'triangle', 0.2, 1040, 0.08);
    this._tone(1040, 0.2, 'sine', 0.16, 1300, 0.16);
  }

  sink() {
    this.explosion(true);
    this._tone(220, 1.5, 'sine', 0.24, 40, 0.15);
    this._noise(1.6, 600, 0.22, 0.6, 90);
  }

  kill() { this._tone(880, 0.09, 'square', 0.2, 1180); this._tone(1180, 0.12, 'square', 0.18, 1600, 0.07); }

  countdown(n) {
    if (n > 0) this._tone(440, 0.16, 'triangle', 0.26, 440);
    else { this._tone(660, 0.5, 'sawtooth', 0.3, 880); this._noise(0.6, 700, 0.2, 0.7, 200); }
  }

  matchEnd(won) {
    const notes = won ? [523, 659, 784, 1047] : [523, 440, 349, 262];
    notes.forEach((f, i) => this._tone(f, 0.42, 'triangle', 0.24, f, i * 0.17));
  }

  /** Rising proximity tone as you close on an enemy mine. */
  mineWarning(closeness) {
    const now = performance.now();
    const gap = 900 - closeness * 700;
    if (now - (this._lastMineBeep || 0) < gap) return;
    this._lastMineBeep = now;
    this._tone(700 + closeness * 500, 0.07, 'square', 0.10 + closeness * 0.08);
  }

  lockWarning() { this._tone(1200, 0.06, 'square', 0.12); }
  collide() { this._noise(0.18, 220, 0.22, 0.8, 90); }
}
