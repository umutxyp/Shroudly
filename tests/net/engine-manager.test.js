'use strict';

/* The app's side, end to end with the real engine (system proxy stubbed out,
 * so the test never touches the machine's settings): the block-page list
 * reaches the engine, encrypted DNS routes through the engine come up, sites
 * load, the working route is remembered, and cut reports need corroboration
 * before the user is told. And an antivirus in the way (security-block.js):
 * the engine's file taken while it runs is told once and not restarted, a
 * file gone at the start is no "npm run build:core", Windows refusing to
 * start it is told as that, and two engines in a row ended right after their
 * start without a word stop the restarts with a "may". */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ROOT, getViaEngine, sleep, freePort, suite } = require('./helpers');

const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
const SB = require(path.join(ROOT, 'electron', 'security-block.js'));
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
  t.ok(em.advice.cut.auto === true && logs.some((l) => l.includes('a.example: connects') && l.includes('Shroudly is trying other techniques')), 'with Auto mode on: the other techniques are being tried, and it says so');
  // Auto mode off (issue #41): only the chosen technique is used, and the log
  // and the notice say so, not that others are being tried.
  mem.autoMode = false; mem.strategy = 'split(sni)';
  em._onCut('c.example', 'reset', 0); em._onCut('c.example', 'reset', 0);
  const off = logs.find((l) => l.includes('c.example: connects')) || '';
  t.ok(off.includes('Auto mode is off, so only split(sni) is used') && !off.includes('trying other techniques') && em.advice.cut.auto === false,
    `with Auto mode off: "${off.replace(/^\w+: /, '')}"`);
  mem.autoMode = true; delete mem.strategy;
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
  // Issue #43: a site a technique opened a moment ago is up; silence from it
  // now is the network's, told as a block (Advanced mode offered), DNS left.
  em._onLine(JSON.stringify({ type: 'blocked', host: 'quiet.example', strategy: '', attempts: 6, family: 'ipv4', note: 'silent' }));
  t.ok(logs.includes('warning: quiet.example: opened a moment ago, now no answer after 6 techniques (ipv4) — the site is up, so the network is stopping it; this network may need Advanced mode')
    && blockedNotices.join() === 'quiet.example' && mem.dnsProtection === false,
    'silent right after a technique opened it: the network\'s doing, announced with Advanced mode, encrypted DNS left as it is');
  blockedNotices.length = 0;
  delete mem.dnsProtection;
  // Refused, but not by the network: the server answered the unchanged
  // request with a TLS alert, or the rest of the site works and only one of
  // its addresses does not answer this client (a tracker, an API, a socket).
  // A line in the log; no notification, no window.
  const blocked = (h, extra) => em._onLine(JSON.stringify({ type: 'blocked', host: h, strategy: '', attempts: 9, family: 'ipv4', ...extra }));
  blocked('af.vendor.example', { site_ok: true });
  blocked('alerting.example', { alert: true });
  t.ok(logs.includes('info: af.vendor.example: does not answer, while the rest of the site works through Shroudly; not a block'), 'an address of a working site that does not answer is logged as not a block');
  t.ok(logs.includes('info: alerting.example: the server refused the connection itself (a TLS alert to the unchanged request); not a block'), 'a server that refuses the handshake itself is logged as not a block');
  t.ok(!blockedNotices.length, '…and neither is announced as a blocked site');
  // A site's own page is always told, working rest or not.
  blocked('www.vendor.example', { site_ok: true });
  t.ok(blockedNotices.length === 1 && blockedNotices[0] === 'www.vendor.example', 'a site\'s own page that defeats every technique is still announced');
  // Issue #29: still blocked while Advanced mode is already on: nothing to
  // suggest; it says that the engine keeps trying.
  blocked('www.unblocked-yet.example');
  t.ok(logs.includes('warning: www.unblocked-yet.example: still blocked after 9 techniques (ipv4) — this network may need Advanced mode'),
    'still blocked with Advanced mode off: Advanced mode is suggested');
  em.advancedOn = () => true;
  blocked('gateway.discord.example');
  t.ok(logs.includes('warning: gateway.discord.example: still blocked after 9 techniques (ipv4) — Advanced mode is on, and Shroudly keeps trying other ways')
    && !logs.some((l) => l.startsWith('warning: gateway.discord.example') && l.includes('may need Advanced mode')),
    'issue #29: with Advanced mode on, it is not suggested again; the line says it is still being tried');
  em.advancedOn = () => { throw new Error('unknown'); };
  blocked('www.unknown-adv.example');
  t.ok(logs.some((l) => l.startsWith('warning: www.unknown-adv.example: still blocked')), 'issue #29: Advanced mode that cannot be read: the old line, nothing lost');
  em.advancedOn = () => false;
  // Issue #29: an unreachable host said once, then at most every half hour,
  // per host and kind, with one gate shared by the engine, Games and apps
  // and the Discord relay. The first time is at once.
  {
    const LogGate = require(path.join(ROOT, 'electron', 'log-gate.js'));
    let clock = 1e9;
    const gate = new LogGate({ now: () => clock });
    em.logGate = gate;
    const n = (line) => logs.filter((l) => l === line).length;
    const A = 'warning: silver.roblox.example: could not be reached (connection)';
    for (let i = 0; i < 30; i++) { unreach('silver.roblox.example', 'connect'); clock += 60 * 1000; }
    t.ok(n(A) === 1, `issue #29: a host retried every minute for half an hour: said once (${n(A)})`);
    unreach('silver.roblox.example', 'connect');
    t.ok(n(A) === 2, 'issue #29: …and again once the half hour is up');
    unreach('silver.roblox.example', 'dns');
    t.ok(n('warning: silver.roblox.example: could not be reached (DNS)') === 1, 'issue #29: another kind of line about the same host has its own half hour');
    unreach('pulsar.roblox.example', 'connect');
    t.ok(n('warning: pulsar.roblox.example: could not be reached (connection)') === 1, 'issue #29: another host is said at once');
    clock -= 3 * 3600 * 1000;
    unreach('silver.roblox.example', 'connect');
    t.ok(n(A) === 3, 'issue #29: a clock set back never silences a host for longer');
    // It got through (the engine opened it): its next failure is news again.
    clock += 60 * 1000;
    unreach('silver.roblox.example', 'connect');
    t.ok(n(A) === 3, 'issue #29: (still within its half hour)');
    em._onLine(JSON.stringify({ type: 'bypass', host: 'silver.roblox.example', strategy: 'tlsrec-sni', attempts: 2, family: 'ipv4' }));
    unreach('silver.roblox.example', 'connect');
    t.ok(n(A) === 4, 'issue #29: a host that got through is forgotten: its next failure is said at once');
    // Kept for the engine start below, which begins afresh.
    unreach('restart.roblox.example', 'connect');
    gate.allow('apps-restarting', '*');
    gate.allow('apps-unreachable', 'restart.roblox.example');
    gate.allow('discord-failed', 'kept.example');
  }
  // Cuts on one address of a site whose rest works: not put in front of the user.
  em._onCut('ws.chat.example', 'reset', 0, true); em._onCut('ws.chat.example', 'reset', 0, true);
  t.ok(!em.advice.cut || em.advice.cut.host !== 'ws.chat.example', 'cuts on an address of a working site raise no warning');

  // What worked is kept across restarts and handed to each new engine with
  // its age; expired, malformed and surplus entries are dropped.
  {
    const now = Date.now();
    delete mem.learnedTechniques;
    em._onLine(JSON.stringify({ type: 'bypass', host: 'discord.com', strategy: 'tlsrec-sni', attempts: 2, family: 'ipv4' }));
    em._rememberTechnique('old.example', 'split-sni', now - 31 * 24 * 3600 * 1000);
    em._rememberTechnique('gateway.discord.gg', 'disorder-tlsrec', now - 3600 * 1000);
    mem.learnedTechniques['bad host'] = { s: 'tlsrec-sni', t: now };
    mem.learnedTechniques['evil.example'] = { s: 'x\nSTOP', t: now };
    const kept = em._learned(now).map(([h, v]) => `${h}=${v.s}`);
    t.ok(JSON.stringify(kept) === JSON.stringify(['gateway.discord.gg=disorder-tlsrec', 'discord.com=tlsrec-sni']),
      `learned techniques are kept, oldest first, expired and malformed ones left out (${kept.join(' ')})`);
    const written = [];
    const realProc = em.proc;
    em.proc = { stdin: { write: (x) => written.push(x) } };
    em._restoreTechniques(now);
    em.proc = realProc;
    t.ok(written.join('') === 'LEARN gateway.discord.gg disorder-tlsrec 3600\nLEARN discord.com tlsrec-sni 0\n',
      `…and given to the engine with their age in seconds (${JSON.stringify(written.join(''))})`);
    for (let i = 0; i < 320; i++) em._rememberTechnique(`h${i}.example`, 'tlsrec-sni', now - 1000 + i);
    t.ok(Object.keys(mem.learnedTechniques).length === 300 && mem.learnedTechniques['h319.example'] && !mem.learnedTechniques['h0.example'],
      'at most 300 are kept, the newest');
    // Raw techniques (an app's own protocol, per address) have a store of
    // their own: an app's many addresses never push out what sites learned.
    for (let i = 0; i < 150; i++) em._onLine(JSON.stringify({ type: 'bypass', host: `149.154.167.${i}`, strategy: 'raw-split1', attempts: 3, family: 'ipv4', raw: true, port: 443 }));
    t.ok(Object.keys(mem.learnedTechniques).length === 300 && mem.learnedTechniques['h319.example'],
      'raw techniques leave the sites\' techniques alone');
    t.ok(Object.keys(mem.learnedRawTechniques || {}).length === 100 && mem.learnedRawTechniques['149.154.167.149'],
      'and keep at most 100 of their own, the newest');
    const w2 = [];
    em.proc = { stdin: { write: (x) => w2.push(x) } };
    em._restoreTechniques(Date.now());
    em.proc = realProc;
    t.ok(/LEARN 149\.154\.167\.149 raw-split1 \d+\n/.test(w2.join('')) && /LEARN h319\.example tlsrec-sni/.test(w2.join('')), 'both are given to the engine');
    delete mem.learnedTechniques;
    delete mem.learnedRawTechniques;
  }

  em._setAdvice({ dnsDown: true }); em._setAdvice({ dnsDown: true });
  t.ok(advices.filter((a) => a.dnsDown).length === 1, 'the window is only told when something changes');

  await em.stop();
  t.ok(!em.proc && em.doh.socksPort === 0, 'stop: engine gone, DNS routes through it off');
  await em.start();
  t.ok(em.advice.cut === null, 'a new start clears the old cut warning');
  // Issue #29: each engine start begins afresh for the unreachable lines and
  // for "Shroudly is restarting" (one line per restart); other lines keep
  // their half hour.
  t.ok(em.logGate.allow('unreachable-connection', 'restart.roblox.example') && em.logGate.allow('apps-restarting', '*')
    && em.logGate.allow('apps-unreachable', 'restart.roblox.example'), 'issue #29: an engine start: the unreachable and restarting lines are news again');
  t.ok(!em.logGate.allow('discord-failed', 'kept.example'), 'issue #29: …and only those');
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

  // ── An antivirus in the way ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-av-'));
  // An EngineManager as main.js has it, reporting through securityBlocked's
  // stand-in: one log line and the window's advice per block.
  const rig = async (hooks = {}) => {
    const m = { listenPort: await freePort(), autoMode: true, dnsProtection: false };
    const st = { get: (k, d) => (k in m ? m[k] : d), set: (k, v) => { m[k] = v; }, delete: (k) => { delete m[k]; }, get store() { return m; } };
    const lines = [];
    const blocks = [];
    const e = new EngineManager(st, {
      addLog: (l, msg) => lines.push(`${l}: ${msg}`), packaged: true, ...hooks,
      onSecurityBlock: (info) => { blocks.push(info); lines.push(`error: ${SB.logLine(info)}`); e._setAdvice({ security: SB.forWindow(info) }); },
    });
    e.proxy = { apply: async () => ({ ok: true, code: 'ok' }), restore: async () => true, cleanupSync() {} };
    e._describeEnvironment = async () => {};
    return { e, lines, blocks };
  };
  const count = (lines, re) => lines.filter((l) => re.test(l)).length;

  // The engine's file quarantined while it runs: an antivirus moves the file
  // away and ends the program (a running program can be renamed on every
  // system, never deleted on Windows).
  {
    const core = path.join(tmp, path.basename(EngineManager.coreBinaryPath()));
    fs.copyFileSync(EngineManager.coreBinaryPath(), core);
    fs.chmodSync(core, 0o755);
    const { e, lines, blocks } = await rig({ binPath: core });
    await e.start();
    t.ok(e.active, 'AV: the engine runs from its copy');
    fs.renameSync(core, `${core}.quarantined`);
    const mark = lines.length;
    e.proc.kill('SIGKILL');
    await sleep(2500);
    const after = lines.slice(mark);
    t.ok(!e.active && !e.proc && !after.some((l) => /Starting engine|Restarting engine/.test(l)),
      `AV: its file gone with it: not restarted (${after.join(' | ')})`);
    t.ok(blocks.length === 1 && blocks[0].kind === 'vanished' && blocks[0].certain === true && blocks[0].part === 'engine'
      && blocks[0].file === path.basename(core), 'AV: told once, as certain, naming the file');
    t.ok(count(after, /^error: Security software: .*disappeared while it ran \(quarantined\?\); protection is off\. Folder: /) === 1,
      'AV: one plain line in the log, with the folder');
    t.ok(e.advice.security && e.advice.security.part === 'engine' && e.advice.security.certain, 'AV: the window gets it (advice.security)');
    // Started again while it is gone: told as the antivirus, never as a build step.
    let err = null;
    try { await e.start(); } catch (x) { err = x; }
    t.ok(err && err.code === 'security_blocked' && err.info.kind === 'missing' && !/npm/.test(err.message) && !lines.some((l) => /npm run build:core/.test(l)),
      `AV: a start with the file gone: security_blocked, no "npm run build:core" (${err && err.message})`);
    // Restored from the quarantine: the next start works, and the notice goes.
    fs.renameSync(`${core}.quarantined`, core);
    await e.start();
    t.ok(e.active && e.advice.security === null, 'AV: restored, a start works and the notice is gone');
    await e.stop();
  }

  // A developer's run without the engine built: how to build it, as before.
  {
    const { e } = await rig({ binPath: path.join(tmp, 'not-built'), packaged: false });
    let err = null;
    try { await e.start(); } catch (x) { err = x; }
    t.ok(err && err.code !== 'security_blocked' && /npm run build:core/.test(err.message), 'not installed: "npm run build:core" still');
  }

  // Ended right after its start, by itself, without a word (Windows): one is
  // a plain failure; two in a row are told as "may", and no more restarts.
  {
    const standIn = path.join(tmp, 'stand-in.exe');
    fs.writeFileSync(standIn, 'MZ the program Windows would check');
    const script = (body) => { const f = path.join(tmp, `engine-${Math.random().toString(36).slice(2)}.js`); fs.writeFileSync(f, body); return f; };
    const noisy = script('console.error("listen failed: address in use"); process.exit(1);');
    const quiet = script('process.exit(1);');
    const { e, blocks } = await rig({ binPath: standIn, platform: 'win32' });
    let which = noisy;
    const spawnIt = e._spawn.bind(e);
    e._spawn = (bin, args) => spawnIt(process.execPath, [which, ...args]);
    const fail = async () => { try { await e.start(); return null; } catch (x) { return x; } };
    const n1 = await fail();
    const n2 = await fail();
    t.ok(n1 && n2 && n2.code !== 'security_blocked' && !blocks.length && /listen failed/.test(n2.message), 'AV: an engine that says why it ended: never taken for an antivirus');
    which = quiet;
    const q1 = await fail();
    t.ok(q1 && q1.code !== 'security_blocked' && q1.message === 'Engine failed to start' && !blocks.length,
      `AV: one quiet early end: a plain failure, and no older error stands in for it (${q1 && q1.message})`);
    const q2 = await fail();
    t.ok(q2 && q2.code === 'security_blocked' && blocks.length === 1 && blocks[0].kind === 'early_exit' && blocks[0].certain === false,
      'AV: two in a row: told, as "may"');
  }
  // The same while it runs: started, then ended a moment later, twice.
  {
    const standIn = path.join(tmp, 'stand-in2.exe');
    fs.writeFileSync(standIn, 'MZ the program Windows would check');
    const brief = path.join(tmp, 'brief-engine.js');
    fs.writeFileSync(brief, "const a = process.argv; const port = Number(a[a.indexOf('--port') + 1]);\n"
      + "process.stdout.write(JSON.stringify({ type: 'ready', port, techniques: 1 }) + '\\n');\nsetTimeout(() => process.exit(1), 300);\nsetInterval(() => {}, 1000);\n");
    const { e, lines, blocks } = await rig({ binPath: standIn, platform: 'win32' });
    const spawnIt = e._spawn.bind(e);
    e._spawn = (bin, args) => spawnIt(process.execPath, [brief, ...args]);
    await e.start();
    await sleep(3500);
    t.ok(count(lines, /Restarting engine/) === 1 && count(lines, /Starting engine/) === 2 && !e.active,
      `AV: ended a moment after each start: restarted once, then not (${lines.filter((l) => /engine/i.test(l)).join(' | ')})`);
    t.ok(blocks.length === 1 && blocks[0].kind === 'early_exit' && !blocks[0].certain, 'AV: …and told once, as "may"');
  }
  // Off Windows a program ended early is not taken for an antivirus.
  {
    const standIn = path.join(tmp, 'stand-in3');
    fs.writeFileSync(standIn, 'a program');
    const quiet = path.join(tmp, 'quiet-engine.js');
    fs.writeFileSync(quiet, 'process.exit(1);');
    const { e, blocks } = await rig({ binPath: standIn, platform: 'linux' });
    const spawnIt = e._spawn.bind(e);
    e._spawn = (bin, args) => spawnIt(process.execPath, [quiet, ...args]);
    for (let i = 0; i < 3; i++) { try { await e.start(); } catch {} }
    t.ok(!blocks.length, 'AV: off Windows, quiet early ends are just failures');
    // A test's own crashes (judgeQuickExits off): never judged, on Windows either.
    const w = await rig({ binPath: path.join(tmp, 'stand-in.exe'), platform: 'win32', judgeQuickExits: false });
    const spawnW = w.e._spawn.bind(w.e);
    w.e._spawn = (bin, args) => spawnW(process.execPath, [quiet, ...args]);
    for (let i = 0; i < 3; i++) { try { await w.e.start(); } catch {} }
    t.ok(!w.blocks.length, 'AV: early ends not judged where the caller says they are its own');
  }
  // Windows refusing to start a file that is there (EPERM/EACCES, UNKNOWN).
  // A file without the right to run gives EACCES where that right exists.
  if (process.platform !== 'win32') {
    const refused = path.join(tmp, 'refused.exe');
    fs.writeFileSync(refused, 'MZ a program it may not run');
    fs.chmodSync(refused, 0o644);
    const { e, lines, blocks } = await rig({ binPath: refused, platform: 'win32' });
    let err = null;
    try { await e.start(); } catch (x) { err = x; }
    t.ok(err && err.code === 'security_blocked' && blocks.length === 1 && blocks[0].kind === 'denied' && /spawn EACCES/.test(blocks[0].detail),
      `AV: a start refused with the file there: told as refused (${err && err.message})`);
    t.ok(!lines.some((l) => /engine error:/.test(l)) && count(lines, /^error: Security software: starting refused\.exe was refused \(spawn EACCES\)/) === 1,
      'AV: …in one line, not also as an engine error');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`engine-manager: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
