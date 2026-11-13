'use strict';

/* --fake-net <CIDR>: address ranges that stand in for names (the Android
 * app's tunnel answers names with addresses from 198.18.0.0/15 and maps
 * them back before they reach the engine). One that does reach it outlived
 * its mapping (a new tunnel after the phone changed network). It cannot be
 * dialled, and it used to be refused at once so that the app looks the name
 * up again; an app that keeps addresses itself never did (TikTok: hundreds
 * of connections to the old ones in the minute after a network change, "it
 * freezes all the time"). Now the client is told yes and the name it means
 * is read from what it sends first, the server name of its TLS handshake or
 * the Host of an http:// request: the connection goes on by that name. One
 * that names nothing is closed. A datagram to a stand-in address is still
 * dropped. Addresses outside the ranges are untouched; a range that does
 * not parse stops the engine. Also: the ready line carries the engine's
 * pid, which a supervisor without a process handle kills a hung engine by. */

const net = require('net');
const os = require('os');
const dgram = require('dgram');
const tls = require('tls');
const { startEngine, sleep, freePort, socks, socks4, dnsStub, suite, testServerOptions, testClientOptions } = require('./helpers');

const t = suite('engine-fakenet');

function echo() {
  const srv = net.createServer((c) => { c.on('error', () => {}); c.pipe(c); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() })));
}

/* A SOCKS5 CONNECT to an address (IPv4 or IPv6 literal): { rep, ms }. */
function connect5(P, host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect(P, '127.0.0.1');
    let b = Buffer.alloc(0); let st = 0;
    const done = (rep) => { if (st !== 9) { st = 9; s.destroy(); resolve({ rep, ms: Date.now() - t0 }); } };
    s.on('error', () => done(null)); s.on('close', () => done(null));
    setTimeout(() => done(null), 15000);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0 && b.length >= 2) {
        st = 1; b = b.subarray(2);
        const a = net.isIPv4(host) ? Buffer.from([1, ...host.split('.').map(Number)])
          : Buffer.concat([Buffer.from([4]), ip6(host)]);
        s.write(Buffer.concat([Buffer.from([5, 1, 0]), a, Buffer.from([port >> 8, port & 255])]));
      }
      if (st === 1 && b.length >= 10) done(b[1]);
    });
  });
}
function ip6(a) {
  const m = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let v4 = null;
  if (m) { v4 = m[2].split('.').map(Number); a = `${m[1]}0:0`; }
  const [h, tl] = a.split('::');
  const head = h ? h.split(':') : []; const tail = tl !== undefined && tl ? tl.split(':') : [];
  const g = tl === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  const out = Buffer.alloc(16);
  g.forEach((x, i) => out.writeUInt16BE(parseInt(x || '0', 16), i * 2));
  if (v4) out.set(v4, 12);
  return out;
}

function associate(P) {
  return new Promise((resolve, reject) => {
    const ctl = net.connect(P, '127.0.0.1');
    let st = 0; let b = Buffer.alloc(0);
    ctl.once('error', reject);
    ctl.on('connect', () => ctl.write(Buffer.from([5, 1, 0])));
    ctl.on('data', (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0 && b.length >= 2) { b = b.subarray(2); st = 1; ctl.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0])); }
      if (st === 1 && b.length >= 10) { st = 2; resolve({ ctl, rep: b[1], port: b.readUInt16BE(8) }); }
    });
  });
}
const hdr4 = (ip, port) => Buffer.from([0, 0, 0, 1, ...ip.split('.').map(Number), port >> 8, port & 255]);

(async () => {
  const e = await echo();
  const dns = await dnsStub({ 'fake.example': { A: ['93.184.216.34'] } });
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(dns.port),
    '--fake-net', '198.18.0.0/15', '--fake-net', 'fd00:5::/64,203.0.113.77']);

  // ── the ready line
  const ready = JSON.parse(eng.out.split('\n').find((l) => l.includes('"ready"')));
  t.ok(ready.pid === eng.proc.pid, `the ready line carries the engine's pid (${ready.pid})`);
  t.ok(ready.port === P && typeof ready.techniques === 'number', 'next to the fields it always had');

  // ── CONNECT: told yes, then closed when the client names no site
  for (const host of ['198.18.0.1', '198.19.255.254', '203.0.113.77', 'fd00:5::1', '::ffff:198.18.7.7']) {
    const r = await connect5(P, host, 443);
    t.ok(r.rep === 0 && r.ms < 1000, `SOCKS5 CONNECT to ${host}: taken at once (${r.ms} ms)`);
  }
  /* What becomes of a connection to a stand-in address after `send`
   * (nothing when null): 'closed' and after how long, or what came back. */
  const after = async (send) => {
    const s = await socks(P, '198.19.64.9', 443);
    const t0 = Date.now();
    return new Promise((resolve) => {
      let got = Buffer.alloc(0);
      s.on('data', (d) => { got = Buffer.concat([got, d]); });
      s.on('error', () => {}); s.on('close', () => resolve({ ms: Date.now() - t0, got }));
      if (send) s.write(send);
      setTimeout(() => { s.destroy(); resolve({ ms: -1, got }); }, 8000);
    });
  };
  let quiet = await after(null);
  t.ok(quiet.ms >= 0 && quiet.ms < 2000 && quiet.got.length === 0, `a client that says nothing: closed (${quiet.ms} ms), nothing dialled`);
  quiet = await after(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n'));
  t.ok(quiet.ms >= 0 && quiet.ms < 2000 && quiet.got.length === 0, `one whose first bytes name no site (not TLS, not HTTP): closed (${quiet.ms} ms)`);
  const s4 = await socks4(P, '198.18.1.2', 443).then((s) => { s.destroy(); return 'granted'; }, (err) => err.message);
  t.ok(s4 === 'granted', `SOCKS4 CONNECT to 198.18.1.2: taken too (${s4})`);
  const outside = await socks(P, '127.0.0.1', e.port).then((s) => { s.destroy(); return true; }, () => false);
  t.ok(outside, 'an address outside the ranges is connected to as always');
  const r20 = await connect5(P, '198.20.0.1', 9);
  t.ok(r20.rep !== 2, `198.20.0.1 (just past 198.18.0.0/15) is not refused as a stand-in (reply ${r20.rep})`);

  // ── the name in what the client sends first: the connection goes on by it
  {
    const OK = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok';
    const site = tls.createServer(testServerOptions(), (x) => { x.on('error', () => {}); x.once('data', () => x.end(OK)); });
    await new Promise((r) => site.listen({ port: 0, host: '::1', ipv6Only: true }, r));
    const web = net.createServer((x) => { x.on('error', () => {}); x.once('data', (d) => x.end(/Host: old\.example/.test(d) ? OK : 'HTTP/1.1 400 Bad\r\n\r\n')); });
    await new Promise((r) => web.listen({ port: 0, host: '::1', ipv6Only: true }, r));
    const dns6 = await dnsStub({ 'kept.example': { AAAA: ['::1'] }, 'old.example': { AAAA: ['::1'] } });
    const P6 = await freePort();
    const e6 = await startEngine(P6, ['--auto', '--doh', '--doh-port', String(dns6.port), '--ipv6', '--fake-net', '198.18.0.0/15']);
    const raw = await socks(P6, '198.19.65.42', site.address().port);
    const page = await new Promise((resolve) => {
      const x = tls.connect({ socket: raw, servername: 'kept.example', ...testClientOptions(), ALPNProtocols: ['http/1.1'] });
      let out = '';
      x.on('secureConnect', () => x.write('GET / HTTP/1.1\r\nHost: kept.example\r\nConnection: close\r\n\r\n'));
      x.on('data', (d) => { out += d; }); x.on('end', () => resolve(out.split('\r\n')[0])); x.on('error', (err) => resolve(`error ${err.message}`));
      setTimeout(() => resolve('timeout'), 15000);
    });
    t.ok(page === 'HTTP/1.1 200 OK', `an address kept from an earlier tunnel, a TLS handshake that names the site: the site comes (${page})`);
    const raw2 = await socks(P6, '198.19.65.43', web.address().port);
    const plain = await new Promise((resolve) => {
      let out = '';
      raw2.on('data', (d) => { out += d; }); raw2.on('close', () => resolve(out.split('\r\n')[0])); raw2.on('error', () => {});
      raw2.write('GET / HTTP/1.1\r\nHost: old.example\r\nConnection: close\r\n\r\n');
      setTimeout(() => resolve('timeout'), 15000);
    });
    t.ok(plain === 'HTTP/1.1 200 OK', `and an http:// request by its Host (${plain})`);
    await sleep(300);
    e6.proc.stdin.write('CONNS\n');
    await sleep(400);
    t.ok(/"host":"kept\.example"/.test(e6.out) && !/"host":"198\.19\.65\.42"/.test(e6.out), 'listed under the site\'s name, not the address');
    t.ok(e6.exited === null && !/AddressSanitizer|runtime error:/.test(e6.err), 'engine still up, no sanitizer errors');
    e6.stop(); site.close(); web.close(); dns6.close();
  }

  // ── UDP
  const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal);
  const LAN4 = (ifaces.find((i) => i.family === 'IPv4' || i.family === 4) || {}).address || null;
  const a = await associate(P);
  const c = dgram.createSocket('udp4');
  const got = [];
  c.on('message', (m) => got.push(m));
  await new Promise((r) => c.bind(0, '127.0.0.1', r));
  const asked = dns.queries.length;
  const q = Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, 102, 97, 107, 101, 7, 101, 120, 97, 109, 112, 108, 101, 0, 0, 1, 0, 1]);
  c.send(Buffer.concat([hdr4('198.18.0.2', 53), q]), a.port, '127.0.0.1');            // DNS to a stand-in
  c.send(Buffer.concat([hdr4('198.18.0.9', 7777), Buffer.from('x')]), a.port, '127.0.0.1');
  await sleep(1000);
  t.ok(got.length === 0 && dns.queries.length === asked, 'datagrams to a stand-in address are dropped, DNS to one included (not sent to the forwarder either)');
  if (LAN4) {
    const u = dgram.createSocket('udp4');
    u.on('message', (m, from) => u.send(m, from.port, from.address));
    await new Promise((r) => u.bind(0, LAN4, r));
    c.send(Buffer.concat([hdr4(LAN4, u.address().port), Buffer.from('fine')]), a.port, '127.0.0.1');
    for (let w = 0; w < 2000 && !got.length; w += 20) await sleep(20);
    t.ok(got.length === 1 && got[0].subarray(10).toString() === 'fine', 'and the association still relays to anywhere else');
    u.close();
  } else {
    console.log('  --  no LAN IPv4 address here: the relay check after a stand-in is skipped');
  }
  a.ctl.destroy(); c.close();

  // ── a range that does not parse stops the engine
  for (const bad of ['198.18.0.0/33', 'not-an-address', '198.18.0.0/']) {
    const Pb = await freePort();
    const r = await startEngine(Pb, ['--fake-net', bad]).then((x) => { x.stop(); return 'started'; }, (err) => err.message);
    t.ok(r !== 'started', `--fake-net ${bad}: the engine does not start`);
  }

  // ── without it nothing is refused as a stand-in
  const P2 = await freePort();
  const plain = await startEngine(P2, ['--auto']);
  const ready2 = JSON.parse(plain.out.split('\n').find((l) => l.includes('"ready"')));
  t.ok(ready2.pid === plain.proc.pid && ready2.pid !== ready.pid, 'each engine names its own pid');
  const r2 = await connect5(P2, '198.18.0.1', 9);
  t.ok(r2.rep !== 2, `without --fake-net, 198.18.0.1 is dialled as any address (reply ${r2.rep} after ${r2.ms} ms)`);

  await sleep(300);
  t.ok(eng.exited === null && plain.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err + plain.err),
    'engines still up, no sanitizer errors');
  eng.stop(); plain.stop(); e.close(); dns.close();
  console.log(`engine-fakenet: ${t.count} passed`);
  process.exit(0);
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
