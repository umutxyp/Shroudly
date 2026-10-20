'use strict';

/* UDP for the Advanced mode labs (advanced-lab.sh, advanced-windows.js): the
 * datagrams a call starts with, and the ones it is made of.
 *
 *   node tests/lab/lab-udp.js serve <address> <port>...
 *     one line per datagram, in the order they arrive:
 *     "<port> <length> <first four bytes in hex>"
 *   node tests/lab/lab-udp.js send <address> <port> <kind> [count]
 *     count datagrams of one kind, all from one socket (one flow), in order.
 *
 * Kinds:
 *   discovery     Discord's IP discovery request: 74 bytes, 00 01 00 46 ...
 *   stun          a STUN Binding request without attributes: 00 01 00 00 21 12 a4 42 ...
 *   rtp           a voice packet: an RTP header (80 78 ...) and 160 bytes
 *   quic-initial  a QUIC v1 long header, 1200 bytes (c3 00 00 00 01 ...)
 *   quic-short    a QUIC short header (41 ...), 60 bytes */

const dgram = require('dgram');
const crypto = require('crypto');

function payload(kind, i = 0) {
  switch (kind) {
    case 'discovery': {
      const b = Buffer.alloc(74);
      b.writeUInt16BE(1, 0); b.writeUInt16BE(70, 2); b.writeUInt32BE(12345, 4);
      return b;
    }
    case 'stun': {
      const b = Buffer.alloc(20);
      b.writeUInt16BE(1, 0); b.writeUInt16BE(0, 2); b.writeUInt32BE(0x2112a442, 4);
      crypto.randomBytes(12).copy(b, 8);
      return b;
    }
    case 'rtp': {
      const b = crypto.randomBytes(172);
      b[0] = 0x80; b[1] = 0x78; b.writeUInt16BE(i & 0xffff, 2); b.writeUInt32BE(i * 960, 4); b.writeUInt32BE(12345, 8);
      return b;
    }
    case 'quic-initial': {
      const b = crypto.randomBytes(1200);
      b[0] = 0xc3; b.writeUInt32BE(1, 1);
      return b;
    }
    case 'quic-short': {
      const b = crypto.randomBytes(60);
      b[0] = 0x41;
      return b;
    }
    default: throw new Error(`unknown kind ${kind}`);
  }
}

/* Send count datagrams of `kind` from one socket. With answerMs, wait that
 * long after the last one for any answer. Resolves { sent, answered }. */
function send(address, port, kind, count = 1, answerMs = 0) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let answered = false;
    let sent = 0;
    sock.on('error', () => {});
    sock.on('message', () => { answered = true; });
    const finish = () => { try { sock.close(); } catch {} resolve({ sent, answered }); };
    const next = () => {
      if (sent >= count) { setTimeout(finish, answerMs || 100); return; }
      sock.send(payload(kind, sent), port, address, (err) => {
        if (!err) sent++;
        else count = sent;
        setTimeout(next, 5);
      });
    };
    sock.bind(0, next);
  });
}

module.exports = { payload, send };

if (require.main === module) {
  const [cmd, address, ...rest] = process.argv.slice(2);
  if (cmd === 'serve') {
    let bound = 0;
    for (const port of rest.map(Number)) {
      const s = dgram.createSocket('udp4');
      s.on('error', (e) => { console.error(`udp ${port}: ${e.message}`); process.exit(1); });
      s.on('message', (m) => console.log(`${port} ${m.length} ${m.subarray(0, 4).toString('hex')}`));
      s.bind(port, address, () => { if (++bound === rest.length) console.log(`lab udp on ${address}: ${rest.join(' ')}`); });
    }
  } else if (cmd === 'send') {
    const [port, kind, count = '1'] = rest;
    send(address, Number(port), kind, Number(count), kind === 'stun' ? 2000 : 0).then((r) => {
      console.log(`sent ${r.sent} ${kind} to ${address}:${port}${kind === 'stun' ? (r.answered ? ', answered' : ', no answer') : ''}`);
    });
  } else {
    console.error('usage: lab-udp.js serve <address> <port>... | send <address> <port> <kind> [count]');
    process.exit(2);
  }
}
