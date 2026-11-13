'use strict';

/* Issue #67: with "Your own server", DNS went straight out to the resolvers
 * from the user's own connection (a DNS leak test saw both the server's
 * address and the provider's). Now every question goes through the engine,
 * and so through the server, as everything else does:
 *   - the built-in encrypted DNS: every route through the engine's SOCKS5
 *     port (a stand-in here, which really connects on), answered; none
 *     straight out, not even while the engine is not up yet
 *   - a DNS server of the user's own: through the engine by name, plain DNS
 *     over TCP; not one UDP packet straight to it
 *   - without a server of one's own, as before
 *   - the wiring: the engine manager turns it on with the server */

const fs = require('fs');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const { ROOT, suite } = require('./helpers');

const t = suite('own-server-dns');
const DohForwarder = require(path.join(ROOT, 'electron', 'doh-forwarder.js'));
const C = require(path.join(ROOT, 'electron', 'custom-dns.js'));
const { buildQuery } = DohForwarder;

/* The engine's SOCKS5 port, standing in: records each target and connects
 * on to it for real (or to `redirect` for names it is given). */
function socksStandIn(redirect = {}) {
  const targets = [];
  const srv = net.createServer((c) => {
    let st = 0; let buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', function on(d) {
      buf = Buffer.concat([buf, d]);
      if (st === 0) { if (buf.length < 3) return; buf = buf.subarray(2 + buf[1]); st = 1; c.write(Buffer.from([5, 0])); }
      if (st === 1) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const len = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + buf[4];
        if (buf.length < len) return;
        const host = atyp === 1 ? [...buf.subarray(4, 8)].join('.') : atyp === 3 ? buf.subarray(5, 5 + buf[4]).toString() : 'v6';
        const port = buf.readUInt16BE(len - 2);
        targets.push(`${host}:${port}`);
        c.removeListener('data', on);
        const to = redirect[`${host}:${port}`] || [host, port];
        const up = net.connect(to[1], to[0], () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); const rest = buf.subarray(len); if (rest.length) up.write(rest); c.pipe(up); up.pipe(c); });
        up.on('error', () => c.destroy());
      }
    });
  }).listen(0, '127.0.0.1');
  srv.targets = targets;
  return srv;
}

/* A DNS answer to `q`: one A record, 192.0.2.7. */
function answer(q) {
  const r = Buffer.from(q);
  r[2] = 0x81; r[3] = 0x80; r.writeUInt16BE(1, 6);
  return Buffer.concat([r, Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 7])]);
}

(async () => {
  // ── The built-in routes ──
  const socks = socksStandIn();
  await new Promise((r) => socks.once('listening', r));
  {
    const d = new DohForwarder(() => {});
    d.setThroughEngine(true);
    const v4 = d.routes.find((r) => net.isIP(r.ip) === 4 && !r.viaEngine);
    const v6 = d.routes.find((r) => net.isIP(r.ip) === 6);
    t.ok(!d.usable(v4) && d.ordered().length === 0, 'the engine not up yet: no route at all, none straight out');
    let refused = false;
    try { await d.resolveRoutes(buildQuery('example.com', 1)); } catch { refused = true; }
    t.ok(refused && socks.targets.length === 0, 'and a question then gets no answer rather than a resolver straight out');
    d.setSocksPort(socks.address().port);
    t.ok(d.usable(v4) && (!v6 || !d.usable(v6)), 'the engine up: every IPv4 route through it (its SOCKS5 port takes addresses)');
    const a = await d.resolveRoutes(buildQuery('example.com', 1));
    t.ok(Buffer.isBuffer(a) && a.length > 12 && C.firstA(a), `answered through the engine (${C.firstA(a)})`);
    const ips = new Set(d.routes.map((r) => `${r.ip}:443`));
    t.ok(socks.targets.length > 0 && socks.targets.every((x) => ips.has(x)), `every connection a resolver's, through the engine (${[...new Set(socks.targets)].join(', ')})`);
    const open = d.routes.filter((r) => r.session);
    t.ok(open.length > 0 && open.every((r) => socks.targets.includes(`${r.ip}:443`)),
      `each open connection, of either kind of route, made through the engine (${open.map((r) => r.id).join(', ')})`);
    d.setThroughEngine(false);
    t.ok(d.routes.every((r) => !r.session) && d.usable(v4), 'off again (no server of one\'s own): connections dropped, routes as before');
    d.stop();
  }

  // ── A DNS server of one's own ──
  {
    const udpHits = [];
    const tcpHits = [];
    const onTcp = (c) => {
      let buf = Buffer.alloc(0);
      c.on('error', () => {});
      c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
          const q = buf.subarray(2, 2 + buf.readUInt16BE(0)); buf = buf.subarray(2 + q.length);
          tcpHits.push(q);
          const a = answer(q); const l = Buffer.alloc(2); l.writeUInt16BE(a.length, 0);
          c.write(Buffer.concat([l, a]));
        }
      });
    };
    // UDP and TCP on the same port: one the system gave for one kind may be
    // one Windows keeps back for the other (its excluded port ranges), so
    // each round asks for a port the other way round, and says why at the end.
    let udp, tcpSrv; const why = [];
    const bindUdp = (port) => new Promise((r) => {
      udp = dgram.createSocket('udp4');
      udp.on('message', (m, rinfo) => { udpHits.push(m); udp.send(answer(m), rinfo.port, rinfo.address); });
      udp.once('error', (e) => { why.push('udp ' + e.code); try { udp.close(); } catch {} r(false); });
      udp.bind(port, '127.0.0.1', () => r(true));
    });
    const listenTcp = (port) => new Promise((r) => {
      tcpSrv = net.createServer(onTcp);
      tcpSrv.once('error', (e) => { why.push('tcp ' + e.code); r(false); });
      tcpSrv.listen(port, '127.0.0.1', () => r(true));
    });
    for (let tries = 0; ; tries++) {
      if (tries % 2 === 0) {
        if (await bindUdp(0)) { if (await listenTcp(udp.address().port)) break; udp.close(); }
      } else if (await listenTcp(0)) {
        if (await bindUdp(tcpSrv.address().port)) break;
        await new Promise((r) => tcpSrv.close(r));
      }
      if (tries === 40) throw new Error('no port free for both UDP and TCP: ' + why.slice(-6).join(', '));
    }
    const port = udp.address().port;
    // The name is sent to the engine, which hands it to the server; here
    // the stand-in sends it to this computer's DNS stand-ins.
    const via = socksStandIn({ [`dns.example:${port}`]: ['127.0.0.1', port] });
    await new Promise((r) => via.once('listening', r));
    let through = true;
    const spec = C.parse('udp', `dns.example:${port}`);
    const d = new C.CustomDns(spec, { socksPort: () => via.address().port, throughEngine: () => through, bootstrap: async () => '127.0.0.1' });
    const a = await d.query(buildQuery('example.org', 1));
    t.ok(C.firstA(a) === '192.0.2.7' && udpHits.length === 0 && tcpHits.length === 1 && via.targets[0] === `dns.example:${port}`,
      `plain DNS of one's own with a server: over TCP through the engine, by name (${via.targets.join(', ')}; ${udpHits.length} UDP packets)`);
    const e = new C.CustomDns(spec, { socksPort: () => 0, throughEngine: () => true, bootstrap: async () => '127.0.0.1' });
    let waited = false;
    try { await e.query(buildQuery('example.org', 1)); } catch (err) { waited = /waiting for the engine/.test(err.message); }
    t.ok(waited && udpHits.length === 0, 'the engine not up yet: no answer, and nothing straight to the server');
    through = false;
    d.drop();
    const b = await d.query(buildQuery('example.net', 1));
    t.ok(C.firstA(b) === '192.0.2.7' && udpHits.length === 1, 'without a server of one\'s own: plain DNS over UDP, as before');
    const own = new C.CustomDns(C.parse('tcp', `127.0.0.1:${port}`), { socksPort: () => via.address().port, throughEngine: () => true, proxy: C.parseProxy(`socks5://127.0.0.1:${via.address().port}`) });
    t.ok(own.through().port === via.address().port, 'a proxy the user chose for the DNS server (#58) is kept');
    d.close(); own.close();
    udp.close(); tcpSrv.close(); via.close();
  }
  socks.close();

  // ── The wiring ──
  const em = fs.readFileSync(path.join(ROOT, 'electron', 'engine-manager.js'), 'utf8');
  t.ok(/async _prepareUpstream\(\) \{\s*const p = this\.ownServer\(\);[\s\S]{0,200}this\.doh\.setThroughEngine\(!!p\)/.test(em), 'the engine manager: on with the server, off without, at each start');
  console.log(`own-server-dns: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
