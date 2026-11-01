'use strict';

/* When an automatic update restarts Shroudly (electron/updater.js). It waits
 * while a Roblox game or Discord goes through Shroudly, but never for good:
 * someone who keeps Discord open from login to shutdown must still be
 * updated. Every condition is looked at again when the countdown starts and
 * when it ends, "Install updates automatically" included. Electron is stood
 * in for, and the timers are driven by hand, so nothing waits a real minute.
 *
 * And an install that does not happen, or a download the disk refuses, never
 * leaves Shroudly closed or half-quit: the macOS download against a local
 * server, the script that swaps the app (with stand-in tools), Linux package
 * installs that ask for a password, and electron-updater's own AppImage
 * install, which renames the file. */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const Module = require('module');
const { ROOT, suite } = require('./helpers');

const quitHandlers = {};
let exits = 0;
const electron = {
  app: {
    getVersion: () => '2.5.5', isPackaged: false,
    once: (ev, fn) => { (quitHandlers[ev] = quitHandlers[ev] || []).push(fn); },
    exit: () => { exits++; },
  },
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
const fileSha = (f) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha512');
  fs.createReadStream(f).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('base64')));
});
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

  /* The own-host mirror fallback (for networks that blackhole GitHub's IPs):
   * tried last, after GitHub direct and through the engine, and it rewrites a
   * GitHub release URL to the mirror host serving the same files. */
  {
    t.ok(JSON.stringify(Updater.ROUTES) === JSON.stringify(['direct', 'system', 'mirror']),
      'routes: GitHub direct, then the engine, then the own-host mirror last');
    const dl = `${Updater.RELEASES_URL}/download/latest-mac.yml`;
    t.ok(Updater.mirrorOf(dl) === `${Updater.MIRROR_URL}/latest-mac.yml`, 'a release feed URL maps to the mirror');
    const asset = `https://github.com/umutxyp/Shroudly/releases/download/v2.6.30/Shroudly-2.6.30-Windows-x64-Setup.exe`;
    t.ok(Updater.mirrorOf(asset) === `${Updater.MIRROR_URL}/Shroudly-2.6.30-Windows-x64-Setup.exe`, 'a release asset URL maps to the mirror');
    t.ok(Updater.mirrorOf('https://example.com/x') === 'https://example.com/x', 'an unrelated URL is left alone');
    t.ok(Updater.MIRROR_URL.startsWith('https://') && !/github\.com/.test(Updater.MIRROR_URL), 'the mirror is a non-GitHub https host');
  }

  // #57: on Windows the update goes into the folder this copy runs from, when
  // this user can write there; anywhere else, the installer's own records.
  {
    const yes = () => true;
    const no = () => false;
    t.ok(Updater.installDirFor('D:\\Uygulamalar\\Shroudly\\Shroudly.exe', { platform: 'win32', canWrite: yes }) === 'D:\\Uygulamalar\\Shroudly',
      'installed on another disk: the update goes there (/D=D:\\Uygulamalar\\Shroudly)');
    t.ok(Updater.installDirFor('C:\\Program Files\\Shroudly\\Shroudly.exe', { platform: 'win32', canWrite: no }) === null,
      'a folder this user cannot write to (Program Files): left to the installer');
    t.ok(Updater.installDirFor('C:\\dev\\node_modules\\electron\\dist\\electron.exe', { platform: 'win32', canWrite: yes }) === null,
      'a development run (electron.exe): no folder');
    t.ok(Updater.installDirFor('/Applications/Shroudly.app/Contents/MacOS/Shroudly', { platform: 'darwin', canWrite: yes }) === null
      && Updater.installDirFor(null, { platform: 'win32', canWrite: yes }) === null, 'not Windows, or no path: no folder');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-updtest-'));

  // ── deb, rpm and pacman: the install asks for a password (ML-3) ──
  {
    const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(8), route: 'direct' } });
    const { u, seen } = ready({ store, away: true });
    u.asksPassword = true;
    await u._armRestart();
    t.ok(!u.restartTimer && !u.waitTimer && seen.notified === 0 && seen.installed === 0,
      'a Linux package update: no countdown and no waiting, nothing installed by itself (the prompt would come up with nobody expecting it)');
    let checked = 0;
    u.check = async () => { checked++; };
    t.ok((await u.installBeforeProtection(5000)) === false && checked === 0, '…nor at launch, however long it has waited');
    const told = [];
    u.notify = (version, kind) => told.push(`${version} ${kind}`);
    u._downloaded('2.5.6');
    u._downloaded('2.5.6');
    await sleep(20);
    t.ok(told.join() === '2.5.6 password' && !u.restartTimer, 'said once that it is ready and asks for a password, so it does not wait unseen in the tray');
    await u.install();
    t.ok(seen.installed === 1, 'the button installs it');
    clearTimeout(u.installWatch);
    const eu = new EventEmitter();
    const v = new Updater({ store: memStore() });
    v.asksPassword = true;
    v._wire(eu);
    const w = new Updater({ store: memStore() });
    const eu2 = new EventEmitter();
    w._wire(eu2);
    t.ok(eu.autoInstallOnAppQuit === false && eu2.autoInstallOnAppQuit === true,
      'and not at a quit or a logout either; elsewhere a downloaded update still installs on quit');
  }
  // electron-updater's own code, where npm installed it (not in the bare
  // distribution containers, which test the engine and Shroudly's own code).
  const updaterLib = path.join(ROOT, 'node_modules', 'electron-updater', 'out');
  const haveUpdaterLib = fs.existsSync(updaterLib);
  if (!haveUpdaterLib) console.log("  --  electron-updater is not installed here: its dpkg and AppImage installs are checked where it is");
  if (haveUpdaterLib) {
    // electron-updater follows a failed `dpkg -i` with `apt-get install -f`,
    // each through pkexec: a dismissed prompt came straight back.
    const { DebUpdater } = require(path.join(updaterLib, 'DebUpdater.js'));
    const quiet = { warn() {}, info() {}, error() {} };
    const run = (code) => {
      const prompts = [];
      const eu = new EventEmitter();
      eu.runCommandWithSudoIfNeeded = (cmd) => { prompts.push(cmd[0]); throw new Error(`Command pkexec exited with code ${code}`); };
      new Updater({ store: memStore() })._wire(eu);
      let err = null;
      try { DebUpdater.installWithCommandRunner('dpkg', '/tmp/Shroudly.deb', eu.runCommandWithSudoIfNeeded, quiet); } catch (e) { err = e; }
      return { prompts, err };
    };
    const dismissed = run(126);
    const noAgent = run(127);
    const dpkgFailed = run(1);
    t.ok(dismissed.prompts.length === 1 && /code 126/.test(dismissed.err.message) && noAgent.prompts.length === 1,
      'the password prompt dismissed, or no prompt possible: not asked a second time');
    t.ok(dpkgFailed.prompts.join() === 'dpkg,apt-get', 'dpkg itself failing (the password given): its apt-get repair still runs');
  }

  // ── an install that does not happen (UI-4, ML-3) ──
  {
    const store = memStore();
    let undone = 0;
    const logs = [];
    const u = new Updater({ store, log: (l, m) => logs.push(m), onInstallFailed: () => { undone++; } });
    u.mac = false;
    const eu = new EventEmitter();
    let calls = 0;
    // As electron-updater does when pkexec fails: 'error', and no quit.
    eu.quitAndInstall = () => { calls++; eu.emit('error', new Error('Command pkexec exited with code 126')); };
    u._wire(eu);
    u._set({ status: 'ready', version: '2.5.6' });
    await u.install();
    t.ok(!u.installing && undone === 1 && u.state.status === 'ready' && u.state.failed === true,
      'a refused password: what was readied for the quit is undone (protection back), the update still there to install');
    t.ok(logs.filter((l) => l === 'Update 2.5.6 could not be installed (Command pkexec exited with code 126); Shroudly carries on with version 2.5.5').length === 1
      && !logs.some((l) => /^Update failed/.test(l)), '…said in one line, not as a failed check');
    await u._armRestart();
    t.ok(!u.restartTimer && !u.waitTimer, 'that version is not installed by itself again');
    await u.install();
    t.ok(calls === 2 && undone === 2 && !u.installing, '"Restart now" still tries again');
    // At the next start too, until a newer version comes out.
    const next = ready({ store });
    next.u._downloaded('2.5.6');
    await sleep(20);
    t.ok(next.u.state.failed === true && !next.u.restartTimer, 'at a later start: still not installed by itself');
    next.u._downloaded('2.5.7');
    await sleep(20);
    t.ok(next.u.state.failed === false && next.u.restartTimer, 'a newer version: installed as usual');
    stop(next.u);
    const later = memStore({ [Updater.FAILED_KEY]: { version: '2.5.5' } });
    new Updater({ store: later });
    t.ok(later.get(Updater.FAILED_KEY) === undefined, 'forgotten once that version runs');
  }
  {
    let undone = 0;
    const u = new Updater({ store: memStore(), onInstallFailed: () => { undone++; } });
    u.mac = false;
    u.installQuitMs = 60;
    u.eu = { quitAndInstall: () => {} };
    u._set({ status: 'ready', version: '2.5.6' });
    quitHandlers['will-quit'] = [];
    await u.install();
    t.ok(u.installing && undone === 0, 'installing: waiting for the quit');
    await sleep(150);
    t.ok(!u.installing && undone === 1 && u.state.failed, 'Shroudly still running some seconds later: the install is taken as failed, and undone');
    const v = new Updater({ store: memStore(), onInstallFailed: () => { undone++; } });
    v.mac = false;
    v.installQuitMs = 60;
    v.eu = { quitAndInstall: () => {} };
    v._set({ status: 'ready', version: '2.5.6' });
    quitHandlers['will-quit'] = [];
    await v.install();
    quitHandlers['will-quit'].forEach((fn) => fn());
    await sleep(150);
    t.ok(v.installing && undone === 1, 'the quit under way: nothing undone');
  }

  // ── an AppImage (MISS-1, UI-4) ──
  {
    const logs = [];
    const u = new Updater({ store: memStore(), log: (l, m) => logs.push(m) });
    u.mac = false;
    let downloads = 0;
    u.eu = { downloadUpdate: async () => { downloads++; } };
    u._euRoute = async () => {};
    u.appImage = '/opt/Shroudly/Shroudly-2.5.5-Linux-x86_64.AppImage';
    u.canWrite = (d) => d !== '/opt/Shroudly';
    u._set({ status: 'available', version: '2.5.6' });
    await u.download();
    t.ok(u.state.status === 'manual' && u.state.reason === 'folder' && downloads === 0
      && logs.includes('Update 2.5.6: Shroudly cannot replace itself in /opt/Shroudly; download it from the download page'),
      'an AppImage in a folder this user cannot write to: not downloaded to fail later, the download page offered');
    u._set({ status: 'available' });
    await u.download();
    t.ok(logs.filter((l) => /cannot replace itself/.test(l)).length === 1, '…said once, not at every check');
    u.appImage = '/home/u/Apps/Shroudly-2.5.5-Linux-x86_64.AppImage';
    await u.download();
    t.ok(downloads === 1, 'in a folder it can write to: downloaded');
    const real = new Updater({ store: memStore() });
    const ro = sandbox();
    fs.chmodSync(ro, 0o555);
    const writable = real.canWrite(os.tmpdir());
    const readOnly = process.platform === 'win32' || process.getuid() === 0 || !real.canWrite(ro);
    fs.chmodSync(ro, 0o755);
    fs.rmSync(ro, { recursive: true, force: true });
    t.ok(writable && readOnly, 'whether the folder can be written to is asked of the system, nothing written there to find out');
  }
  if (process.platform !== 'win32' && haveUpdaterLib) {
    // electron-updater's own AppImage install, as it runs at a quit.
    const { AppImageUpdater } = require(path.join(updaterLib, 'AppImageUpdater.js'));
    const dir = sandbox();
    const oldFile = path.join(dir, 'Shroudly-2.5.5-Linux-x86_64.AppImage');
    fs.writeFileSync(oldFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'cache'));
    const newFile = path.join(dir, 'cache', 'Shroudly-2.5.6-Linux-x86_64.AppImage');
    fs.writeFileSync(newFile, '#!/bin/sh\n[ "$APPIMAGE_EXIT_AFTER_INSTALL" = true ] && exit 0\ntouch "$0.started"\n', { mode: 0o755 });
    const appAdapter = {
      version: '2.5.5', name: 'Shroudly', isPackaged: true, appUpdateConfigPath: path.join(dir, 'app-update.yml'),
      userDataPath: dir, baseCachePath: dir, whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit(fn) { this.quitFn = fn; },
    };
    const eu = new AppImageUpdater(null, appAdapter);
    let entry = null;
    const u = new Updater({ store: memStore(), onAppImageMoved: (file) => { entry = file; } });
    u._wire(eu);
    eu.downloadedUpdateHelper = { file: newFile, downloadedFileInfo: {} };
    const env = process.env.APPIMAGE;
    process.env.APPIMAGE = oldFile;
    try { eu.addQuitHandler(); appAdapter.quitFn(0); } finally { if (env === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = env; }
    const moved = path.join(dir, 'Shroudly-2.5.6-Linux-x86_64.AppImage');
    t.ok(!fs.existsSync(oldFile) && fs.existsSync(moved) && !fs.existsSync(`${moved}.started`),
      'installed at a quit: the old AppImage is gone, the new one beside it under its own name (not started)');
    t.ok(entry === moved, '"Start at login" is told the new file at once, so the next login does not start one that is gone');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── a full disk (BR-2) ──
  {
    const e = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    const u = new Updater({ store: memStore() });
    u._set({ version: '2.5.6' });
    u._fail(e);
    t.ok(u.state.status === 'no-space', 'electron-updater on a full disk: "free up some space", not "could not check for updates"');
  }

  /* The macOS download, against a local server: Electron's net is stood in
   * for by Node's http, every route reaching the same server. */
  const GOOD = crypto.randomBytes(300 * 1024);
  const sha = (b) => crypto.createHash('sha512').update(b).digest('base64');
  let served = 0;
  const server = http.createServer((req, res) => {
    served++;
    const name = path.basename(req.url);
    if (name.startsWith('short')) { res.writeHead(200); res.end(GOOD.subarray(0, GOOD.length / 2)); return; }
    if (name.startsWith('stall')) { res.writeHead(200, { 'content-length': GOOD.length }); res.write(GOOD.subarray(0, 1000)); return; }
    res.writeHead(200, { 'content-length': GOOD.length });
    res.end(GOOD);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  electron.session.fromPartition = () => ({ setProxy: async () => {} });
  electron.net.request = ({ url }) => http.request(`http://127.0.0.1:${port}/${path.basename(url)}`);
  const mac = (name, { buf = GOOD, store = memStore({ autoUpdate: false }), ...opts } = {}) => {
    const dir = sandbox();
    const logs = [];
    const u = new Updater({ store, log: (l, m) => logs.push(m), dir: path.join(dir, 'update'), ...opts });
    u.mac = true;
    u.tmp = path.join(dir, 'tmp');
    u._macCanReplace = () => true;
    u.stallMs = 150;
    u.macFeed = { version: '2.5.6', files: [{ url: name, sha512: sha(buf), size: buf.length }] };
    return { u, logs, dir };
  };
  const leftovers = (u) => { try { return fs.readdirSync(u.dir).filter((n) => n.startsWith('shroudly-update-')); } catch { return []; } };
  let uncaught = 0;
  const onUncaught = () => { uncaught++; };
  process.on('uncaughtException', onUncaught);
  {
    const { u, dir } = mac('Shroudly-2.5.6-macOS-arm64.zip');
    await u.download();
    t.ok(u.state.status === 'ready' && u.macDownload && fs.statSync(u.macDownload.zip).size === GOOD.length
      && u.macDownload.zip.startsWith(u.dir), 'downloaded, verified from the file on disk, and kept in Shroudly\'s own folder (not the one macOS empties after three days)');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    // The disk fills up partway: the file stream fails, as with ENOSPC.
    const { u, logs, dir } = mac('Shroudly-2.5.6-macOS-arm64.zip');
    const real = fs.createWriteStream;
    const { Writable } = require('stream');
    let writes = 0;
    fs.createWriteStream = () => new Writable({
      write(chunk, enc, cb) { writes++; cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })); },
    });
    served = 0;
    try { await u.download(); } finally { fs.createWriteStream = real; }
    await sleep(50);
    t.ok(uncaught === 0 && u.state.status === 'no-space' && !u.macDownload,
      'the disk full mid-download: no uncaught exception (which quit Shroudly at every check), "free up some space" instead');
    t.ok(served === 1 && writes >= 1 && leftovers(u).length === 0 && logs.some((l) => /^Update failed: ENOSPC/.test(l)),
      '…not tried again on every route, and nothing left behind on the full disk');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const { u, dir } = mac('short.zip');
    served = 0;
    await u.download();
    t.ok(u.state.status === 'error' && u.state.error === 'checksum mismatch' && !u.macDownload && leftovers(u).length === 0 && served === 3,
      'a file cut short: refused (judged from the disk), tried on every route, nothing left behind');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const { u, dir } = mac('stall.zip');
    const t0 = Date.now();
    await u.download();
    t.ok(u.state.status === 'error' && /stalled/.test(u.state.error) && Date.now() - t0 < 3000,
      'a connection that goes silent: given up, not "downloading" for the rest of the session');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const { u, logs, dir } = mac('Shroudly-2.5.6-macOS-arm64.zip');
    const real = fs.statfsSync;
    fs.statfsSync = () => ({ bavail: 100, bsize: 4096 });
    served = 0;
    try { await u.download(); } finally { fs.statfsSync = real; }
    t.ok(u.state.status === 'no-space' && served === 0 && leftovers(u).length === 0
      && logs.includes(`Update 2.5.6 needs ${Math.ceil((GOOD.length * 4) / 1048576)} MB of free disk space; Shroudly tries again at the next check`),
      'not enough room for the zip and the app it unpacks to: nothing downloaded, said once');
    await u.check(false);
    t.ok(u.state.status !== 'no-space', '…and the next check (every half hour) is not held back by it');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── installing on macOS (UI-3) ──
  {
    let before = 0;
    let undone = 0;
    const { u, logs, dir } = mac('Shroudly-2.5.6-macOS-arm64.zip', { beforeInstall: async () => { before++; }, onInstallFailed: () => { undone++; } });
    await u.download();
    // Damaged while it waited.
    fs.writeFileSync(u.macDownload.zip, crypto.randomBytes(GOOD.length));
    let swaps = 0;
    u._macSwapOnExit = () => { swaps++; };
    exits = 0;
    await u.install();
    t.ok(before === 0 && swaps === 0 && exits === 0 && logs.includes('The downloaded update 2.5.6 is missing or damaged; downloading it again'),
      'the zip damaged since it was verified: nothing is stopped, Shroudly does not quit');
    for (let i = 0; i < 50 && u.state.status !== 'ready'; i++) await sleep(20);
    t.ok(u.state.status === 'ready' && await fileSha(u.macDownload.zip) === sha(GOOD), '…it is downloaded again');
    fs.rmSync(u.macDownload.zip);
    await u.install();
    t.ok(before === 0 && swaps === 0 && exits === 0, 'the zip deleted meanwhile: the same');
    for (let i = 0; i < 50 && u.state.status !== 'ready'; i++) await sleep(20);
    await u.install();
    t.ok(before === 1 && swaps === 1 && exits === 1, 'intact: protection stopped, the swap set up, Shroudly quits');
    // The install script cannot be written (its folder gone).
    const v = mac('Shroudly-2.5.6-macOS-arm64.zip', { beforeInstall: async () => { before++; }, onInstallFailed: () => { undone++; } });
    await v.u.download();
    v.u.macDownload = { ...v.u.macDownload, dir: path.join(v.dir, 'gone', 'x') };
    exits = 0;
    await v.u.install();
    t.ok(exits === 0 && undone === 1 && !v.u.installing && v.u.state.failed, 'the install script cannot be written: Shroudly does not quit, protection comes back');
    // On a normal quit, with the zip gone: nothing is set up.
    fs.rmSync(v.u.macDownload.zip);
    let swapsOnQuit = 0;
    v.u._macSwapOnExit = () => { swapsOnQuit++; };
    v.u.installOnQuit();
    t.ok(swapsOnQuit === 0, 'quitting with the zip gone: no swap set up');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(v.dir, { recursive: true, force: true });
  }
  process.removeListener('uncaughtException', onUncaught);
  server.close();

  // The swap script itself, with stand-in tools: tar for ditto, scripts for
  // codesign and open (nothing is opened for real).
  if (process.platform !== 'win32') {
    const dir = sandbox();
    const tool = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };
    const opened = path.join(dir, 'opened');
    const tools = {
      ditto: tool('ditto', 'tar -xf "$3" -C "$4"'),
      xattr: tool('xattr', 'exit 0'),
      open: tool('open', `echo "$@" >> "${opened}"`),
    };
    const goodSign = tool('codesign-ok', 'exit 0');
    const badSign = tool('codesign-bad', 'exit 1');
    fs.mkdirSync(path.join(dir, 'new', 'Shroudly.app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'new', 'Shroudly.app', 'v'), '2');
    const tarball = path.join(dir, 'update.tar');
    spawnSync('tar', ['-cf', tarball, '-C', path.join(dir, 'new'), 'Shroudly.app']);
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    const swap = ({ codesign = goodSign, zip = tarball, relaunch = '1' } = {}) => {
      const app = path.join(dir, 'Applications', 'Shroudly.app');
      fs.rmSync(path.join(dir, 'Applications'), { recursive: true, force: true });
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, 'v'), '1');
      const work = path.join(dir, 'update', 'shroudly-update-x');
      fs.mkdirSync(work, { recursive: true });
      const marker = path.join(dir, 'update', 'failed');
      fs.rmSync(marker, { force: true });
      fs.rmSync(opened, { force: true });
      const script = path.join(work, 'install.sh');
      fs.writeFileSync(script, Updater.macSwapScript({ ...tools, codesign }));
      const r = spawnSync('/bin/sh', [script, String(dead), zip, work, app, relaunch, marker, '2.5.6']);
      const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
      return { code: r.status, version: read(path.join(app, 'v')), opened: read(opened), marker: read(marker), workLeft: fs.existsSync(work), oldLeft: fs.existsSync(`${app}.old`) };
    };
    const ok = swap();
    t.ok(ok.code === 0 && ok.version === '2' && ok.opened.endsWith('--args --updated') && ok.marker === null && !ok.workLeft && !ok.oldLeft,
      'the swap: the new app in place, opened again, its download gone');
    const missing = swap({ zip: path.join(dir, 'gone.zip') });
    t.ok(missing.code === 1 && missing.version === '1' && missing.opened.endsWith(`--args ${Updater.UPDATE_FAILED_ARG}`) && missing.marker === '2.5.6 unpack',
      'the zip gone (macOS empties its temporary folder after three days): the app as it was, opened again, the failure noted');
    const unsigned = swap({ codesign: badSign });
    t.ok(unsigned.code === 1 && unsigned.version === '1' && unsigned.opened.endsWith(`--args ${Updater.UPDATE_FAILED_ARG}`) && unsigned.marker === '2.5.6 signature' && !unsigned.oldLeft,
      'a signature that does not check out: the app as it was, opened again, the failure noted');
    const onQuit = swap({ codesign: badSign, relaunch: '0' });
    t.ok(onQuit.code === 1 && onQuit.version === '1' && onQuit.opened === null && onQuit.marker === '2.5.6 signature',
      'the same at a quit: nothing opened (the user quit), the failure noted');
    // The next start reads the note: said once, and not installed by itself again.
    const store = memStore();
    const logs = [];
    const u = new Updater({ store, log: (l, m) => logs.push(m), dir: path.join(dir, 'update') });
    fs.writeFileSync(path.join(dir, 'update', 'failed'), '2.5.6 signature\n');
    u._readFailedNote();
    t.ok(logs.includes('Update 2.5.6 could not be installed (its signature did not check out); Shroudly carries on with version 2.5.5')
      && store.get(Updater.FAILED_KEY).version === '2.5.6' && !fs.existsSync(path.join(dir, 'update', 'failed')),
      'at the next start: said in one line, and that version is not installed by itself again');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    // Downloads left behind by a run that never finished with them.
    const dir = sandbox();
    const u = new Updater({ store: memStore(), dir: path.join(dir, 'update') });
    u.tmp = path.join(dir, 'tmp');
    const old = [path.join(u.dir, 'shroudly-update-a'), path.join(u.tmp, 'shroudly-update-b')];
    const fresh = path.join(u.dir, 'shroudly-update-c');
    const other = path.join(u.tmp, 'someone-else');
    for (const d of [...old, fresh, other]) fs.mkdirSync(d, { recursive: true });
    const past = (Date.now() - HOURS(2)) / 1000;
    for (const d of [...old, other]) fs.utimesSync(d, past, past);
    u._clearLeftovers();
    t.ok(old.every((d) => !fs.existsSync(d)) && fs.existsSync(fresh) && fs.existsSync(other),
      'left-behind downloads cleared at start (ours and the old temporary ones), not one an install script may still be using, nor anything else');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`updater: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
