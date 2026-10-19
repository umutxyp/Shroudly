'use strict';

/* SOCKS5 username/password (RFC 1929), on only with --auth-file: the file
 * holds "user:pass", so the secret is never on the command line. With it,
 * every client must offer method 0x02 and give exactly those; a wrong or
 * missing one is refused, and so is SOCKS4, which has no password. Without
 * it the engine takes any local client, as it always has. */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startEngine, sleep, freePort, socks, socks4, suite } = require('./helpers');

const t = suite('engine-auth');

/* A SOCKS5 greeting offering methods, then (when the engine picks 0x02) the
 * credentials, then a CONNECT to 127.0.0.1:port. Resolves what happened:
 * { method, auth (the 0x01 reply's status, or null), rep (CONNECT reply, or
 * null), sock }. */
function attempt(P, { methods = [2], user, pass, port, cmd = 1 }) {
  return new Promise((resolve) => {
    const s = net.connect(P, '127.0.0.1');
    const res = { method: null, auth: null, rep: null, sock: s };
    let b = Buffer.alloc(0); let st = 0;
    const done = () => { if (st !== 9) { st = 9; resolve(res); } };
    s.on('error', done); s.on('close', done);
    setTimeout(done, 3000);
    const connect = () => {
      st = 2;
      s.write(Buffer.from([5, cmd, 0, 1, 127, 0, 0, 1, port >> 8, port & 255]));
    };
    s.on('connect', () => s.write(Buffer.from([5, methods.length, ...methods])));
    s.on('data', (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0 && b.length >= 2) {
        res.method = b[1]; b = b.subarray(2);
        if (res.method === 2) {
          st = 1;
          const u = Buffer.from(user || ''); const p = Buffer.from(pass || '');
          s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        } else if (res.method === 0) connect();
        else return;
      }
      if (st === 1 && b.length >= 2) {
        res.auth = b[1]; b = b.subarray(2);
        if (res.auth === 0) connect();
      }
      if (st === 2 && b.length >= 10) { res.rep = b[1]; b = b.subarray(10); st = 9; resolve(res); }
    });
  });
}

/* A TCP echo server on 127.0.0.1. */
function echo() {
  const srv = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() })));
}

async function echoes(sock, text) {
  return new Promise((resolve) => {
    let got = '';
    sock.on('data', (d) => { got += d; if (got === text) resolve(true); });
    sock.write(text);
    setTimeout(() => resolve(false), 2000);
  });
}

(async () => {
  const e = await echo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-auth-'));
  const file = path.join(dir, 'auth');
  const USER = 'shroudly'; const PASS = 'c0rrect:horse-battery';   // a ':' in the password is part of it
  fs.writeFileSync(file, `${USER}:${PASS}\n`);

  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--auth-file', file]);
  t.ok(!eng.proc.spawnargs.some((a) => a.includes(PASS)), 'the password is not on the command line');

  let r = await attempt(P, { user: USER, pass: PASS, port: e.port });
  t.ok(r.method === 2 && r.auth === 0 && r.rep === 0, 'the right username and password: accepted, and the CONNECT goes through');
  t.ok(await echoes(r.sock, 'through with auth'), 'and data flows both ways');
  r.sock.destroy();

  r = await attempt(P, { methods: [0, 2], user: USER, pass: PASS, port: e.port });
  t.ok(r.method === 2 && r.auth === 0 && r.rep === 0, 'a client offering "no auth" too is still asked for the password');
  r.sock.destroy();

  r = await attempt(P, { user: USER, pass: 'c0rrect:horse-batterY', port: e.port });
  t.ok(r.method === 2 && r.auth === 1 && r.rep === null, 'a wrong password: refused (status 1), no CONNECT');
  r = await attempt(P, { user: USER, pass: `${PASS}x`, port: e.port });
  t.ok(r.auth === 1 && r.rep === null, 'a password with a byte more: refused');
  r = await attempt(P, { user: USER, pass: PASS.slice(0, -1), port: e.port });
  t.ok(r.auth === 1 && r.rep === null, 'a password with a byte less: refused');
  r = await attempt(P, { user: 'someone', pass: PASS, port: e.port });
  t.ok(r.auth === 1 && r.rep === null, 'a wrong username: refused');

  r = await attempt(P, { methods: [0], port: e.port });
  t.ok(r.method === 0xff && r.rep === null, 'no credentials offered: "no acceptable method" (0xFF), no CONNECT');

  const s4 = await socks4(P, '127.0.0.1', e.port).then(() => 'granted', (err) => err.message);
  t.ok(s4 !== 'granted', `SOCKS4 is refused when authentication is on (${s4})`);

  r = await attempt(P, { user: USER, pass: PASS, port: 0, cmd: 3 });
  t.ok(r.auth === 0 && r.rep === 0, 'a UDP ASSOCIATE with the right credentials is granted');
  r.sock.destroy();
  r = await attempt(P, { methods: [0], port: 0, cmd: 3 });
  t.ok(r.method === 0xff && r.rep === null, 'and one without them is not');

  // A file that cannot be used stops the engine rather than leaving it open.
  for (const [body, what] of [['nocolon\n', 'no ":"'], [':pass\n', 'an empty username'], ['user:\n', 'an empty password']]) {
    fs.writeFileSync(file, body);
    const Pb = await freePort();
    const bad = await startEngine(Pb, ['--auth-file', file]).then((x) => { x.stop(); return 'started'; }, (err) => err.message);
    t.ok(bad !== 'started', `an auth file with ${what}: the engine does not start`);
  }
  const Pm = await freePort();
  const missing = await startEngine(Pm, ['--auth-file', path.join(dir, 'missing')]).then((x) => { x.stop(); return 'started'; }, (err) => err.message);
  t.ok(missing !== 'started', 'a missing auth file: the engine does not start');

  // ── without --auth-file nothing changes
  const P2 = await freePort();
  const open = await startEngine(P2, ['--auto']);
  r = await attempt(P2, { methods: [0], port: e.port });
  t.ok(r.method === 0 && r.rep === 0, 'without --auth-file: "no auth" is taken, as before');
  r.sock.destroy();
  const s5 = await socks(P2, '127.0.0.1', e.port);
  t.ok(await echoes(s5, 'open'), 'and a plain SOCKS5 client gets through');
  s5.destroy();
  const s4b = await socks4(P2, '127.0.0.1', e.port);
  t.ok(await echoes(s4b, 'socks4'), 'and so does SOCKS4');
  s4b.destroy();

  await sleep(300);
  t.ok(eng.exited === null && open.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err + open.err),
    'engines still up, no sanitizer errors');
  eng.stop(); open.stop(); e.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`engine-auth: ${t.count} passed`);
  process.exit(0);
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
