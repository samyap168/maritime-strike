/**
 * Ship's comms.
 *
 * Voice lines use the browser's built-in speech synthesis rather than audio
 * files, for the same reason every asset in this game is procedural: there is
 * nothing to download, nothing to 404, and it works on a laptop with no
 * internet. A procedural radio click and squelch either side of each line does
 * most of the work of making it read as a bridge intercom rather than a screen
 * reader.
 *
 * The hard constraint is that this must never become annoying. Fifteen people
 * in a meeting room will forgive a missed callout; they will not forgive a
 * vessel that talks over itself continuously. Hence: a per-line cooldown, a
 * global minimum gap, a queue that drops rather than backs up, and priority so
 * "you are on fire" always beats "nice shot".
 */

const MIN_GAP_MS = 1400;      // never two lines closer than this
const QUEUE_MAX = 2;          // beyond this, drop rather than back up

export const PRIORITY = { CHATTER: 1, TACTICAL: 2, URGENT: 3 };

export class Voice {
  constructor(audio) {
    this.audio = audio;
    this.muted = true;
    this.enabled = true;
    this.synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    this.supported = !!(this.synth && typeof window.SpeechSynthesisUtterance === 'function');
    this.lastSaidAt = new Map();
    this.lastAnyAt = 0;
    this.queue = [];
    this.speaking = false;
    this.voice = null;

    if (this.supported) {
      const pick = () => { this.voice = this._pickVoice(); };
      pick();
      // Chrome populates the voice list asynchronously.
      if (this.synth.addEventListener) this.synth.addEventListener('voiceschanged', pick);
    }
  }

  /** Prefer a clear English voice; fall back to whatever exists. */
  _pickVoice() {
    let voices = [];
    try { voices = this.synth.getVoices() || []; } catch { return null; }
    if (!voices.length) return null;
    const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang || ''));
    const pool = en.length ? en : voices;
    // A male-ish default reads more like a bridge officer, but never insist.
    return pool.find((v) => /daniel|google uk english male|male/i.test(v.name)) || pool[0];
  }

  setMuted(muted) {
    this.muted = muted;
    if (muted) this.stop();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stop();
  }

  stop() {
    this.queue.length = 0;
    this.speaking = false;
    try { this.synth && this.synth.cancel(); } catch { /* nothing queued */ }
  }

  /**
   * Speak a line.
   * `key` is what the cooldown is tracked against, so several phrasings of the
   * same event share one cooldown.
   */
  say(key, text, opts = {}) {
    if (!this.supported || this.muted || !this.enabled || !text) return false;

    const {
      cooldown = 9000,
      priority = PRIORITY.CHATTER,
      rate = 1.05,
      pitch = 0.85,
    } = opts;

    const now = performance.now();
    if (now - (this.lastSaidAt.get(key) || -1e9) < cooldown) return false;

    // Under load, keep only what matters. Urgent lines evict chatter.
    if (this.speaking || now - this.lastAnyAt < MIN_GAP_MS) {
      if (priority < PRIORITY.URGENT && this.queue.length >= QUEUE_MAX) return false;
      if (priority >= PRIORITY.URGENT) this.queue = this.queue.filter((q) => q.priority >= PRIORITY.TACTICAL);
      if (this.queue.length >= QUEUE_MAX) return false;
    }

    this.lastSaidAt.set(key, now);
    this.queue.push({ text, priority, rate, pitch });
    this.queue.sort((a, b) => b.priority - a.priority);
    this._pump();
    return true;
  }

  _pump() {
    if (this.speaking || !this.queue.length) return;
    const now = performance.now();
    const wait = Math.max(0, MIN_GAP_MS - (now - this.lastAnyAt));
    if (wait > 0) { setTimeout(() => this._pump(), wait); return; }

    const line = this.queue.shift();
    this.speaking = true;
    this.lastAnyAt = now;

    if (this.audio) this.audio.radioClick(false);

    let utter;
    try {
      utter = new window.SpeechSynthesisUtterance(line.text);
    } catch {
      this.speaking = false;
      return;
    }
    if (this.voice) utter.voice = this.voice;
    utter.rate = line.rate;
    utter.pitch = line.pitch;
    utter.volume = 0.95;

    const done = () => {
      if (!this.speaking) return;
      this.speaking = false;
      this.lastAnyAt = performance.now();
      if (this.audio) this.audio.radioClick(true);
      this._pump();
    };
    utter.onend = done;
    utter.onerror = done;

    try {
      this.synth.speak(utter);
    } catch {
      done();
      return;
    }
    // Some browsers never fire onend; do not let one dropped event mute the
    // rest of the match.
    const guard = Math.min(9000, 1200 + line.text.length * 90);
    setTimeout(done, guard);
  }
}

/**
 * Line pools. Several phrasings per event so the same words are not repeated
 * every thirty seconds, which is what makes scripted callouts grating.
 */
export const LINES = {
  battleStations: ['All hands, battle stations.', 'Action stations. All hands to your posts.'],
  helmAhead: ['Helm, all ahead full.', 'Engine room, full ahead.'],
  enemySighted: ['Enemy vessel detected.', 'Contact! Enemy vessel on the scope.', 'Radar contact, enemy vessel closing.'],
  enemyClose: ['Enemy vessel close aboard.', 'Contact bearing down on us.'],
  missileAway: ['Missile away.', 'Bird away.'],
  torpedoAway: ['Torpedo in the water.', 'Torpedo away, running hot.'],
  minesLaid: ['Mines away.', 'Laying mines astern.'],
  minesNear: ['Mines in the water. All stop.', 'Mines ahead, helm hard over.'],
  rearmed: ['Rearmed and ready.', 'Weapons upgraded. Standing by.'],
  onFire: ['Ship is on fire!', 'Fire on deck! Damage control party, close up.', 'We are burning! Fire teams to the deck.'],
  hullBreach: ['Hull breach! Damage control, close up.', 'We are taking water. Seal the compartment.'],
  criticalDamage: ['She cannot take much more, Captain.', 'Critical damage. We are barely afloat.'],
  kill: ['Well done, Captain.', 'Target destroyed. Well done, Captain.', 'Splash one. Well done, Captain.'],
  mateLost: ['We have lost a ship.', 'Man overboard. We have lost her.'],
  lastAfloat: ['We are the last ship afloat, Captain.', 'All other ships are down. It is on us.'],
  victory: ['Well done, Captain. All enemy vessels sunk.', 'Victory, Captain. The strait is ours.'],
  defeat: ['We have lost the fleet, Captain.', 'All ships down. Stand down.'],
  sunk: ['Abandon ship! All hands, abandon ship!', 'She is going down. Abandon ship.'],
};

/** Deterministic-enough variety without repeating the same phrasing twice running. */
const lastIndex = new Map();
export function pickLine(key) {
  const pool = LINES[key];
  if (!pool || !pool.length) return null;
  if (pool.length === 1) return pool[0];
  let i = Math.floor(Math.random() * pool.length);
  if (i === lastIndex.get(key)) i = (i + 1) % pool.length;
  lastIndex.set(key, i);
  return pool[i];
}
