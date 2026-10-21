'use strict';

/* When an automatic update restarts Shroudly (electron/updater.js). It waits
 * while a Roblox game or Discord goes through Shroudly, but never for good:
 * someone who keeps Discord open from login to shutdown must still be
 * updated. Every condition is looked at again when the countdown starts and
 * when it ends, "Install updates automatically" included. Electron is stood
 * in for, and the timers are driven by hand, so nothing waits a real minute. */

const path = require('path');
const Module = require('module');
const { ROOT, suite } = require('./helpers');

const electron = {
  app: { getVersion: () => '2.5.5', isPackaged: false },
  net: {}, session: {},
  powerMonitor: { getSystemIdleState: () => 'active' },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
const Updater = require(path.join(ROOT, 'electron', 'updater.js'));
const t = suite('updater');

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => { m.set(k, v); }, delete: (k) => { m.delete(k); }, m };
}

/* An updater with a downloaded update, as on Windows (electron-updater). */
function ready({ store = memStore(), busy = false, away = false } = {}) {
  const seen = { installed: 0, notified: 0, logs: [] };
  const u = new Updater({
    store, log: (l, m) => seen.logs.push(m), notify: () => { seen.notified++; },
    busy: async () => (typeof busy === 'function' ? busy() : busy), away: () => (typeof away === 'function' ? away() : away),
  });
  u.mac = false;
  u.eu = { quitAndInstall: () => { seen.installed++; } };
  u._set({ status: 'ready', version: '2.5.6' });
  return { u, seen, store };
}
const stop = (u) => { clearTimeout(u.waitTimer); clearTimeout(u.restartTimer); };
const HOURS = (h) => h * 60 * 60 * 1000;

(async () => {
  // ── what counts as in use ──
  let asked = 0;
  const yes = async () => { asked++; return true; };
  t.ok(await Updater.inUse({ protection: false, appMode: true, discordMode: true, robloxPlaying: yes, discordOpen: yes }) === false && asked === 0,
    'protection off: nothing goes through Shroudly, so nothing waits (and no program list is read)');
  t.ok(await Updater.inUse({ protection: true, appMode: false, discordMode: false, robloxPlaying: yes, discordOpen: yes }) === false && asked === 0,
    'Roblox and Discord open with their modes off: their traffic is not what a restart interrupts');
  t.ok(await Updater.inUse({ protection: true, appMode: true, discordMode: false, robloxPlaying: yes, discordOpen: yes }) === true, 'Roblox playing through Games and apps mode: in use');
  t.ok(await Updater.inUse({ protection: true, appMode: false, discordMode: true, robloxPlaying: yes, discordOpen: yes }) === true, 'Discord open with Discord app mode: in use');
  t.ok(await Updater.inUse({ protection: true, appMode: true, discordMode: true, robloxPlaying: async () => false, discordOpen: async () => false }) === false, 'modes on, nothing running: not in use');

  // ── the rule ──
  const P = Updater.restartPlan;
  const L = Updater.WAIT_LIMIT_MS;
  t.ok(P({ busy: false, waitedMs: 0, away: false }) === 'countdown' && P({ busy: true, waitedMs: 0, away: true }) === 'wait'
    && P({ busy: true, waitedMs: L - 1, away: true }) === 'wait' && P({ busy: true, waitedMs: L, away: false }) === 'wait'
    && P({ busy: true, waitedMs: L, away: true }) === 'countdown' && P({ busy: false, waitedMs: L, atLaunch: true }) === 'install'
    && P({ busy: false, waitedMs: 0, atLaunch: true }) === 'countdown', 'waits while in use; after the limit, installs once nobody is at the computer, or at launch');

  // ── a Discord that is open all day ──
  {
    const { u, seen, store } = ready({ busy: true });
    await u._armRestart();
    t.ok(!u.restartTimer && u.waitTimer && store.get(Updater.WAIT_KEY).version === '2.5.6', 'in use: no countdown, looked at again in a minute, the wait remembered');
    const since = store.get(Updater.WAIT_KEY).since;
    await u._armRestart();
    t.ok(store.get(Updater.WAIT_KEY).since === since && seen.logs.filter((l) => /^Update ready/.test(l)).length === 1, 'the wait is counted from when it began, and logged once');
    // Hours later, still open, someone at the computer: still waiting.
    store.set(Updater.WAIT_KEY, { ...store.get(Updater.WAIT_KEY), since: Date.now() - HOURS(5) });
    await u._armRestart();
    t.ok(!u.restartTimer && seen.installed === 0, 'past the limit but the computer in use: still waiting');
    stop(u);
  }
  {
    // The wait survives a restart of Shroudly (a reboot every evening).
    const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(26), route: 'direct' } });
    const { u, seen } = ready({ store, busy: true, away: true });
    await u._armRestart();
    t.ok(u.restartTimer && seen.notified === 1 && u.state.restartAt > Date.now(), 'past the limit and nobody at the computer: the countdown starts, game or call or not');
    await u._restartDue(u.restartTimer);
    t.ok(seen.installed === 1, '…and the update installs when it ends');
  }
  {
    const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(26) } });
    let away = true;
    const { u, seen } = ready({ store, busy: true, away: () => away });
    await u._armRestart();
    away = false;   // back at the computer during the countdown
    await u._restartDue(u.restartTimer);
    t.ok(seen.installed === 0 && !u.restartTimer && u.waitTimer && u.state.restartAt === null, 'someone back at the computer before the countdown ends: no restart, waiting again');
    stop(u);
  }

  // ── the computer asleep during the countdown, or just woken up ──
  {
    const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(26) } });
    const { u, seen } = ready({ store, busy: true, away: true });
    await u._armRestart();
    const first = u.state.restartAt;
    // The countdown's end comes an hour late: the computer slept through it.
    u._set({ restartAt: Date.now() - HOURS(1) });
    await u._restartDue(u.restartTimer);
    await new Promise((r) => setImmediate(r));
    t.ok(seen.installed === 0, 'a countdown that ran out while the computer slept: no restart at the wake');
    t.ok(u.restartTimer === null && u.waitTimer && u.state.restartAt === null, 'and just after the wake nobody counts as away: waiting again (a Discord or Roblox in use)');
    stop(u);
    t.ok(first > Date.now(), 'the first countdown was on (its end in the future)');
    const r2 = ready({ store: memStore(), busy: false });
    await r2.u._armRestart();
    const end1 = r2.u.state.restartAt;
    r2.u._set({ restartAt: Date.now() - HOURS(1) });
    r2.u.resumed();
    await new Promise((r) => setTimeout(r, 20));
    t.ok(r2.u.restartTimer && r2.u.state.restartAt > Date.now() && r2.seen.notified === 2 && r2.seen.installed === 0 && end1,
      'nothing in use, woken up during the countdown: it starts again from the wake, said again');
    stop(r2.u);
  }

  // ── the setting, looked at again every time ──
  {
    let busy = true;
    const { u, seen, store } = ready({ busy: () => busy });
    await u._armRestart();
    store.set('autoUpdate', false);
    busy = false;   // Discord closed after the user switched automatic installs off
    await u._armRestart();
    t.ok(!u.restartTimer && !u.waitTimer && seen.notified === 0 && seen.installed === 0, 'switched off while waiting: no countdown when Discord closes');
    store.set('autoUpdate', true);
    u.autoChanged();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    t.ok(u.restartTimer && seen.notified === 1, 'switched on again: the countdown starts');
    store.set('autoUpdate', false);
    u.autoChanged();
    t.ok(!u.restartTimer && u.state.restartAt === null, 'switched off during the countdown: it stops at once');
    stop(u);
  }
  {
    const { u, seen, store } = ready();
    await u._armRestart();
    const timer = u.restartTimer;
    store.set('autoUpdate', false);   // without telling the updater
    await u._restartDue(timer);
    t.ok(seen.installed === 0 && u.state.restartAt === null, 'switched off during the countdown: no restart when it ends');
    stop(u);
  }
  {
    let busy = false;
    const { u, seen } = ready({ busy: () => busy });
    await u._armRestart();
    busy = true;   // a game started during the countdown
    await u._restartDue(u.restartTimer);
    t.ok(seen.installed === 0 && u.waitTimer && !u.restartTimer, 'a game started during the countdown: no restart, waiting again');
    stop(u);
  }
  {
    const { u, seen } = ready();
    await u._armRestart();
    const timer = u.restartTimer;
    u.postpone();
    await u._restartDue(timer);
    t.ok(seen.installed === 0, 'postponed: the countdown that was running does not install');
  }

  // ── at launch, before protection ──
  {
    const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(8), route: 'direct' } });
    const u = new Updater({ store, busy: async () => false });
    u.mac = false;
    let installed = 0;
    u.eu = { quitAndInstall: () => { installed++; } };
    u.check = async () => { u._downloaded('2.5.6'); };   // the download kept from the last run
    const t0 = Date.now();
    const r = await u.installBeforeProtection(5000);
    await new Promise((res) => setImmediate(res));
    t.ok(r === true && installed === 1 && Date.now() - t0 < 2000, 'an update that has waited its limit installs at launch, before protection starts');
  }
  {
    const fresh = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(1), route: 'direct' } });
    const viaShroudly = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(8), route: 'system' } });
    const results = [];
    for (const store of [fresh, viaShroudly, memStore()]) {
      const u = new Updater({ store });
      u.mac = false;
      u.eu = { quitAndInstall: () => {} };
      let checked = 0;
      u.check = async () => { checked++; };
      results.push((await u.installBeforeProtection(5000)) === false && checked === 0);
    }
    t.ok(results.every(Boolean), 'not yet due, only reachable through Shroudly, or nothing waiting: protection starts at once');
    const u = new Updater({ store: memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(8), route: 'direct' } }) });
    u.mac = false;
    u.eu = { quitAndInstall: () => {} };
    u.check = async () => {};   // the network does not answer
    const t0 = Date.now();
    t.ok((await u.installBeforeProtection(300)) === false && Date.now() - t0 < 1500 && !u.atLaunch, 'no answer in time: protection starts, the update waits as before');
    for (const [what, end] of [['nothing newer (the release was withdrawn)', (x) => x._set({ status: 'up-to-date' })], ['the check failed', (x) => x._fail(new Error('offline'))]]) {
      const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(8), route: 'direct' } });
      const x = new Updater({ store });
      x.mac = false;
      x.eu = { quitAndInstall: () => {} };
      x.check = async () => { end(x); };
      const t1 = Date.now();
      const r = await x.installBeforeProtection(5000);
      t.ok(r === false && Date.now() - t1 < 1000, `${what}: protection starts at once, without waiting the full time`);
      if (what.startsWith('nothing')) t.ok(store.get(Updater.WAIT_KEY) === undefined, '…and nothing is left waiting');
    }
  }
  {
    const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.5', since: 1 } });
    new Updater({ store });
    t.ok(store.get(Updater.WAIT_KEY) === undefined, 'the wait is forgotten once that version runs');
  }

  console.log(`updater: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
