'use strict';

/* The app's side, end to end with the real engine (system proxy stubbed out,
 * so the test never touches the machine's settings): the block-page list
 * reaches the engine, encrypted DNS routes through the engine come up, sites
 * load, the working route is remembered, and cut reports need corroboration
 * before the user is told. */

const path = require('path');
const { ROOT, getViaEngine, sleep, freePort, suite } = require('./helpers');

const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
const t = suite('engine-manager');

(async () => {
  const P = await freePort();
  const mem = { listenPort: P, autoMode: true, dnsProtection: true };
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; }, get store() { return mem; } };
  const logs = []; const advices = [];
  const em = new EngineManager(store, { addLog: (l, m) => logs.push(`${l}: ${m}`), onAdvice: (a) => advices.push(JSON.parse(JSON.stringify(a))) });
  em.proxy = { apply: async () => {}, restore: async () => {}, cleanupSync() {} };

  await em.start();
  const startLine = logs.find((l) => l.includes('Starting engine')) || '';
  t.ok(/\(\+\d{3} known block pages\)/.test(startLine), 'engine gets the block-page list; the log line stays short');
  t.ok(em.doh.socksPort === P, 'encrypted DNS routes through the engine enabled once it is ready');
  const res = await Promise.all(['discord.com', 'www.wikipedia.org', 'github.com'].map((h) => getViaEngine(P, h)));
  t.ok(res.every((x) => x.status >= 200 && x.status < 400), `sites load with encrypted DNS: ${res.map((x) => x.status).join(' ')}`);
  await sleep(6500);
  t.ok(logs.some((l) => l.includes('Encrypted DNS answering via')), 'the log says which DNS routes answer');
  t.ok(!!mem.dohRoute, `working route remembered: ${mem.dohRoute}`);

  em._onCut('a.example', 'stall', 5);
  t.ok(!em.advice.cut, 'a single cut is not reported');
  em._onCut('a.example', 'reset', 3);
  t.ok(em.advice.cut && em.advice.cut.host === 'a.example', 'a second on the same site is');
  em._onCut('a.example', 'stall', 5);
  t.ok(logs.filter((l) => l.includes('a.example: connects')).length === 1, 'and only once');
  for (let i = 0; i < 3; i++) em._onCut('b.example', 'noreply', 0);
  t.ok(em.advice.cut.host === 'a.example', '"no reply" alone needs more than three');
  em._setAdvice({ dnsDown: true }); em._setAdvice({ dnsDown: true });
  t.ok(advices.filter((a) => a.dnsDown).length === 1, 'the window is only told when something changes');

  await em.stop();
  t.ok(!em.proc && em.doh.socksPort === 0, 'stop: engine gone, DNS routes through it off');
  await em.start();
  t.ok(em.advice.cut === null, 'a new start clears the old cut warning');
  await em.stop();

  // Another program (v2rayN, Clash...) already holds the configured port.
  const net = require('net');
  const squatter = net.createServer().listen(P, '127.0.0.1');
  await new Promise((r) => squatter.once('listening', r));
  await em.start();
  t.ok(em.port !== P && em.active, `configured port taken: protection still starts, on ${em.port}`);
  t.ok(logs.some((l) => l.includes(`Port ${P} is in use by another program`)), 'and the log says so');
  t.ok(mem.listenPort === em.port, 'the new port is saved for next time');
  const moved = await getViaEngine(em.port, 'discord.com');
  t.ok(moved.status >= 200 && moved.status < 400, 'sites load on the new port');
  await em.restart();
  t.ok(em.port !== P && em.active, 'a settings restart keeps the free port instead of retrying the taken one');
  await em.stop();
  const second = em.port;
  await em.start();
  t.ok(em.port === second && !logs.slice(-12).some((l) => l.includes('is in use')), 'next start goes straight to the saved port');
  await em.stop();
  // And when the saved one is taken as well, it moves on again.
  const squatter2 = net.createServer().listen(second, '127.0.0.1');
  await new Promise((r) => squatter2.once('listening', r));
  await em.start();
  t.ok(em.port !== second && em.port !== P && mem.listenPort === em.port && em.active, `saved port taken too: moved on to ${em.port} and saved it`);
  await em.stop();
  squatter2.close();
  squatter.close();
  console.log(`engine-manager: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
