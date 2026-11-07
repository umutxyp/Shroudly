'use strict';

/* --http-open (the Mac App Store app as the Mac's proxy, AppSettings.proxyOnly):
 * with a SOCKS password set,
 *   - HTTP CONNECT is taken without it (the apps of the Mac, through the
 *     system's proxy settings), and reaches the site
 *   - SOCKS5 without the password is still refused, with it still taken
 *   - without --http-open, HTTP CONNECT is refused (403), as before */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const H = require('./helpers');

const t = H.suite('engine-http-open');

/* A CONNECT through the engine to 127.0.0.1:port; the first line of the answer. */
function connect(P, port) {
  return new Promise((resolve) => {
    const c = net.connect(P, '127.0.0.1');
    let b = '';
    c.on('connect', () => c.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
    c.on('data', (d) => {
      b += d;
      if (b.includes('\r\n')) {
        const first = b.split('\r\n')[0];
        if (/ 200 /.test(first)) {
          c.write('ping');
          c.once('data', (e) => { c.destroy(); resolve(`${first} | ${String(e)}`); });
        } else { c.destroy(); resolve(first); }
      }
    });
    c.on('error', () => resolve('error'));
    setTimeout(() => { c.destroy(); resolve(b.split('\r\n')[0] || 'timeout'); }, 8000);
  });
}

/* A SOCKS5 greeting offering no authentication only: the method chosen. */
function socksNoAuth(P) {
  return new Promise((resolve) => {
    const c = net.connect(P, '127.0.0.1');
    c.on('connect', () => c.write(Buffer.from([5, 1, 0])));
    c.on('data', (d) => { c.destroy(); resolve(d[1]); });
    c.on('close', () => resolve('closed'));
    c.on('error', () => resolve('error'));
    setTimeout(() => { c.destroy(); resolve('timeout'); }, 5000);
  });
}

/* A SOCKS5 greeting with username and password (RFC 1929): the status. */
function socksAuth(P, user, pass) {
  return new Promise((resolve) => {
    const c = net.connect(P, '127.0.0.1');
    let step = 0;
    c.on('connect', () => c.write(Buffer.from([5, 1, 2])));
    c.on('data', (d) => {
      if (step === 0) {
        step = 1;
        if (d[1] !== 2) { c.destroy(); resolve('method ' + d[1]); return; }
        c.write(Buffer.concat([Buffer.from([1, user.length]), Buffer.from(user), Buffer.from([pass.length]), Buffer.from(pass)]));
      } else { c.destroy(); resolve(d[1]); }
    });
    c.on('error', () => resolve('error'));
    setTimeout(() => { c.destroy(); resolve('timeout'); }, 5000);
  });
}

(async () => {
  const echo = net.createServer((s) => { s.on('error', () => {}); s.on('data', () => s.write('pong')); }).listen(0, '127.0.0.1');
  await new Promise((r) => echo.once('listening', r));
  const port = echo.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-httpopen-'));
  const auth = path.join(dir, 'auth');
  fs.writeFileSync(auth, 'u1:p1\n');

  const P = await H.freePort();
  const eng = await H.startEngine(P, ['--strategy', 'none', '--auth-file', auth, '--http-open']);
  const got = await connect(P, port);
  t.ok(/ 200 /.test(got) && got.endsWith('pong'), `--http-open: CONNECT without the password reaches the site (${got})`);
  t.ok((await socksNoAuth(P)) !== 0, '--http-open: SOCKS5 without the password is still refused');
  t.ok((await socksAuth(P, 'u1', 'p1')) === 0, '--http-open: SOCKS5 with the password is taken');
  eng.stop();

  const P2 = await H.freePort();
  const eng2 = await H.startEngine(P2, ['--strategy', 'none', '--auth-file', auth]);
  t.ok(/403/.test(await connect(P2, port)), 'without it: CONNECT is refused (403), as before');
  eng2.stop();

  echo.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`engine-http-open: ${t.count} passed`);
  process.exit(0);
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
