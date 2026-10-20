'use strict';

/* --fake-net <CIDR>: address ranges that stand in for names (the Android
 * app's tunnel answers names with addresses from 198.18.0.0/15 and maps
 * them back before they reach the engine). One that does reach it outlived
 * its mapping, so a CONNECT to it is refused at once (SOCKS5 0x02, SOCKS4
 * 0x5B) and a datagram to it is dropped, instead of waiting out a connect
 * timeout. Addresses outside the ranges are untouched; a range that does
 * not parse stops the engine. Also: the ready line carries the engine's
 * pid, which a supervisor without a process handle kills a hung engine by. */

const net = require('net');
const os = require('os');
const dgram = require('dgram');
const { startEngine, sleep, freePort, socks, socks4, dnsStub, suite } = require('./helpers');

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

  // ── CONNECT
  for (const host of ['198.18.0.1', '198.19.255.254', '203.0.113.77', 'fd00:5::1', '::ffff:198.18.7.7']) {
    const r = await connect5(P, host, 443);
    t.ok(r.rep === 2 && r.ms < 1000, `SOCKS5 CONNECT to ${host}: refused with 0x02 at once (${r.ms} ms)`);
  }
  const s4 = await socks4(P, '198.18.1.2', 443).then(() => 'granted', (err) => err.message);
  t.ok(/SOCKS4 reply 91/.test(s4), `SOCKS4 CONNECT to 198.18.1.2: refused (${s4})`);
  const outside = await socks(P, '127.0.0.1', e.port).then((s) => { s.destroy(); return true; }, () => false);
  t.ok(outside, 'an address outside the ranges is connected to as always');
  const r20 = await connect5(P, '198.20.0.1', 9);
  t.ok(r20.rep !== 2, `198.20.0.1 (just past 198.18.0.0/15) is not refused as a stand-in (reply ${r20.rep})`);

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
