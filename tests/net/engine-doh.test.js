'use strict';

/* Names keep resolving through the engine while encrypted DNS has blips.
 * The app's forwarder (electron/doh-forwarder.js, its waves, rests and
 * states as they are) is put in front of an upstream that stands in for the
 * network: it answers every name with ::1, except while it is silent, when a
 * request gets nothing and fails after 2.5 s, as a lost one does. The engine
 * asks the forwarder as in the app (--doh-port). What it proves:
 *   - the network silent for 5 s out of every 10: every name asked during
 *     those 30 s connects, and the forwarder never says "down";
 *   - an answer that comes after the engine's first 4 s is still taken:
 *     the engine asks once more and listens on while it tries the plaintext
 *     resolvers and the system's, which on a network that forges answers
 *     have nothing to give for a filtered name (it used to fail);
 *   - once the silence ends the next name answers at once;
 *   - silent for 20 s: "down" (a lookup gives up after about 6 s, and
 *     lookups have to have failed for 10 s), and "ok" at the next answer.
 * The fallback the engine tries meanwhile asks this machine's network for
 * names under .example, which exist nowhere: it only costs time. */

const net = require('net');
const path = require('path');
const { ROOT, startEngine, sleep, freePort, socks, suite } = require('./helpers');

const F = require(path.join(ROOT, 'electron', 'doh-forwarder.js'));
const t = suite('engine-doh');

/* The answer to a query: ::1 for AAAA, nothing (the name has no IPv4) for A. */
function answerFor(q) {
  let p = 12;
  while (p < q.length && q[p]) p += 1 + q[p];
  const qend = p + 5;
  const aaaa = q.readUInt16BE(p + 1) === 28;
  const head = Buffer.from(q.subarray(0, 12));
  head[2] = 0x81; head[3] = 0x80;
  head.writeUInt16BE(1, 4); head.writeUInt16BE(aaaa ? 1 : 0, 6); head.writeUInt32BE(0, 8);
  if (!aaaa) return Buffer.concat([head, q.subarray(12, qend)]);
  const rr = Buffer.alloc(12 + 16);
  rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(28, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(30, 6); rr.writeUInt16BE(16, 10);
  rr[12 + 15] = 1;   // ::1
  return Buffer.concat([head, q.subarray(12, qend), rr]);
}

/* A forwarder whose routes all reach `upstream`: { silent, delay(name) }. */
async function forwarder(upstream, states) {
  const f = new F(() => {}, { onState: (s) => states.push({ s, at: Date.now() }) });
  f.query = (r, msg) => new Promise((res, rej) => {
    if (upstream.silent) { setTimeout(() => rej(new Error('timeout')), 2500); return; }
    let p = 12; const labels = [];
    while (p < msg.length && msg[p]) { labels.push(msg.subarray(p + 1, p + 1 + msg[p]).toString()); p += 1 + msg[p]; }
    const ms = (upstream.delay && upstream.delay(labels.join('.'))) || 20;
    setTimeout(() => res(answerFor(msg)), ms);
  });
  const port = await f.start();
  return { f, port };
}

/* SOCKS CONNECT to name:port through the engine: { ok, ms }. */
async function reach(P, name, port) {
  const t0 = Date.now();
  try { const s = await socks(P, name, port); s.destroy(); return { ok: true, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, err: e.message }; }
}

(async () => {
  const target = net.createServer((c) => { c.on('error', () => {}); c.end(); });
  await new Promise((r) => target.listen({ port: 0, host: '::1', ipv6Only: true }, r));
  const X = target.address().port;

  const upstream = { silent: false, delay: null };
  const states = [];
  const { f, port } = await forwarder(upstream, states);
  const P = await freePort();
  const eng = await startEngine(P, ['--auto', '--doh', '--doh-port', String(port), '--ipv6']);
  const t0 = Date.now();
  const at = () => Date.now() - t0;

  // Up 5 s, silent 5 s, three times over; a new name every second.
  const flip = setInterval(() => { upstream.silent = !upstream.silent; }, 5000);
  const tries = [];
  for (let i = 0; i < 30; i++) {
    const asked = at();
    const silent = upstream.silent;
    tries.push(reach(P, `blip${i}.example`, X).then((r) => ({ ...r, i, asked, silent })));
    await sleep(1000);
  }
  const res = await Promise.all(tries);
  clearInterval(flip);
  upstream.silent = false;
  const failed = res.filter((r) => !r.ok);
  const inSilence = res.filter((r) => r.silent);
  t.ok(!failed.length,
    `network silent 5 s of every 10: all ${res.length} names connected (${inSilence.length} asked while it was silent, slowest ${Math.max(...res.map((r) => r.ms))} ms)${failed.length ? `; failed: ${failed.map((r) => `#${r.i} at ${r.asked} ms after ${r.ms} ms`).join(', ')}` : ''}`);
  t.ok(!states.some((x) => x.s === 'down'), 'blips of 5 s never made the forwarder say "down"');

  // Back: the next name answers at once.
  await sleep(500);
  let r = await reach(P, 'back.example', X);
  t.ok(r.ok && r.ms < 1500, `after the silence the next name answers at once (${r.ms} ms)`);

  // An answer that takes 5 s, past the engine's first 4 s: still taken.
  upstream.delay = (name) => (name === 'slow.example' ? 5000 : 20);
  r = await reach(P, 'slow.example', X);
  t.ok(r.ok && r.ms >= 4000 && r.ms < 9000, `the forwarder answers after 5 s: the name still connects (${r.ms} ms)`);
  upstream.delay = null;

  // Silent for 20 s: "down" once lookups have failed for 10 s, and "ok" at
  // the next answer.
  upstream.silent = true;
  const long = [];
  for (let i = 0; i < 20; i++) { long.push(reach(P, `long${i}.example`, X)); await sleep(1000); }
  upstream.silent = false;
  await Promise.all(long);
  const down = states.find((x) => x.s === 'down');
  t.ok(!!down, `silent for 20 s with names asked all along: "down" (${down ? ((down.at - t0) / 1000).toFixed(1) : '-'} s into the test)`);
  r = await reach(P, 'again.example', X);
  t.ok(r.ok && states[states.length - 1].s === 'ok', `and "ok" again at the next answer (${r.ms} ms)`);

  t.ok(eng.exited === null && !/AddressSanitizer|runtime error:/.test(eng.err), 'engine still up, no sanitizer errors');
  eng.stop(); f.stop(); target.close();
  console.log(`engine-doh: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
