/**
 * WebRTC transport — the default.
 *
 * Star topology: the host is the hub and the authority. Every client opens two
 * data channels to it:
 *
 *   'ev'   reliable + ordered   — joins, kills, pickups, phase changes
 *   'snap' unreliable/unordered — 15Hz position snapshots
 *
 * Splitting them matters: a reliable channel head-of-line blocks, so a single
 * dropped packet would stall every subsequent position update. Losing a
 * snapshot is invisible; losing a kill event desyncs the match.
 *
 * If the unreliable channel fails to open (some corporate stacks disallow it),
 * we degrade to routing snapshots over the reliable channel rather than
 * failing the connection. Slightly worse under packet loss, still playable.
 */

import { BaseTransport, HOST_ID } from './transport.js';
import { MSG } from './protocol.js';

const PEER_PREFIX = 'mstrike-';
const SNAP_CHANNEL_GRACE_MS = 3500;

const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};

const peerIdFor = (roomCode) => PEER_PREFIX + roomCode.toLowerCase();
const randomTag = () => Math.random().toString(36).slice(2, 10);

/**
 * Pre-flight check: can this network reach the WebRTC signalling service at all?
 *
 * Worth its weight on demo day. Client isolation and blocked WSS are the only
 * realistic reasons peer-to-peer play fails, and both are silent until fifteen
 * people are already waiting. This answers the question in five seconds.
 */
export function probeSignalling(timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (typeof window.Peer !== 'function') {
      resolve({ ok: false, reason: 'PeerJS did not load.' });
      return;
    }
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { peer.destroy(); } catch { /* gone */ } resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, reason: 'Timed out reaching the signalling service.' }), timeoutMs);

    let peer;
    try {
      peer = new window.Peer(PEER_PREFIX + 'probe-' + randomTag(), PEER_CONFIG);
    } catch (e) {
      finish({ ok: false, reason: e.message });
      return;
    }
    peer.on('open', () => finish({ ok: true }));
    peer.on('error', (err) => finish({ ok: false, reason: `${err.type || err.message}` }));
  });
}

export class WebRtcTransport extends BaseTransport {
  constructor() {
    super();
    this.mode = 'rtc';
    this.peer = null;
    this.localTag = randomTag();
    this.hostConns = null;   // client side: { ev, snap }
    this.pingTimer = null;
  }

  _newPeer(id) {
    if (typeof window.Peer !== 'function') {
      throw new Error('PeerJS failed to load. Try the ?net=ws fallback.');
    }
    return id ? new window.Peer(id, PEER_CONFIG) : new window.Peer(PEER_CONFIG);
  }

  // -------------------------------------------------------------- host side

  host(roomCode) {
    this.isHost = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const peer = this._newPeer(peerIdFor(roomCode));
      this.peer = peer;

      peer.on('open', () => {
        settled = true;
        this.emit('status', 'Room open. Waiting for players.');
        this._startPingLoop();
        resolve();
      });

      peer.on('connection', (conn) => this._acceptClientChannel(conn));

      peer.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(
            err.type === 'unavailable-id'
              ? 'That room code is already in use. Create a new game.'
              : `Could not open the room (${err.type || err.message}).`
          ));
        } else {
          this.emit('error', err);
        }
      });

      peer.on('disconnected', () => {
        this.emit('status', 'Signalling dropped — reconnecting.');
        try { peer.reconnect(); } catch { /* peer already destroyed */ }
      });
    });
  }

  /** A client opens one channel at a time; pair them up by their tag. */
  _acceptClientChannel(conn) {
    const tag = conn.metadata && conn.metadata.tag;
    if (!tag) { conn.close(); return; }

    const rec = this.peers.get(tag) || { id: tag, ev: null, snap: null, announced: false };
    this.peers.set(tag, rec);

    if (conn.label === 'snap') rec.snap = conn; else rec.ev = conn;

    conn.on('data', (msg) => this._onData(tag, msg));

    conn.on('open', () => {
      if (rec.ev && rec.ev.open && !rec.announced) {
        rec.announced = true;
        this.emit('peer:open', tag);
      }
    });

    conn.on('close', () => {
      if (conn.label === 'snap') { rec.snap = null; return; }  // lone snap loss is survivable
      this.peers.delete(tag);
      this.pings.delete(tag);
      this.emit('peer:close', tag);
    });

    conn.on('error', () => { /* channel-level errors surface as close */ });
  }

  // ------------------------------------------------------------ client side

  join(roomCode) {
    this.isHost = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const peer = this._newPeer(null);
      this.peer = peer;
      const target = peerIdFor(roomCode);

      const fail = (msg) => {
        if (settled) return;
        settled = true;
        reject(new Error(msg));
      };

      const timeout = setTimeout(
        () => fail('No answer from that room. Check the code, or ask the host to use the ?net=ws fallback.'),
        15000
      );

      peer.on('open', () => {
        const meta = { tag: this.localTag };
        const ev = peer.connect(target, { label: 'ev', reliable: true, metadata: meta });
        const snap = peer.connect(target, { label: 'snap', reliable: false, metadata: meta });
        this.hostConns = { ev, snap };
        this.peers.set(HOST_ID, { id: HOST_ID, ev, snap });

        ev.on('data', (msg) => this._onData(HOST_ID, msg));
        snap.on('data', (msg) => this._onData(HOST_ID, msg));

        ev.on('open', () => {
          clearTimeout(timeout);
          if (settled) return;
          settled = true;
          this._startPingLoop();
          this.emit('peer:open', HOST_ID);
          resolve();
        });

        // Degrade rather than fail if the unreliable channel never opens.
        setTimeout(() => {
          this.snapshotChannelReady = !!(snap && snap.open);
          if (!this.snapshotChannelReady) {
            this.emit('status', 'Unreliable channel unavailable — using reliable only.');
          }
        }, SNAP_CHANNEL_GRACE_MS);

        ev.on('close', () => {
          this.peers.delete(HOST_ID);
          this.emit('peer:close', HOST_ID);
        });

        ev.on('error', (e) => fail(`Connection failed (${e.type || e.message}).`));
      });

      peer.on('error', (err) => {
        clearTimeout(timeout);
        if (err.type === 'peer-unavailable') fail('No room with that code is open right now.');
        else if (!settled) fail(`Could not connect (${err.type || err.message}).`);
        else this.emit('error', err);
      });
    });
  }

  // ----------------------------------------------------------------- shared

  _onData(from, msg) {
    if (!msg || !msg._) return;
    if (msg._ === MSG.PING) { this.send(from, { _: MSG.PONG, t: msg.t }, true); return; }
    if (msg._ === MSG.PONG) { this.pings.set(from, Math.round(performance.now() - msg.t)); return; }
    this.emit('data', from, msg);
  }

  _startPingLoop() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      for (const id of this.peers.keys()) {
        this.send(id, { _: MSG.PING, t: performance.now() }, true);
      }
    }, 2000);
  }

  send(peerId, msg, reliable = true) {
    const rec = this.peers.get(peerId);
    if (!rec) return false;
    // Snapshots take the unreliable channel when it exists, else fall back.
    const wantSnap = !reliable && rec.snap && rec.snap.open;
    const conn = wantSnap ? rec.snap : rec.ev;
    if (!conn || !conn.open) return false;
    try { conn.send(msg); return true; } catch { return false; }
  }

  close() {
    clearInterval(this.pingTimer);
    for (const rec of this.peers.values()) {
      try { rec.ev && rec.ev.close(); } catch { /* already gone */ }
      try { rec.snap && rec.snap.close(); } catch { /* already gone */ }
    }
    this.peers.clear();
    try { this.peer && this.peer.destroy(); } catch { /* already gone */ }
    this.peer = null;
  }
}
