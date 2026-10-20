'use strict';

/* The far end of the Advanced mode lab (tests/lab/advanced-lab.sh): a TLS
 * server on 443 and a plain HTTP server on 80 at the given address, each
 * answering any request with BODY_BYTES of body, so a client can tell a whole
 * answer from a cut one.
 *   node tests/lab/lab-server.js <address>
 * With "alert", only port 443, answering whatever the client sends first with
 * a plaintext TLS handshake_failure alert and closing, the way a server does
 * when a decoy got into the stream ahead of the real ClientHello.
 *   node tests/lab/lab-server.js <address> alert */

const tls = require('tls');
const net = require('net');
const path = require('path');
const fs = require('fs');

const addr = process.argv[2];
const mode = process.argv[3] || '';
const BODY_BYTES = 256 * 1024;
const body = Buffer.alloc(BODY_BYTES, 'x');
const fixture = (f) => fs.readFileSync(path.join(__dirname, '..', 'net', 'fixtures', f));

function answer(sock) {
  let seen = '';
  sock.on('data', (d) => {
    seen += d.toString('latin1');
    if (!seen.includes('\r\n\r\n')) return;
    seen = '';
    sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${BODY_BYTES}\r\nConnection: close\r\n\r\n`);
    sock.end(body);
  });
  sock.on('error', () => {});
}

if (mode === 'alert') {
  const alert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]);
  net.createServer((sock) => {
    sock.on('error', () => {});
    sock.once('data', () => sock.end(alert));
  }).listen(443, addr, () => console.log(`lab server on ${addr}:443 (TLS alert)`));
  return;
}

tls.createServer({ key: fixture('test-only-key.pem'), cert: fixture('test-only-cert.pem') }, answer).listen(443, addr);
net.createServer(answer).listen(80, addr, () => console.log(`lab server on ${addr}:443 (TLS) and :80 (HTTP)`));
