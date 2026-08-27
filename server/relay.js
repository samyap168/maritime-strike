#!/usr/bin/env node
/**
 * MARITIME STRIKE — static file server + WebSocket relay.
 *
 * ZERO DEPENDENCIES. `node server/relay.js` and you are done. No npm install,
 * which means it works on a locked-down laptop with no internet, in a meeting
 * room, five minutes before you present.
 *
 * Two jobs:
 *   1. Serve the game over plain HTTP, so colleagues can load it off your
 *      laptop without GitHub Pages at all.
 *   2. Relay messages between browsers when WebRTC is blocked. It is a dumb
 *      router: the host's BROWSER remains the authority. This deliberately
 *      knows nothing about vessels, damage or scoring.
 *
 *   Host:    http://<your-ip>:8080/?net=ws
 *   Players: http://<your-ip>:8080/?net=ws&host=<your-ip>
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.resolve(__dirname, '..');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------- static files

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(ROOT, path.normalize(rel));
  // Never serve outside the project directory.
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ------------------------------------------------------------ websocket layer

/** rooms: code -> { host: Client|null, clients: Map<id, Client> } */
const rooms = new Map();
let nextId = 1;

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const url = new URL(req.url, 'http://localhost');
  const roomCode = (url.searchParams.get('room') || 'default').toUpperCase();
  const role = url.searchParams.get('role') === 'host' ? 'host' : 'client';

  const room = rooms.get(roomCode) || { host: null, clients: new Map() };
  rooms.set(roomCode, room);

  const client = { id: role === 'host' ? '__host__' : `p${nextId++}`, socket, room: roomCode, role, buf: Buffer.alloc(0) };

  if (role === 'host') {
    if (room.host) { sendJson(client, { sys: 'busy' }); setTimeout(() => socket.destroy(), 50); return; }
    room.host = client;
    sendJson(client, { sys: 'id', id: '__host__', isHost: true });
    log(`room ${roomCode}: host connected`);
  } else {
    room.clients.set(client.id, client);
    sendJson(client, { sys: 'id', id: client.id, isHost: false });
    if (room.host) sendJson(room.host, { sys: 'peer:open', id: client.id });
    log(`room ${roomCode}: ${client.id} joined (${room.clients.size} players)`);
  }

  socket.on('data', (chunk) => {
    client.buf = Buffer.concat([client.buf, chunk]);
    let frame;
    while ((frame = readFrame(client.buf))) {
      client.buf = client.buf.subarray(frame.total);
      if (frame.opcode === 0x8) { socket.end(); return; }             // close
      if (frame.opcode === 0x9) { writeFrame(socket, frame.payload, 0xA); continue; }  // ping
      if (frame.opcode !== 0x1 && frame.opcode !== 0x0) continue;     // only text
      route(client, room, frame.payload.toString('utf8'));
    }
  });

  const drop = () => {
    if (client.role === 'host') {
      if (room.host === client) room.host = null;
      // Host is gone: cut the clients loose so their UI reports it honestly.
      for (const c of room.clients.values()) c.socket.end();
      room.clients.clear();
      rooms.delete(roomCode);
      log(`room ${roomCode}: host left, room closed`);
    } else {
      room.clients.delete(client.id);
      if (room.host) sendJson(room.host, { sys: 'peer:close', id: client.id });
      log(`room ${roomCode}: ${client.id} left`);
    }
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

function route(from, room, text) {
  let env;
  try { env = JSON.parse(text); } catch { return; }
  if (!env || !env.d) return;

  if (from.role === 'host') {
    if (env.to === '*') { for (const c of room.clients.values()) sendJson(c, { from: '__host__', d: env.d }); return; }
    const target = room.clients.get(env.to);
    if (target) sendJson(target, { from: '__host__', d: env.d });
  } else if (room.host) {
    sendJson(room.host, { from: from.id, d: env.d });
  }
}

const sendJson = (client, obj) => writeFrame(client.socket, Buffer.from(JSON.stringify(obj)), 0x1);

/** Parse one frame out of `buf`, or return null if it is not complete yet. */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); offset = 10;
  }

  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;

  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  }
  return { opcode, payload, total: offset + maskLen + len };
}

/** Server-to-client frames are never masked. */
function writeFrame(socket, payload, opcode = 0x1) {
  if (!socket || socket.destroyed) return;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch { /* peer went away */ }
}

const log = (m) => console.log(`[relay] ${m}`);

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  const ip = ips[0] || 'localhost';
  console.log('');
  console.log('  MARITIME STRIKE relay is up.');
  console.log('');
  console.log(`  You (host):   http://${ip}:${PORT}/?net=ws`);
  console.log(`  Everyone else: http://${ip}:${PORT}/?net=ws&host=${ip}`);
  if (ips.length > 1) console.log(`  Other addresses on this machine: ${ips.slice(1).join(', ')}`);
  console.log('');
  console.log('  Ctrl-C to stop.');
  console.log('');
});
