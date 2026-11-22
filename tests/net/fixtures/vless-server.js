'use strict';

/* A VLESS and Trojan server for the tests only: the server's half of what
 * electron/vless.js speaks (TCP, WebSocket and HTTPUpgrade, with TLS or
 * without), written from the protocols' descriptions and not from the
 * client, so that the two check each other. Real servers (Xray, sing-box)
 * are tried by hand and in the lab; this one runs everywhere the tests do. */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');

const KEY = fs.readFileSync(path.join(__dirname, 'test-only-key.pem'));
const CERT = fs.readFileSync(path.join(__dirname, 'test-only-cert.pem'));
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function serverFrame(data, opcode = 2) {
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeUInt32BE(n, 6); return b; })();
  return Buffer.concat([head, data]);
}

/* Client frames (masked) -> payloads. */
class ClientFrames {
  constructor() { this.buf = Buffer.alloc(0); this.closed = false; this.unmasked = 0; this.pongs = 0; }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const opcode = b[0] & 0x0f;
      const masked = !!(b[1] & 0x80);
      let n = b[1] & 0x7f; let at = 2;
      if (n === 126) { if (b.length < 4) break; n = b.readUInt16BE(2); at = 4; } else if (n === 127) { if (b.length < 10) break; n = b.readUInt32BE(6); at = 10; }
      if (!masked) this.unmasked++;
      const need = at + (masked ? 4 : 0) + n;
      if (b.length < need) break;
      const mask = masked ? b.subarray(at, at + 4) : null;
      const body = Buffer.from(b.subarray(at + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
      this.buf = b.subarray(need);
      if (opcode === 8) { this.closed = true; break; }
      if (opcode === 10) { this.pongs++; continue; }
      if (opcode === 0 || opcode === 2) out.push(body);
    }
    return out;
  }
}

/* { kind: 'vless' | 'trojan', id (hex) | password, net: 'tcp' | 'ws' |
 *   'httpupgrade', tls, path, dial(host, port) -> socket, pingEvery,
 *   split (send answers in pieces of this many bytes), addons (bytes of
 *   additions in the VLESS answer) }
 * -> { port, close(), seen: { requests: [{ host, port }], badAuth, hostHeaders: [],
 *      paths: [], sni: [], unmasked, pongs } } */
function start(o) {
  const seen = { requests: [], badAuth: 0, hostHeaders: [], paths: [], sni: [], unmasked: 0, pongs: 0, userAgents: [] };
  const open = new Set();
  const onConn = (s) => {
    open.add(s);
    s.on('close', () => open.delete(s));
    s.on('error', () => {});
    if (s.servername !== undefined) seen.sni.push(s.servername || '');
    let stage = o.net === 'tcp' ? 'header' : 'http';
    let buf = Buffer.alloc(0);
    let frames = null;
    let up = null;
    const send = (d) => {
      if (s.destroyed) return;
      const piece = o.split || d.length || 1;
      for (let i = 0; i < d.length; i += piece) {
        const part = d.subarray(i, i + piece);
        s.write(o.net === 'ws' ? serverFrame(part) : part);
      }
    };
    const feed = (data) => {
      if (stage === 'relay') { up.write(data); return; }
      buf = Buffer.concat([buf, data]);
      let host; let port; let at;
      if (o.kind === 'vless') {
        if (buf.length < 18) return;
        if (buf[0] !== 0 || buf.subarray(1, 17).toString('hex') !== o.id) { seen.badAuth++; s.destroy(); return; }
        const addons = buf[17];
        if (buf.length < 18 + addons + 4) return;
        at = 18 + addons;
        if (buf[at] !== 1) { s.destroy(); return; }
        port = buf.readUInt16BE(at + 1);
        const atyp = buf[at + 3];
        at += 4;
        if (atyp === 1) { if (buf.length < at + 4) return; host = [...buf.subarray(at, at + 4)].join('.'); at += 4; } else if (atyp === 2) {
          if (buf.length < at + 1 || buf.length < at + 1 + buf[at]) return;
          host = buf.subarray(at + 1, at + 1 + buf[at]).toString(); at += 1 + buf[at];
        } else if (atyp === 3) {
          if (buf.length < at + 16) return;
          const g = []; for (let i = 0; i < 16; i += 2) g.push(buf.readUInt16BE(at + i).toString(16));
          host = g.join(':'); at += 16;
        } else { s.destroy(); return; }
      } else {
        if (buf.length < 58) return;
        const want = crypto.createHash('sha224').update(o.password).digest('hex');
        if (buf.subarray(0, 56).toString('latin1') !== want || buf.subarray(56, 58).toString('latin1') !== '\r\n') { seen.badAuth++; s.destroy(); return; }
        at = 58;
        if (buf.length < at + 2) return;
        if (buf[at] !== 1) { s.destroy(); return; }
        const atyp = buf[at + 1];
        at += 2;
        if (atyp === 1) { if (buf.length < at + 4) return; host = [...buf.subarray(at, at + 4)].join('.'); at += 4; } else if (atyp === 3) {
          if (buf.length < at + 1 || buf.length < at + 1 + buf[at]) return;
          host = buf.subarray(at + 1, at + 1 + buf[at]).toString(); at += 1 + buf[at];
        } else if (atyp === 4) {
          if (buf.length < at + 16) return;
          const g = []; for (let i = 0; i < 16; i += 2) g.push(buf.readUInt16BE(at + i).toString(16));
          host = g.join(':'); at += 16;
        } else { s.destroy(); return; }
        if (buf.length < at + 4) return;
        port = buf.readUInt16BE(at);
        at += 4;
      }
      const rest = buf.subarray(at);
      seen.requests.push({ host, port });
      stage = 'relay';
      up = o.dial(host, port);
      up.on('error', () => s.destroy());
      // The client is done sending: said to the destination, which may still answer.
      s.on('end', () => { try { up.end(); } catch {} });
      // What the destination sent last still goes out before the close.
      up.on('close', () => { if (!s.destroyed) s.end(); });
      s.on('close', () => up.destroy());
      // VLESS answers with its version, a length, and that many bytes of additions.
      let first = o.kind === 'vless' ? Buffer.concat([Buffer.from([0, (o.addons || Buffer.alloc(0)).length]), o.addons || Buffer.alloc(0)]) : Buffer.alloc(0);
      up.on('data', (d) => { if (first.length) { send(Buffer.concat([first, d])); first = Buffer.alloc(0); } else send(d); });
      if (rest.length) up.write(rest);
    };
    s.on('data', (d) => {
      if (stage === 'http') {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        const after = buf.subarray(end + 4);
        buf = Buffer.alloc(0);
        const reqPath = (/^GET (\S+) HTTP\/1\.1/.exec(head) || [])[1];
        seen.paths.push(reqPath);
        seen.hostHeaders.push((/^host:\s*(\S+)/im.exec(head) || [])[1]);
        seen.userAgents.push((/^user-agent:\s*(.+)$/im.exec(head) || [])[1]);
        const key = (/^sec-websocket-key:\s*(\S+)/im.exec(head) || [])[1];
        if (reqPath !== (o.path || '/') || !/^upgrade:\s*websocket/im.test(head) || (o.net === 'ws' && !key)) {
          s.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
          return;
        }
        s.write(o.net === 'ws'
          ? `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + WS_GUID).digest('base64')}\r\n\r\n`
          : 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        stage = 'header';
        if (o.net === 'ws') {
          frames = new ClientFrames();
          if (o.pingEvery) { const t = setInterval(() => { if (s.destroyed) clearInterval(t); else s.write(serverFrame(Buffer.from('hi'), 9)); }, o.pingEvery); s.on('close', () => clearInterval(t)); }
        }
        if (!after.length) return;
        d = after;
      }
      if (frames) {
        const parts = frames.push(d);
        seen.unmasked += frames.unmasked; frames.unmasked = 0;
        seen.pongs += frames.pongs; frames.pongs = 0;
        for (const part of parts) feed(part);
        if (frames.closed) s.destroy();
      } else feed(d);
    });
  };
  const srv = o.tls ? tls.createServer({ key: KEY, cert: CERT, ALPNProtocols: ['http/1.1'], allowHalfOpen: true }, onConn) : net.createServer({ allowHalfOpen: true }, onConn);
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, seen, close: () => { srv.close(); for (const c of open) c.destroy(); } }));
  });
}

module.exports = { start, CERT, serverFrame };
