'use strict';

/* SOCKS5 UDP ASSOCIATE (RFC 1928 section 7), which the Android app's
 * tun2socks uses for every UDP flow of the phone: games, voice calls, apps'
 * own DNS. The control connection gets a relay port on 127.0.0.1; each
 * datagram sent there carries a header naming its destination (an IPv4 or
 * IPv6 address, or a name the engine resolves itself), goes out without it,
 * and what comes back is returned headed with where it came from.
 *
 * The association belongs to one client endpoint: the one the request names,
 * else the one the first well-formed datagram comes from; another socket on
 * this machine gets nothing through it and nothing back from it. Fragments,
 * malformed headers and datagrams to loopback or unspecified addresses are
 * dropped; closing the control connection ends the association. Plain DNS
 * (port 53) goes to the engine's encrypted-DNS forwarder when it has one.
 *
 * The far side is played by echo servers on this machine's LAN address (the
 * relay refuses loopback), and a local DNS server stands in for the app's
 * encrypted-DNS forwarder; only the last check (a real DNS query) needs the
 * internet, and it is skipped cleanly without it. */

const net = require('net');
const os = require('os');
const dgram = require('dgram');
const { startEngine, sleep, freePort, dnsStub, suite } = require('./helpers');

const t = suite('engine-udp');
const BUF = { sendBufferSize: 1 << 20, recvBufferSize: 1 << 20 };

/* An echo server: sends every datagram back unchanged (after delayMs), and
 * counts them. */
function echoServer(type, host, delayMs = 0) {
  const s = dgram.createSocket({ type, ...BUF });
  const e = { got: 0, sources: [], msgs: [], close: () => { try { s.close(); } catch {} } };
  s.on('message', (m, from) => {
    e.got++; e.sources.push(`${from.address}:${from.port}`); e.msgs.push(m.toString());
    const back = () => { try { s.send(m, from.port, from.address); } catch {} };
    if (delayMs) setTimeout(back, delayMs); else back();
  });
  s.on('error', () => {});
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

/* The header for host:port; asName forces ATYP 3 even for an address. */
function header(host, port, asName = false) {
  let a;
  if (!asName && net.isIPv4(host)) a = Buffer.from([1, ...host.split('.').map(Number)]);
  else if (!asName && net.isIPv6(host)) a = Buffer.concat([Buffer.from([4]), ip6(host)]);
  else a = Buffer.concat([Buffer.from([3, host.length]), Buffer.from(host)]);
  return Buffer.concat([Buffer.from([0, 0, 0]), a, Buffer.from([port >> 8, port & 255])]);
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

/* A reply's header: { frag, host, port, data }, or null when malformed. */
function parseReply(m) {
  if (m.length < 4) return null;
  let off; let host;
  if (m[3] === 1) { host = [...m.subarray(4, 8)].join('.'); off = 8; }
  else if (m[3] === 4) { host = ip6str(m.subarray(4, 20)); off = 20; }
  else if (m[3] === 3) { host = m.subarray(5, 5 + m[4]).toString(); off = 5 + m[4]; }
  else return null;
  return { frag: m[2], atyp: m[3], host, port: m.readUInt16BE(off), data: m.subarray(off + 2) };
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
  return new Promise((resolve, reject) => { s.once('error', reject); s.bind(0, host, () => { c.port = s.address().port; resolve(c); }); });
}

/* Send through the relay and wait for the next datagram back (or null). */
async function roundTrip(c, relayPort, host, port, payload, ms = 3000, asName = false) {
  const n = c.msgs.length;
  c.s.send(Buffer.concat([header(host, port, asName), payload]), relayPort, '127.0.0.1');
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

const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal);
const LAN4 = (ifaces.find((i) => i.family === 'IPv4' || i.family === 4) || {}).address || null;
const LAN6 = (ifaces.find((i) => (i.family === 'IPv6' || i.family === 6) && !/^fe80:/i.test(i.address)) || {}).address || null;

(async () => {
  if (!LAN4) {
    console.log('  --  no LAN IPv4 address here: the relay refuses loopback, so there is no far side to test with; skipped');
    console.log('engine-udp: 0 passed');
    process.exit(0);
  }
  const e4 = await echoServer('udp4', LAN4);
  const e6 = LAN6 ? await echoServer('udp6', LAN6) : null;
  const slow = await echoServer('udp4', LAN4, 800);
  // Loopback services the relay must never reach.
  const lo4 = await echoServer('udp4', '127.0.0.1');
  const lo6 = await echoServer('udp6', '::1');   // null where this machine has no IPv6 loopback
  const dns = await dnsStub({
    // A private IPv4 address from encrypted DNS is not taken on its own word
    // (only the system resolver's is, for a name encrypted DNS does not have
    // publicly), so a name reaches the LAN echo server only over IPv6.
    'udp-echo.example': { A: [LAN4], AAAA: LAN6 ? [LAN6] : [] },
    'udp-loop.example': { A: ['127.0.0.1'] },
  });
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(dns.port)]);

  // ── the association itself
  const a = await associate(P);
  t.ok(a.rep === 0 && a.atyp === 1 && a.addr === '127.0.0.1' && a.port > 0,
    `UDP ASSOCIATE granted: relay port ${a.addr}:${a.port}`);
  const c = await client();

  let r = await roundTrip(c, a.port, LAN4, e4.port, Buffer.from('hello over udp'));
  t.ok(r && r.data.toString() === 'hello over udp', 'IPv4 destination: the payload arrives without its header and the echo comes back');
  t.ok(r && r.frag === 0 && r.host === LAN4 && r.port === e4.port,
    `the reply is headed with where it came from (${r && `${r.host}:${r.port}`})`);
  t.ok(e4.sources.length === 1 && !e4.sources[0].endsWith(`:${a.port}`),
    'it went out from an outbound socket of its own, not from the relay port');

  if (e6) {
    r = await roundTrip(c, a.port, LAN6, e6.port, Buffer.from('six'));
    t.ok(r && r.data.toString() === 'six' && r.atyp === 4 && r.port === e6.port,
      'IPv6 destination: echoed, and the reply header is an IPv6 one (ATYP 4)');
  } else {
    console.log('  --  no global IPv6 address here: the IPv6 destination check is skipped');
  }
  const before = dns.asked['udp-echo.example/A'] || 0;
  const far = e6 || e4;
  r = await roundTrip(c, a.port, 'udp-echo.example', far.port, Buffer.from('by name'), e6 ? 6000 : 0);
  for (let w = 0; w < 6000 && (dns.asked['udp-echo.example/A'] || 0) === before; w += 50) await sleep(50);
  if (!e6) await sleep(1000);   // the lookup goes on to the system resolver and to IPv6
  if (e6) {
    t.ok(r && r.data.toString() === 'by name' && r.atyp === 4 && r.port === e6.port,
      'a name (ATYP 3) is resolved by the engine\'s own resolver and reached');
  } else {
    console.log('  --  no global IPv6 address here: a name cannot lead to a LAN address, so only the lookup is checked');
  }
  t.ok((dns.asked['udp-echo.example/A'] || 0) === before + 1, 'a name (ATYP 3) goes to our resolver');
  r = await roundTrip(c, a.port, 'udp-echo.example', far.port, Buffer.from('again'), e6 ? 3000 : 500);
  t.ok((!e6 || (r && r.data.toString() === 'again')) && (dns.asked['udp-echo.example/A'] || 0) === before + 1,
    'the next datagram to the name reuses that answer instead of asking again');

  const big = Buffer.alloc(60000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 255;
  r = await roundTrip(c, a.port, LAN4, e4.port, big);
  t.ok(r && r.data.length === big.length && r.data.equals(big), 'a 60000-byte datagram goes through whole, both ways');

  r = await roundTrip(c, a.port, LAN4, e4.port, Buffer.alloc(0));
  t.ok(r && r.data.length === 0, 'an empty datagram is a datagram too');

  // ── what is dropped
  let got = e4.got;
  c.s.send(Buffer.concat([Buffer.from([0, 0, 1]), header(LAN4, e4.port).subarray(3), Buffer.from('frag')]), a.port, '127.0.0.1');
  c.s.send(Buffer.from([0, 0, 0, 9, 1, 2, 3]), a.port, '127.0.0.1');                   // unknown ATYP
  c.s.send(Buffer.from([0, 0, 0, 1, 127, 0]), a.port, '127.0.0.1');                    // cut short
  c.s.send(Buffer.concat([header(LAN4, 0), Buffer.from('port 0')]), a.port, '127.0.0.1');
  await sleep(500);
  t.ok(e4.got === got, 'a fragment (FRAG != 0) and malformed headers are dropped');
  r = await roundTrip(c, a.port, LAN4, e4.port, Buffer.from('still here'));
  t.ok(r && r.data.toString() === 'still here', 'and the association goes on working after them');

  // ── loopback and unspecified destinations are refused
  const other = await associate(P);
  const nested = (h) => Buffer.concat([h, header(LAN4, e4.port), Buffer.from('bounced')]);
  got = e4.got; const loGot = lo4.got;
  c.s.send(nested(header('127.0.0.1', other.port)), a.port, '127.0.0.1');               // into another relay
  c.s.send(nested(header('0.0.0.0', a.port)), a.port, '127.0.0.1');                     // into itself
  c.s.send(Buffer.concat([header('127.0.0.1', lo4.port), Buffer.from('lo')]), a.port, '127.0.0.1');
  c.s.send(Buffer.concat([header('127.0.0.2', lo4.port), Buffer.from('lo')]), a.port, '127.0.0.1');
  c.s.send(Buffer.concat([header('localhost', lo4.port), Buffer.from('lo')]), a.port, '127.0.0.1');
  c.s.send(Buffer.concat([header('udp-loop.example', lo4.port), Buffer.from('lo')]), a.port, '127.0.0.1');
  c.s.send(Buffer.concat([header('::ffff:127.0.0.1', lo4.port), Buffer.from('lo')]), a.port, '127.0.0.1');
  if (lo6) {
    c.s.send(Buffer.concat([header('::1', lo6.port), Buffer.from('lo6')]), a.port, '127.0.0.1');
    c.s.send(Buffer.concat([header('::', lo6.port), Buffer.from('lo6')]), a.port, '127.0.0.1');
  }
  await sleep(1500);
  t.ok(!e4.msgs.slice(got).includes('bounced'), 'a datagram to 127.0.0.1:<another relay> or 0.0.0.0:<its own port> goes nowhere: no relay feeds another');
  t.ok(lo4.got === loGot && (!lo6 || lo6.got === 0),
    'loopback destinations are refused: 127.0.0.1, 127.0.0.2, "localhost", a name resolving to 127.0.0.1, ::ffff:127.0.0.1, ::1, ::');
  r = await roundTrip(c, a.port, LAN4, e4.port, Buffer.from('after refusals'));
  t.ok(r && r.data.toString() === 'after refusals', 'and the association goes on working after them');
  other.ctl.destroy();

  // ── the association belongs to its first client
  const c2 = await client();
  got = e4.got;
  const slowGot = slow.got;
  c.s.send(Buffer.concat([header(LAN4, slow.port), Buffer.from('SECRET')]), a.port, '127.0.0.1');
  await sleep(150);
  c2.s.send(Buffer.concat([header(LAN4, e4.port), Buffer.from('from c2')]), a.port, '127.0.0.1');
  c2.s.send(Buffer.concat([header(LAN4, slow.port), Buffer.from('from c2')]), a.port, '127.0.0.1');
  const cHad = c.msgs.length;
  await sleep(1500);
  t.ok(e4.got === got && slow.got === slowGot + 1, 'a second local socket sending to the relay port gets nothing forwarded');
  t.ok(c2.msgs.length === 0, 'and gets no replies, not even one that arrives after it sent');
  const late = c.msgs.slice(cHad).map(parseReply).find((m) => m && m.data.toString() === 'SECRET');
  t.ok(late && late.port === slow.port, 'the first client still gets its delayed reply');
  c2.close();

  // A request that names its endpoint: only that one is taken, from the start.
  const c3 = await client(); const c4 = await client();
  const named = await associate(P, [5, 3, 0, 1, 0, 0, 0, 0, c3.port >> 8, c3.port & 255]);
  got = e4.got;
  c4.s.send(Buffer.concat([header(LAN4, e4.port), Buffer.from('c4 first')]), named.port, '127.0.0.1');
  await sleep(400);
  r = await roundTrip(c3, named.port, LAN4, e4.port, Buffer.from('named client'));
  t.ok(e4.got === got + 1 && r && r.data.toString() === 'named client' && c4.msgs.length === 0,
    'a request naming 0.0.0.0:<port> pins that port: another socket that sends first is still ignored');
  named.ctl.destroy();
  const named2 = await associate(P, [5, 3, 0, 1, 127, 0, 0, 1, c4.port >> 8, c4.port & 255]);
  r = await roundTrip(c4, named2.port, LAN4, e4.port, Buffer.from('127.0.0.1 named'));
  const r3 = await roundTrip(c3, named2.port, LAN4, e4.port, Buffer.from('not me'), 600);
  t.ok(r && r.data.toString() === '127.0.0.1 named' && !r3, 'and so does one naming 127.0.0.1:<port>');
  named2.ctl.destroy(); c3.close(); c4.close();

  // Anyone but the client: a datagram from this machine's own LAN address.
  {
    let stranger = null;
    try { stranger = await client(LAN4); } catch { stranger = null; }
    if (stranger) {
      const fresh = await associate(P);
      got = e4.got;
      const sent = await new Promise((resolve) => stranger.s.send(Buffer.concat([header(LAN4, e4.port), Buffer.from('stranger')]), fresh.port, '127.0.0.1', (e) => resolve(!e)));
      await sleep(500);
      if (sent) t.ok(e4.got === got, `a datagram from a non-loopback source (${LAN4}) is ignored`);
      else console.log('  --  this OS will not send from a LAN address to 127.0.0.1: skipped');
      fresh.ctl.destroy();
      stranger.close();
    }
  }

  // ── plain DNS goes to the encrypted-DNS forwarder
  {
    const d = await associate(P);
    const cd = await client();
    const q = dnsQuery('udp-echo.example');
    const asked = dns.asked['udp-echo.example/A'] || 0;
    r = await roundTrip(cd, d.port, '192.0.2.53', 53, q.buf, 3000);   // TEST-NET: nobody there
    t.ok(r && dnsAnswers(r.data, q.id) === 1 && r.data.subarray(-4).equals(Buffer.from(LAN4.split('.').map(Number))),
      'a DNS query to an address of the app\'s own choosing is answered by our forwarder');
    t.ok(r && r.atyp === 1 && r.host === '192.0.2.53' && r.port === 53, `headed with the address it was sent to (${r && `${r.host}:${r.port}`})`);
    t.ok((dns.asked['udp-echo.example/A'] || 0) === asked + 1, 'and the forwarder was asked');
    const q2 = dnsQuery('udp-echo.example');
    r = await roundTrip(cd, d.port, 'resolver.example', 53, q2.buf, 3000);
    t.ok(r && dnsAnswers(r.data, q2.id) === 1 && r.atyp === 3 && r.host === 'resolver.example' && r.port === 53,
      'a query to a resolver by name: the same, headed with that name');
    d.ctl.destroy(); cd.close();
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
  c.s.send(Buffer.concat([header(LAN4, e4.port), Buffer.from('after close')]), a.port, '127.0.0.1');
  await sleep(600);
  t.ok(e4.got === got, 'once the control connection is closed the relay port no longer forwards anything');
  const c5 = await client();
  r = await roundTrip(c5, a2.port, LAN4, e4.port, Buffer.from('other one'));
  t.ok(r && r.data.toString() === 'other one', 'while the other association is untouched');
  a2.ctl.destroy(); c5.close();

  // ── without our resolver: a name goes to the system's
  const P2 = await freePort();
  const eng2 = await startEngine(P2, ['--auto']);
  const b = await associate(P2);
  const cb = await client();
  r = await roundTrip(cb, b.port, LAN4, e4.port, Buffer.from('by the system'), 6000, true);
  t.ok(r && r.data.toString() === 'by the system' && r.host === LAN4, `a name through the system resolver (reply from ${r && r.host})`);
  const lo2 = lo4.got;
  cb.s.send(Buffer.concat([header('localhost', lo4.port), Buffer.from('lo')]), b.port, '127.0.0.1');
  await sleep(800);
  t.ok(lo4.got === lo2, '"localhost" through the system resolver is refused too');

  // ── the cap: 256 associations at once, the next one refused
  const held = [];
  for (let i = 0; i < 255; i++) held.push(await associate(P2));
  t.ok(held.every((h) => h.rep === 0), '256 associations at once are granted');
  const over = await associate(P2);
  t.ok(over.rep === 1, `the 257th is refused (reply ${over.rep}) and nothing else is affected`);
  over.ctl.destroy();
  r = await roundTrip(cb, b.port, LAN4, e4.port, Buffer.from('under load'));
  t.ok(r && r.data.toString() === 'under load', 'the ones held still relay');
  held.forEach((h) => h.ctl.destroy());
  await sleep(1500);
  const again = await associate(P2);
  t.ok(again.rep === 0, 'once they are closed, a new one is granted again');
  again.ctl.destroy(); b.ctl.destroy(); cb.close();

  // ── a real DNS query, if this network lets one out: with no forwarder it
  // goes where the app sent it
  const servers = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
  let server = null;
  for (const s of servers) if ((await directDns(s)) > 0) { server = s; break; }
  if (server) {
    const d = await associate(P2);
    const cd = await client();
    const q = dnsQuery('example.com');
    let n = -1;
    for (let i = 0; i < 3 && n <= 0; i++) {
      r = await roundTrip(cd, d.port, server, 53, q.buf, 3000);
      n = r ? dnsAnswers(r.data, q.id) : -1;
    }
    t.ok(n > 0 && r.host === server && r.port === 53, `with no forwarder, a DNS query to ${server}:53 goes out as sent and is answered (${n} answers)`);
    d.ctl.destroy(); cd.close();
  } else {
    console.log('  --  no public DNS reachable from here (offline?): the real DNS check is skipped');
  }

  const st = await eng.stats();
  t.ok(st && st.bytes_up > 60000 && st.bytes_down > 60000, `datagram bytes are counted (up ${st && st.bytes_up}, down ${st && st.bytes_down})`);
  await sleep(300);
  t.ok(eng.exited === null && eng2.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err + eng2.err),
    'engines still up, no sanitizer errors');
  eng.stop(); eng2.stop();
  [e4, e6, slow, lo4, lo6].forEach((e) => e && e.close());
  dns.close(); c.close();
  console.log(`engine-udp: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
