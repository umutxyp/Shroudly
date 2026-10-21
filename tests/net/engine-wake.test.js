'use strict';

/* The app's side of the engine across a sleep, a frozen main process and a
 * clock change, and while it restarts (electron/engine-manager.js, wake.js):
 *  - a healthy engine is never taken for a hung one because the computer
 *    slept or its clock jumped (the poll ran late, the clocks disagree, the
 *    system said it woke up); a real hang is still caught, before a wake and
 *    after one;
 *  - a start is not failed because a sleep fell into its time limit;
 *  - from the moment a crash restart is decided until the engine is back,
 *    the engine counts as coming (what the Discord relay and the app proxy
 *    wait on), and the system proxy stays pointed at Shroudly, the new port
 *    going into the PAC; put back only when the engine is not coming back;
 *  - connections reported cut just after a wake are no news.
 * A stand-in engine (fixtures/fake-engine.js) runs on every OS. */

const path = require('path');
const fs = require('fs');
const { ROOT, sleep, freePort, suite } = require('./helpers');

const EngineManager = require(path.join(ROOT, 'electron', 'engine-manager.js'));
const { Wake } = require(path.join(ROOT, 'electron', 'wake.js'));
const FAKE = path.join(__dirname, 'fixtures', 'fake-engine.js');
const t = suite('engine-wake');

// The app's clock, moved by the tests where a clock change is the point.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const busy = (ms) => { const end = process.hrtime.bigint() + BigInt(ms) * 1000000n; while (process.hrtime.bigint() < end) { /* frozen */ } };
async function until(fn, ms, step = 20) {
  const end = realNow() + ms;
  for (;;) { if (await fn()) return true; if (realNow() > end) return false; await sleep(step); }
}

/* An EngineManager on the stand-in engine, with short windows. proxy: what
 * stands in for the system proxy. */
async function rig({ proxy = null, hangTimeoutMs = 1500, startTimeoutMs = 6000 } = {}) {
  const port = await freePort();
  const mem = { listenPort: port, autoMode: true, dnsProtection: false };
  const store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; }, delete: (k) => { delete mem[k]; }, get store() { return mem; } };
  const logs = [];
  const events = [];
  const wake = new Wake({ gapMs: 600, tickMs: 100 });
  const em = new EngineManager(store, {
    addLog: (l, m) => logs.push(`${l}: ${m}`), wake, hangTimeoutMs, pollMs: 100, startTimeoutMs,
    onHostEvent: (kind, host) => events.push(`${kind} ${host}`),
  });
  em.proxy = proxy || { apply: async () => ({ ok: true, code: 'ok' }), restore: async () => true, cleanupSync() {} };
  em._describeEnvironment = async () => {};
  const spawn = em._spawn.bind(em);
  em._spawn = (bin, args) => spawn(process.execPath, [FAKE, ...args]);
  // The binary check of a start: the stand-in is what runs.
  const exists = fs.existsSync;
  fs.existsSync = (p) => (p === EngineManager.coreBinaryPath() ? true : exists(p));
  return { em, logs, events, wake, mem };
}
const pidOf = (em) => (em.proc ? em.proc.pid : 0);
const hung = (logs) => logs.some((l) => l.includes('Engine stopped responding'));

(async () => {
  // ── a real hang is caught ──
  {
    const { em, logs } = await rig();
    await em.start();
    const first = pidOf(em);
    em.proc.stdin.write('HANG\n');
    t.ok(await until(() => hung(logs), 5000), 'an engine that stops answering is taken for hung within its window');
    t.ok(await until(() => em.active && pidOf(em) && pidOf(em) !== first, 8000), 'and restarted');
    await em.stop();
  }

  // ── a sleep where the timers stop (macOS, Linux): the wall clock jumps,
  //    the poll comes on time ──
  {
    const { em, logs, wake } = await rig();
    await em.start();
    const first = pidOf(em);
    await sleep(300);
    const e0 = wake.epoch;
    skew += 10 * 60 * 1000;            // ten minutes asleep
    await sleep(500);
    t.ok(!hung(logs) && pidOf(em) === first && em.active, 'the clock jumped ten minutes (a sleep): the healthy engine is left alone');
    t.ok(wake.epoch > e0 && wake.why === 'clock', `and the jump is seen as a wake (${wake.why})`);
    skew -= 30 * 60 * 1000;            // set back half an hour
    await sleep(500);
    em.proc.stdin.write('HANG\n');
    t.ok(await until(() => hung(logs), 5000), 'clock set back, then a real hang: still caught (not hidden until the clock catches up)');
    await until(() => em.active, 8000);
    await em.stop();
  }

  // ── a sleep where the timers count it (Windows), or a frozen main
  //    process: the poll runs late, with the engine's answer unread ──
  {
    const { em, logs, wake } = await rig();
    await em.start();
    const first = pidOf(em);
    await sleep(300);
    const e0 = wake.epoch;
    busy(2500);                        // nothing runs for longer than the hang window
    await sleep(400);
    t.ok(!hung(logs) && pidOf(em) === first, 'the poll ran 2.5 s late (longer than the hang window): the engine is given a fresh window, not killed');
    t.ok(wake.epoch > e0 && wake.why === 'late', 'and the late poll is seen as a wake');
    // A real hang after the wake is still caught.
    em.proc.stdin.write('HANG\n');
    t.ok(await until(() => hung(logs), 5000), 'a real hang after the wake: caught within the window');
    await until(() => em.active, 8000);
    await em.stop();
  }

  // ── the system says it woke up (powerMonitor 'resume') ──
  {
    const { em, logs } = await rig();
    await em.start();
    const first = pidOf(em);
    em.lastOutputAt = Date.now() - 5000;   // the engine's answer waiting unread
    em.resumed();
    await sleep(300);
    t.ok(!hung(logs) && pidOf(em) === first, "the system's resume gives the engine a fresh window at once");
    await em.stop();
  }

  // ── a sleep during a start ──
  {
    process.env.READY_DELAY_MS = '700';
    const { em, logs } = await rig({ startTimeoutMs: 500 });
    const p = em.start();
    await sleep(100);
    busy(1400);                        // the start's time limit passes while frozen
    let ok = true;
    try { await p; } catch (e) { ok = false; logs.push(`start failed: ${e.message}`); }
    t.ok(ok && em.active, 'a sleep that falls into a start\'s time limit does not fail the start');
    await em.stop();
    delete process.env.READY_DELAY_MS;
    const r2 = await rig({ startTimeoutMs: 300 });
    process.env.READY_DELAY_MS = '5000';
    let failed = false;
    try { await r2.em.start(); } catch { failed = true; }
    delete process.env.READY_DELAY_MS;
    t.ok(failed, 'an engine that really never says it is ready still fails the start');
  }

  // ── a crash restart: coming all along, the system proxy kept ──
  {
    const calls = [];
    const proxy = {
      applied: false,
      apply: async (port) => { calls.push(`apply ${port}`); proxy.applied = true; return { ok: true, code: 'ok' }; },
      restore: async () => { calls.push('restore'); await sleep(200); proxy.applied = false; return true; },
      updatePort: (port) => { calls.push(`port ${port}`); return true; },
      cleanupSync() {},
    };
    const { em } = await rig({ proxy });
    await em.start();
    const first = pidOf(em);
    calls.length = 0;
    let gaps = 0;
    let seen = false;
    const watch = setInterval(() => { if (!em.active) { seen = true; if (!em.coming) gaps++; } }, 5);
    em.proc.kill('SIGKILL');
    t.ok(await until(() => em.active && pidOf(em) !== first, 8000), 'the engine came back after a crash');
    clearInterval(watch);
    t.ok(seen && gaps === 0, `from the crash until it was back, it was "coming" all along (${gaps} moments it was not)`);
    t.ok(!calls.includes('restore') && calls.some((c) => c.startsWith('apply')), `the system proxy stayed pointed at Shroudly; only the PAC was given the port (${calls.join(', ')})`);
    // Not coming back: the user's own settings at once.
    calls.length = 0;
    em.restarts = 5;
    em.proc.kill('SIGKILL');
    t.ok(await until(() => calls.includes('restore'), 3000) && !em.coming, 'an engine that keeps crashing: the system proxy is put back, nothing is coming');
    await em.stop();
  }
  {
    // A Stop pressed during the restart: it ends stopped, nothing coming.
    const proxy = { applied: false, apply: async () => { proxy.applied = true; return { ok: true, code: 'ok' }; }, restore: async () => { proxy.applied = false; return true; }, updatePort: () => true, cleanupSync() {} };
    const { em } = await rig({ proxy });
    await em.start();
    em.proc.kill('SIGKILL');
    await until(() => !em.active, 2000);
    await em.stop();
    await sleep(1500);
    t.ok(!em.active && !em.coming && !proxy.applied, 'a Stop during a crash restart: stopped, nothing coming, the system proxy put back');
  }

  // ── cuts just after a wake ──
  {
    const { em, events, wake } = await rig();
    await em.start();
    wake.resumed('system');
    em._onLine(JSON.stringify({ type: 'cut', host: 'a.example', strategy: 'stall', attempts: 5 }));
    em._onLine(JSON.stringify({ type: 'cut', host: 'a.example', strategy: 'stall', attempts: 5 }));
    t.ok(!events.length && !em.advice.cut, 'connections reported cut just after a wake: no news (the sleep stalled them)');
    wake.at -= 31000;
    em._onLine(JSON.stringify({ type: 'cut', host: 'a.example', strategy: 'stall', attempts: 5 }));
    em._onLine(JSON.stringify({ type: 'cut', host: 'a.example', strategy: 'reset', attempts: 5 }));
    t.ok(events.length === 2 && em.advice.cut && em.advice.cut.host === 'a.example', 'half a minute later they count again');
    await em.stop();
  }

  // ── a command written to an engine that has just died ──
  {
    const { em } = await rig();
    await em.start();
    const p = em.proc;
    p.kill('SIGKILL');
    await new Promise((r) => p.once('exit', r));
    for (let i = 0; i < 3; i++) { try { p.stdin.write('STATS\n'); } catch {} await sleep(50); }
    await sleep(300);
    t.ok(true, 'a command written to an engine that has just died (EPIPE) does not take the app down');
    await until(() => em.active && em.proc && em.proc !== p, 8000);
    // Stop pressed the moment the engine died, before its end is seen: STOP
    // is written to a pipe nobody reads (Linux and Windows: EPIPE).
    em.proc.kill('SIGKILL');
    await sleep(30);
    await em.stop();
    await sleep(300);
    t.ok(!em.active, 'and so is a Stop pressed the moment the engine died');
  }

  // ── what was learnt, when the clock was set back ──
  {
    const { em, mem } = await rig();
    mem.learnedTechniques = { 'a.example': { s: 'split(sni)', t: Date.now() + 3600 * 1000 } };
    const list = em._learned();
    t.ok(list.length === 1 && list[0][1].t <= Date.now(), 'a technique learnt "in the future" (clock set back since) is kept, as learnt now');
  }

  // ── Wake.timeout: a limit measured across a sleep starts again ──
  {
    const w = new Wake({ gapMs: 300, tickMs: 50 });
    let fired = 0;
    const t0 = realNow();
    w.timeout(() => { fired = realNow() - t0; }, 400);
    await sleep(50);
    busy(900);
    await until(() => fired, 3000);
    t.ok(fired >= 1200, `a 400 ms limit that a 900 ms freeze fell into waits 400 ms more after it (${fired} ms)`);
  }

  console.log(`engine-wake: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
