'use strict';

/* Streams that are neither TLS nor HTTP (Telegram's MTProto here, standing
 * for any app with a protocol of its own), through the engine:
 *  - a filter that resets them by their first bytes is got past: the app's
 *    next connections are cut with one technique after another until one is
 *    answered, and that one is learned, told once, and used from then on;
 *  - the server always receives the exact bytes the app sent;
 *  - a destination that is not filtered is never touched;
 *  - a filter nothing gets past is tried with each technique once, told once,
 *    and then left alone: never a search forever;
 *  - a filter that drops silently is noticed once the app gives up;
 *  - an address that cannot be reached at all is told (once), with the port
 *    the app used, while the app is still connected (so the desktop app can
 *    name the program).
 * Everything is local: a stand-in data centre, and filters in front of it. */

const net = require('net');
const { startEngine, sleep, freePort, socks, suite } = require('./helpers');
const mt = require('./mtproto');

const t = suite('engine-raw');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const lines = (eng, from) => eng.out.slice(from).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/* One connection of the app: through the engine, the opening and a message;
 * resolves true when the data centre answered. */
async function attempt(P, port, timeoutMs = 8000) {
  let s;
  try { s = await socks(P, '127.0.0.1', port); } catch { return false; }
  try { await mt.client(s, timeoutMs); return true; } catch { return false; }
}

(async () => {
  const dc = mt.server();
  const dcPort = await listen(dc);
  const plainDc = mt.server();
  const plainPort = await listen(plainDc);
  const filter = mt.censor(dcPort, { mode: 'first' });
  const filterPort = await listen(filter);
  const wall = mt.censor(dcPort, { mode: 'stream' });
  const wallPort = await listen(wall);
  const quiet = mt.censor(dcPort, { mode: 'first', drop: true });
  const quietPort = await listen(quiet);

  /* What the engine learns is per destination (an address here, all on
   * 127.0.0.1), so each part starts an engine of its own. */
  let P = await freePort();
  let eng = await startEngine(P, ['--auto']);
  const fresh = async () => { eng.stop(); await sleep(200); P = await freePort(); eng = await startEngine(P, ['--auto']); };
  try {
    /* 0. an unfiltered destination: answered at once, untouched, no word */
    let from = eng.out.length;
    t.ok(await attempt(P, plainPort), 'an unfiltered MTProto-like connection is answered');
    t.ok(await attempt(P, plainPort), 'and again');
    await sleep(200);
    t.ok(!lines(eng, from).some((l) => l.raw), 'nothing is said about an unfiltered one');

    /* 1. a filter that resets the opening it sees in a first piece. (The
     * filter here reads a stream, not packets: on a busy machine the kernel
     * can hand it two of the engine's pieces in one read, which a filter on
     * the wire never sees. So the checks allow a connection lost that way;
     * the cuts themselves are checked byte for byte in core/test and on a
     * real network stack in the Android emulator run.) */
    from = eng.out.length;
    const tries = [];
    for (let i = 0; i < 10 && !tries.includes(true); i++) tries.push(await attempt(P, filterPort));
    t.ok(tries[0] === false, 'the untouched opening is reset by the filter');
    t.ok(tries.includes(true), `a later connection of the app gets through (after ${tries.indexOf(true)} failed)`);
    t.ok(filter.resets >= 1 && filter.resets <= tries.indexOf(true), 'every failure was the filter, one per connection');
    await sleep(200);
    const by = lines(eng, from).filter((l) => l.type === 'bypass' && l.raw);
    t.ok(by.length >= 1 && by.every((b) => /^raw-/.test(b.strategy) && b.port === filterPort && b.host === '127.0.0.1'),
      `told, with its technique and port (${by.map((b) => `${b.strategy}, ${b.attempts} tries`).join('; ')})`);
    t.ok(dc.bad === 0, 'the data centre received exactly what the app sent, every time');

    /* 2. learned: the next connections go out with it, and are answered */
    from = eng.out.length;
    const s0 = await eng.stats();
    const next = [];
    for (let i = 0; i < 3; i++) next.push(await attempt(P, filterPort));
    const s1 = await eng.stats();
    t.ok(s1.desync - s0.desync === 3, 'learned: each next connection goes out with a technique');
    t.ok(next.filter(Boolean).length >= 2, `and is answered (${next.filter(Boolean).length} of 3)`);
    t.ok(filter.firsts.slice(-3).filter((n) => n < 64).length >= 2, 'their first piece does not hold the whole opening');
    await sleep(200);
    t.ok(!lines(eng, from).some((l) => l.type === 'blocked'), 'and nothing is said to be blocked');

    /* 3. nothing gets past: each technique once, one line, then untouched */
    await fresh();
    from = eng.out.length;
    let made = 0, blockedAt = -1;
    for (let i = 0; i < 12 && blockedAt < 0; i++) {
      t.ok(!(await attempt(P, wallPort)), `a reassembling filter stops connection ${i + 1}`);
      made++;
      await sleep(100);
      if (lines(eng, from).some((l) => l.type === 'blocked' && l.raw)) blockedAt = made;
    }
    const bl = lines(eng, from).filter((l) => l.type === 'blocked' && l.raw);
    t.ok(bl.length === 1 && bl[0].port === wallPort && !bl[0].note, `told once that nothing got through (${bl[0] && bl[0].attempts} connections, refused)`);
    t.ok(blockedAt >= 4 && blockedAt <= 7, `after the untouched one and each technique once (${blockedAt} connections)`);
    const firstsBefore = wall.firsts.length;
    for (let i = 0; i < 3; i++) await attempt(P, wallPort);
    await sleep(200);
    t.ok(wall.firsts.slice(firstsBefore).every((n) => n >= 64), 'then its connections go out untouched (no search forever)');
    t.ok(lines(eng, from).filter((l) => l.type === 'blocked' && l.raw).length === 1, 'and it is not said again');

    /* 4. a filter that drops silently: noticed when the app gives up */
    await fresh();
    from = eng.out.length;
    t.ok(!(await attempt(P, quietPort, 6000)), 'a silently dropped opening is not answered');
    await sleep(500);
    t.ok(await attempt(P, quietPort), 'the next connection of the app gets through');
    await sleep(200);
    const qb = lines(eng, from).filter((l) => l.type === 'bypass' && l.raw);
    t.ok(qb.length === 1 && qb[0].port === quietPort, `told once (${qb[0] && qb[0].strategy})`);

    /* 5. an address that cannot be reached at all (TEST-NET-1: nothing answers) */
    from = eng.out.length;
    const t0 = Date.now();
    let settled = false;
    const conn = socks(P, '192.0.2.1', 443).then(() => false, () => true).finally(() => { settled = true; });
    let un = null;
    for (let i = 0; i < 200 && !un; i++) { await sleep(50); un = lines(eng, from).find((l) => l.type === 'unreachable' && l.raw); }
    const openAtLine = !settled;
    const refused = await conn;
    t.ok(refused, `the app is refused (after ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    t.ok(un && un.host === '192.0.2.1' && un.port === 443 && un.cport > 0, `told, with the app's own port (${un && un.cport})`);
    t.ok(openAtLine, 'the line came while the app was still connected');
    from = eng.out.length;
    await socks(P, '192.0.2.1', 443).catch(() => {});
    await sleep(200);
    t.ok(!lines(eng, from).some((l) => l.type === 'unreachable'), 'not told again a moment later');

    /* 6. this computer's own addresses are never told about */
    from = eng.out.length;
    const closed = await freePort();
    await socks(P, '127.0.0.1', closed).catch(() => {});
    await sleep(200);
    t.ok(!lines(eng, from).some((l) => l.type === 'unreachable'), 'a closed local port is not told about');

    /* 7. HTTP CONNECT on the same port (what WinHTTP programs are given on
     * Windows): a tunnel like a SOCKS one, the search included */
    const httpConnect = (target, extra = '') => new Promise((resolve) => {
      const s = net.connect(P, '127.0.0.1');
      let b = Buffer.alloc(0);
      s.on('error', () => resolve({ status: 0 }));
      s.on('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`));
      s.on('close', () => resolve({ status: Number((/^HTTP\/1\.1 (\d+)/.exec(b.toString('latin1')) || [])[1] || 0) }));
      const on = (d) => {
        b = Buffer.concat([b, d]);
        const end = b.indexOf('\r\n\r\n');
        if (end < 0) return;
        s.removeListener('data', on);
        const status = Number((/^HTTP\/1\.1 (\d+)/.exec(b.toString('latin1')) || [])[1] || 0);
        if (status !== 200) { s.destroy(); return; }
        const rest = b.subarray(end + 4);
        if (rest.length) s.unshift(rest);
        mt.client(s).then(() => resolve({ status, answered: true }), () => resolve({ status, answered: false }));
      };
      s.on('data', on);
    });
    const c1 = await httpConnect(`127.0.0.1:${plainPort}`);
    t.ok(c1.status === 200 && c1.answered, 'CONNECT: 200, then MTProto through it is answered');
    const c2 = await httpConnect(`localhost:${plainPort}`, 'Proxy-Connection: keep-alive\r\nUser-Agent: Qt\r\n');
    t.ok(c2.status === 200 && c2.answered, 'CONNECT by name, with more headers: the same');
    t.ok((await httpConnect(`127.0.0.1:${closed}`)).status === 502, 'CONNECT to nothing: 502');
    t.ok((await httpConnect('127.0.0.1:0')).status === 400 && (await httpConnect('bad host:443')).status === 400, 'a malformed target: 400');
    const notConnect = await new Promise((resolve) => {
      const s = net.connect(P, '127.0.0.1');
      let b = '';
      s.on('connect', () => s.write('COPY / HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { b += d; });
      s.on('error', () => {});
      s.on('close', () => resolve(b));
    });
    t.ok(/^HTTP\/1\.1 400/.test(notConnect), 'anything but CONNECT is refused');
    const a = await new Promise((resolve) => {
      const s = net.connect(P, '127.0.0.1');
      let b = '';
      s.on('connect', () => s.write('GET http://127.0.0.1/ HTTP/1.1\r\nHost: x\r\n\r\n'));
      s.on('data', (d) => { b += d; });
      s.on('error', () => {});
      s.on('close', () => resolve(b));
    });
    t.ok(a === '', 'a plain proxy request (GET http://...) is not served at all');

    t.ok(eng.exited === null, 'the engine is still running');
  } finally {
    eng.stop();
    for (const s of [dc, plainDc, filter, wall, quiet]) s.close();
  }
  console.log(`engine-raw: ${t.count} checks passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
