'use strict';

/* Shadowsocks (electron/shadowsocks.js) and the links of "Use my own server"
 * (electron/own-server.js):
 *   - the master key is OpenSSL's EVP_BytesToKey (MD5), as every other
 *     implementation derives it; with a fixed salt, the bytes written are
 *     the fixed vectors Android's Shadowsocks.kt is checked against
 *     (fixtures/ss-vectors.json)
 *   - a stream sealed by one side opens on the other, cut at any byte
 *   - something that does not authenticate (another password, a byte
 *     changed) is told, never passed on
 *   - Shroudly's client through Shroudly's server reaches a site, for each
 *     method; with a user name and password on the client, a program
 *     without them is refused; the server never answers a wrong password or a replayed
 *     connection, it only holds it in silence
 *   - with the reference implementation (shadowsocks-libev's ss-server and
 *     ss-local, installed in CI): its server takes Shroudly's client, and its
 *     client goes through Shroudly's server
 *   - links: socks5, http, host:port, ss:// (SIP002 and the older form),
 *     user names with ":" refused, unknown methods named; no password in
 *     what is shown
 *   - the test of Settings: a site's certificate through each kind of
 *     server, and what is told when it does not come (no answer, a refused
 *     password, one asked for, a Shadowsocks server that stays silent, a
 *     server that answers but carries no site) */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const H = require('./helpers');
const SS = require(path.join(H.ROOT, 'electron', 'shadowsocks.js'));
const Own = require(path.join(H.ROOT, 'electron', 'own-server.js'));

const t = H.suite('shadowsocks');

function site() {
  return net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', (d) => c.end(`HTTP/1.1 200 OK\r\nContent-Length: ${d.length}\r\nConnection: close\r\n\r\n${d}`));
  }).listen(0, '127.0.0.1');
}
const listening = (s) => new Promise((r) => (s.listening ? r() : s.once('listening', r)));

async function viaSocks(port, host, tport, payload = 'GET / HTTP/1.1\r\nHost: x\r\n\r\n') {
  const s = await H.socks(port, host, tport);
  return new Promise((resolve) => {
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out || 'error'));
    s.write(payload);
    setTimeout(() => s.destroy(), 6000);
  });
}

/* What a SOCKS5 server on `port` picks for a greeting that offers no
 * password (0: none needed, 0xff: refused), or -1 for no answer. */
function socksMethodWithout(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(Buffer.from([5, 1, 0])));
    s.once('data', (d) => { resolve(d.length >= 2 ? d[1] : -1); s.destroy(); });
    s.on('error', () => resolve(-1));
    s.on('close', () => resolve(-1));
    setTimeout(() => { s.destroy(); resolve(-1); }, 3000);
  });
}

(async () => {
  // EVP_BytesToKey: MD5(pass) then MD5(prev + pass).
  const k = SS.masterKey('test', 32);
  const d1 = crypto.createHash('md5').update('test').digest();
  const d2 = crypto.createHash('md5').update(Buffer.concat([d1, Buffer.from('test')])).digest();
  t.ok(k.equals(Buffer.concat([d1, d2])) && SS.masterKey('test', 16).equals(d1), 'the master key is OpenSSL\'s EVP_BytesToKey (MD5)');

  // The fixed vectors.
  {
    const V = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'fixtures', 'ss-vectors.json'), 'utf8'));
    const parts = V.plaintext.map((x) => (typeof x === 'string' ? Buffer.from(x, 'hex') : Buffer.alloc(x.count, parseInt(x.byte, 16))));
    const same = Object.entries(V.methods).every(([m, v]) => {
      const key = SS.masterKey(V.password, SS.METHODS[m].key);
      const e = new SS.Encoder(m, key, Buffer.from(v.salt, 'hex'));
      const w = parts.map((x) => e.encode(x));
      const d = new SS.Decoder(m, key);
      const back = d.push(Buffer.concat(w));
      return key.toString('hex') === v.key && w[0].toString('hex') === v.wire[0] && w[1].toString('hex') === v.wire[1]
        && crypto.createHash('sha256').update(w[2]).digest('hex') === v.wire[2].sha256 && w[2].length === v.wire[2].length
        && back.equals(Buffer.concat(parts));
    });
    t.ok(same && Object.keys(V.methods).length === 3, 'with a fixed salt, every method writes the fixed vectors Android is checked against');
  }

  for (const method of Object.keys(SS.METHODS)) {
    const key = SS.masterKey('pw', SS.METHODS[method].key);
    const enc = new SS.Encoder(method, key);
    const dec = new SS.Decoder(method, key);
    const data = Buffer.concat([Buffer.alloc(40000, 7), Buffer.from('end')]);
    const wire = Buffer.concat([enc.encode(data.subarray(0, 100)), enc.encode(data.subarray(100))]);
    let out = Buffer.alloc(0);
    for (let i = 0; i < wire.length; i += 777) out = Buffer.concat([out, dec.push(wire.subarray(i, i + 777))]);
    t.ok(out.equals(data) && !dec.bad, `${method}: what one side seals opens on the other, cut at any byte, in chunks of at most 16 KB`);
    const bad = new SS.Decoder(method, SS.masterKey('other', SS.METHODS[method].key));
    t.ok(bad.push(wire).length === 0 && bad.bad, `${method}: another password does not authenticate, and nothing is passed on`);
    const tampered = Buffer.from(wire);
    tampered[SS.METHODS[method].key + 30] ^= 1;
    const td = new SS.Decoder(method, key);
    t.ok(td.push(tampered).length === 0 && td.bad, `${method}: a byte changed on the way does not authenticate`);
  }
  const tg = SS.decodeTarget(SS.encodeTarget('2001:db8::1', 443));
  const mapped = SS.decodeTarget(SS.encodeTarget('::ffff:127.0.0.1', 80));
  t.ok(SS.decodeTarget(SS.encodeTarget('example.com', 443)).host === 'example.com' && SS.decodeTarget(SS.encodeTarget('1.2.3.4', 80)).port === 80
    && tg && tg.host === '2001:db8:0:0:0:0:0:1' && tg.port === 443 && mapped && mapped.host === '0:0:0:0:0:ffff:7f00:1',
  'targets as in SOCKS5: a name, IPv4, IPv6 (an IPv4 address written inside one too)');

  const web = site();
  await listening(web);
  const webPort = web.address().port;
  const dial = (host, port) => new Promise((res, rej) => { const s = net.connect(port, '127.0.0.1', () => res(s)); s.once('error', rej); });

  for (const method of Object.keys(SS.METHODS)) {
    const server = await SS.startServer({ host: '127.0.0.1', method, password: 'friends-only', dial });
    const client = await SS.startClient({ server: '127.0.0.1', port: server.port, method, password: 'friends-only' });
    const out = await viaSocks(client.port, 'some.site.example', webPort, 'GET /x HTTP/1.1\r\nHost: some.site.example\r\n\r\n');
    t.ok(/^HTTP\/1\.1 200 OK/.test(out) && out.includes('Host: some.site.example') && server.stats().total === 1 && server.stats().people <= 1,
      `${method}: Shroudly's client through Shroudly's server reaches the site; only counts kept`);
    client.close();
    if (method === 'aes-256-gcm') {
      // The engine's way in: a user name and password only it was given.
      const locked = await SS.startClient({ server: '127.0.0.1', port: server.port, method, password: 'friends-only', user: 'e1', pass: 'f2' });
      const without = await socksMethodWithout(locked.port);
      const withAuth = await new Promise((resolve) => {
        const s = net.connect(locked.port, '127.0.0.1', () => s.write(Buffer.from([5, 1, 2])));
        let st = 0;
        s.on('data', (d) => {
          if (st === 0 && d[1] === 2) { st = 1; s.write(Buffer.from([1, 2, 0x65, 0x31, 2, 0x66, 0x32])); return; }
          if (st === 1) { resolve(d[1] === 0); s.destroy(); }
        });
        s.on('error', () => resolve(false));
        setTimeout(() => { s.destroy(); resolve(false); }, 3000);
      });
      t.ok(without === 0xff && withAuth, 'the client with a user name and password: a program without them is refused, the engine with them gets in');
      locked.close();
    }
    await server.close();
  }

  // A wrong password and a replayed connection: held in silence, never answered.
  {
    const method = 'chacha20-ietf-poly1305';
    const server = await SS.startServer({ host: '127.0.0.1', method, password: 'right', dial });
    const probe = (bytes) => new Promise((resolve) => {
      const s = net.connect(server.port, '127.0.0.1', () => s.write(bytes));
      let got = 0;
      s.on('data', (d) => { got += d.length; });
      s.on('error', () => {});
      setTimeout(() => { const open = !s.destroyed; s.destroy(); resolve({ got, open }); }, 1200);
    });
    const wrongKey = SS.masterKey('wrong', 32);
    const wrong = new SS.Encoder(method, wrongKey).encode(Buffer.concat([SS.encodeTarget('127.0.0.1', webPort), Buffer.from('GET / HTTP/1.1\r\n\r\n')]));
    const r1 = await probe(wrong);
    const rightKey = SS.masterKey('right', 32);
    const rec = new SS.Encoder(method, rightKey).encode(Buffer.concat([SS.encodeTarget('127.0.0.1', webPort), Buffer.from('GET / HTTP/1.1\r\n\r\n')]));
    const first = await probe(rec);
    const replay = await probe(rec);
    const noise = await probe(crypto.randomBytes(200));
    t.ok(r1.got === 0 && r1.open && noise.got === 0 && noise.open, 'a wrong password or random bytes: not a byte back, held open in silence');
    t.ok(first.got > 0 && replay.got === 0 && replay.open, 'a recorded connection played back: turned away in silence');
    await server.close();
  }

  // The reference implementation, where it is installed (CI installs it).
  const have = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
  if (have('ss-server') && have('ss-local')) {
    for (const method of ['chacha20-ietf-poly1305', 'aes-256-gcm']) {
      // Its server, Shroudly's client.
      const sp = await H.freePort();
      const ref = spawn('ss-server', ['-s', '127.0.0.1', '-p', String(sp), '-k', 'interop', '-m', method], { stdio: 'ignore' });
      ref.on('error', () => {});
      await H.sleep(800);
      const client = await SS.startClient({ server: '127.0.0.1', port: sp, method, password: 'interop' });
      const out = await viaSocks(client.port, '127.0.0.1', webPort, 'GET /ref HTTP/1.1\r\nHost: r\r\n\r\n');
      t.ok(/^HTTP\/1\.1 200 OK/.test(out), `${method}: shadowsocks-libev's ss-server takes Shroudly's client`);
      client.close();
      ref.kill();
      // Shroudly's server, its client.
      const server = await SS.startServer({ host: '127.0.0.1', method, password: 'interop', dial });
      const lp = await H.freePort();
      const loc = spawn('ss-local', ['-s', '127.0.0.1', '-p', String(server.port), '-b', '127.0.0.1', '-l', String(lp), '-k', 'interop', '-m', method], { stdio: 'ignore' });
      loc.on('error', () => {});
      await H.sleep(800);
      const out2 = await viaSocks(lp, '127.0.0.1', webPort, 'GET /loc HTTP/1.1\r\nHost: l\r\n\r\n');
      t.ok(/^HTTP\/1\.1 200 OK/.test(out2), `${method}: shadowsocks-libev's ss-local goes through Shroudly's server (any common app can join a share)`);
      loc.kill();
      await server.close();
    }
  } else if (process.env.SHROUDLY_SS_REF) {
    throw new Error('shadowsocks-libev (ss-server, ss-local) was to be installed for the reference checks, and is not');
  } else {
    console.log('  --  shadowsocks-libev (ss-server, ss-local) is not installed here: the reference checks run in CI');
  }

  // Links.
  const ok = (s) => Own.parseLink(s);
  const sip = Own.ssLink({ method: 'chacha20-ietf-poly1305', password: 'p@ss:wörd', host: '5.6.7.8', port: 8388, name: 'Ali\'s' });
  const old = `ss://${Buffer.from('aes-256-gcm:secret@[2001:db8::2]:443').toString('base64')}#old`;
  t.ok(ok('socks5://u:p%40ss@1.2.3.4:1080').kind === 'socks5' && ok('socks5://u:p%40ss@1.2.3.4:1080').pass === 'p@ss'
    && ok('http://proxy.ir:3128').kind === 'http' && ok('1.2.3.4:1080').kind === 'socks5' && ok('[2001:db8::1]:1080').host === '2001:db8::1',
  'links: socks5 (a password with "@" escaped), http, a bare host:port, IPv6');
  const p = ok(sip);
  const q = ok(old);
  t.ok(p.ok && p.kind === 'ss' && p.method === 'chacha20-ietf-poly1305' && p.password === 'p@ss:wörd' && p.host === '5.6.7.8' && p.port === 8388 && p.name === 'Ali\'s'
    && q.ok && q.method === 'aes-256-gcm' && q.password === 'secret' && q.host === '2001:db8::2' && q.port === 443,
  'ss:// links: the SIP002 form Shroudly gives out, and the older all-base64 form');
  t.ok(ok('').error === 'empty' && ok('ftp://x:1').error === 'format' && ok('socks5://a:b:c@h:1').ok && ok('socks5://a%3Ab:c@h:1').error === 'user'
    && ok(`ss://${Buffer.from('rc4-md5:x').toString('base64')}@h:1`).error === 'method' && ok('h:70000').error === 'format',
  'what cannot be used is told: nothing, another scheme, a user name with ":", a method not supported, a port out of range');
  t.ok(!Own.describe(p).includes('p@ss') && Own.describe(p) === 'Shadowsocks 5.6.7.8:8388' && Own.engineLine(ok('socks5://u:p@h:1'), 0) === 'socks5://u:p@h:1'
    && Own.engineLine(p, 4242, { user: 'a1', pass: 'b2' }) === 'socks5://a1:b2@127.0.0.1:4242', 'what is shown has no password; the engine gets the server, or the local client (and its password) for Shadowsocks');

  // The test of Settings, against a site with a certificate of its own.
  const opts = H.testServerOptions();
  const secure = tls.createServer(opts, (c) => { c.on('error', () => {}); c.end(); }).listen(0, '127.0.0.1');
  await listening(secure);
  const sp = secure.address().port;
  const T = (link, extra = {}) => Own.test(ok(link), { host: 'test.local', port: sp, ca: opts.cert, timeout: 2500, ...extra });
  {
    const up = H.socksServer(sp);
    const upAuth = H.socksServer(sp, { user: 'ali', pass: 'pw' });
    const http = H.httpProxy(sp, 'mehdi:s3cret');
    const plain = H.socksServer(webPort);
    await Promise.all([up, upAuth, http, plain].map(listening));
    const ss = await SS.startServer({ host: '127.0.0.1', method: 'aes-256-gcm', password: 'right', dial: (h, port) => dial(h, sp) });
    const dead = await H.freePort();
    const r = {
      socks: await T(`socks5://127.0.0.1:${up.address().port}`),
      auth: await T(`socks5://ali:pw@127.0.0.1:${upAuth.address().port}`),
      wrong: await T(`socks5://ali:nope@127.0.0.1:${upAuth.address().port}`),
      asks: await T(`127.0.0.1:${upAuth.address().port}`),
      http: await T(`http://mehdi:s3cret@127.0.0.1:${http.address().port}`),
      httpWrong: await T(`http://mehdi:x@127.0.0.1:${http.address().port}`),
      ss: await T(Own.ssLink({ method: 'aes-256-gcm', password: 'right', host: '127.0.0.1', port: ss.port })),
      ssWrong: await T(Own.ssLink({ method: 'aes-256-gcm', password: 'wrong', host: '127.0.0.1', port: ss.port })),
      dead: await T(`socks5://127.0.0.1:${dead}`),
      notTls: await T(`socks5://127.0.0.1:${plain.address().port}`),
    };
    const w = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.ok ? 'ok' : v.why]));
    t.ok(w.socks === 'ok' && w.auth === 'ok' && w.http === 'ok' && w.ss === 'ok',
      `the test: a site's certificate comes through SOCKS5, SOCKS5 with a password, HTTP CONNECT and Shadowsocks (${JSON.stringify(w)})`);
    t.ok(w.wrong === 'auth' && w.httpWrong === 'auth' && w.asks === 'asks' && w.dead === 'noAnswer' && w.ssWrong === 'silent' && w.notTls === 'tls',
      'the test says why not: a refused password, one asked for, no answer, a silent Shadowsocks server, no site through it');
    t.ok(Own.whyCode('does not answer') === 'noAnswer' && Own.whyCode('refused the user name or password') === 'auth'
      && Own.whyCode('does not speak the protocol chosen') === 'protocol' && Own.whyCode('anything else') === 'protocol',
    'what the engine says about the server, as the codes the window translates');
    for (const x of [up, upAuth, http, plain]) x.close();
    await ss.close();
  }
  secure.close();

  web.close();
  console.log(`shadowsocks: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
