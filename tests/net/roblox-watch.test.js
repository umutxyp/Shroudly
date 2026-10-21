'use strict';

/* Roblox's programs that go around Shroudly (electron/roblox-watch.js), run
 * on a fake clock: a world of processes that start, ask Roblox through
 * Shroudly or not, and are listed, read, stopped and started with the delays
 * real machines have (a process listing, a PowerShell start, a signature
 * check that asks about revocation online). What is measured is what the
 * user waits for: from an installer started around Shroudly to the same
 * installer started again through it. And what must never happen: an
 * installer that goes through Shroudly touched, a player in a game
 * restarted. */

const path = require('path');
const { ROOT, suite } = require('./helpers');

const W = require(path.join(ROOT, 'electron', 'roblox-watch.js'));
const t = suite('roblox-watch');

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
// Right before a program is stopped: a listing and a question to the
// PowerShell kept running, to make sure it is still the same process.
const VERIFY_MS = 120 + 150 + 150;

/* A computer, with a clock that only moves when the simulation says so.
 *   probeMs   the first PowerShell call reading start times and files
 *   warmInfoMs  the next ones (PowerShell kept running)
 *   sigMs     the signature check (revocation asked online)
 *   listMs    one process listing (snapshotAt: 'end', or 'start' as tasklist
 *             takes it before it returns)
 *   firstAskMs  how soon a program started through Shroudly asks Roblox
 *   offset    the system clock against the simulation's (set it to step it) */
function world({ probeMs = 1200, warmInfoMs = 150, sigMs = 1500, listMs = 120, snapshotAt = 'end', firstAskMs = 800, watched = true, coldMs = 0, infoFails = false, restricted = null } = {}) {
  let now = 0;
  let seq = 1;
  const timers = [];
  const setT = (fn, ms) => { const id = seq++; timers.push({ at: now + Math.max(0, ms), fn, id }); return id; };
  const clearT = (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); };
  const sleep = (ms) => new Promise((r) => setT(r, ms));
  const procs = new Map();   // pid -> { role, kind, start, path, through, alive, end }
  let nextPid = 4000;
  let lastRequestAt = 0;
  let infoAsked = 0;
  // PowerShell, kept running once started: its first answer waits for it to start.
  let hostUpAt = null;
  const host = () => { if (hostUpAt == null) hostUpAt = now + coldMs; return Math.max(0, hostUpAt - now); };
  const w = {
    get now() { return now; },
    get wall() { return now + w.offset; },
    offset: 0,
    procs, lists: 0, probes: 0, sigs: 0, killed: [], started: [], checks: 0, logs: [], told: [], installs: 0,
    // killFails: true (nothing can be stopped) or the pids that cannot be;
    // startFails: nothing can be started (installer or Roblox).
    on: false, active: false, blocked: false, killFails: false, fetchFails: false, unsigned: false, startFails: false,
    sleep,
    /* A program starts. through: it has the setting (it asks Roblox through
     * Shroudly firstAskMs later, and again every `every` ms if given, or at
     * each of `asks`). `pid` reuses a process id. */
    start(role, kind, { through = false, file = null, every = 0, ask = firstAskMs, asks = null, pid: reuse = null } = {}) {
      const pid = reuse || nextPid++;
      const p = { pid, role, kind, start: w.wall, path: file || `D:\\Games\\Roblox\\${kind === 'studio' ? 'RobloxStudioInstaller' : 'RobloxPlayerInstaller'}.exe`, through, alive: true, end: 0 };
      procs.set(pid, p);
      if (through) {
        const once = () => { if (p.alive && procs.get(pid) === p) lastRequestAt = w.wall; };
        const asks0 = () => { once(); if (every && p.alive) setT(asks0, every); };
        if (asks) for (const a of asks) setT(once, a); else setT(asks0, ask);
      }
      return pid;
    },
    end(pid) { const p = procs.get(pid); if (p) { p.alive = false; p.end = now; } },
    /* A request from Roblox through Shroudly, `ms` from now. */
    ask(ms) { setT(() => { lastRequestAt = w.wall; }, ms); },
    async run(until) {
      for (;;) {
        await settle();
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const n = timers[0];
        if (!n || n.at > until) { now = until; await settle(); return; }
        timers.shift();
        now = n.at;
        n.fn();
      }
    },
  };
  const alive = () => [...procs.values()].filter((p) => p.alive);
  const listing = () => {
    const a = alive();
    const of = (role, kind) => a.filter((p) => p.role === role && (!kind || p.kind === kind)).map((p) => p.pid);
    return { players: of('player'), studios: of('studio'), installers: { player: of('installer', 'player'), studio: of('installer', 'studio') } };
  };
  w.watch = new W.RobloxWatch({
    now: () => w.wall,
    setTimeout: setT,
    clearTimeout: clearT,
    watched,
    on: () => w.on,
    active: () => w.active,
    blocked: () => w.blocked,
    stillBlocked: async () => { if (w.stillMs) await sleep(w.stillMs); return w.blocked; },
    checkSoon: () => { w.checks++; },
    lastRequestAt: () => lastRequestAt,
    list: async () => {
      w.lists++;
      if (snapshotAt === 'start') { const l = listing(); await sleep(listMs); return l; }
      await sleep(listMs);
      return listing();
    },
    prepare: () => { host(); },
    info: async (pids) => {
      w.probes++;
      await sleep(host() + (infoAsked++ ? warmInfoMs : probeMs));
      const m = new Map();
      m.answered = !infoFails;
      m.restricted = restricted;
      if (infoFails) return m;
      for (const pid of pids) { const p = procs.get(pid); if (p && p.alive) m.set(pid, { startedAt: p.start, path: p.role === 'installer' ? p.path : `C:\\Roblox\\RobloxPlayerBeta.exe` }); }
      return m;
    },
    signed: async (file) => { w.sigs++; await sleep(host() + sigMs); w.signedAt = now; return /Installer\.exe$/.test(file) && !w.unsigned ? 'a'.repeat(64) : null; },
    same: async () => true,
    kill: async (pids) => {
      await sleep(150);
      const fails = (pid) => w.killFails === true || (w.killFails instanceof Set && w.killFails.has(pid));
      for (const pid of pids) { const p = procs.get(pid); if (p && !fails(pid)) { p.alive = false; p.end = now; w.killed.push({ pid, at: now, start: p.start }); } }
      return pids.filter(fails);
    },
    startInstaller: (file) => {
      if (w.startFails) return false;
      const old = [...procs.values()].find((p) => p.path === file && p.role === 'installer');
      const pid = w.start('installer', old ? old.kind : 'player', { through: true, file });
      w.started.push({ pid, at: now, file });
      return pid;
    },
    fetch: async (kind) => { w.installs++; await sleep(4000); return w.fetchFails ? { success: false, code: 'unreachable', detail: 'timed out' } : { success: true, kind, file: `C:\\dl\\${kind}.exe`, hash: 'b'.repeat(64), version: 'version-1' }; },
    startFetched: async (r) => { if (w.startFails) return false; const pid = w.start('installer', r.kind, { through: true, file: r.file }); w.started.push({ pid, at: now, download: true }); return pid; },
    restart: async (pids) => {
      await sleep(300);
      if (w.killFails) return { success: false, code: 'notstopped', left: pids, stopped: 0 };
      for (const pid of pids) { const p = procs.get(pid); if (p) { p.alive = false; p.end = now; w.killed.push({ pid, at: now, start: p.start }); } }
      if (w.startFails) return { success: false, code: 'failed' };
      const pid = w.start('player', 'player', { through: true });
      w.started.push({ pid, at: now, player: true });
      return { success: true, pid };
    },
    log: (level, msg) => w.logs.push(msg),
    tell: (id) => w.told.push(id),
    needAdvanced: () => {},
    studioReopen: () => {},
  });
  /* What main.js does: the mode comes on (what is open is listed), protection
   * comes on, the autopilot's verdict comes. */
  w.modeOn = async () => {
    w.on = true;
    w.watch.modeOn(listing(), w.wall);
  };
  w.engineOn = () => { w.active = true; w.watch.warm(); };
  w.engineOff = () => { w.active = false; w.watch.halt(); };
  w.verdict = () => { w.blocked = true; w.watch.warm(); };
  w.restartedAfter = (pid) => {
    const k = w.killed.find((x) => x.pid === pid);
    const player = procs.get(pid).role === 'player';
    const s = k && w.started.find((x) => x.at >= k.at && !!x.player === player);
    return s ? s.at + w.offset - k.start : null;
  };
  return w;
}

/* Mode, protection and verdict in place since long ago: how a day goes. */
async function steady(opts) {
  const w = world(opts);
  w.watch.start();
  await w.modeOn();
  w.engineOn();
  w.verdict();
  await w.run(5 * 60 * 1000);
  return w;
}

(async () => {
  // ── one process, by the rules ──
  {
    const J = W.judge;
    const base = { role: 'installer', firstSeen: 10000, after: 8000, startedAt: null, probing: false };
    t.ok(J(base, { now: 12000 }) === 'waiting' && J(base, { now: 16000 }) === 'around',
      `an installer that has asked nothing is judged ${W.QUIET_MS.installer / 1000} s after it was first seen`);
    t.ok(J({ ...base, startedAt: 9000 }, { now: 15000 }) === 'around', 'or after it started, once its start time is known');
    t.ok(J({ ...base, startedAt: 9000 }, { now: 30000, lastRequestAt: 9500 }) === 'through', 'a request from Roblox since it started: it uses Shroudly, never touched');
    t.ok(J({ ...base, startedAt: 9000 }, { now: 30000, lastRequestAt: 8500 }) === 'around', 'one from before it started says nothing about it');
    t.ok(J(base, { now: 30000, lastRequestAt: 8500 }) === 'through', 'without its start time, a request in the seconds it may have started counts for it (never restarted on a doubt)');
    t.ok(J({ ...base, startedAt: 2000 }, { now: 10500, setAt: 5000, lastRequestAt: 9000 }) === 'through',
      "a start time from before the look before is held to that look (the clock may have been set): it cannot mean it started before the setting");
    t.ok(J({ ...base, after: null, startedAt: 4000 }, { now: 10100, setAt: 5000 }) === 'around', 'started before the setting was in place: around it at once');
    t.ok(J({ ...base, after: null, probing: true }, { now: 15000 }) === 'waiting', 'seen on the first look: its start time is waited for');
    t.ok(J({ ...base, after: null, probing: true }, { now: 10000 + W.INFO_WAIT_MS }) === 'around' && J({ ...base, after: null, probing: true }, { now: 10000 + W.INFO_WAIT_MS, lastRequestAt: 1 }) === 'through',
      `not for longer than ${W.INFO_WAIT_MS / 1000} s (a PowerShell that takes 20 s to start): judged without it, any request from Roblox sparing it`);
    t.ok(J({ ...base, after: null }, { now: 30000, lastRequestAt: 1 }) === 'through', 'and if it cannot be read, any request from Roblox at all spares it');
    t.ok(J({ ...base, role: 'player' }, { now: 10000 + 16000 }) === 'waiting' && J({ ...base, role: 'player' }, { now: 10000 + W.QUIET_MS.player }) === 'around' && W.QUIET_MS.player >= 20000,
      `a player gets ${W.QUIET_MS.player / 1000} s (a slow PC can take long to load it before its first request)`);
    // A Shroudly started again (after a crash) has seen no request from
    // before it started: a player in a game since long ago is given its
    // quiet wait from then, not judged around at once.
    t.ok(J({ ...base, role: 'player', startedAt: 1000, after: null }, { now: 10000 + 5000, from: 10000 }) === 'waiting'
      && J({ ...base, role: 'player', startedAt: 1000, after: null }, { now: 10000 + W.QUIET_MS.player, from: 10000 }) === 'around'
      && W.dueAt({ ...base, role: 'player', startedAt: 1000, after: null }, 10000) === 10000 + W.QUIET_MS.player,
    "silence from before this Shroudly could see requests is not counted (a restart after a crash)");
  }
  {
    const P = W.pollDelay;
    t.ok(P({ on: false }) === W.SLOW_MS && P({ on: true, watched: true, pending: true }) === W.FAST_MS && P({ on: true, watched: true, warm: true }) === W.FAST_MS,
      `every ${W.FAST_MS / 1000} s while a program is judged or may be about to start`);
    t.ok(P({ on: true, watched: true, active: true, blocked: true }) === W.IDLE_MS && P({ on: true, watched: true, active: true }) === W.SLOW_MS && P({ on: true, watched: false, active: true, blocked: true }) === W.SLOW_MS,
      `else every ${W.IDLE_MS / 1000} s where there is something to act on, ${W.SLOW_MS / 1000} s otherwise (and on macOS)`);
  }

  // ── an installer started around Shroudly, at any moment, on any machine ──
  for (const [machine, probeMs, sigMs] of [['a quick machine', 600, 300], ['a typical machine', 1200, 1500], ['a slow machine', 2500, 4000]]) {
    const times = [];
    // The worst case: first seen a whole idle look after it started, then
    // read, then its file checked. Within the quiet wait on most machines.
    // Then, right before it is stopped, it is made sure it is still the same
    // process (a listing and a question to the PowerShell kept running).
    const bound = Math.max(W.QUIET_MS.installer + W.FAST_MS + 600, W.IDLE_MS + 120 + probeMs + sigMs + 600) + VERIFY_MS;
    {
      for (let k = 0; k < 12; k++) {
        const w = world({ probeMs, sigMs });
        w.watch.start();
        await w.modeOn();
        w.engineOn();
        w.verdict();
        await w.run(90000 + k * 433);      // any phase of the looks
        const pid = w.start('installer', 'player');
        await w.run(w.now + 60000);
        const took = w.restartedAfter(pid);
        times.push(took);
        if (took == null || took > bound) { t.ok(false, `installer around Shroudly (probe ${probeMs} ms, signature ${sigMs} ms, phase ${k}): restarted after ${took} ms`); }
        const again = w.started.find((s) => s.at - w.procs.get(pid).start === took);
        if (!again || again.file !== w.procs.get(pid).path || w.installs) t.ok(false, 'started again from its own file, no download');
      }
    }
    const max = Math.max(...times); const avg = times.reduce((a, b) => a + b, 0) / times.length;
    t.ok(max <= bound && (probeMs + sigMs > 3000 || max <= 8000 + VERIFY_MS) && avg >= W.QUIET_MS.installer,
      `${machine} (PowerShell ${probeMs / 1000} s, signature ${sigMs / 1000} s): an installer started around Shroudly is started again through it after ${(avg / 1000).toFixed(1)} s on average, ${(max / 1000).toFixed(1)} s at most, whenever it starts (12 moments); never before its ${W.QUIET_MS.installer / 1000} s`);
  }
  {
    // The slowest signature check (revocation asked of a slow network) is
    // what the user waits for, not the checks before it as well.
    const w = world({ sigMs: 20000 });
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const pid = w.start('installer', 'player');
    await w.run(w.now + 60000);
    const took = w.restartedAfter(pid);
    t.ok(took != null && took <= W.IDLE_MS + 120 + 1200 + 20000 + 600 + VERIFY_MS, `a 20 s signature check: started again ${(took / 1000).toFixed(1)} s after it started (the check began when it was first seen, not when it was judged)`);
  }
  {
    // The same file a second time: its signature is not asked again.
    const w = world({ sigMs: 20000 });
    let known = null;
    w.watch.d.signed = async (file) => { if (known === file) return 'a'.repeat(64); w.sigs++; await w.sleep(20000); known = file; return 'a'.repeat(64); };
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const a = w.start('installer', 'player');
    await w.run(w.now + 60000);
    const b = w.start('installer', 'player');
    await w.run(w.now + 60000);
    t.ok(w.sigs === 1 && w.restartedAfter(b) <= 8000 + VERIFY_MS, `the same installer again: no second signature check, started again within ${(w.restartedAfter(b) / 1000).toFixed(1)} s (first time ${(w.restartedAfter(a) / 1000).toFixed(1)} s)`);
  }

  // ── slow machines: PowerShell that takes 20 s to start, signatures that take 20 s ──
  {
    // An ARM PC (windows-11-arm on CI: 20 s to start PowerShell, 23 s for
    // the signature with it). PowerShell is started when the mode comes on,
    // so an installer started later finds it ready; the signature is what
    // the user waits for, and the installer is started again the moment it
    // is known.
    const w = world({ coldMs: 20000, probeMs: 300, sigMs: 3500 });
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const pid = w.start('installer', 'player');
    await w.run(w.now + 120000);
    const took = w.restartedAfter(pid);
    const s = w.started.find((x) => x.at - w.procs.get(pid).start === took);
    t.ok(took != null && took <= W.IDLE_MS + 120 + 300 + 3500 + 800 + VERIFY_MS && s && s.file && !w.installs,
      `a slow PC whose PowerShell was started ahead: an installer around Shroudly started again from its own file after ${(took / 1000).toFixed(1)} s`);
  }
  {
    // The same machine at boot, with the installer already running: the
    // cold start and a 23 s check both fall on the user, nothing more.
    const w = world({ coldMs: 20000, probeMs: 300, sigMs: 3500 });
    w.watch.start();
    const pid = w.start('installer', 'player');
    await w.run(1500); await w.modeOn();
    await w.run(3000); w.engineOn();
    await w.run(12000); w.verdict();
    await w.run(180000);
    const took = w.restartedAfter(pid);
    t.ok(took != null && w.signedAt != null && took - (w.signedAt - w.procs.get(pid).start) <= 1000,
      `at a slow PC's boot: started again ${(took / 1000).toFixed(1)} s after it started, ${((took - (w.signedAt - w.procs.get(pid).start)) / 1000).toFixed(1)} s after its signature was known (PowerShell started with the mode, 20 s to start)`);
  }
  {
    // The computer sleeps ten seconds after a player started, before it
    // asked anything: it could not ask while asleep. Its silence counts from
    // the wake, and the request it makes then spares it. A player that stays
    // silent after the wake is still restarted.
    const w = world();
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const player = w.start('player', 'player', { through: true, asks: [15000] });
    await w.run(w.now + 10000);
    w.offset += 3600 * 1000;           // an hour asleep: the clock jumps, the timers do not run
    w.watch.resumed();
    await w.run(w.now + 60000);
    t.ok(!w.killed.some((k) => k.pid === player), 'woken up an hour later: a player that asks right after the wake is not restarted (it could not ask while asleep)');
    const v = world();
    v.watch.start(); await v.modeOn(); v.engineOn(); v.verdict();
    await v.run(60000);
    const around = v.start('player', 'player');
    await v.run(v.now + 10000);
    v.offset += 3600 * 1000;
    v.watch.resumed();
    await v.run(v.now + 4000);
    t.ok(!v.killed.length, 'a silent one is not restarted at the wake either');
    await v.run(v.now + 40000);
    t.ok(v.killed.some((k) => k.pid === around), 'but once it has stayed silent for its time after the wake, it is');
    // The clock set back an hour (by hand, by NTP): silence counts from the
    // change, not from an hour ahead.
    const c = world();
    c.watch.start(); await c.modeOn(); c.engineOn(); c.verdict();
    await c.run(60000);
    const silent = c.start('player', 'player');
    await c.run(c.now + 10000);
    c.offset -= 3600 * 1000;
    c.watch.resumed();
    await c.run(c.now + 40000);
    t.ok(c.killed.some((k) => k.pid === silent), 'the clock set back an hour: a silent player is still restarted after its time, not an hour later');
  }
  {
    // A slow signature check holds up nothing else: a player around Shroudly
    // started meanwhile is restarted on time.
    const w = world({ sigMs: 40000 });
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const inst = w.start('installer', 'player');
    await w.run(w.now + 3000);
    const player = w.start('player', 'player');
    await w.run(w.now + 60000);
    const tp = w.restartedAfter(player); const ti = w.restartedAfter(inst);
    t.ok(tp != null && tp <= W.QUIET_MS.player + 3000 + VERIFY_MS && ti != null && ti >= 40000 && ti > tp + 3000,
      `while an installer's signature takes 40 s (started again after ${(ti / 1000).toFixed(1)} s), a player around Shroudly is restarted after ${(tp / 1000).toFixed(1)} s: the looks go on`);
  }
  {
    // PowerShell gives nothing at all (missing, blocked by AppLocker, never
    // answering): the installer is still judged, from the process list
    // alone, but it cannot be told apart from a program that got its process
    // id later, so it is never stopped: the user is asked to start it again.
    const w = world({ infoFails: true });
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const pid = w.start('installer', 'player');
    const pid2 = w.start('installer', 'player');
    await w.run(w.now + 3 * 60000);
    t.ok(!w.killed.length && w.procs.get(pid).alive && w.procs.get(pid2).alive && !w.installs && !w.started.length
      && w.told.filter((x) => x === 'autoInstallerAround').length === 1 && w.logs.some((l) => /left running \(PowerShell did not answer\)/.test(l)),
    `no answer from PowerShell: nothing stopped, nothing downloaded; the user told once (${w.told.join(', ')}): ${w.logs.filter((l) => /left running/.test(l)).length} lines in the log`);
  }
  {
    // A PowerShell an administrator restricted (ConstrainedLanguage, under
    // AppLocker or Device Guard): what it says is not acted on.
    const w = world({ restricted: 'ConstrainedLanguage' });
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const inst = w.start('installer', 'player');
    const player = w.start('player', 'player');
    await w.run(w.now + 2 * 60000);
    t.ok(!w.killed.length && w.procs.get(inst).alive && w.procs.get(player).alive && !w.installs && !w.started.length
      && w.told.includes('autoInstallerAround') && w.told.includes('autoRobloxAround') && w.logs.some((l) => /restricted here \(ConstrainedLanguage\)/.test(l)),
    `PowerShell in ConstrainedLanguage: the installer and the player are left running, the user is told (${w.told.join(', ')})`);
  }
  {
    // Neither its own file (not Roblox's signed one) nor a download (the
    // engine cannot reach Roblox's servers): nothing could be started in its
    // place, so it is not stopped.
    const w = world();
    w.unsigned = true; w.fetchFails = true;
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const pid = w.start('installer', 'player');
    await w.run(w.now + 60000);
    t.ok(!w.killed.length && w.procs.get(pid).alive && w.installs === 1 && !w.started.length && w.told.includes('autoInstallerAround')
      && w.logs.some((l) => /left running \(no installer to start in its place: timed out\)/.test(l)),
    'no installer to start in its place: the one around Shroudly is never stopped, the user is told');
  }
  {
    // It cannot be stopped (an administrator's, or another user's): no
    // second installer is started beside it; the user is told.
    const w = world();
    w.killFails = true;
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const pid = w.start('installer', 'player');
    const player = w.start('player', 'player');
    await w.run(w.now + 60000);
    t.ok(w.procs.get(pid).alive && w.procs.get(player).alive && !w.started.length && w.told.includes('autoInstallerAround') && w.told.includes('autoRobloxAround')
      && w.logs.filter((l) => /left running \(it could not be stopped\)/.test(l)).length === 2 && !w.logs.some((l) => /started it again|restarted it/.test(l)),
    'one that could not be stopped: nothing started beside it, the user told, nothing said to be started again');
  }
  {
    // Two installers around Shroudly, and only one can be stopped: the one
    // that was is started again through Shroudly, the other is left and the
    // user told about it alone.
    const w = world();
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const a = w.start('installer', 'player');
    const b = w.start('installer', 'player');
    w.killFails = new Set([a]);
    await w.run(w.now + 60000);
    const left = w.logs.filter((l) => /left running \(it could not be stopped\)/.test(l));
    t.ok(w.procs.get(a).alive && !w.procs.get(b).alive && w.started.length === 1 && left.length === 1
      && w.told.includes('autoInstallerAround') && w.told.includes('autoInstallerRestarted') && w.logs.some((l) => /started it again through Shroudly/.test(l)),
    `two installers, one that cannot be stopped: the other is started again (${w.started.length} started), only the one left is reported (${left.length})`);
  }
  {
    // Stopped, but what was to start in its place could not be started: the
    // user is told to start it again, never a silent loss. The same for a
    // player quit and Roblox not opened again.
    const w = world();
    w.startFails = true;
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const inst = w.start('installer', 'player');
    const player = w.start('player', 'player');
    await w.run(w.now + 60000);
    t.ok(!w.procs.get(inst).alive && !w.procs.get(player).alive && w.told.includes('autoInstallerStopped') && w.told.includes('autoRobloxStopped')
      && w.logs.some((l) => /was stopped, but the one to start in its place could not be started/.test(l)) && w.logs.some((l) => /was closed, but could not be opened again/.test(l))
      && !w.told.includes('autoInstallerRestarted') && !w.told.includes('autoRobloxRestarted'),
    `stopped, but nothing could be started in its place: the user is told (${w.told.join(', ')})`);
  }
  {
    // Its file is not Roblox's signed installer: never started.
    const w = world();
    w.unsigned = true;
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const pid = w.start('installer', 'player');
    await w.run(w.now + 60000);
    t.ok(w.killed.some((x) => x.pid === pid) && w.installs === 1 && !w.started.some((x) => x.file), 'a file not signed by Roblox is never started: the current installer is downloaded through the engine instead');
  }

  // ── what must never be touched ──
  {
    const w = await steady();
    const ok = w.start('installer', 'player', { through: true });
    const slow = w.start('installer', 'player', { through: true, ask: 4000 });
    await w.run(w.now + 10 * 60 * 1000);
    t.ok(!w.killed.length && !w.started.length && w.procs.get(ok).alive && w.procs.get(slow).alive,
      'installers started through Shroudly (asking at once, or only after 4 s on a slow machine) are never touched in ten minutes');
  }
  {
    const w = await steady();
    // A player that got into a game through Shroudly, then holds its
    // connections for two hours without a new request.
    const inGame = w.start('player', 'player', { through: true, ask: 1500 });
    await w.run(w.now + 2 * 60 * 60 * 1000);
    t.ok(!w.killed.length && w.procs.get(inGame).alive, 'a player in a game through Shroudly is never restarted, however long it plays without asking anything');
    // Meanwhile a second player, started from a browser that was open before
    // Shroudly, goes around it.
    const around = w.start('player', 'player');
    await w.run(w.now + 60000);
    const took = w.restartedAfter(around);
    t.ok(w.procs.get(inGame).alive && took != null && took <= W.QUIET_MS.player + 3000 + VERIFY_MS && w.killed.every((k) => k.pid === around),
      `only the player that goes around Shroudly is restarted (after ${(took / 1000).toFixed(1)} s), never the one in a game`);
  }
  {
    // What Shroudly started itself is never taken for something around it,
    // even if it never asks: no restart loop.
    const w = await steady();
    w.watch.d.startInstaller = (file) => { const pid = w.start('installer', 'player', { file }); w.started.push({ pid, at: w.now, file }); return pid; };
    const pid = w.start('installer', 'player');
    await w.run(w.now + 10 * 60 * 1000);
    t.ok(w.killed.length === 1 && w.killed[0].pid === pid && w.started.length === 1, 'an installer Shroudly started again is never restarted itself (no loop, even when it stays silent)');
  }
  {
    // Studio holds work that may not be saved: told about, never closed.
    const w = await steady();
    const studio = w.start('studio', 'studio');
    await w.run(w.now + 60000);
    t.ok(!w.killed.length && w.procs.get(studio).alive && w.told.filter((x) => x === 'autoStudioReopen').length === 1, 'a Studio around Shroudly is never closed; the user is told, once');
  }

  // ── timing that must not fool it ──
  {
    // A listing is taken somewhere between being asked for and returning
    // (tasklist takes its snapshot first): an installer that started while
    // one was under way, asked Roblox's servers through Shroudly before it
    // returned and then only downloads over the connections it opened, is
    // never taken for one going around Shroudly.
    let touched = 0; let n = 0;
    for (let k = 0; k < 20; k++) {
      const w = world({ listMs: 1500, snapshotAt: 'start' });
      w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
      await w.run(90000 + k * 397);
      const pid = w.start('installer', 'player', { through: true, asks: [200, 500] });
      await w.run(w.now + 60000);
      n++;
      if (w.killed.some((x) => x.pid === pid)) touched++;
    }
    t.ok(!touched, `an installer that asked through Shroudly while a 1.5 s listing was under way, then only downloads, is never touched (${touched} of ${n} moments)`);
  }
  {
    // While its start time and file are still being read (PowerShell takes
    // 30 s at a slow PC's boot), the installer ends and Windows gives its
    // process id to another program: that one is never stopped, and the
    // user is not told about an installer that is gone.
    const w = world({ coldMs: 30000, probeMs: 300 });
    w.watch.start();
    await w.run(1000); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(2000);
    const pid = w.start('installer', 'player');
    await w.run(15000); w.end(pid);
    await w.run(15500);
    w.start('installer', 'player', { pid, through: true });
    await w.run(w.now + 120000);
    t.ok(!w.killed.length && w.procs.get(pid).alive && !w.told.length && !w.started.length,
      `a process id given to another program while the first was being read is never stopped (killed: ${JSON.stringify(w.killed)}, told: ${w.told.join(', ') || 'nothing'})`);
  }
  {
    // Protection is stopped while an installer's signature is being checked:
    // nothing is stopped or started after that; once protection is back, it
    // is seen to.
    const w = world({ sigMs: 20000 });
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(60000);
    const pid = w.start('installer', 'player');
    await w.run(w.now + 12000);
    w.engineOff();
    await w.run(w.now + 60000);
    const untouched = !w.killed.length && !w.started.length && w.procs.get(pid).alive;
    w.engineOn();
    await w.run(w.now + 30000);
    t.ok(untouched && w.killed.some((x) => x.pid === pid) && w.started.length === 1,
      `protection stopped while it was being seen to: nothing stopped or started (${untouched}); seen to once protection is back (${w.started.length} started)`);
  }
  {
    // Shroudly started again after a crash, the setting still in place (so
    // nothing tells what was open before it): a player in a game through it
    // for half an hour, whose connections went with the old Shroudly, asks
    // again 12 s later: never restarted. One that stays silent is, after its
    // quiet wait counted from then.
    const w = world();
    const player = w.start('player', 'player');
    await w.run(30 * 60000);
    w.watch.start(); w.on = true; w.watch.warm(); w.engineOn(); w.verdict();
    w.ask(12000);
    await w.run(w.now + 5 * 60000);
    const w2 = world();
    const silent = w2.start('player', 'player');
    await w2.run(30 * 60000);
    const back = w2.now;
    w2.watch.start(); w2.on = true; w2.watch.warm(); w2.engineOn(); w2.verdict();
    await w2.run(w2.now + 5 * 60000);
    const k = w2.killed.find((x) => x.pid === silent);
    t.ok(!w.killed.length && w.procs.get(player).alive && k && k.at - back >= W.QUIET_MS.player && k.at - back <= W.QUIET_MS.player + 3000 + VERIFY_MS,
      `after a crash: a player that asks again within seconds is left in its game; a silent one is restarted ${k ? ((k.at - back) / 1000).toFixed(1) : '-'} s after Shroudly is back, not at once`);
  }
  {
    // The clock is set back after the setting was put in place (Windows
    // correcting a clock that ran fast): programs started since, through
    // Shroudly, are not taken for ones started before the setting.
    const w = world();
    w.watch.start();
    await w.run(1000 * 1000);
    await w.modeOn(); w.engineOn(); w.verdict();
    await w.run(w.now + 60000);
    w.offset -= 250000;
    const inst = w.start('installer', 'player', { through: true });
    const player = w.start('player', 'player', { through: true, ask: 1500 });
    await w.run(w.now + 5 * 60000);
    t.ok(!w.killed.length && w.procs.get(inst).alive && w.procs.get(player).alive, `a clock set back 250 s after the setting: what goes through Shroudly is never touched (${w.killed.length} stopped)`);
  }
  {
    // A player that takes long to load on a slow PC (its first request 15 s
    // after it started) goes through Shroudly: never restarted. Nor one
    // whose first request comes while the verdict is checked again right
    // before it would be: it is judged again then.
    const w = await steady();
    const slow = w.start('player', 'player', { through: true, ask: 15000 });
    await w.run(w.now + 10 * 60000);
    const w2 = await steady();
    w2.stillMs = 3000;
    const late = w2.start('player', 'player', { through: true, ask: W.QUIET_MS.player + 1000 });
    await w2.run(w2.now + 5 * 60000);
    t.ok(!w.killed.length && w.procs.get(slow).alive && !w2.killed.length && w2.procs.get(late).alive,
      `a slow player (first request after 15 s), and one asking only while it was being seen to, are never restarted (${w.killed.length + w2.killed.length} restarted)`);
  }
  {
    // Its first request comes while it is being made sure of, right before
    // it would be quit (a slow PowerShell): judged again then, spared.
    const w = await steady({ warmInfoMs: 4000 });
    const late = w.start('player', 'player', { through: true, ask: W.QUIET_MS.player + 2500 });
    await w.run(w.now + 5 * 60000);
    t.ok(!w.killed.length && w.procs.get(late).alive && w.probes >= 2,
      `a player whose first request comes while it is checked again right before it would be quit is never restarted (${w.killed.length} restarted, ${w.probes} PowerShell questions)`);
  }
  {
    // Shroudly quit (or updated itself) and started again with the same
    // port: the mode comes on with a player in a game through it. Its
    // requests through the new Shroudly spare it; one that sends none is
    // restarted once its quiet wait has passed, not at once.
    const w = world();
    const inGame = w.start('player', 'player', { through: true, asks: [] });
    await w.run(10 * 60000);
    w.watch.start(); await w.modeOn(); w.engineOn(); w.verdict();
    w.ask(3000);
    await w.run(w.now + 5 * 60000);
    const w2 = world();
    const silent = w2.start('player', 'player');
    await w2.run(10 * 60000);
    w2.watch.start(); const back = w2.wall; await w2.modeOn(); w2.engineOn(); w2.verdict();
    await w2.run(w2.now + 5 * 60000);
    const k = w2.killed.find((x) => x.pid === silent);
    t.ok(w.procs.get(inGame).alive && !w.killed.length && k && k.at - back >= W.QUIET_MS.player && k.at - back <= W.QUIET_MS.player + 3000 + VERIFY_MS,
      `after Shroudly is back on the same port: a player in a game that asks through it is left in its game; a silent one open before is restarted ${k ? ((k.at - back) / 1000).toFixed(1) : '-'} s after, not at once`);
  }

  // ── the internet cafe: a script starts the installer as Shroudly starts ──
  for (const [label, verdictAt] of [['a DNS block', 5000], ['a filter that drops silently', 12000]]) {
    for (const [when, at] of [['before', 500], ['while', 2600]]) {
      const w = world();
      w.watch.start();
      let pid = null;
      if (at < 1500) { await w.run(at); pid = w.start('installer', 'player'); }
      await w.run(1500);
      await w.modeOn();                      // the mode, from the settings, as Shroudly starts
      if (!pid) { await w.run(at); pid = w.start('installer', 'player'); }
      await w.run(3000);
      w.engineOn();                          // protection is up
      await w.run(verdictAt);
      w.verdict();                           // the autopilot: Roblox is blocked here
      await w.run(120000);
      const took = w.restartedAfter(pid);
      const after = took == null ? null : took + w.procs.get(pid).start - verdictAt;
      // The verdict is the gate (Roblox really blocked here); then only the
      // quiet wait of one started after the setting.
      const bound = Math.max(verdictAt - w.procs.get(pid).start, when === 'before' ? 0 : W.QUIET_MS.installer) + 2600;
      t.ok(took != null && after >= 0 && took <= bound,
        `cafe, installer started ${when} the setting, ${label} (verdict ${verdictAt / 1000} s after Shroudly started): started again through Shroudly ${(took / 1000).toFixed(1)} s after it started, ${(after / 1000).toFixed(1)} s after the verdict`);
    }
  }
  {
    // No verdict yet (offline at login): the autopilot is asked to find out
    // while an installer waits, and the verdict acts at once.
    const w = world();
    w.watch.start(); await w.modeOn(); w.engineOn();
    await w.run(30000);
    const pid = w.start('installer', 'player');
    await w.run(w.now + 20000);
    t.ok(w.checks > 0 && !w.killed.length, `an installer around Shroudly with no verdict yet: the check is asked for (${w.checks}x), nothing touched`);
    const v = w.now;
    w.verdict();
    await w.run(w.now + 20000);
    const k = w.killed.find((x) => x.pid === pid);
    t.ok(k && k.at - v <= 1000, `the verdict comes: dealt with ${(k.at - v)} ms later, not at the next look`);
  }
  {
    // Not blocked here: nothing is touched, whatever goes around.
    const w = world();
    w.watch.start(); await w.modeOn(); w.engineOn();
    w.start('installer', 'player'); w.start('player', 'player');
    await w.run(10 * 60 * 1000);
    t.ok(!w.killed.length && !w.started.length, 'where Roblox is not blocked nothing is ever touched');
  }

  // ── what it costs ──
  {
    const w = await steady();
    const l0 = w.lists; const t0 = w.now;
    await w.run(w.now + 60 * 60 * 1000);
    const perMin = (w.lists - l0) / ((w.now - t0) / 60000);
    t.ok(perMin <= 12.5 && w.probes === 0 && w.sigs === 0, `nothing running: ${perMin.toFixed(1)} process listings a minute, nothing else (the 20 s look made 3 listings each: 9 a minute)`);
    const w2 = world();
    w2.watch.start(); await w2.modeOn(); w2.engineOn();
    await w2.run(2 * 60 * 1000);
    const l1 = w2.lists;
    await w2.run(62 * 60 * 1000);
    t.ok((w2.lists - l1) / 60 <= 3.1, `Roblox not blocked here: ${((w2.lists - l1) / 60).toFixed(1)} listings a minute`);
    const w3 = await steady();
    const l2 = w3.lists;
    w3.start('player', 'player', { through: true, every: 0 });
    await w3.run(w3.now + 60 * 60 * 1000);
    t.ok((w3.lists - l2) / 60 <= 13 && w3.probes === 1, `a player in a game for an hour: ${((w3.lists - l2) / 60).toFixed(1)} listings a minute, one PowerShell call in all`);
  }

  console.log(`roblox-watch: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
