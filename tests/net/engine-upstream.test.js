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
const { socksServer, httpProxy } = H;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-upstream-'));
const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text, { mode: 0o600 }); return f; };

/* A site: answers any request with a page naming the name it was asked as. */
function site() {
  return net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', () => c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'));
  }).listen(0, '127.0.0.1');
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
