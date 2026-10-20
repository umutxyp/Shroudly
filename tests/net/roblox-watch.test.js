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

/* A computer, with a clock that only moves when the simulation says so.
 *   probeMs   a PowerShell call reading start times and files
 *   sigMs     the signature check (revocation asked online)
 *   listMs    one process listing
 *   firstAskMs  how soon a program started through Shroudly asks Roblox */
function world({ probeMs = 1200, sigMs = 1500, listMs = 120, firstAskMs = 800, watched = true } = {}) {
  let now = 0;
  let seq = 1;
  const timers = [];
  const setT = (fn, ms) => { const id = seq++; timers.push({ at: now + Math.max(0, ms), fn, id }); return id; };
  const clearT = (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); };
  const sleep = (ms) => new Promise((r) => setT(r, ms));
  const procs = new Map();   // pid -> { role, kind, start, path, through, alive, end }
  let nextPid = 4000;
  let lastRequestAt = 0;
  const w = {
    get now() { return now; },
    procs, lists: 0, probes: 0, sigs: 0, killed: [], started: [], checks: 0, logs: [], told: [], installs: 0,
    on: false, active: false, blocked: false,
    sleep,
    /* A program starts. through: it has the setting (it asks Roblox through
     * Shroudly firstAskMs later, and again every `every` ms if given). */
    start(role, kind, { through = false, file = null, every = 0, ask = firstAskMs } = {}) {
      const pid = nextPid++;
      const p = { pid, role, kind, start: now, path: file || `D:\\Games\\Roblox\\${kind === 'studio' ? 'RobloxStudioInstaller' : 'RobloxPlayerInstaller'}.exe`, through, alive: true, end: 0 };
      procs.set(pid, p);
      if (through) {
        const asks = () => { if (p.alive) { lastRequestAt = now; if (every) setT(asks, every); } };
        setT(asks, ask);
      }
      return pid;
    },
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
  w.watch = new W.RobloxWatch({
    now: () => now,
    setTimeout: setT,
    clearTimeout: clearT,
    watched,
    on: () => w.on,
    active: () => w.active,
    blocked: () => w.blocked,
    stillBlocked: async () => w.blocked,
    checkSoon: () => { w.checks++; },
    lastRequestAt: () => lastRequestAt,
    list: async () => {
      w.lists++;
      await sleep(listMs);
      const a = alive();
      const of = (role, kind) => a.filter((p) => p.role === role && (!kind || p.kind === kind)).map((p) => p.pid);
      return { players: of('player'), studios: of('studio'), installers: { player: of('installer', 'player'), studio: of('installer', 'studio') } };
    },
    info: async (pids) => {
      w.probes++;
      await sleep(probeMs);
      const m = new Map();
      for (const pid of pids) { const p = procs.get(pid); if (p && p.alive) m.set(pid, { startedAt: p.start, path: p.role === 'installer' ? p.path : null }); }
      return m;
    },
    signed: async (file) => { w.sigs++; await sleep(sigMs); return /Installer\.exe$/.test(file) ? 'a'.repeat(64) : null; },
    same: async () => true,
    kill: async (pids) => { await sleep(150); for (const pid of pids) { const p = procs.get(pid); if (p) { p.alive = false; p.end = now; w.killed.push({ pid, at: now }); } } return true; },
    startInstaller: (file) => {
      const old = [...procs.values()].find((p) => p.path === file && p.role === 'installer');
      const pid = w.start('installer', old ? old.kind : 'player', { through: true, file });
      w.started.push({ pid, at: now, file });
      return pid;
    },
    install: async (kind) => { w.installs++; await sleep(4000); const pid = w.start('installer', kind, { through: true }); w.started.push({ pid, at: now, download: true }); return { success: true, pid }; },
    restart: async (pids) => {
      await sleep(300);
      for (const pid of pids) { const p = procs.get(pid); if (p) { p.alive = false; p.end = now; w.killed.push({ pid, at: now }); } }
      const pid = w.start('player', 'player', { through: true });
      w.started.push({ pid, at: now, player: true });
      return pid;
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
    const a = alive();
    const of = (role, kind) => a.filter((p) => p.role === role && (!kind || p.kind === kind)).map((p) => p.pid);
    w.watch.modeOn({ players: of('player'), studios: of('studio'), installers: { player: of('installer', 'player'), studio: of('installer', 'studio') } }, now);
  };
  w.engineOn = () => { w.active = true; w.watch.warm(); };
  w.verdict = () => { w.blocked = true; w.watch.warm(); };
  w.restartedAfter = (pid) => { const k = w.killed.find((x) => x.pid === pid); const s = k && w.started.find((x) => x.at >= k.at); return s ? s.at - procs.get(pid).start : null; };
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
    t.ok(J({ ...base, after: null, probing: true }, { now: 30000 }) === 'waiting', 'seen on the first look: its start time is waited for');
    t.ok(J({ ...base, after: null }, { now: 30000, lastRequestAt: 1 }) === 'through', 'and if it cannot be read, any request from Roblox at all spares it');
    t.ok(J({ ...base, role: 'player' }, { now: 16000 }) === 'waiting' && J({ ...base, role: 'player' }, { now: 18000 }) === 'around',
      `a player gets ${W.QUIET_MS.player / 1000} s (it starts slower than an installer)`);
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
    const bound = Math.max(W.QUIET_MS.installer + W.FAST_MS + 600, W.IDLE_MS + 120 + probeMs + sigMs + 600);
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
    t.ok(max <= bound && (probeMs + sigMs > 3000 || max <= 8000) && avg >= W.QUIET_MS.installer,
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
    t.ok(took != null && took <= W.IDLE_MS + 120 + 1200 + 20000 + 600, `a 20 s signature check: started again ${(took / 1000).toFixed(1)} s after it started (the check began when it was first seen, not when it was judged)`);
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
    t.ok(w.sigs === 1 && w.restartedAfter(b) <= 8000, `the same installer again: no second signature check, started again within ${(w.restartedAfter(b) / 1000).toFixed(1)} s (first time ${(w.restartedAfter(a) / 1000).toFixed(1)} s)`);
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
    t.ok(w.procs.get(inGame).alive && took != null && took <= 10000 && w.killed.every((k) => k.pid === around),
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
