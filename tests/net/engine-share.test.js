'use strict';

/* What one name of a site or service teaches, the others use (core/src/
 * engine.c: SITE_FAMILY, site_of, hs_get, g_hs_gen).
 *
 *   - one service under several registrable domains (YouTube's pages,
 *     video servers and images; Discord's): a technique learned for one
 *     opens the others on their first try;
 *   - two names of one site opened at about the same time (a browser's
 *     www. and static., a player's video servers) behind a filter that drops
 *     without a word: the second one's ladder, already on its way, tries
 *     what the first found as soon as it is found, instead of going on down
 *     the list on its own. */

const tls = require('tls');
const net = require('net');
const { startEngine, sleep, freePort, socks, testServerOptions, suite } = require('./helpers');

const t = suite('engine-share');

/* The server name, and whether the first TLS record holds it whole, split
 * one byte before its end ('end') or elsewhere; null while it arrives. */
function look(buf) {
  let p = 0, body = Buffer.alloc(0), first = -1;
  while (p + 5 <= buf.length) {
    if (buf[p] !== 0x16) return { name: '', shape: 'other' };
    const len = buf.readUInt16BE(p + 3);
    if (p + 5 + len > buf.length) return null;
    body = Buffer.concat([body, buf.subarray(p + 5, p + 5 + len)]);
    if (first < 0) first = len;
    p += 5 + len;
    if (body.length >= 4 && body.length >= 4 + body.readUIntBE(1, 3)) {
      let q = 4 + 2 + 32; q += 1 + body[q]; q += 2 + body.readUInt16BE(q); q += 1 + body[q];
      const end = q + 2 + body.readUInt16BE(q); q += 2;
      let name = '';
      while (q + 4 <= end) {
        const type = body.readUInt16BE(q), l = body.readUInt16BE(q + 2); q += 4;
        if (type === 0) { name = body.subarray(q + 5, q + 5 + body.readUInt16BE(q + 3)).toString(); break; }
        q += l;
      }
      const i = name ? body.indexOf(name) : -1;
      if (i < 0) return { name: '', shape: 'other' };
      const inFirst = first - i;
      return { name, shape: inFirst >= name.length ? 'one' : inFirst === name.length - 1 ? 'end' : 'other' };
    }
  }
  return null;
}

(async () => {
  const server = tls.createServer(testServerOptions(), (s) => {
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); s.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  // Only a record split one byte before the name's end gets through (a
  // technique well down the list). YouTube's and Discord's names are reset,
  // *.par.example's swallowed without a word.
  const seen = [];
  const censor = net.createServer((c) => {
    let buf = Buffer.alloc(0), u = null, decided = false;
    c.on('error', () => {});
    c.on('close', () => { if (u) u.destroy(); });
    c.on('data', (d) => {
      if (u) { u.write(d); return; }
      if (decided) return;
      buf = Buffer.concat([buf, d]);
      const k = look(buf);
      if (!k) return;
      decided = true;
      const pass = k.shape === 'end';
      seen.push({ ...k, pass, at: Date.now() });
      if (!pass) { if (k.name.endsWith('.par.example')) return; c.resetAndDestroy(); return; }
      u = net.connect(server.address().port, '127.0.0.1');
      u.on('error', () => c.destroy());
      u.write(buf); u.pipe(c);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => censor.once('listening', r));

  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--local-unacked']);
  async function visit(name) {
    const t0 = Date.now();
    const raw = await socks(P, '127.0.0.1', censor.address().port);
    const ok = await new Promise((resolve) => {
      const s = tls.connect({ socket: raw, servername: name, rejectUnauthorized: false });
      const done = (v) => { s.destroy(); resolve(v); };
      s.on('secureConnect', () => s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { if (d.includes('200 OK')) done(true); });
      s.on('error', () => done(false)); s.on('close', () => done(false));
      setTimeout(() => done(false), 20000);
    });
    return { ok, ms: Date.now() - t0 };
  }
  const tries = (name) => seen.filter((x) => x.name === name);
  const shapes = (name) => tries(name).map((x) => `${x.shape}${x.pass ? '' : ' (refused)'}`).join(', ');

  // One service, several domains.
  let r = await visit('www.youtube.com');
  t.ok(r.ok && tries('www.youtube.com').length > 3, `www.youtube.com: found down the list (${tries('www.youtube.com').length} tries)`);
  for (const name of ['rr3---sn-abc.googlevideo.com', 'i.ytimg.com', 'yt3.ggpht.com']) {
    r = await visit(name);
    t.ok(r.ok && tries(name).length === 1 && tries(name)[0].pass, `${name}: opens on its first try with what youtube.com learned (${shapes(name)})`);
  }
  r = await visit('discord.com');
  t.ok(r.ok && tries('discord.com').length > 1, `discord.com: learned for itself (${tries('discord.com').length} tries)`);
  r = await visit('gateway.discord.gg');
  t.ok(r.ok && tries('gateway.discord.gg').length === 1, `gateway.discord.gg: its first try (${shapes('gateway.discord.gg')})`);
  // (youtube.com and discord.com: two sites opened with one technique, so
  // from here what opens sites on this network would be raced for a new
  // site: the next part uses a site of its own all the same, and says what
  // it checks either way.)
  eng.proc.stdin.write('NET-CHANGED\n');
  await sleep(200);

  // Two names of one site at about the same time, silently dropped: the
  // second, 300 ms behind, takes what the first found as soon as it is.
  const a = visit('a.par.example');
  await sleep(300);
  const b = visit('b.par.example');
  const [ra, rb] = await Promise.all([a, b]);
  t.ok(ra.ok && rb.ok, `both open (${ra.ms} ms, ${rb.ms} ms)`);
  // The second, already on its way, takes what the first found as soon as
  // it is found: how many techniques of its own it sent before that depends
  // on the machine's pace (one batch or two in flight), so what is checked
  // is what came after. Once the first was through (and its answer had a
  // moment to arrive), nothing but the found technique is tried for the
  // second; and the second ends well short of the first's walk down the
  // list, which it would repeat on its own.
  const tb = tries('b.par.example'), ta = tries('a.par.example');
  const found = (ta.find((x) => x.pass) || {}).at || Infinity;
  const after = tb.filter((x) => x.at > found + 250);
  t.ok(tb.length >= 2 && tb.length < ta.length && tb[0].shape === 'one' &&
    tb[tb.length - 1].pass && after.every((x) => x.pass),
    `the second name tries what the first found next, not the rest of the list (${tb.map((x) => `${x.shape}${x.pass ? '' : ' (refused)'} ${x.at - found} ms`).join(', ')}; the first: ${ta.length} tries)`);

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); server.close(); censor.close();
  console.log(`engine-share: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
