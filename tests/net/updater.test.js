'use strict';

/* When an automatic update restarts Shroudly (electron/updater.js): only
 * while nobody is at the computer, at a quit or at the next start, never in
 * the middle of what someone does through it; and while a Roblox game,
 * Discord or a full-screen film goes through it, not before a limit. Every
 * condition is looked at again when the countdown starts and when it ends,
 * "Install updates automatically" included. Electron is stood in for, and
 * the timers are driven by hand, so nothing waits a real minute.
 *
 * What downloads by itself: not a release a few hours old once one came that
 * day, not on a metered connection, less and less often after failures; a
 * check or download that goes silent is given up; the mirror only through
 * the engine, and its turn really downloads from it.
 *
 * And an install that does not happen, or a download the disk refuses, never
 * leaves Shroudly closed or half-quit: the macOS download against a local
 * server, the script that swaps the app (with stand-in tools), Linux package
 * installs that ask for a password (asked before anything is stopped),
 * electron-updater's own Windows installer start (one that cannot start, one
 * that needs elevate.exe) and its AppImage install, which now keeps the file
 * where and as the user has it. */

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
let quits = 0;
let inApps = false;
let moved = 0;
const electron = {
  app: {
    getVersion: () => '2.5.5', isPackaged: false,
    once: (ev, fn) => { (quitHandlers[ev] = quitHandlers[ev] || []).push(fn); },
    exit: () => { exits++; },
    quit: () => { quits++; },
    isInApplicationsFolder: () => inApps,
    moveToApplicationsFolder: () => { moved++; if (moved > 1) throw new Error('Failed to move'); return true; },
  },
  net: {}, session: {},
  shell: { openPath: async () => 'not found' },
  powerMonitor: { getSystemIdleState: () => 'active' },
};
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'electron' ? electron : load.call(this, request, ...rest); };
const Updater = require(path.join(ROOT, 'electron', 'updater.js'));
const Metered = require(path.join(ROOT, 'electron', 'metered.js'));
// Never this computer's own connection: each test says what it is.
const realMetered = Metered.metered;
Metered.metered = async () => false;
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
  u.installQuitMs = 60000;
  u.eu = { install: () => { seen.installed++; return true; } };
  u._set({ status: 'ready', version: '2.5.6' });
  return { u, seen, store };
}
const stop = (u) => { clearTimeout(u.waitTimer); clearTimeout(u.restartTimer); clearTimeout(u.installWatch); };
const fileSha = (f) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha512');
  fs.createReadStream(f).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('base64')));
});
const HOURS = (h) => h * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-updtest-'));

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
  t.ok(P({ busy: false, waitedMs: 0, away: false }) === 'wait' && P({ busy: false, waitedMs: L * 10, away: false }) === 'wait',
    'someone at the computer (browsing, downloading, in a call): never a restart, however long it has waited');
  t.ok(P({ busy: false, waitedMs: 0, away: true }) === 'countdown', 'nobody at the computer, nothing going through Shroudly that a restart would cut: the countdown');
  t.ok(P({ busy: true, waitedMs: 0, away: true }) === 'wait' && P({ busy: true, waitedMs: L - 1, away: true }) === 'wait'
    && P({ busy: true, waitedMs: L, away: true }) === 'countdown', 'a game, Discord or a full-screen film while nobody is there: it waits, for the limit at most');
  t.ok(P({ atLaunch: true, waitedMs: 0 }) === 'install', 'at launch, before protection: at once');

  // ── someone working all day ──
  {
    const { u, seen, store } = ready({ busy: false, away: false });
    await u._armRestart();
    t.ok(!u.restartTimer && u.waitTimer && seen.notified === 0 && store.get(Updater.WAIT_KEY).version === '2.5.6',
      'someone at the computer, nothing else going on: no countdown, looked at again in a minute, the wait remembered');
    let lists = 0;
    u.busy = async () => { lists++; return false; };
    await u._armRestart();
    t.ok(lists === 0, '…and the program list is not read while someone is there');
    stop(u);
  }
  {
    // A Discord that is open all day, with nobody at the computer for a while.
    let away = true;
    const { u, seen, store } = ready({ busy: true, away: () => away });
    await u._armRestart();
    t.ok(!u.restartTimer && u.waitTimer && store.get(Updater.WAIT_KEY).version === '2.5.6', 'Discord in use, nobody there: no countdown yet');
    const since = store.get(Updater.WAIT_KEY).since;
    let writes = 0;
    const set = store.set;
    store.set = (k, v) => { writes++; set(k, v); };
    await u._armRestart();
    t.ok(store.get(Updater.WAIT_KEY).since === since && writes === 0 && seen.logs.filter((l) => /^Update ready/.test(l)).length === 1,
      'the wait is counted from when it began, written once (not every minute), and logged once');
    store.set = set;
    // Hours later, still open, someone back at the computer: still waiting.
    store.set(Updater.WAIT_KEY, { ...store.get(Updater.WAIT_KEY), since: Date.now() - HOURS(5) });
    away = false;
    await u._armRestart();
    t.ok(!u.restartTimer && seen.installed === 0, 'past the limit but the computer in use: still waiting');
    away = true;
    await u._armRestart();
    t.ok(u.restartTimer && seen.notified === 1, 'past the limit and nobody there: the countdown starts, call or not');
    await u._restartDue(u.restartTimer);
    t.ok(seen.installed === 1, '…and the update installs when it ends');
    stop(u);
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
    const { u, seen } = ready({ away: true });
    await u._armRestart();
    const first = u.state.restartAt;
    // The countdown's end comes an hour late: the computer slept through it.
    u._set({ restartAt: Date.now() - HOURS(1) });
    await u._restartDue(u.restartTimer);
    await tick();
    t.ok(first > Date.now() && seen.installed === 0, 'a countdown that ran out while the computer slept: no restart at the wake');
    t.ok(u.restartTimer === null && u.waitTimer && u.state.restartAt === null,
      'and just after the wake nobody counts as away (the idle time counts the sleep): waiting again');
    stop(u);
  }

  // ── "Later" ──
  {
    const { u, seen } = ready({ away: true });
    await u._armRestart();
    const timer = u.restartTimer;
    u.postpone();
    await u._restartDue(timer);
    t.ok(seen.installed === 0 && u.state.restartAt === null, 'postponed: the countdown that was running does not install');
    await u._armRestart();
    t.ok(!u.restartTimer && u.waitTimer && u.heldUntil - Date.now() > Updater.LATER_MS - 5000,
      '…nor does a new one start for a while, nobody at the computer or not');
    u.heldUntil = Date.now() - 1;   // that while is over
    await u._armRestart();
    t.ok(u.restartTimer && seen.notified === 2, 'then it installs as usual while nobody is there (not only at a quit, weeks later)');
    stop(u);
  }

  // ── the setting, looked at again every time ──
  {
    let busy = true;
    const { u, seen, store } = ready({ busy: () => busy, away: true });
    await u._armRestart();
    store.set('autoUpdate', false);
    busy = false;   // Discord closed after the user switched automatic installs off
    await u._armRestart();
    t.ok(!u.restartTimer && !u.waitTimer && seen.notified === 0 && seen.installed === 0, 'switched off while waiting: no countdown when Discord closes');
    store.set('autoUpdate', true);
    u.autoChanged();
    await tick(); await tick();
    t.ok(u.restartTimer && seen.notified === 1 && u.state.byItself === true, 'switched on again: the countdown starts (the window says it installs by itself)');
    store.set('autoUpdate', false);
    u.autoChanged();
    t.ok(!u.restartTimer && u.state.restartAt === null && u.state.byItself === false, 'switched off during the countdown: it stops at once (and the window says: at the next quit)');
    stop(u);
  }
  {
    const { u, seen, store } = ready({ away: true });
    await u._armRestart();
    const timer = u.restartTimer;
    store.set('autoUpdate', false);   // without telling the updater
    await u._restartDue(timer);
    t.ok(seen.installed === 0 && u.state.restartAt === null, 'switched off during the countdown: no restart when it ends');
    stop(u);
  }
  {
    let busy = false;
    const { u, seen } = ready({ busy: () => busy, away: true });
    await u._armRestart();
    busy = true;   // a game started during the countdown
    await u._restartDue(u.restartTimer);
    t.ok(seen.installed === 0 && u.waitTimer && !u.restartTimer, 'a game started during the countdown: no restart, waiting again');
    stop(u);
  }

  // ── at launch, before protection ──
  {
    const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(1), route: 'direct' } });
    const u = new Updater({ store, busy: async () => false });
    u.mac = false;
    u.installQuitMs = 60000;
    let installed = 0;
    u.eu = { install: () => { installed++; return true; } };
    u.check = async () => { u._downloaded('2.5.6'); };   // the download kept from the last run
    const t0 = Date.now();
    const r = await u.installBeforeProtection(5000);
    await tick();
    t.ok(r === true && installed === 1 && Date.now() - t0 < 2000, 'an update that was waiting for the computer to be free installs at the next launch, before protection starts');
    stop(u);
  }
  {
    const viaShroudly = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(8), route: 'system' } });
    const results = [];
    for (const store of [viaShroudly, memStore()]) {
      const u = new Updater({ store });
      u.mac = false;
      u.eu = { install: () => true };
      let checked = 0;
      u.check = async () => { checked++; };
      results.push((await u.installBeforeProtection(5000)) === false && checked === 0);
    }
    t.ok(results.every(Boolean), 'only reachable through Shroudly, or nothing waiting: protection starts at once');
    const u = new Updater({ store: memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(8), route: 'direct' } }) });
    u.mac = false;
    u.eu = { install: () => true };
    u.check = async () => {};   // the network does not answer
    const t0 = Date.now();
    t.ok((await u.installBeforeProtection(300)) === false && Date.now() - t0 < 1500 && !u.atLaunch, 'no answer in time: protection starts, the update waits as before');
    for (const [what, end] of [['nothing newer (the release was withdrawn)', (x) => x._set({ status: 'up-to-date' })], ['the check failed', (x) => x._fail(new Error('offline'))]]) {
      const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(8), route: 'direct' } });
      const x = new Updater({ store });
      x.mac = false;
      x.eu = { install: () => true };
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
   * tried last, after GitHub direct and through the engine, only through the
   * engine, and it rewrites a GitHub release URL to the mirror host serving
   * the same files. */
  {
    t.ok(JSON.stringify(Updater.ROUTES) === JSON.stringify(['direct', 'system', 'mirror']),
      'routes: GitHub direct, then the engine, then the own-host mirror last');
    Updater.setSystemRoute({ mode: 'system' });
    t.ok(JSON.stringify(Updater.routesNow()) === JSON.stringify(['direct', 'system']),
      'protection off: the mirror is not asked at all (a request to our own host in the clear says this computer runs circumvention software)');
    const engine = { proxyRules: 'socks5://127.0.0.1:10808', proxyBypassRules: '<local>' };
    Updater.setSystemRoute(engine);
    t.ok(JSON.stringify(Updater.routesNow()) === JSON.stringify(['direct', 'system', 'mirror']), 'protection on: the mirror last');
    const proxies = [];
    const eu = { netSession: { setProxy: async (c) => { proxies.push(c); } }, setFeedURL: () => {} };
    const u = new Updater({ store: memStore() });
    u.eu = eu;
    await u._euRoute('mirror');
    await u._euRoute('direct');
    t.ok(proxies[0] === engine && proxies[1].mode === 'direct', '…and it goes through the engine, never direct');
    const dl = `${Updater.RELEASES_URL}/download/latest-mac.yml`;
    t.ok(Updater.mirrorOf(dl) === `${Updater.MIRROR_URL}/latest-mac.yml`, 'a release feed URL maps to the mirror');
    const asset = `https://github.com/umutxyp/Shroudly/releases/download/v2.6.30/Shroudly-2.6.30-Windows-x64-Setup.exe`;
    t.ok(Updater.mirrorOf(asset) === `${Updater.MIRROR_URL}/Shroudly-2.6.30-Windows-x64-Setup.exe`, 'a release asset URL maps to the mirror');
    t.ok(Updater.mirrorOf('https://example.com/x') === 'https://example.com/x', 'an unrelated URL is left alone');
    t.ok(Updater.MIRROR_URL.startsWith('https://') && !/github\.com/.test(Updater.MIRROR_URL), 'the mirror is a non-GitHub https host');
  }

  // The download page's link: this copy's own file, from the mirror.
  {
    const n = Updater.downloadName;
    t.ok(n('2.6.45', { platform: 'win32', arch: 'x64' }) === 'Shroudly-2.6.45-Windows-x64-Setup.exe' && n('2.6.45', { platform: 'win32', arch: 'arm64' }) === 'Shroudly-2.6.45-Windows-arm64-Setup.exe'
      && n('2.6.45', { platform: 'darwin', arch: 'arm64' }) === 'Shroudly-2.6.45-macOS-arm64.dmg' && n('2.6.45', { platform: 'darwin', arch: 'x64' }) === 'Shroudly-2.6.45-macOS-x64.dmg'
      && n('2.6.45', { platform: 'linux', arch: 'x64' }) === 'Shroudly-2.6.45-Linux-x86_64.AppImage' && n('2.6.45', { platform: 'linux', arch: 'arm64' }) === 'Shroudly-2.6.45-Linux-arm64.AppImage'
      && n('2.6.45', { platform: 'linux', packageType: 'deb' }) === 'Shroudly-2.6.45-Linux-amd64.deb' && n('2.6.45', { platform: 'linux', packageType: 'rpm' }) === 'Shroudly-2.6.45-Linux-x86_64.rpm'
      && n('2.6.45', { platform: 'linux', packageType: 'pacman' }) === 'Shroudly-2.6.45-Linux-x64.pacman',
    'each copy is sent its own file (the names the release and the mirror use)');
    const server = fs.readFileSync(path.join(ROOT, 'server', 'stats', 'server.js'), 'utf8');
    const names = [...server.matchAll(/\(v\) => `Shroudly-\$\{v\}-([^`]+)`/g)].map((m) => `Shroudly-2.6.45-${m[1]}`);
    const ours = [['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']].map(([platform, arch]) => n('2.6.45', { platform, arch }))
      .concat(['deb', 'rpm', 'pacman'].map((packageType) => n('2.6.45', { platform: 'linux', packageType })));
    t.ok(ours.every((f) => names.includes(f)), '…every one of them served by the mirror (server/stats/server.js)');
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
  {
    // UI-7: an update postponed to the quit, or with automatic installs off,
    // is installed there by electron-updater itself: it gets the folder too.
    const real = process.platform;
    const execPath = process.execPath;
    const dir = sandbox();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'execPath', { value: `${dir}\\Shroudly.exe`, configurable: true, writable: true });
    try {
      const u = new Updater({ store: memStore({ autoUpdate: false }) });
      u.mac = false;
      u.eu = {};
      u._downloaded('2.5.6');
      t.ok(u.eu.installDirectory === path.win32.dirname(process.execPath) && u.eu.autoInstallOnAppQuit === true,
        'a downloaded update: installed at the quit into the folder this copy runs from (#57), not only by "Restart now"');
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
      Object.defineProperty(process, 'execPath', { value: execPath, configurable: true, writable: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── deb, rpm and pacman: the install asks for a password (ML-3, UI-6) ──
  {
    const store = memStore({ [Updater.WAIT_KEY]: { version: '2.5.6', since: Date.now() - HOURS(8), route: 'direct' } });
    const { u, seen } = ready({ store, away: true });
    u.permission = 'password';
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
    const order = [];
    u.beforeInstall = async () => { order.push('stop'); };
    u.eu = { install: () => { order.push('password'); return true; } };
    quits = 0;
    await u.install();
    await tick();
    t.ok(order.join() === 'password,stop' && quits === 1, 'the button: the password is asked first, while protection is still on; Shroudly stops only once the package is in');
    stop(u);
    const refused = ready();
    refused.u.permission = 'password';
    let undone = 0;
    refused.u.onInstallFailed = () => { undone++; };
    refused.u.beforeInstall = async () => { order.push('stop'); };
    refused.u.eu = { install: () => { refused.u.installError = new Error('Command pkexec exited with code 126'); return false; } };
    order.length = 0;
    await refused.u.install();
    t.ok(order.length === 0 && undone === 0 && refused.u.state.failed && !refused.u.installing,
      'a password refused: nothing was stopped, so nothing to start again; the version is noted as failed');
    const eu = new EventEmitter();
    const v = new Updater({ store: memStore() });
    v.permission = 'password';
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
  if (!haveUpdaterLib) console.log("  --  electron-updater is not installed here: its dpkg, pacman, NSIS and AppImage installs are checked where it is");
  if (haveUpdaterLib) {
    // electron-updater follows a failed `dpkg -i` with `apt-get install -f`,
    // each through pkexec: a dismissed prompt came straight back.
    const { DebUpdater } = require(path.join(updaterLib, 'DebUpdater.js'));
    const { PacmanUpdater } = require(path.join(updaterLib, 'PacmanUpdater.js'));
    const quiet = { warn() {}, info() {}, error() {} };
    const run = (code, installer = (r) => DebUpdater.installWithCommandRunner('dpkg', '/tmp/Shroudly.deb', r, quiet)) => {
      const prompts = [];
      const eu = new EventEmitter();
      eu.runCommandWithSudoIfNeeded = (cmd) => { prompts.push(cmd.slice(0, 2).join(' ')); throw new Error(`Command pkexec exited with code ${code}`); };
      new Updater({ store: memStore() })._wire(eu);
      let err = null;
      try { installer(eu.runCommandWithSudoIfNeeded); } catch (e) { err = e; }
      return { prompts, err };
    };
    const dismissed = run(126);
    const noAgent = run(127);
    const dpkgFailed = run(1);
    t.ok(dismissed.prompts.length === 1 && /code 126/.test(dismissed.err.message) && noAgent.prompts.length === 1,
      'the password prompt dismissed, or no prompt possible: not asked a second time');
    t.ok(dpkgFailed.prompts.join() === 'dpkg -i,apt-get install', 'dpkg itself failing (the password given): its apt-get repair still runs');
    const pacman = run(1, (r) => PacmanUpdater.installWithCommandRunner('/tmp/Shroudly.pacman', r, quiet));
    t.ok(pacman.prompts.join() === 'pacman -U' && /code 1\b/.test(pacman.err.message),
      'pacman failing: no `pacman -Sy` of its own (a partial upgrade), the failure reported as it is (UI-15)');
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
    // As electron-updater does when pkexec fails: 'error', and false.
    eu.install = () => { calls++; eu.emit('error', new Error('Command pkexec exited with code 126')); return false; };
    u._wire(eu);
    u._set({ status: 'ready', version: '2.5.6' });
    eu.quitAndInstallCalled = true;
    await u.install();
    t.ok(!u.installing && undone === 1 && u.state.status === 'ready' && u.state.failed === true && eu.quitAndInstallCalled === false && eu.autoInstallOnAppQuit === false,
      'a refused password: what was readied for the quit is undone (protection back), the update still there to install, not at a quit');
    t.ok(logs.filter((l) => l === 'Update 2.5.6 could not be installed (Command pkexec exited with code 126); Shroudly carries on with version 2.5.5').length === 1
      && !logs.some((l) => /^Update failed/.test(l)), '…said in one line, not as a failed check');
    await u._armRestart();
    t.ok(!u.restartTimer && !u.waitTimer, 'that version is not installed by itself again');
    await u.install();
    t.ok(calls === 2 && undone === 2 && !u.installing, '"Restart now" still tries again');
    // At the next start too, until a newer version comes out.
    const next = ready({ store, away: true });
    next.u.eu = {};
    next.u._downloaded('2.5.6');
    await sleep(20);
    t.ok(next.u.state.failed === true && !next.u.restartTimer && next.u.eu.autoInstallOnAppQuit === false, 'at a later start: still not installed by itself, nor at a quit');
    next.u._downloaded('2.5.7');
    await sleep(20);
    t.ok(next.u.state.failed === false && next.u.restartTimer && next.u.eu.autoInstallOnAppQuit === true, 'a newer version: installed as usual');
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
    u.eu = { install: () => true };
    u._set({ status: 'ready', version: '2.5.6' });
    quitHandlers['will-quit'] = [];
    await u.install();
    t.ok(u.installing && undone === 0, 'installing: waiting for the quit');
    await sleep(150);
    t.ok(!u.installing && undone === 1 && u.state.failed, 'Shroudly still running some seconds later: the install is taken as failed, and undone');
    const v = new Updater({ store: memStore(), onInstallFailed: () => { undone++; } });
    v.mac = false;
    v.installQuitMs = 60;
    v.eu = { install: () => true };
    v._set({ status: 'ready', version: '2.5.6' });
    quitHandlers['will-quit'] = [];
    await v.install();
    quitHandlers['will-quit'].forEach((fn) => fn());
    await sleep(150);
    t.ok(v.installing && undone === 1, 'the quit under way: nothing undone');
  }

  /* Windows: electron-updater's own installer start (NsisUpdater), on this
   * system: a stand-in installer that notes how it was started. */
  if (haveUpdaterLib && process.platform !== 'win32') {
    const { NsisUpdater } = require(path.join(updaterLib, 'NsisUpdater.js'));
    const dir = sandbox();
    const note = path.join(dir, 'ran');
    const script = (name, mode = 0o755) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\necho "$(basename "$0") $@" >> "${note}"\n`, { mode }); return f; };
    const setup = script('Shroudly-Setup.exe');
    script('elevate.exe');
    const blocked = script('Blocked-Setup.exe', 0o644);
    const resources = process.resourcesPath;
    process.resourcesPath = dir;
    const nsis = (file) => {
      const appAdapter = {
        version: '2.5.5', name: 'Shroudly', isPackaged: true, appUpdateConfigPath: path.join(dir, 'app-update.yml'),
        userDataPath: dir, baseCachePath: dir, whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit() {},
      };
      const eu = new NsisUpdater(null, appAdapter);
      eu.downloadedUpdateHelper = { file, downloadedFileInfo: {}, packageFile: null };
      let undone = 0;
      const u = new Updater({ store: memStore(), onInstallFailed: () => { undone++; } });
      u.mac = false;
      u._wire(eu);
      u._set({ status: 'ready', version: '2.5.6' });
      return { u, eu, undone: () => undone };
    };
    const ran = () => { try { return fs.readFileSync(note, 'utf8').trim(); } catch { return ''; } };
    try {
      {
        const { u } = nsis(setup);
        quits = 0;
        await u.install();
        await tick();
        for (let i = 0; i < 50 && !ran(); i++) await sleep(20);
        t.ok(quits === 1 && /^Shroudly-Setup\.exe --updated \/S --force-run/.test(ran()), 'the installer started: Shroudly quits for it (silently, and the installer starts the new version)');
        stop(u);
      }
      {
        // An antivirus took the downloaded installer away.
        const { u, undone } = nsis(path.join(dir, 'Gone-Setup.exe'));
        quits = 0;
        await u.install();
        await tick();
        t.ok(quits === 0 && undone() === 1 && !u.installing && u.state.failed && /ENOENT/.test(u.state.error),
          'an installer that cannot be started: Shroudly does not quit (it used to close and never come back), protection comes back, the version noted');
      }
      {
        // Windows refuses a normal start: electron-updater goes through elevate.exe.
        fs.rmSync(note, { force: true });
        const { u, undone } = nsis(blocked);
        u.elevatedQuitMs = 600;
        quits = 0;
        await u.install();
        for (let i = 0; i < 50 && !ran(); i++) await sleep(20);
        t.ok(quits === 0 && u.installing && /^elevate\.exe .*Blocked-Setup\.exe --updated/.test(ran()),
          'started through elevate.exe (which asks for permission first): Shroudly is left for the installer to close');
        await sleep(700);
        t.ok(!u.installing && undone() === 1 && u.state.failed, '…not closed in time: permission was not given, Shroudly carries on as before');
      }
    } finally {
      process.resourcesPath = resources;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  {
    // The Windows installer of a copy installed for everyone was refused its
    // permission after Shroudly had quit (scripts/installer.nsh): it starts
    // this version again with a note, read at the start.
    const dir = sandbox();
    const store = memStore();
    const logs = [];
    const u = new Updater({ store, log: (l, m) => logs.push(m), dir });
    fs.writeFileSync(path.join(dir, 'failed'), '2.5.6 permission\r\n');
    u._readFailedNote();
    t.ok(logs.includes('Update 2.5.6 could not be installed (administrator permission was not given); Shroudly carries on with version 2.5.5')
      && store.get(Updater.FAILED_KEY).version === '2.5.6', 'Windows, permission refused: said once, at the start the installer made');
    const next = ready({ store, away: true });
    next.u.eu = {};
    next.u._downloaded('2.5.6');
    await sleep(20);
    t.ok(next.u.state.failed && !next.u.restartTimer && next.u.eu.autoInstallOnAppQuit === false, '…and that version is not tried again by itself, at no countdown and no quit');
    fs.writeFileSync(path.join(dir, 'failed'), '2.5.6 elevation\n');
    u._readFailedNote();
    t.ok(logs.some((l) => /\(Windows could not ask for administrator permission\)/.test(l)), '…and when Windows could not even ask, that is said');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    // A copy installed for everyone: like a Linux package, only the button.
    const { u, seen } = ready({ away: true });
    u.permission = 'admin';
    const told = [];
    u.notify = (version, kind) => told.push(`${version} ${kind}`);
    u.eu = {};
    u._downloaded('2.5.6');
    await sleep(20);
    t.ok(!u.restartTimer && seen.installed === 0 && told.join() === '2.5.6 admin' && u.eu.autoInstallOnAppQuit === false,
      'Windows, installed for everyone: no countdown, no install at a quit (a permission prompt with nobody expecting it), said once');
    stop(u);
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
    // electron-updater's own AppImage install, as it runs at a quit and from
    // the button: the update takes the old file's place, under its name.
    const { AppImageUpdater } = require(path.join(updaterLib, 'AppImageUpdater.js'));
    const setup = () => {
      const dir = sandbox();
      const apps = path.join(dir, 'Apps');
      fs.mkdirSync(apps);
      const oldFile = path.join(apps, 'Shroudly-2.5.5-Linux-x86_64.AppImage');
      fs.writeFileSync(oldFile, '#!/bin/sh\necho old\n', { mode: 0o755 });
      fs.mkdirSync(path.join(dir, 'cache', 'pending'), { recursive: true });
      const newFile = path.join(dir, 'cache', 'pending', 'Shroudly-2.5.6-Linux-x86_64.AppImage');
      fs.writeFileSync(newFile, '#!/bin/sh\n[ "$APPIMAGE_EXIT_AFTER_INSTALL" = true ] && exit 0\ntouch "$0.started"\necho new\n', { mode: 0o644 });
      const appAdapter = {
        version: '2.5.5', name: 'Shroudly', isPackaged: true, appUpdateConfigPath: path.join(dir, 'app-update.yml'),
        userDataPath: dir, baseCachePath: dir, whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit(fn) { this.quitFn = fn; },
      };
      const eu = new AppImageUpdater(null, appAdapter);
      eu.autoInstallOnAppQuit = true;
      let entry = null;
      let undone = 0;
      const u = new Updater({ store: memStore(), onAppImageMoved: (file) => { entry = file; }, onInstallFailed: () => { undone++; } });
      u.mac = false;
      u._wire(eu);
      // As electron-updater's DownloadedUpdateHelper holds a finished download.
      eu.downloadedUpdateHelper = { _file: newFile, get file() { return this._file; }, downloadedFileInfo: {}, cacheDir: path.join(dir, 'cache') };
      return { dir, apps, oldFile, newFile, eu, u, appAdapter, entry: () => entry, undone: () => undone };
    };
    const withAppImage = async (file, fn) => {
      const env = process.env.APPIMAGE;
      process.env.APPIMAGE = file;
      try { return await fn(); } finally { if (env === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = env; }
    };
    const content = (f) => fs.readFileSync(f, 'utf8');
    {
      const s = setup();
      const link = path.join(s.dir, 'shroudly');   // a shortcut, a launcher, a script that starts it
      fs.symlinkSync(s.oldFile, link);
      await withAppImage(s.oldFile, () => { s.eu.addQuitHandler(); s.appAdapter.quitFn(0); });
      t.ok(fs.existsSync(s.oldFile) && /echo new/.test(content(s.oldFile)) && (fs.statSync(s.oldFile).mode & 0o111) && !fs.existsSync(`${s.oldFile}.started`)
        && fs.readdirSync(s.apps).join() === path.basename(s.oldFile),
      'installed at a quit: the new version in the same file, under the same name, nothing else left in the folder (not started)');
      t.ok(/echo new/.test(content(link)) && s.entry() === null, '…so a shortcut or script that starts it keeps working, and "Start at login" needs no change');
      t.ok(!fs.existsSync(s.newFile), '…and the download is not left behind in the cache');
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
    {
      const s = setup();
      quits = 0;
      s.u._set({ status: 'ready', version: '2.5.6' });
      await withAppImage(s.oldFile, () => s.u.install());
      for (let i = 0; i < 50 && !fs.existsSync(`${s.oldFile}.started`); i++) await sleep(20);
      await tick();
      t.ok(fs.existsSync(`${s.oldFile}.started`) && quits === 1 && /echo new/.test(content(s.oldFile)),
        '"Restart now": the new version started from the same file, and Shroudly quits once it has');
      stop(s.u);
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
    {
      // The cache on another disk: copied beside the file first, then put in place.
      const s = setup();
      const rename = fs.renameSync;
      let first = true;
      fs.renameSync = (a, b) => { if (first && a === s.newFile) { first = false; throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); } return rename(a, b); };
      try { await withAppImage(s.oldFile, () => { s.eu.addQuitHandler(); s.appAdapter.quitFn(0); }); } finally { fs.renameSync = rename; }
      t.ok(/echo new/.test(content(s.oldFile)) && fs.readdirSync(s.apps).join() === path.basename(s.oldFile) && !fs.existsSync(s.newFile),
        'the download on another disk: copied beside the file, then put in place');
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
    {
      // The copy fails (the disk fills up): nothing has been touched.
      const s = setup();
      const copy = fs.copyFileSync;
      const rename = fs.renameSync;
      fs.renameSync = (a, b) => { if (a === s.newFile) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); return rename(a, b); };
      fs.copyFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' }); };
      quits = 0;
      s.u._set({ status: 'ready', version: '2.5.6' });
      try { await withAppImage(s.oldFile, () => s.u.install()); } finally { fs.copyFileSync = copy; fs.renameSync = rename; }
      t.ok(/echo old/.test(content(s.oldFile)) && fs.existsSync(s.newFile) && fs.readdirSync(s.apps).join() === path.basename(s.oldFile)
        && quits === 0 && s.undone() === 1 && s.u.state.failed && /ENOSPC/.test(s.u.state.error),
      'the disk full while copying: the old AppImage still there and untouched (before, it was deleted first), Shroudly carries on');
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
    {
      // A leftover of an install that never got into place is cleared at the next start.
      const s = setup();
      fs.mkdirSync(path.join(s.apps, Updater.APPIMAGE_STAGE));
      fs.writeFileSync(path.join(s.apps, Updater.APPIMAGE_STAGE, path.basename(s.oldFile)), 'x');
      s.u.appImage = s.oldFile;
      s.u.tmp = path.join(s.dir, 'tmp');
      s.u.dir = path.join(s.dir, 'update');
      s.u._clearLeftovers();
      t.ok(fs.readdirSync(s.apps).join() === path.basename(s.oldFile), '…and what such an install left beside the file goes at the next start');
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }

  // ── what downloads by itself (MISS-2) ──
  {
    const found = async ({ releaseDate, fetched, manual = false, metered = false, store } = {}) => {
      store = store || memStore(fetched ? { [Updater.FETCHED_KEY]: fetched } : {});
      const logs = [];
      const u = new Updater({ store, log: (l, m) => logs.push(m), metered: async () => metered });
      u.mac = false;
      let downloads = 0;
      u.download = async () => { downloads++; };
      u.manualCheck = manual;
      await u._found('2.5.6', releaseDate);
      return { u, logs, downloads: () => downloads, store };
    };
    const fresh = new Date(Date.now() - HOURS(1)).toISOString();
    const old = new Date(Date.now() - HOURS(7)).toISOString();
    t.ok((await found({ releaseDate: fresh, fetched: Date.now() - HOURS(3) })).downloads() === 0,
      'a release an hour old, one already downloaded today: it waits a few hours (releases come in bursts, about 100 MB each)');
    t.ok((await found({ releaseDate: old, fetched: Date.now() - HOURS(3) })).downloads() === 1, '…once it has been out a while, it downloads');
    t.ok((await found({ releaseDate: fresh, fetched: Date.now() - HOURS(30) })).downloads() === 1, 'nothing downloaded for a day: the newest one at once');
    t.ok((await found({ releaseDate: fresh, fetched: Date.now() - HOURS(3), manual: true })).downloads() === 1, '"Check for updates" by hand: at once');
    const m = await found({ releaseDate: old, metered: true });
    t.ok(m.downloads() === 0 && m.u.state.status === 'available' && m.logs.filter((l) => l === 'Update 2.5.6 is not downloaded by itself on a metered connection').length === 1,
      'a metered connection (a phone hotspot): not downloaded by itself, the button there, said once');
    await m.u._found('2.5.6', old);
    t.ok(m.logs.filter((l) => /metered/.test(l)).length === 1 && m.logs.filter((l) => /^Update available/.test(l)).length === 1,
      '…and at the next check neither line again (BR-7: not 48 times a day)');
    const fails = await found({ releaseDate: old });
    fails.u._set({ version: '2.5.6' });
    fails.u._downloadFailed(new Error('connection reset'));
    t.ok(fails.u.state.status === 'error' && fails.u.state.stage === 'download', 'a failed download says so (not "could not check for updates")');
    await fails.u._found('2.5.6', old);
    t.ok(fails.downloads() === 1, '…and is tried again at the next check');
    fails.u._downloadFailed(new Error('connection reset'));
    await fails.u._found('2.5.6', old);
    t.ok(fails.downloads() === 1 && fails.u.failedDownload.next - Date.now() > HOURS(0.9), '…then less and less often, each try being the whole file');
    fails.u.manualCheck = true;
    await fails.u._found('2.5.6', old);
    t.ok(fails.downloads() === 2, '…while the user\'s own check still goes ahead');
  }
  {
    // A metered connection, as each system tells it.
    t.ok(Metered.windowsMetered('Variable False False') && Metered.windowsMetered('Fixed False False') && Metered.windowsMetered('Unrestricted True False')
      && Metered.windowsMetered('Unrestricted False True') && !Metered.windowsMetered('Unrestricted False False') && !Metered.windowsMetered(''),
    'Windows: a metered or mobile connection, roaming, or over its limit');
    t.ok(Metered.macMetered('   route to: default\n    gateway: 172.20.10.1\n  interface: en0\n') && Metered.macMetered('  interface: pdp_ip0\n')
      && !Metered.macMetered('    gateway: 192.168.1.1\n  interface: en0\n') && !Metered.macMetered('    gateway: 172.20.10.17\n'),
    "macOS: an iPhone's hotspot (Wi-Fi, USB, Bluetooth) or the Mac's own mobile modem");
    t.ok(Metered.linuxMetered('   variant       uint32 1\n') && Metered.linuxMetered('variant uint32 3') && !Metered.linuxMetered('variant uint32 4') && !Metered.linuxMetered(''),
      "Linux: NetworkManager's answer (a hotspot it guesses counts)");
    const calls = [];
    const fake = (out) => async (cmd) => { calls.push(cmd); return out; };
    t.ok(await realMetered({ platform: 'darwin', exec: fake('    gateway: 172.20.10.1\n') }) === true && calls.pop() === '/sbin/route'
      && await realMetered({ platform: 'win32', exec: fake('Fixed False False') }) === true && calls.pop() === 'powershell.exe'
      && await realMetered({ platform: 'linux', exec: fake('variant uint32 1') }) === true && calls.pop() === 'dbus-send',
    'each system asked its own way');
    t.ok(await realMetered({ platform: 'darwin', exec: async () => { throw new Error('no route'); } }) === false && await realMetered({ platform: 'freebsd', exec: fake('x') }) === false,
      'a look that cannot be made: not metered (updates never stop on it)');
  }

  // ── electron-updater's checks and downloads (UI-5, MISS-3, BR-7) ──
  /* A stand-in electron-updater: checks and downloads per route, as told. */
  const fakeEu = (plan) => {
    const eu = new EventEmitter();
    eu.route = null;
    eu.calls = [];
    eu.closed = 0;
    eu.cancelled = 0;
    eu.netSession = { setProxy: async (c) => { eu.route = c.mode === 'direct' ? 'direct' : 'engine'; }, closeAllConnections: async () => { eu.closed++; } };
    eu.setFeedURL = (o) => { eu.feed = o.provider; };
    const where = () => (eu.feed === 'generic' ? 'mirror' : eu.route);
    eu.checkForUpdates = () => {
      const w = where();
      eu.calls.push(`check ${w}`);
      const p = plan.check ? plan.check(w) : 'found';
      if (p === 'hang') return new Promise(() => {});
      if (p === 'fail') return Promise.reject(new Error(`no ${w}`));
      eu.emit('checking-for-update');
      const info = { version: p === 'other' ? '2.5.9' : '2.5.6', releaseDate: new Date(Date.now() - HOURS(30)).toISOString() };
      eu.bound = w;
      eu.emit('update-available', info);
      return Promise.resolve({ isUpdateAvailable: true, updateInfo: info });
    };
    eu.downloadUpdate = (token) => {
      // From the provider of the last check, through the session's proxy.
      const w = eu.bound === 'mirror' ? 'mirror' : eu.route;
      eu.calls.push(`download ${w}`);
      const p = plan.download ? plan.download(w) : 'ok';
      if (p === 'hang') return new Promise((resolve, reject) => { if (token) token.onCancel(() => { eu.cancelled++; reject(new Error('cancelled')); }); });
      if (p === 'fail') return Promise.reject(new Error(`download from ${w} failed`));
      eu.emit('update-downloaded', { version: '2.5.6' });
      return Promise.resolve([]);
    };
    return eu;
  };
  const euUpdater = (eu, { store, ...opts } = {}) => {
    const states = [];
    const logs = [];
    const u = new Updater({ store: memStore(store || {}), log: (l, m) => logs.push(m), ...opts });
    u.mac = false;
    u.stallMs = 80;
    u._wire(eu);
    u.onState((s) => states.push(s.status));
    return { u, states, logs };
  };
  {
    Updater.setSystemRoute({ proxyRules: 'socks5://127.0.0.1:10808' });
    const eu = fakeEu({ download: (w) => (w === 'mirror' ? 'ok' : 'fail') });
    const { u } = euUpdater(eu, { store: { autoUpdate: false } });
    await u.check(true);
    u._set({ status: 'available', version: '2.5.6' });
    await u.download();
    t.ok(eu.calls.join() === 'check direct,download direct,download engine,check mirror,download mirror' && u.state.status === 'ready',
      "the mirror's turn: its own feed read first, so the file really comes from the mirror (it was fetched from GitHub a third time)");
    const other = fakeEu({ check: (w) => (w === 'mirror' ? 'other' : 'found'), download: (w) => (w === 'mirror' ? 'ok' : 'fail') });
    const o = euUpdater(other, { store: { autoUpdate: false } });
    await o.u.check(true);
    o.u._set({ status: 'available', version: '2.5.6' });
    await o.u.download();
    t.ok(o.u.state.status === 'error' && !other.calls.includes('download mirror'), '…and a mirror with another version is not taken for this one');
  }
  {
    const eu = fakeEu({ check: (w) => (w === 'direct' ? 'hang' : 'found') });
    const { u, states } = euUpdater(eu, { store: { autoUpdate: false } });
    const t0 = Date.now();
    await u.check(true);
    t.ok(u.state.status === 'available' && eu.closed === 1 && eu.calls.join() === 'check direct,check engine' && Date.now() - t0 < 2000 && states.includes('checking'),
      'a check that goes silent: given up after a while (its connections closed), the next route tried; not "checking" for the rest of the session');
  }
  {
    const eu = fakeEu({ download: (w) => (w === 'direct' ? 'hang' : 'ok') });
    const { u } = euUpdater(eu, { store: { autoUpdate: false } });
    await u.check(true);
    u._set({ status: 'available', version: '2.5.6' });
    const t0 = Date.now();
    await u.download();
    t.ok(u.state.status === 'ready' && eu.cancelled === 1 && Date.now() - t0 < 2000, 'a download that goes silent: called off, and the next route downloads it');
  }
  {
    // BR-7: in the background, a version that cannot be applied is looked at
    // again without the window going "checking" and back, and said once.
    const eu = fakeEu({});
    const { u, states, logs } = euUpdater(eu, { store: { autoUpdate: false } });
    await u.check(false);
    const first = states.length;
    await u.check(false);
    await u.check(false);
    t.ok(u.state.status === 'available' && states.slice(first).every((s) => s === 'available') && logs.filter((l) => /^Update available/.test(l)).length === 1,
      'an update the user has not taken: rechecked quietly, "Update available" said once (not 48 times a day)');
    await u.check(true);
    t.ok(states.slice(-2)[0] === 'checking', '…while "Check for updates" by hand still shows it checking');
  }
  {
    // A check in the background that fails takes nothing away.
    const eu = fakeEu({ check: () => 'fail' });
    const { u, logs } = euUpdater(eu);
    u._set({ status: 'ready', version: '2.5.6' });
    await u.check(false);
    t.ok(u.state.status === 'ready' && logs.some((l) => /^Update failed/.test(l)), 'ready to install, then offline for a moment: still ready, the button still there');
    const newer = fakeEu({ check: () => 'other' });
    const n = euUpdater(newer);
    n.u._set({ status: 'ready', version: '2.5.6' });
    await n.u.check(false);
    await tick();
    t.ok(newer.calls.includes('download direct'), 'ready, and a newer version comes out meanwhile: that one is fetched instead of a stale install');
    stop(n.u);
  }

  // ── macOS: where the app runs from (UI-10) ──
  {
    const logs = [];
    const u = new Updater({ store: memStore(), log: (l, m) => logs.push(m) });
    u.mac = true;
    u._macBundle = () => '/Applications/Shroudly.app';
    inApps = true;
    t.ok(u._macWhy() === 'folder', 'in Applications, which a standard account cannot change: "download it", not "move it to Applications"');
    inApps = false;
    u._macBundle = () => '/Users/u/Downloads/Shroudly.app';
    t.ok(u._macWhy() === 'location', 'anywhere else (Downloads, the disk image): moving it to Applications is the fix');
    moved = 0;
    t.ok(u.moveToApplications() === true && moved === 1, '…and the window\'s button moves it there');
    t.ok(u.moveToApplications() === false && logs.includes('Shroudly could not be moved to the Applications folder (Failed to move)'), '…saying so when it cannot');
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
  // Protection on: every route there is (the mirror through the engine).
  Updater.setSystemRoute({ proxyRules: 'socks5://127.0.0.1:10808' });
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
  // ── macOS, Applications not this account's to change (VML-3) ──
  {
    let before = 0;
    let undone = 0;
    const told = [];
    const { u, logs, dir } = mac('Shroudly-2.5.6-macOS-arm64.zip', {
      store: memStore(), beforeInstall: async () => { before++; }, onInstallFailed: () => { undone++; },
      notify: (v, kind) => told.push(`${v} ${kind}`), adminPrompt: (v) => `Shroudly needs an administrator's password to install version ${v}.`, away: () => true,
    });
    u._macCanReplace = () => false;
    u._macBundle = () => '/Applications/Shroudly.app';
    inApps = true;
    await u.download();
    await sleep(20);
    t.ok(u.state.status === 'ready' && u.permission === 'admin' && u.state.permission === 'admin' && !u.restartTimer && !u.waitTimer && told.join() === '2.5.6 admin',
      'a standard account, the app in Applications: downloaded all the same, installed only from the button that says it asks for an administrator (said once)');
    let swaps = 0;
    u._macSwapOnExit = () => { swaps++; };
    u.installOnQuit();
    t.ok(swaps === 0 && !u.installing, '…never at a quit (a password dialog with nobody expecting it)');
    const asked = [];
    u.osascript = async (args) => { asked.push({ args, stopped: before }); throw new Error('execution error: User canceled. (-128)'); };
    exits = 0;
    await u.install();
    t.ok(asked.length === 1 && asked[0].stopped === 0 && before === 0 && undone === 0 && exits === 0 && u.state.failed && !u.installing,
      'the password asked first, while protection is still on; refused: nothing stopped, Shroudly carries on, the version noted');
    const src = asked[0].args[1];
    t.ok(asked[0].args[0] === '-e' && /with prompt "Shroudly needs an administrator's password to install version 2\.5\.6\." with administrator privileges$/.test(src)
      && /^do shell script "\/bin\/sh '[^']+install\.sh' '\d+' '[^']+\.zip' /.test(src) && new RegExp(`'${process.getuid()}' </dev/null >/dev/null 2>&1 &"`).test(src),
    '…one macOS dialog saying what it is for, running the same swap script in the background, told whose app to open afterwards');
    u.osascript = async () => '';
    u._set({ failed: false });
    await u.install();
    t.ok(before === 1 && exits === 1, 'the password given: protection stopped, Shroudly quits, the script swaps the app');
    inApps = false;
    fs.rmSync(dir, { recursive: true, force: true });
    void logs;
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
      const r = spawnSync('/bin/sh', [script, String(dead), zip, work, app, relaunch, marker, '2.5.6', String(process.getuid())]);
      const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
      return { code: r.status, version: read(path.join(app, 'v')), opened: read(opened), marker: read(marker), workLeft: fs.existsSync(work), oldLeft: fs.existsSync(`${app}.old`) };
    };
    const ok = swap();
    t.ok(ok.code === 0 && ok.version === '2' && ok.opened === `-g ${path.join(dir, 'Applications', 'Shroudly.app')} --args --updated` && ok.marker === null && !ok.workLeft && !ok.oldLeft,
      'the swap: the new app in place, opened again in the background (never over a full-screen game or film), its download gone');
    const missing = swap({ zip: path.join(dir, 'gone.zip') });
    t.ok(missing.code === 1 && missing.version === '1' && missing.opened.startsWith('-g ') && missing.opened.endsWith(`--args ${Updater.UPDATE_FAILED_ARG}`) && missing.marker === '2.5.6 unpack',
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
