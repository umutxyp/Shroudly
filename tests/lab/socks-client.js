'use strict';

/* One request through Shroudly's engine, the way an app on the system proxy
 * makes it: SOCKS5 to 127.0.0.1:<port> with the name (the engine resolves
 * it), then TLS with that name, and a whole answer from the lab server
 * (tests/lab/lab-server.js: 256 KB of body). Exit 0 when it all arrived in
 * time, 1 otherwise, with one line saying which.
 *   node tests/lab/socks-client.js <socks port> <name> [timeout ms] */

const net = require('net');
const tls = require('tls');
const path = require('path');
const fs = require('fs');

const [port, name, ms = '20000'] = process.argv.slice(2);
const want = 256 * 1024;
const t0 = Date.now();
// The lab server's certificate is the test CA's (tests/net/fixtures); it is
// checked against it, whatever name the lab asks for.
const ca = fs.readFileSync(path.join(__dirname, '..', 'net', 'fixtures', 'test-only-cert.pem'));

function done(ok, why) {
  console.log(`${ok ? 'loaded' : 'failed'} ${name}: ${why} (${Date.now() - t0} ms)`);
  process.exit(ok ? 0 : 1);
}
setTimeout(() => done(false, 'timed out'), Number(ms)).unref();

const s = net.connect(Number(port), '127.0.0.1');
s.on('error', (e) => done(false, e.code || e.message));
s.once('connect', () => s.write(Buffer.from([5, 1, 0])));
let stage = 0;
let buf = Buffer.alloc(0);
s.on('data', function onData(d) {
  buf = Buffer.concat([buf, d]);
  if (stage === 0 && buf.length >= 2) {
    if (buf[0] !== 5 || buf[1] !== 0) return done(false, 'SOCKS refused');
    buf = buf.subarray(2);
    const host = Buffer.from(name);
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([1, 0xbb])]));
    stage = 1;
  }
  if (stage === 1 && buf.length >= 10) {
    if (buf[1] !== 0) return done(false, `SOCKS reply ${buf[1]}`);
    stage = 2;
    s.removeListener('data', onData);
    const c = tls.connect({ socket: s, servername: name, ca, checkServerIdentity: () => undefined });
    let head = '';
    let got = 0;
    let bodyAt = -1;
    c.on('secureConnect', () => c.write(`GET / HTTP/1.1\r\nHost: ${name}\r\nConnection: close\r\n\r\n`));
    c.on('data', (x) => {
      if (bodyAt < 0) {
        head += x.toString('latin1');
        bodyAt = head.indexOf('\r\n\r\n');
        if (bodyAt >= 0) got = head.length - bodyAt - 4;
      } else got += x.length;
      if (got >= want) done(true, `${got} bytes`);
    });
    c.on('error', (e) => done(false, e.code || e.message));
    c.on('close', () => done(got >= want, `${got} of ${want} bytes`));
  }
});
