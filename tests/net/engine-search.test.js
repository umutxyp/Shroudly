'use strict';

/* The last way out (Tor) only for a name every technique failed on, and the
 * whole list on the first visit (core/src/engine.c: BURST_BATCH, hand_over,
 * legs_unheard, bg_search).
 *
 *   - a network that drops without a word, and a site only a later technique
 *     opens (Türk Telekom, Turkcell Superonline): from 2.6.54 to 2.6.74 the
 *     first ladder ran out of time after four techniques, the name went to
 *     Tor and nothing looked further; before Tor it took three visits. Now
 *     the rest of the list goes out at once: found on the first visit, Tor
 *     never asked;
 *   - nothing gets past the filter: Tor takes the name, but only after every
 *     technique had its turn;
 *   - the network is itself again: the name leaves Tor ("direct") instead of
 *     staying there for a quarter of an hour; so does one Tor took because
 *     no address of it answered for a moment;
 *   - plain http:// the network drops without a word (a report from Türk
 *     Telekom: "no http:// site opens, by Tor or without"): the ladder
 *     stopped at the second silence, as for a slow server, so no technique
 *     was tried, Tor never reached and nothing said. Whether the request
 *     arrived is what tells the two apart (sock_unacked). This computer
 *     acknowledges for the far end, so the tests say so with
 *     --local-unacked; without it the same silence is a slow server's, and
 *     that one is still left alone. */

const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const H = require('./helpers');

const t = H.suite('engine-search');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-search-'));
const OK = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok';
const on6 = (srv) => new Promise((r) => srv.listen({ port: 0, host: '::1', ipv6Only: true }, () => r(srv)));
const listening = (srv) => new Promise((r) => (srv.listening ? r() : srv.once('listening', r)));

/* One request through the engine, TLS or plain: { r: its status line, ms }. */
function visit(P, host, port, { plain = false, timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  return new Promise(async (resolve) => {
    let raw; try { raw = await H.socks(P, host, port); } catch { resolve({ r: 'refused', ms: Date.now() - t0 }); return; }
    const s = plain ? raw : tls.connect({ socket: raw, servername: host, ...H.testClientOptions(), ALPNProtocols: ['http/1.1'] });
    let out = ''; let fin = false;
    const done = (r) => { if (fin) return; fin = true; s.destroy(); raw.destroy(); resolve({ r, ms: Date.now() - t0 }); };
    const send = () => s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: x\r\nConnection: close\r\n\r\n`);
    if (plain) send(); else s.on('secureConnect', send);
    s.on('data', (d) => { out += d; if (out.includes('\r\n\r\n')) done(out.split('\r\n')[0]); });
    s.on('end', () => done(out ? out.split('\r\n')[0] : 'empty'));
    s.on('error', () => done('error'));
    setTimeout(() => done('timeout'), timeoutMs);
  });
}
const tlsSite = () => on6(tls.createServer(H.testServerOptions(), (c) => { c.on('error', () => {}); c.once('data', () => c.end(OK)); }));
const httpSite = () => on6(net.createServer((c) => { c.on('error', () => {}); c.on('data', () => c.end(OK)); }));
/* In front of `to`: pass(firstChunk) says whether the connection goes on;
 * otherwise it is swallowed (taken, never answered, never closed). */
function filter(to, pass) {
  const srv = net.createServer((c) => {
    let u = null; let n = 0;
    srv.seen++;
    c.on('error', () => {}); c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      if (n++ > 0) return;
      if (!pass(d)) return;
      u = net.connect(to, '::1'); u.on('error', () => c.destroy()); u.write(d); u.pipe(c);
    });
  });
  srv.seen = 0;
  return on6(srv);
}
/* In front of `to`: swallows every handshake but one whose first TLS record
 * ends one byte before the end of `name` (what tlsrec-sni-end sends, the
 * sixth technique: past what a ladder that took them one by one reached). */
function lateFilter(to, name) {
  const srv = net.createServer((c) => {
    let buf = Buffer.alloc(0), u = null, decided = false;
    srv.seen++;
    c.on('error', () => {}); c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      if (decided) return;
      buf = Buffer.concat([buf, d]);
      let p = 0, body = Buffer.alloc(0), first = -1;
      while (p + 5 <= buf.length) {
        if (buf[p] !== 0x16) { decided = true; return; }
        const len = buf.readUInt16BE(p + 3);
        if (p + 5 + len > buf.length) return;
        body = Buffer.concat([body, buf.subarray(p + 5, p + 5 + len)]);
        if (first < 0) first = len;
        p += 5 + len;
        if (body.length >= 4 && body.length >= 4 + body.readUIntBE(1, 3)) {
          decided = true;
          const i = body.indexOf(name);
          if (i < 0 || first - i !== name.length - 1) return;      // swallowed
          u = net.connect(to, '::1'); u.on('error', () => c.destroy()); u.write(buf); u.pipe(c);
          return;
        }
      }
    });
  });
  srv.seen = 0;
  return on6(srv);
}
/* What Tor reaches: anything, TLS or plain, answered at once. */
async function torStandIn() {
  const w = await tlsSite();
  const front = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', (d) => {
      if (d[0] !== 0x16) { c.end(OK); return; }
      const u = net.connect(w.address().port, '::1'); u.on('error', () => c.destroy()); c.on('close', () => u.destroy());
      u.write(d); c.pipe(u); u.pipe(c);
    });
  }).listen(0, '127.0.0.1');
  await listening(front);
  const tor = H.socksServer(front.address().port);
  await listening(tor);
  const f = path.join(dir, `tor-${tor.address().port}.txt`);
  fs.writeFileSync(f, `socks5://127.0.0.1:${tor.address().port}\n`, { mode: 0o600 });
  return { tor, file: f };
}
const events = (eng, type) => eng.out.split('\n').filter((l) => l.includes(`"type":"${type}"`)).map((l) => { try { return JSON.parse(l); } catch { return {}; } });

(async () => {
  const names = ['late.example', 'six.example', 'hole.example', 'back.example', 'hdrop.example', 'hhole.example', 'hslow.example', 'hnone.example'];
  const table = {}; for (const n of names) table[n] = { AAAA: ['::1'] };
  const dns = await H.dnsStub(table);
  const base = ['--strategy', 'split(sni)', '--auto', '--doh', '--doh-port', String(dns.port), '--ipv6'];

  { // A site only a later technique opens (the sixth).
    const { tor, file } = await torStandIn();
    const site = await tlsSite();
    const f = await lateFilter(site.address().port, 'late.example');
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--fallback-file', file]);
    const a = await visit(P, 'late.example', f.address().port);
    await H.sleep(300);
    const by = events(eng, 'bypass').find((e) => e.host === 'late.example');
    t.ok(a.r === 'HTTP/1.1 200 OK' && a.ms < 20000, `a silent filter only a late technique opens: the site comes on the first visit (${a.r}, ${a.ms} ms)`);
    t.ok(by && by.strategy === 'tlsrec-sni-end' && by.note === 'silent', `found and learned (${by && by.strategy})`);
    t.ok(tor.asked.length === 0 && events(eng, 'fallback').length === 0, 'the last way out is never asked for it');
    const b = await visit(P, 'late.example', f.address().port);
    t.ok(b.r === 'HTTP/1.1 200 OK' && b.ms < 2000 && tor.asked.length === 0, `from then on at once, on its own way (${b.ms} ms)`);
    // A browser opens several connections to a site at once: one of them
    // goes through the list, the others take what it finds.
    const f6 = await lateFilter(site.address().port, 'six.example');
    const six = await Promise.all([0, 1, 2, 3, 4, 5].map(() => visit(P, 'six.example', f6.address().port)));
    t.ok(six.every((v) => v.r === 'HTTP/1.1 200 OK') && tor.asked.length === 0,
      `six connections at once to such a site: all six open, none through the last way out (${six.map((v) => v.ms).join(', ')} ms)`);
    const techniques = JSON.parse(eng.out.split('\n').find((l) => l.includes('"ready"'))).techniques;
    t.ok(f6.seen <= 6 + 6 + techniques + 6,
      `one went through the list for the others: ${f6.seen} connections for six clients, not ${6 * (techniques + 1)}`);
    eng.stop(); tor.close(); f.close(); f6.close(); site.close();
  }

  { // Nothing gets past: Tor, after every technique; and back when the network lets it through again.
    const { tor, file } = await torStandIn();
    const site = await tlsSite();
    let open = false; let seenAtTor = -1;
    const f = await filter(site.address().port, () => open);
    tor.on('connection', () => { if (seenAtTor < 0) seenAtTor = f.seen; });
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--fallback-file', file]);
    const techniques = JSON.parse(eng.out.split('\n').find((l) => l.includes('"ready"'))).techniques;
    const a = await visit(P, 'hole.example', f.address().port);
    await H.sleep(300);
    t.ok(a.r === 'HTTP/1.1 200 OK' && tor.asked.length === 1 && tor.asked[0].host === 'hole.example', `no technique gets past: the last way out carries it (${a.r}, ${a.ms} ms)`);
    t.ok(seenAtTor >= techniques + 1, `only after the untouched request and all ${techniques} techniques had their turn (${seenAtTor} connections before it)`);
    t.ok(a.ms < 26000, `in one visit's time (${a.ms} ms)`);
    const b = await visit(P, 'hole.example', f.address().port);
    t.ok(b.r === 'HTTP/1.1 200 OK' && b.ms < 2000 && tor.asked.length === 2, 'its next connection goes straight there');
    open = true;                       // the network is itself again
    await H.sleep(48000);
    const d = events(eng, 'direct').find((e) => e.host === 'hole.example');
    t.ok(!!d, `looked at again behind the last way out: reached without it (${JSON.stringify(d)})`);
    const before = tor.asked.length;
    const c = await visit(P, 'hole.example', f.address().port);
    t.ok(c.r === 'HTTP/1.1 200 OK' && tor.asked.length === before, 'and its connections are its own again, not Tor\'s for a quarter of an hour');
    eng.stop(); tor.close(); f.close(); site.close();
  }

  { // No address of it answers for a moment: Tor meanwhile, and back soon after.
    const { tor, file } = await torStandIn();
    const port = await H.freePort();
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--fallback-file', file]);
    const a = await visit(P, 'back.example', port);
    t.ok(a.r === 'HTTP/1.1 200 OK' && tor.asked.length === 1, `nothing answers at its address: the last way out (${a.r})`);
    const site = tls.createServer(H.testServerOptions(), (c) => { c.on('error', () => {}); c.once('data', () => c.end(OK)); });
    await new Promise((r) => site.listen({ port, host: '::1', ipv6Only: true }, r));
    await H.sleep(13000);
    const d = events(eng, 'direct').find((e) => e.host === 'back.example');
    const b = await visit(P, 'back.example', port);
    t.ok(!!d && b.r === 'HTTP/1.1 200 OK' && tor.asked.length === 1, 'it answers again: back on its own way within seconds');
    eng.stop(); tor.close(); site.close();
  }

  { // Plain http:// the network drops without a word.
    const { tor, file } = await torStandIn();
    const site = await httpSite();
    const f = await filter(site.address().port, (d) => !d.includes('Host: hdrop.example'));
    const hole = await filter(site.address().port, () => false);
    const P = await H.freePort();
    const eng = await H.startEngine(P, [...base, '--local-unacked', '--fallback-file', file]);
    const a = await visit(P, 'hdrop.example', f.address().port, { plain: true });
    await H.sleep(300);
    const by = events(eng, 'bypass').find((e) => e.host === 'hdrop.example');
    t.ok(a.r === 'HTTP/1.1 200 OK' && by && by.note === 'silent' && tor.asked.length === 0,
      `http:// dropped without a word: the techniques are tried and one opens it (${a.r}, ${a.ms} ms, ${by && by.strategy})`);
    const b = await visit(P, 'hdrop.example', f.address().port, { plain: true });
    t.ok(b.r === 'HTTP/1.1 200 OK' && b.ms < 2000, `and at once from then on (${b.ms} ms)`);
    const c = await visit(P, 'hhole.example', hole.address().port, { plain: true });
    await H.sleep(300);
    const bl = events(eng, 'blocked').find((e) => e.host === 'hhole.example');
    t.ok(c.r === 'HTTP/1.1 200 OK' && tor.asked.some((x) => x.host === 'hhole.example') && bl && bl.note === 'silent',
      `no technique opens it: said, and the last way out carries it (${c.r}, ${c.ms} ms)`);
    eng.stop(); tor.close();

    // The same with no last way out: nothing can open it, but it is said.
    const P2 = await H.freePort();
    const eng2 = await H.startEngine(P2, [...base, '--local-unacked']);
    const e = await visit(P2, 'hnone.example', hole.address().port, { plain: true, timeoutMs: 30000 });
    const bl2 = events(eng2, 'blocked').find((x) => x.host === 'hnone.example');
    t.ok(e.r !== 'HTTP/1.1 200 OK' && bl2 && bl2.note === 'silent', 'with no last way out it stays shut, and the log says so');
    eng2.stop(); f.close(); hole.close(); site.close();
  }

  { // A slow server: what it was sent arrived, so it is left alone (the real question to the system, no flag).
    let conns = 0;
    const slow = await on6(net.createServer((c) => { conns++; c.on('error', () => {}); c.once('data', () => setTimeout(() => { if (!c.destroyed) c.end(OK); }, 8000)); }));
    const P = await H.freePort();
    const eng = await H.startEngine(P, base);
    const a = await visit(P, 'hslow.example', slow.address().port, { plain: true });
    t.ok(a.r === 'HTTP/1.1 200 OK' && a.ms >= 7900 && conns <= 2, `a server that is only slow is not sent the request again and again (${conns} connections, ${a.ms} ms)`);
    t.ok(events(eng, 'blocked').length === 0 && events(eng, 'bypass').length === 0, 'and nothing is learned or said about it');
    eng.stop(); slow.close();
  }

  dns.close();
  console.log(`engine-search: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
