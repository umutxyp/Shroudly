'use strict';

/* A server that is down is not a censored one. While it is down it takes the
 * connection and never answers (an overloaded load balancer, a dead backend):
 * from the engine that looks exactly like a filter that drops a handshake
 * silently, so its ladder runs out and leaves a place to carry on from. But
 * that is a place to search from, not evidence: once the server is back,
 * nothing may be learned from it, no other name of the site may inherit it,
 * and no connection to any of them may carry a technique. A desync technique
 * is only ever attached to a site the network was seen to block.
 *
 * Nothing is censored here at all. A front stands before the real server:
 * while "down" it swallows every connection (nothing forwarded, nothing back,
 * nothing closed), when "up" it is a transparent pipe. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-outage');

/* Whether the client's first TLS record holds this whole server name: an
 * untouched handshake (or one split at the TCP level only) does; one a
 * technique re-framed into several records does not. null while the first
 * record is still arriving. */
function untouched(buf, name) {
  if (buf.length < 5 || buf.length < 5 + buf.readUInt16BE(3)) return null;
  return buf.subarray(0, 5 + buf.readUInt16BE(3)).includes(Buffer.from(name));
}

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  let down = true;
  let name = '';         // the server name being visited
  const seen = [];       // per connection: was its first record untouched?
  const front = net.createServer((c) => {
    c.on('error', () => {});
    let buf = Buffer.alloc(0), u = null;
    const isDown = down;
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      buf = Buffer.concat([buf, d]);
      const k = untouched(buf, name);
      if (k === null) return;
      seen.push(k);
      if (isDown) { c.removeAllListeners('data'); return; }          // swallowed
      u = net.connect(server.address().port, '127.0.0.1');
      u.on('error', () => c.destroy());
      u.write(buf); u.pipe(c);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => front.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--auto']);
  const events = (from, type) => eng.out.slice(from).split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => JSON.parse(l));
  async function visit(host) {
    name = host;
    const mark = eng.out.length; const from = seen.length;
    const s0 = await eng.stats();
    const t0 = Date.now();
    const raw = await socks(P, '127.0.0.1', front.address().port);
    const ok = await new Promise((resolve) => {
      const s = tls.connect({ socket: raw, servername: host, rejectUnauthorized: false });
      let over = false;
      // A browser gives up on its own; here, as soon as the engine has.
      const iv = setInterval(() => { if (events(mark, 'blocked').length) fin(false); }, 100);
      function fin(v) { if (over) return; over = true; clearInterval(iv); s.destroy(); resolve(v); }
      s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { if (d.includes('200 OK')) fin(true); });
      s.on('error', () => fin(false)); s.on('close', () => fin(false));
      setTimeout(() => fin(false), 20000);
    });
    const ms = Date.now() - t0;
    await sleep(300);
    const s1 = await eng.stats();
    return { ok, ms, desync: s1.desync - s0.desync, tries: seen.slice(from),
      bypass: events(mark, 'bypass'), blocked: events(mark, 'blocked') };
  }
  const shapes = (r) => r.tries.map((x) => (x ? 'untouched' : 'technique')).join(', ');

  // The outage: api. is down for one connection's whole ladder.
  let r = await visit('api.outage.example');
  t.ok(!r.ok && r.blocked.length === 1 && r.blocked[0].note === 'silent',
    `server down: nothing answers, the ladder gives up (${shapes(r)})`);
  t.ok(!r.bypass.length, 'and nothing is learned from it');

  down = false;
  // www. was never down. Its first connection must not start from where
  // api.'s search left off: that was one name's outage, not the site's filter.
  r = await visit('www.outage.example');
  t.ok(r.ok && r.desync === 0 && r.tries.length === 1 && r.tries[0],
    `another name of the site, once the server is back: untouched, one attempt (${r.ms} ms, ${shapes(r)})`);
  t.ok(!r.bypass.length, 'no bypass reported for it');
  r = await visit('www.outage.example');
  t.ok(r.ok && r.desync === 0, 'and its next connection is untouched too');
  r = await visit('cdn.outage.example');
  t.ok(r.ok && r.desync === 0 && !r.bypass.length, 'nor does any other name of the site carry a technique');

  // api. itself still has its place to search from. Its next ladder sends the
  // untouched request first, which the server, being back, answers before a
  // technique has even gone out: used, nothing learned, the search dropped.
  r = await visit('api.outage.example');
  t.ok(r.ok && r.tries[0] && !r.bypass.length,
    `the name that was down: its untouched request goes first and is answered (${r.ms} ms, ${shapes(r)})`);
  t.ok(r.desync === 0 && r.tries.length === 1, `no technique was needed or sent (${r.desync} desync)`);
  r = await visit('api.outage.example');
  t.ok(r.ok && r.desync === 0 && r.tries.length === 1 && r.tries[0] && r.ms < 2000,
    'and its next connection is an ordinary untouched one: the search is over');

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); front.close();
  console.log(`engine-outage: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
