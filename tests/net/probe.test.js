'use strict';

/* The site test (Settings → Test a site): the engine's answer must name the
 * host it is about, as valid JSON whatever the user typed, and reach the
 * window through the app. 2.4.1–2.4.4 wrote the name under the wrong key, so
 * every test spun until it timed out and the log said "undefined". */

const path = require('path');
const { ROOT, startEngine, freePort, sleep, suite } = require('./helpers');

const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
const t = suite('probe');

async function probe(eng, host, timeoutMs = 40000) {
  const before = eng.out.length;
  eng.proc.stdin.write(`PROBE ${host}\n`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const line = eng.out.slice(before).split('\n').find((l) => l.includes('"type":"probe"'));
    if (line) return line;
    await sleep(200);
  }
  return null;
}

(async () => {
  const eng = await startEngine(await freePort(), ['--strategy', 'split(sni)', '--auto']);

  let line = await probe(eng, 'example.com');
  let msg = JSON.parse(line);
  t.ok(msg.host === 'example.com' && msg.ok === true, `open site: answer names it (${msg.host}, ok=${msg.ok}, strategy=${msg.strategy})`);

  line = await probe(eng, 'no-such-host.invalid');
  msg = JSON.parse(line);
  t.ok(msg.host === 'no-such-host.invalid' && msg.ok === false, 'site that cannot be reached: answer names it, ok=false');

  line = await probe(eng, 'evil"},"x":"\\\\.invalid');
  let parsed = null; try { parsed = JSON.parse(line); } catch {}
  t.ok(parsed && parsed.type === 'probe' && !('x' in parsed) && typeof parsed.host === 'string', `hostile name stays inside the host field as valid JSON (${parsed && parsed.host})`);
  eng.stop();

  // Through the app, as the Settings screen receives it.
  const P = await freePort();
  const mem = { listenPort: P, autoMode: true, dnsProtection: true };
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; }, get store() { return mem; } };
  const results = []; const logs = [];
  const em = new EngineManager(store, { addLog: (l, m) => logs.push(m), onProbe: (p) => results.push(p) });
  em.proxy = { apply: async () => {}, restore: async () => {}, cleanupSync() {} };
  await em.start();
  em.probe('example.com');
  for (let i = 0; i < 200 && !results.length; i++) await sleep(200);
  t.ok(results[0] && results[0].host === 'example.com', `the window gets the result for the host it asked about (${results[0] && results[0].host})`);
  t.ok(!logs.some((l) => /undefined/.test(l)), 'no "undefined" in the log');
  await em.stop();
  console.log(`probe: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
