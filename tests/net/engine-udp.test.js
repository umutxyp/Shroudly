'use strict';

/* SOCKS5 UDP ASSOCIATE (RFC 1928 section 7), which the Android app's
 * tun2socks uses for every UDP flow of the phone: games, voice calls, apps'
 * own DNS. The control connection gets a relay port on 127.0.0.1; each
 * datagram sent there carries a header naming its destination (an IPv4 or
 * IPv6 address, or a name the engine resolves itself), goes out without it,
 * and what comes back is returned headed with where it came from, to the
 * client address that sent last. Fragments, malformed headers and datagrams
 * from anyone but the client are dropped; closing the control connection ends
 * the association. Local echo servers stand in for the far side, and a local
 * DNS server for the app's encrypted-DNS forwarder; only the last check (a
 * real DNS query) needs the internet, and it is skipped cleanly without it. */

const net = require('net');
const os = require('os');
const dgram = require('dgram');
const { startEngine, sleep, freePort, dnsStub, suite } = require('./helpers');

const t = suite('engine-udp');
const BUF = { sendBufferSize: 1 << 20, recvBufferSize: 1 << 20 };

/* An echo server: sends every datagram back unchanged, and counts them. */
function echoServer(type, host) {
  const s = dgram.createSocket({ type, ...BUF });
  const e = { got: 0, sources: [], close: () => { try { s.close(); } catch {} } };
  s.on('message', (m, from) => { e.got++; e.sources.push(`${from.address}:${from.port}`); s.send(m, from.port, from.address); });
  return new Promise((resolve) => {
    s.once('error', () => resolve(null));
    s.bind(0, host, () => { e.port = s.address().port; resolve(e); });
  });
}

/* Ask for an association: resolves { ctl, port, rep } once the engine replies. */
function associate(P, req = [5, 3, 0, 1, 0, 0, 0, 0, 0, 0]) {
  return new Promise((resolve, reject) => {
    const ctl = net.connect(P, '127.0.0.1');
    let st = 0; let b = Buffer.alloc(0);
    ctl.once('error', reject);
    ctl.on('connect', () => ctl.write(Buffer.from([5, 1, 0])));
    ctl.on('data', (d) => {
      b = Buffer.concat([b, d]);
      if (st === 0 && b.length >= 2) { b = b.subarray(2); st = 1; ctl.write(Buffer.from(req)); }
      if (st === 1 && b.length >= 10) {
        st = 2;
        resolve({ ctl, rep: b[1], atyp: b[3], addr: [...b.subarray(4, 8)].join('.'), port: b.readUInt16BE(8) });
      }
    });
    ctl.on('close', () => { if (st < 2) reject(new Error('closed before a reply')); });
  });
}

function header(host, port) {
  let a;
  if (net.isIPv4(host)) a = Buffer.from([1, ...host.split('.').map(Number)]);
  else if (net.isIPv6(host)) a = Buffer.concat([Buffer.from([4]), ip6(host)]);
  else a = Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host)]);
  return Buffer.concat([Buffer.from([0, 0, 0]), a, Buffer.from([port >> 8, port & 255])]);
}

function ip6(a) {
  const [h, tl] = a.split('::');
  const head = h ? h.split(':') : []; const tail = tl !== undefined && tl ? tl.split(':') : [];
  const g = tl === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  const out = Buffer.alloc(16);
  g.forEach((x, i) => out.writeUInt16BE(parseInt(x || '0', 16), i * 2));
  return out;
}

/* A reply's header: { frag, host, port, data }, or null when malformed. */
function parseReply(m) {
  if (m.length < 4) return null;
  let off = 4; let host;
  if (m[3] === 1) { host = [...m.subarray(4, 8)].join('.'); off = 8; }
  else if (m[3] === 4) { host = ip6str(m.subarray(4, 20)); off = 20; }
  else return null;
  return { frag: m[2], host, port: m.readUInt16BE(off), data: m.subarray(off + 2) };
}
function ip6str(b) {
  const g = []; for (let i = 0; i < 16; i += 2) g.push(b.readUInt16BE(i).toString(16));
  return g.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
}

/* A client UDP socket on 127.0.0.1 (or on host). */
function client(host = '127.0.0.1', type = 'udp4') {
  const s = dgram.createSocket({ type, ...BUF });
  const c = { s, msgs: [], close: () => { try { s.close(); } catch {} } };
  s.on('message', (m) => c.msgs.push(m));
  s.on('error', () => {});
  return new Promise((resolve, reject) => { s.once('error', reject); s.bind(0, host, () => resolve(c)); });
}

/* Send through the relay and wait for the next datagram back (or null). */
async function roundTrip(c, relayPort, host, port, payload, ms = 3000) {
  const n = c.msgs.length;
  c.s.send(Buffer.concat([header(host, port), payload]), relayPort, '127.0.0.1');
  for (let waited = 0; waited < ms && c.msgs.length === n; waited += 20) await sleep(20);
  return c.msgs.length > n ? parseReply(c.msgs[n]) : null;
}

/* A plain DNS query for name/A; resolves the reply's answer count, or -1. */
function dnsQuery(name) {
  const id = Math.floor(Math.random() * 65535);
  const q = Buffer.alloc(12); q.writeUInt16BE(id, 0); q.writeUInt16BE(0x0100, 2); q.writeUInt16BE(1, 4);
  const labels = Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, 1, 0, 1])]);
  return { id, buf: Buffer.concat([q, labels]) };
}
function dnsAnswers(m, id) { return m && m.length >= 12 && m.readUInt16BE(0) === id && (m[3] & 0x0f) === 0 ? m.readUInt16BE(6) : -1; }

async function directDns(server) {
  const s = dgram.createSocket('udp4');
  const q = dnsQuery('example.com');
  const r = await new Promise((resolve) => {
    s.on('message', (m) => resolve(dnsAnswers(m, q.id)));
    s.on('error', () => resolve(-1));
    s.send(q.buf, 53, server, (e) => { if (e) resolve(-1); });
    setTimeout(() => resolve(-1), 3000);
  });
  try { s.close(); } catch {}
  return r;
}

(async () => {
  const e4 = await echoServer('udp4', '127.0.0.1');
  const e6 = await echoServer('udp6', '::1');   // null where this machine has no IPv6 loopback
  const dns = await dnsStub({ 'udp-echo.example': { AAAA: ['::1'] } });
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(dns.port)]);

  // ── the association itself
  const a = await associate(P);
  t.ok(a.rep === 0 && a.atyp === 1 && a.addr === '127.0.0.1' && a.port > 0,
    `UDP ASSOCIATE granted: relay port ${a.addr}:${a.port}`);
  const c = await client();

  let r = await roundTrip(c, a.port, '127.0.0.1', e4.port, Buffer.from('hello over udp'));
  t.ok(r && r.data.toString() === 'hello over udp', 'IPv4 destination: the payload arrives without its header and the echo comes back');
  t.ok(r && r.frag === 0 && r.host === '127.0.0.1' && r.port === e4.port,
    `the reply is headed with where it came from (${r && `${r.host}:${r.port}`})`);
  t.ok(e4.sources.length === 1 && !e4.sources[0].endsWith(`:${a.port}`),
    'it went out from an outbound socket of its own, not from the relay port');

  if (e6) {
    r = await roundTrip(c, a.port, '::1', e6.port, Buffer.from('six'));
    t.ok(r && r.data.toString() === 'six' && r.host === '::1' && r.port === e6.port,
      'IPv6 destination: echoed, and the reply header is an IPv6 one (ATYP 4)');
    const before = dns.asked['udp-echo.example/AAAA'] || 0;
    r = await roundTrip(c, a.port, 'udp-echo.example', e6.port, Buffer.from('by name'), 6000);
    t.ok(r && r.data.toString() === 'by name' && r.host === '::1' && r.port === e6.port,
      'a name (ATYP 3) is resolved by the engine\'s own resolver and reached');
    t.ok((dns.asked['udp-echo.example/AAAA'] || 0) === before + 1, 'and the name went to our resolver');
    r = await roundTrip(c, a.port, 'udp-echo.example', e6.port, Buffer.from('again'));
    t.ok(r && r.data.toString() === 'again' && (dns.asked['udp-echo.example/AAAA'] || 0) === before + 1,
      'the next datagram to the name reuses that answer instead of asking again');
  } else {
    console.log('  --  no IPv6 loopback here: the IPv6 and by-name checks are skipped');
  }

  const big = Buffer.alloc(60000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
  r = await roundTrip(c, a.port, '127.0.0.1', e4.port, big);
  t.ok(r && r.data.length === big.length && r.data.equals(big), 'a 60000-byte datagram goes through whole, both ways');

  r = await roundTrip(c, a.port, '127.0.0.1', e4.port, Buffer.alloc(0));
  t.ok(r && r.data.length === 0, 'an empty datagram is a datagram too');

  // ── what is dropped
  let got = e4.got;
  c.s.send(Buffer.concat([Buffer.from([0, 0, 1]), header('127.0.0.1', e4.port).subarray(3), Buffer.from('frag')]), a.port, '127.0.0.1');
  c.s.send(Buffer.from([0, 0, 0, 9, 1, 2, 3]), a.port, '127.0.0.1');                   // unknown ATYP
  c.s.send(Buffer.from([0, 0, 0, 1, 127, 0]), a.port, '127.0.0.1');                    // cut short
  c.s.send(Buffer.concat([header('127.0.0.1', 0), Buffer.from('port 0')]), a.port, '127.0.0.1');
  await sleep(500);
  t.ok(e4.got === got, 'a fragment (FRAG != 0) and malformed headers are dropped');
  r = await roundTrip(c, a.port, '127.0.0.1', e4.port, Buffer.from('still here'));
  t.ok(r && r.data.toString() === 'still here', 'and the association goes on working after them');

  // Replies go to the client address that sent last.
  const c2 = await client();
  r = await roundTrip(c2, a.port, '127.0.0.1', e4.port, Buffer.from('from c2'));
  await sleep(200);
  const c1had = c.msgs.length;
  t.ok(r && r.data.toString() === 'from c2', 'a second socket of the client gets its own reply');
  r = await roundTrip(c, a.port, '127.0.0.1', e4.port, Buffer.from('back to c1'));
  t.ok(r && r.data.toString() === 'back to c1' && c.msgs.length === c1had + 1, 'and the reply follows whoever sent last');
  c2.close();

  // Anyone but the client: a datagram from this machine's own LAN address.
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) {
    let stranger = null;
    try { stranger = await client(lan.address); } catch { stranger = null; }
    if (stranger) {
      got = e4.got;
      const sent = await new Promise((resolve) => stranger.s.send(Buffer.concat([header('127.0.0.1', e4.port), Buffer.from('stranger')]), a.port, '127.0.0.1', (e) => resolve(!e)));
      await sleep(500);
      if (sent) t.ok(e4.got === got, `a datagram from a non-loopback source (${lan.address}) is ignored`);
      else console.log('  --  this OS will not send from a LAN address to 127.0.0.1: skipped');
      stranger.close();
    }
  } else {
    console.log('  --  no LAN address: the non-loopback source check is skipped');
  }

  // A BIND is still refused, and a second association has a port of its own.
  const bind = await associate(P, [5, 2, 0, 1, 0, 0, 0, 0, 0, 0]).catch(() => ({ rep: -1 }));
  t.ok(bind.rep === 7, `BIND is refused with 0x07 (got ${bind.rep})`);
  if (bind.ctl) bind.ctl.destroy();
  const a2 = await associate(P);
  t.ok(a2.rep === 0 && a2.port !== a.port, 'each association has a relay port of its own');

  // ── closing the control connection ends it
  a.ctl.destroy();
  await sleep(1500);
  got = e4.got;
  c.s.send(Buffer.concat([header('127.0.0.1', e4.port), Buffer.from('after close')]), a.port, '127.0.0.1');
  await sleep(600);
  t.ok(e4.got === got, 'once the control connection is closed the relay port no longer forwards anything');
  const c3 = await client();
  r = await roundTrip(c3, a2.port, '127.0.0.1', e4.port, Buffer.from('other one'));
  t.ok(r && r.data.toString() === 'other one', 'while the other association is untouched');
  a2.ctl.destroy(); c3.close();

  // ── without our resolver: a name goes to the system's
  const P2 = await freePort();
  const eng2 = await startEngine(P2, ['--auto']);
  const b = await associate(P2);
  const cb = await client();
  r = await roundTrip(cb, b.port, 'localhost', e4.port, Buffer.from('localhost'), 6000);
  if (!r && e6) r = await roundTrip(cb, b.port, 'localhost', e6.port, Buffer.from('localhost'), 6000);
  t.ok(r && r.data.toString() === 'localhost', `"localhost" through the system resolver (reply from ${r && r.host})`);

  // ── the cap: 256 associations at once, the next one refused
  const held = [];
  for (let i = 0; i < 255; i++) held.push(await associate(P2));
  t.ok(held.every((h) => h.rep === 0), '256 associations at once are granted');
  const over = await associate(P2);
  t.ok(over.rep === 1, `the 257th is refused (reply ${over.rep}) and nothing else is affected`);
  over.ctl.destroy();
  r = await roundTrip(cb, b.port, '127.0.0.1', e4.port, Buffer.from('under load'));
  t.ok(r && r.data.toString() === 'under load', 'the ones held still relay');
  held.forEach((h) => h.ctl.destroy());
  await sleep(1500);
  const again = await associate(P2);
  t.ok(again.rep === 0, 'once they are closed, a new one is granted again');
  again.ctl.destroy(); b.ctl.destroy(); cb.close();

  // ── a real DNS query, if this network lets one out
  const servers = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
  let server = null;
  for (const s of servers) if ((await directDns(s)) > 0) { server = s; break; }
  if (server) {
    const d = await associate(P);
    const cd = await client();
    const q = dnsQuery('example.com');
    let n = -1;
    for (let i = 0; i < 3 && n <= 0; i++) {
      r = await roundTrip(cd, d.port, server, 53, q.buf, 3000);
      n = r ? dnsAnswers(r.data, q.id) : -1;
    }
    t.ok(n > 0 && r.host === server && r.port === 53, `a DNS query to ${server}:53 through the association is answered (${n} answers)`);
    d.ctl.destroy(); cd.close();
  } else {
    console.log('  --  no public DNS reachable from here (offline?): the real DNS check is skipped');
  }

  const st = await eng.stats();
  t.ok(st && st.bytes_up > 60000 && st.bytes_down > 60000, `datagram bytes are counted (up ${st && st.bytes_up}, down ${st && st.bytes_down})`);
  await sleep(300);
  t.ok(eng.exited === null && eng2.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err + eng2.err),
    'engines still up, no sanitizer errors');
  eng.stop(); eng2.stop(); e4.close(); if (e6) e6.close(); dns.close(); c.close();
  console.log(`engine-udp: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
