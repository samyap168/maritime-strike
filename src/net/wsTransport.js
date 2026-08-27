/**
 * WebSocket transport — the fallback.
 *
 * Used when WebRTC cannot get through the network (client isolation on
 * corporate wifi, symmetric NAT with no TURN). The host's browser is still the
 * authority; server/relay.js is a dumb message router that knows nothing about
 * the game. That keeps the authoritative model identical across both
 * transports, so gameplay code cannot tell which one it is running on.
 *
 * Two ways to point at a relay:
 *   ?net=ws&host=<host-laptop-ip>   local relay on the same network
 *   ?net=ws&relay=wss://host        a public relay reached over TLS
 *
 * The scheme is not cosmetic. A page served over HTTPS cannot open a plaintext
 * ws:// socket — browsers block it as mixed content — so anything deployed to
 * GitHub Pages must use wss://.
 */

import { BaseTransport, HOST_ID } from './transport.js';
import { MSG } from './protocol.js';

export class WsTransport extends BaseTransport {
  constructor(opts = {}) {
    super();
    this.mode = 'ws';
    this.url = (opts.wsUrl || 'ws://localhost:8080').replace(/\/+$/, '');
    // Catch the mixed-content trap before the browser does, so the error names
    // the actual problem instead of a bare "connection failed".
    this.mixedContent = opts.pageIsSecure && this.url.startsWith('ws://');
    this.sock = null;
    this.pingTimer = null;
    this.snapshotChannelReady = true;  // a single socket carries everything
  }

  host(roomCode) { return this._open(roomCode, 'host'); }
  join(roomCode) { return this._open(roomCode, 'client'); }

  _open(roomCode, role) {
    this.isHost = role === 'host';
    return new Promise((resolve, reject) => {
      if (this.mixedContent) {
        reject(new Error(
          'This page is served over HTTPS, so it can only reach a relay over wss://. '
          + `Pass ?relay=wss://your-relay-host, or open the game over plain http:// to use ${this.url}.`
        ));
        return;
      }
      let settled = false;
      const url = `${this.url}/?room=${encodeURIComponent(roomCode)}&role=${role}`;
      let sock;
      try {
        sock = new WebSocket(url);
      } catch (e) {
        reject(new Error(`Could not reach the relay at ${this.url}. Is it running?`));
        return;
      }
      this.sock = sock;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch { /* already closing */ }
        reject(new Error(`No relay answered at ${this.url}. Start it with: node server/relay.js`));
      }, 8000);

      sock.onopen = () => { /* wait for the relay's id assignment before resolving */ };

      sock.onmessage = (e) => {
        let env;
        try { env = JSON.parse(e.data); } catch { return; }

        if (env.sys === 'id') {
          clearTimeout(timeout);
          if (this.isHost) {
            this.peers.clear();
          } else {
            this.peers.set(HOST_ID, { id: HOST_ID });
          }
          if (!settled) {
            settled = true;
            this._startPingLoop();
            if (!this.isHost) this.emit('peer:open', HOST_ID);
            resolve();
          }
          return;
        }

        if (env.sys === 'busy') {
          clearTimeout(timeout);
          if (!settled) { settled = true; reject(new Error('That room already has a host.')); }
          return;
        }

        if (env.sys === 'peer:open') {
          this.peers.set(env.id, { id: env.id });
          this.emit('peer:open', env.id);
          return;
        }

        if (env.sys === 'peer:close') {
          this.peers.delete(env.id);
          this.pings.delete(env.id);
          this.emit('peer:close', env.id);
          return;
        }

        if (env.d) this._onData(this.isHost ? env.from : HOST_ID, env.d);
      };

      sock.onerror = () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error(`Could not reach the relay at ${this.url}. Is it running, and is the IP right?`));
        }
      };

      sock.onclose = () => {
        clearInterval(this.pingTimer);
        if (settled) {
          if (!this.isHost) {
            this.peers.delete(HOST_ID);
            this.emit('peer:close', HOST_ID);
          } else {
            this.emit('status', 'Relay connection lost.');
          }
        }
      };
    });
  }

  _onData(from, msg) {
    if (!msg || !msg._) return;
    if (msg._ === MSG.PING) { this.send(from, { _: MSG.PONG, t: msg.t }, true); return; }
    if (msg._ === MSG.PONG) { this.pings.set(from, Math.round(performance.now() - msg.t)); return; }
    this.emit('data', from, msg);
  }

  _startPingLoop() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.isHost) {
        for (const id of this.peers.keys()) this.send(id, { _: MSG.PING, t: performance.now() }, true);
      } else {
        this.send(HOST_ID, { _: MSG.PING, t: performance.now() }, true);
      }
    }, 2000);
  }

  /** The relay understands '*', so a broadcast costs one frame, not N. */
  broadcast(msg) {
    if (!this.isHost || !this.sock || this.sock.readyState !== WebSocket.OPEN) return;
    try { this.sock.send(JSON.stringify({ to: '*', d: msg })); } catch { /* socket closing */ }
  }

  send(peerId, msg) {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) return false;
    try {
      this.sock.send(JSON.stringify({ to: this.isHost ? peerId : HOST_ID, d: msg }));
      return true;
    } catch { return false; }
  }

  close() {
    clearInterval(this.pingTimer);
    this.peers.clear();
    try { this.sock && this.sock.close(); } catch { /* already closing */ }
    this.sock = null;
  }
}
