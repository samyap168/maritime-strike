/**
 * Transport interface.
 *
 * The entire rest of the game talks to the network through exactly this shape,
 * so the underlying mechanism can be swapped without touching game code.
 * Two implementations ship:
 *
 *   webrtcTransport — the default. Peer-to-peer data channels, host as hub.
 *                     Nothing to deploy; works from a static GitHub Pages URL.
 *   wsTransport     — the fallback for networks that block WebRTC (corporate
 *                     wifi with client isolation, symmetric NAT). Talks to the
 *                     zero-dependency relay in server/relay.js.
 *
 * Selected with ?net=rtc (default) or ?net=ws&host=<ip>.
 */

export const HOST_ID = '__host__';

export class BaseTransport {
  constructor() {
    this.handlers = {};
    this.peers = new Map();      // peerId -> connection record
    this.pings = new Map();      // peerId -> round trip ms
    this.isHost = false;
    this.mode = 'none';
    this.snapshotChannelReady = false;
  }

  on(event, cb) {
    (this.handlers[event] || (this.handlers[event] = [])).push(cb);
    return this;
  }

  emit(event, ...args) {
    const list = this.handlers[event];
    if (list) for (const cb of list) { try { cb(...args); } catch (e) { console.error(e); } }
  }

  broadcast(msg, reliable = true) {
    for (const id of this.peers.keys()) this.send(id, msg, reliable);
  }

  // Subclasses implement: host(code), join(code), send(id, msg, reliable), close()
}

export async function createTransport(mode, opts = {}) {
  if (mode === 'ws') {
    const { WsTransport } = await import('./wsTransport.js');
    return new WsTransport(opts);
  }
  const { WebRtcTransport } = await import('./webrtcTransport.js');
  return new WebRtcTransport(opts);
}

/** Read transport selection off the URL so it can be changed without a rebuild. */
export function transportOptionsFromUrl() {
  const p = new URLSearchParams(location.search);
  const mode = p.get('net') === 'ws' ? 'ws' : 'rtc';

  // A full relay URL wins outright: ?relay=wss://relay.example.com
  // Otherwise build one from host/port, choosing the scheme from the page's
  // own protocol. This matters: a page served over HTTPS (GitHub Pages, any
  // real deployment) cannot open a plaintext ws:// socket — browsers block it
  // as mixed content — so an https page must always talk wss.
  const explicit = p.get('relay');
  const secure = location.protocol === 'https:';
  const host = p.get('host') || location.hostname || 'localhost';
  // Default to the port the page itself came from: the relay serves the game
  // and the socket on one port, so hardcoding 8080 breaks the moment anyone
  // runs it on another. Fall back to 8080 only when the page has no port
  // (opened from the filesystem, or served on 80/443).
  const port = p.get('port') || location.port || (secure ? '' : '8080');

  return {
    mode,
    wsUrl: explicit || `${secure ? 'wss' : 'ws'}://${host}${port ? ':' + port : ''}`,
    pageIsSecure: secure,
  };
}
