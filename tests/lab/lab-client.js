'use strict';

/* One request through the Advanced mode lab: TLS to <address>:443 with the
 * given name, or plain HTTP to :80 with it as the Host. Exit 0 when the whole
 * answer arrived within the time, 1 otherwise, and one line saying which.
 *   node tests/lab/lab-client.js <address> <name> [tls|http] [timeout ms] */

const tls = require('tls');
const net = require('net');

const [addr, name, kind = 'tls', ms = '8000'] = process.argv.slice(2);
const want = 256 * 1024;
let got = 0;
let head = '';
let bodyAt = -1;
const t0 = Date.now();

function done(ok, why) {
  console.log(`${ok ? 'loaded' : 'failed'} ${kind} ${name}: ${why} (${Date.now() - t0} ms)`);
  process.exit(ok ? 0 : 1);
}

const sock = kind === 'http'
  ? net.connect(80, addr)
  : tls.connect({ host: addr, port: 443, servername: name, rejectUnauthorized: false });
const request = `GET / HTTP/1.1\r\nHost: ${name}\r\nConnection: close\r\n\r\n`;
sock.once(kind === 'http' ? 'connect' : 'secureConnect', () => sock.write(request));
sock.on('data', (d) => {
  if (bodyAt < 0) {
    head += d.toString('latin1');
    const i = head.indexOf('\r\n\r\n');
    if (i < 0) return;
    bodyAt = i + 4;
    got = head.length - bodyAt;
  } else got += d.length;
  if (got >= want) done(true, `${got} bytes`);
});
sock.on('error', (e) => done(false, e.code || e.message));
sock.on('close', () => done(got >= want, `closed after ${got} bytes`));
setTimeout(() => done(false, `timed out after ${got} bytes`), Number(ms));
