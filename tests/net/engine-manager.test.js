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

  // Programs carried by Shroudly wait while the engine is on its way, never
  // while it is being stopped.
  t.ok(em.coming === false, 'nothing coming at rest');
  em._starting = Promise.resolve(); t.ok(em.coming === true, 'a start under way: the engine is coming');
  em._stops = 1; t.ok(em.coming === false, '…but not while a stop is asked for');
  em._stops = 0; em._starting = null;
  em._restartTimer = setTimeout(() => {}, 1); t.ok(em.coming === true, 'a crash restart pending: coming');
  clearTimeout(em._restartTimer); em._restartTimer = null;

  await em.start();
  const startLine = logs.find((l) => l.includes('Starting engine')) || '';
  t.ok(/\(\+\d{3} known block pages\)/.test(startLine), 'engine gets the block-page list; the log line stays short');
  t.ok(em.doh.socksPort === P, 'encrypted DNS routes through the engine enabled once it is ready');
  const active = logs.find((l) => l.includes('Shroudly engine active')) || '';
  t.ok(/\(strategy: auto, \d+ techniques\)$/.test(active) && !active.includes('split(sni)'),
    `auto mode is described as what runs, not the unused configured strategy: "${active.replace(/^\w+: /, '')}"`);
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
  // Hosts that cannot be reached at all: one plain line per host, not one per retry.
  const unreach = (h, stage) => em._onLine(JSON.stringify({ type: 'unreachable', host: h, stage, ips: stage === 'dns' ? 0 : 2 }));
  unreach('gone.example', 'connect'); unreach('gone.example', 'connect'); unreach('nxdomain.example', 'dns');
  t.ok(logs.filter((l) => l === 'warning: gone.example: could not be reached (connection)').length === 1, 'unreachable host logged once, as a connection failure');
  t.ok(logs.includes('warning: nxdomain.example: could not be reached (DNS)'), 'a name that does not resolve is logged as a DNS failure');
  // A silent drop is told apart from a refusal in the log.
  em._onLine(JSON.stringify({ type: 'bypass', host: 'quiet.example', strategy: 'tlsrec-sni', attempts: 2, family: 'ipv4', note: 'silent' }));
  // Nothing answered at all: a silent filter and a site that is down look the
  // same, so it is a log line, never a notification or a changed setting.
  const blockedNotices = [];
  em.onSiteBlocked = (h) => blockedNotices.push(h);
  mem.dnsProtection = false;
  em._onLine(JSON.stringify({ type: 'blocked', host: 'dead.example', strategy: '', attempts: 5, family: 'ipv4', note: 'silent' }));
  t.ok(logs.some((l) => l.startsWith('success: quiet.example: blocked here, opened with tlsrec-sni (2 tries, ipv4) — the network drops these connections silently')), 'silent-drop bypass says so');
  t.ok(logs.some((l) => l.startsWith('warning: dead.example: no answer after 5 techniques (ipv4) — the network may be dropping these connections silently, or the site is down')), 'no answer at all is logged as such');
  t.ok(!blockedNotices.length, 'no answer at all is not announced as a blocked site');
  t.ok(mem.dnsProtection === false, 'no answer at all does not switch encrypted DNS back on');
  delete mem.dnsProtection;

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
  const mark = logs.length;
  await em.start();
  t.ok(em.port === second && !logs.slice(mark).some((l) => l.includes('is in use')), 'next start goes straight to the saved port');
  await em.stop();
  // And when the saved one is taken as well, it moves on again.
  const squatter2 = net.createServer().listen(second, '127.0.0.1');
  await new Promise((r) => squatter2.once('listening', r));
  await em.start();
  t.ok(em.port !== second && em.port !== P && mem.listenPort === em.port && em.active, `saved port taken too: moved on to ${em.port} and saved it`);
  await em.stop();
  squatter2.close();
  squatter.close();

  // P9: the automatic start at launch and a click on Start at the same
  // moment: one engine, one system proxy, and after Stop nothing left.
  {
    let applies = 0;
    em.proxy = { apply: async () => { applies++; await sleep(50); return { ok: true, code: 'ok' }; }, restore: async () => true, cleanupSync() {} };
    const mark2 = logs.length;
    const [a, b] = await Promise.all([em.start(), em.start()]);
    const spawned = logs.slice(mark2).filter((l) => l.includes('Starting engine')).length;
    t.ok(a.success && b.success && spawned === 1 && applies === 1 && em.active, `P9: two starts at once make one engine and one system proxy (${spawned} engine, ${applies} apply)`);
    const proc = em.proc;
    await em.stop();
    await sleep(200);
    t.ok(!em.active && !em.proc && (proc.exitCode !== null || proc.signalCode !== null), 'P9: …and after Stop no engine is left running');
    // A Start pressed after Stop is a new start, made once the stop is done.
    applies = 0;
    await em.start();
    const s1 = em.stop();
    const s2 = em.start();
    await Promise.all([s1, s2]);
    t.ok(em.active && applies === 2, 'P9: Stop then Start in quick succession ends started (the start waits for the stop)');
    await em.stop();
  }

  // P3: the engine ends while the system is being pointed at it: the start
  // fails and undoes everything, instead of showing protection on with no
  // engine behind it.
  {
    let restores = 0;
    const statuses = [];
    em.onProxyStatus = (s) => statuses.push(s);
    em.proxy = {
      apply: async () => {
        const p = em.proc;
        p.kill('SIGKILL');
        await new Promise((r) => p.once('close', r));
        return { ok: true, code: 'ok' };
      },
      restore: async () => { restores++; return true; },
      cleanupSync() {},
    };
    const mark3 = logs.length;
    let err = null;
    try { await em.start(); } catch (e) { err = e; }
    t.ok(err && !em.active && !em.proc && restores >= 1 && em.proxyStatus === null && !statuses.some((s) => s && s.ok) && mem.runtimeActive !== true,
      'P3: the engine gone during apply(): the start fails, the proxy is restored, protection is not shown on');
    t.ok(logs.slice(mark3).some((l) => /^error: Engine exited unexpectedly \(code /.test(l)), 'P3: …and the log says the engine exited');
    em.onProxyStatus = () => {};
  }
  console.log(`engine-manager: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
