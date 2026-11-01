'use strict';

/* The user's own server (--upstream-file): every connection to a name goes
 * through it, the name sent as a name so the server looks it up (no lookup
 * of the engine's own), as in a shutdown where a server inside the country
 * still reaches the world. Covered:
 *   - SOCKS5, with and without a user name and password; HTTP CONNECT with
 *     Basic authentication: the site's answer comes back through it
 *   - a wrong password, a server that does not answer, a server that speaks
 *     another protocol: the client is refused, and the engine says why once
 *   - an address on this computer goes straight, not through the server
 *   - a file that cannot be used stops the engine instead of running without */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const H = require('./helpers');

const t = H.suite('engine-upstream');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-upstream-'));
const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text, { mode: 0o600 }); return f; };

/* A site: answers any request with a page naming the name it was asked as. */
function site() {
  return net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', () => c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  }).listen(0, '127.0.0.1');
}

/* A SOCKS5 server that takes names, with an optional user and password,
 * and connects every name to `to` (the site). */
function socksServer(to, { user = null, pass = null } = {}) {
  const asked = [];
  const srv = net.createServer((c) => {
    c.on('error', () => {});
    let b = Buffer.alloc(0);
    let st = 'hello';
    c.on('data', function on(d) {
      b = Buffer.concat([b, d]);
      if (st === 'hello' && b.length >= 2 && b.length >= 2 + b[1]) {
        const methods = [...b.subarray(2, 2 + b[1])];
        b = b.subarray(2 + b[1]);
        if (user) { if (!methods.includes(2)) { c.end(Buffer.from([5, 0xff])); return; } c.write(Buffer.from([5, 2])); st = 'auth'; }
        else { c.write(Buffer.from([5, 0])); st = 'req'; }
      }
      if (st === 'auth' && b.length >= 2 && b.length >= 3 + b[1] && b.length >= 3 + b[1] + b[2 + b[1]]) {
        const ul = b[1];
        const u = b.subarray(2, 2 + ul).toString();
        const pl = b[2 + ul];
        const p = b.subarray(3 + ul, 3 + ul + pl).toString();
        b = b.subarray(3 + ul + pl);
        if (u !== user || p !== pass) { c.end(Buffer.from([1, 1])); return; }
        c.write(Buffer.from([1, 0]));
        st = 'req';
      }
      if (st === 'req' && b.length >= 5) {
        const atyp = b[3];
        const len = atyp === 3 ? 5 + b[4] + 2 : atyp === 1 ? 10 : 22;
        if (b.length < len) return;
        const host = atyp === 3 ? b.subarray(5, 5 + b[4]).toString() : atyp === 1 ? [...b.subarray(4, 8)].join('.') : 'v6';
        const port = b.readUInt16BE(len - 2);
        asked.push({ atyp, host, port });
        c.removeListener('data', on);
        const rest = b.subarray(len);
        const up = net.connect(to, '127.0.0.1', () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) up.write(rest);
          c.pipe(up); up.pipe(c);
        });
        up.on('error', () => c.destroy());
      }
    });
  }).listen(0, '127.0.0.1');
  srv.asked = asked;
  return srv;
}

/* An HTTP proxy that takes CONNECT, with Basic authentication. */
function httpProxy(to, auth) {
  const asked = [];
  const srv = net.createServer((c) => {
    c.on('error', () => {});
    let head = '';
    c.on('data', function on(d) {
      head += d.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      c.removeListener('data', on);
      const line = head.split('\r\n')[0];
      const got = (/^Proxy-Authorization: Basic (\S+)$/mi.exec(head) || [])[1];
      asked.push({ line, auth: got ? Buffer.from(got, 'base64').toString() : null });
      if (auth && got !== Buffer.from(auth).toString('base64')) { c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      const up = net.connect(to, '127.0.0.1', () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n');
        c.pipe(up); up.pipe(c);
      });
      up.on('error', () => c.destroy());
    });
  }).listen(0, '127.0.0.1');
  srv.asked = asked;
  return srv;
}

async function fetchVia(P, host, port) {
  const s = await H.socks(P, host, port);
  return new Promise((resolve) => {
    let out = '';
    s.on('data', (d) => { out += d; });
    s.on('close', () => resolve(out.split('\r\n')[0]));
    s.on('error', () => resolve('error'));
    s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    setTimeout(() => s.destroy(), 8000);
  });
}

const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));

(async () => {
  const web = site();
  await listening(web);
  const sitePort = web.address().port;

  // SOCKS5, no password: the name goes to the server as a name.
  {
    const up = socksServer(sitePort);
    await listening(up);
    const P = await H.freePort();
    const eng = await H.startEngine(P, ['--upstream-file', file('s.txt', `socks5://127.0.0.1:${up.address().port}\n`)]);
    const first = await fetchVia(P, 'blocked-abroad.example', 443);
    t.ok(first === 'HTTP/1.1 200 OK' && up.asked.length === 1 && up.asked[0].atyp === 3 && up.asked[0].host === 'blocked-abroad.example' && up.asked[0].port === 443,
      `SOCKS5: the site comes back through the server, asked by name (${JSON.stringify(up.asked[0] || null)})`);
    // An address on this computer: straight, not through the server.
    const local = await fetchVia(P, '127.0.0.1', sitePort);
    t.ok(local === 'HTTP/1.1 200 OK' && up.asked.length === 1, 'an address on this computer goes straight, not through the server');
    eng.stop(); up.close();
  }

  // SOCKS5 with a user name and password: right, then wrong.
  {
    const up = socksServer(sitePort, { user: 'ali', pass: 'p@ss:wörd' });
    await listening(up);
    const P = await H.freePort();
    const eng = await H.startEngine(P, ['--upstream-file', file('a.txt', `socks5://ali:p@ss:wörd@127.0.0.1:${up.address().port}`)]);
    t.ok(await fetchVia(P, 'a.example', 443) === 'HTTP/1.1 200 OK', 'SOCKS5 with a user name and a password that holds "@", ":" and letters outside English');
    eng.stop();
    const P2 = await H.freePort();
    const eng2 = await H.startEngine(P2, ['--upstream-file', file('w.txt', `socks5://ali:wrong@127.0.0.1:${up.address().port}`)]);
    let refused = false;
    try { await H.socks(P2, 'b.example', 443); } catch { refused = true; }
    await H.sleep(300);
    t.ok(refused && /"type":"upstream","ok":0,"why":"refused the user name or password"/.test(eng2.out), 'a wrong password: the client refused, and the engine says why');
    eng2.stop(); up.close();
  }

  // HTTP CONNECT with Basic authentication.
  {
    const up = httpProxy(sitePort, 'mehdi:s3cret');
    await listening(up);
    const P = await H.freePort();
    const eng = await H.startEngine(P, ['--upstream-file', file('h.txt', `http://mehdi:s3cret@127.0.0.1:${up.address().port}`)]);
    const first = await fetchVia(P, 'c.example', 443);
    t.ok(first === 'HTTP/1.1 200 OK' && up.asked[0] && up.asked[0].line === 'CONNECT c.example:443 HTTP/1.1' && up.asked[0].auth === 'mehdi:s3cret',
      `HTTP CONNECT with its user name and password (${JSON.stringify(up.asked[0] || null)})`);
    eng.stop(); up.close();
  }

  // A server that does not answer; one that speaks something else.
  {
    const dead = await H.freePort();
    const P = await H.freePort();
    const eng = await H.startEngine(P, ['--upstream-file', file('d.txt', `socks5://127.0.0.1:${dead}`)]);
    let refused = false;
    try { await H.socks(P, 'd.example', 443); } catch { refused = true; }
    await H.sleep(300);
    t.ok(refused && /"type":"upstream","ok":0,"why":"does not answer"/.test(eng.out), 'a server that does not answer: refused, and said');
    eng.stop();
    const other = net.createServer((c) => { c.on('error', () => {}); c.on('data', () => c.end('HTTP/1.1 400 Bad Request\r\n\r\n')); }).listen(0, '127.0.0.1');
    await listening(other);
    const P2 = await H.freePort();
    const eng2 = await H.startEngine(P2, ['--upstream-file', file('o.txt', `socks5://127.0.0.1:${other.address().port}`)]);
    refused = false;
    try { await H.socks(P2, 'e.example', 443); } catch { refused = true; }
    await H.sleep(300);
    t.ok(refused && /"why":"does not speak the protocol chosen"/.test(eng2.out), 'a server that speaks something else: refused, and said');
    eng2.stop(); other.close();
  }

  // A file that cannot be used: the engine does not start without it.
  for (const [name, text] of [['bad1', 'ftp://1.2.3.4:21'], ['bad2', 'socks5://host-without-port'], ['bad3', 'socks5://h:99999'], ['bad4', 'socks5://a:b@c:1\nsocks5://d:2']]) {
    const P = await H.freePort();
    let failed = null;
    try { const e = await H.startEngine(P, ['--upstream-file', file(`${name}.txt`, text)]); e.stop(); } catch (e) { failed = e.message; }
    t.ok(failed && /exited \(2\)/.test(failed), `an unusable file (${name}): the engine does not start without the server asked for`);
  }

  web.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`engine-upstream: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
