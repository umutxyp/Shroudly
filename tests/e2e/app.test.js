'use strict';

/* The real app, driven end to end: how its window comes and goes, and what
 * every state costs in memory, on whatever OS this runs on.
 *
 *   node tests/e2e/app.test.js          assert and report
 *   SHROUDLY_APP_DIR=<dir> ...          another checkout (a baseline), report only
 *
 * Its own settings folder (--user-data-dir), so a Shroudly installed on the
 * machine is never touched. Starting protection changes the system proxy, so
 * that part only runs on CI machines (CI=true). */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron } = require('playwright-core');
const { measure, describe, tree } = require('./memory');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = process.env.SHROUDLY_APP_DIR || ROOT;
const BASELINE = !!process.env.SHROUDLY_APP_DIR;
const SHOTS = path.join(ROOT, 'test-results');
const IDLE_MS = 4000;

let count = 0;
const ok = (cond, label) => {
  if (BASELINE) return;
  if (!cond) throw new Error(`not ok: ${label}`);
  count++;
  console.log(`  ok  ${label}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

// The app closes an unused window after IDLE_MS; while the test needs it
// open, it reports use the way the interface does when someone is at it.
function keepOpen(page) {
  const t = setInterval(() => { page.evaluate(() => window.electron.uiActive()).catch(() => {}); }, 1000);
  return () => clearInterval(t);
}

const report = [];
let metrics = async () => [];
async function record(label, pid) {
  const m = measure(pid, await metrics());
  report.push(describe(label, m));
  console.log(`  ..  ${describe(label, m)}`);
  return m;
}

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-e2e-'));
  // Language Turkish (a language other than English, loaded on demand),
  // nothing starting by itself, no notifications on the test machine.
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    autoMode: false, showNotifications: false, minimizeToTray: true, autoStart: false, language: 'tr', shareOnlineCount: true,
  }));
  fs.mkdirSync(SHOTS, { recursive: true });
  const env = { ...process.env, SHROUDLY_IDLE_RELEASE_MS: String(IDLE_MS) };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({
    executablePath: require(path.join(APP, 'node_modules', 'electron')),
    args: [APP, `--user-data-dir=${ud}`, '--autostart', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env,
    timeout: 60000,
  });
  const pid = app.process().pid;
  metrics = () => app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.serviceName || m.name || '' }))).catch(() => []);
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const open = async () => {
    // A new window, unless one is still there (a baseline that only hides
    // its window shows the same one again).
    const live = (await windows()) > 0 ? app.windows().filter((w) => !w.isClosed()).pop() : null;
    const next = live ? null : app.waitForEvent('window', { timeout: 30000 });
    await app.evaluate(({ app: a }) => a.emit('second-instance'));
    const page = live || await next;
    await page.waitForLoadState('domcontentloaded');
    return page;
  };

  try {
    // ── 1. started at login: tray only ──
    await sleep(5000);
    ok(await windows() === 0, 'started at login: no window at all, only the tray');
    const tray = await record('1 tray only, protection off', pid);
    ok(!tray.kinds.has('renderer'), 'no window process in the tray-only state');

    // ── 2. opened: the interface, in the chosen language ──
    let page = await open();
    let stop = keepOpen(page);
    const tr = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'tr.json'), 'utf8'));
    const shown = await until(() => page.getByText(tr.navSettings, { exact: true }).first().isVisible(), 15000);
    ok(!!shown, `window opened from the tray, in Turkish ("${tr.navSettings}" shown)`);
    await sleep(2500);
    await page.screenshot({ path: path.join(SHOTS, `window-${process.platform}-${process.arch}.png`) });
    const opened = await record('2 window open, protection off', pid);
    ok(opened.kinds.has('renderer'), 'the window has its process');
    stop();

    // ── 3. left alone: closed by itself ──
    const t0 = Date.now();
    const released = await until(async () => (await windows()) === 0, IDLE_MS + 20000);
    ok(!!released, `left unused: the window closed by itself after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await sleep(3000);
    const idle = await record('3 after the window closed for being idle', pid);
    ok(!idle.kinds.has('renderer'), 'its process is gone too');

    // ── 4. sent to the tray: closed at once ──
    page = await open();
    await until(() => page.getByText(tr.navSettings, { exact: true }).first().isVisible(), 15000);
    await page.evaluate(() => window.electron.closeWindow());
    ok(!!(await until(async () => (await windows()) === 0, 5000)), 'sent to the tray: the window is closed, not just hidden');

    // ── 5. protection on (changes the system proxy: CI machines only) ──
    if (process.env.CI) {
      page = await open();
      stop = keepOpen(page);
      await until(() => page.getByText(tr.navSettings, { exact: true }).first().isVisible(), 15000);
      const r = await page.evaluate(() => window.electron.startDPI());
      const active = await until(() => page.evaluate(() => window.electron.getDPIStatus().then((s) => s.active)), 20000);
      ok(!!active, `protection started (${JSON.stringify(r).slice(0, 80)})`);
      await sleep(12000);   // the live-count ping has gone out by now
      const on = await record('5 window open, protection on', pid);
      ok(on.kinds.has('renderer'), 'the window stayed open while in use');
      ok(on.kinds.has('engine'), 'the engine runs');
      ok(![...on.kinds].some((k) => /ProxyResolver/i.test(k)), 'no proxy-resolver process for our own requests');
      stop();
      await page.evaluate(() => window.electron.closeWindow());
      await until(async () => (await windows()) === 0, 5000);
      await sleep(3000);
      const bg = await record('6 tray only, protection on', pid);
      // The watchdog runs once something is applied that must be undone if
      // Shroudly is killed (a Linux runner may have no desktop proxy to set).
      const wd = bg.parts.find((p) => p.kind === 'watchdog');
      const armed = ['proxy-state.json', 'app-env.json'].some((f) => fs.existsSync(path.join(ud, f)));
      console.log(`  --  system proxy applied: ${armed}`);
      if (armed) ok(!!wd, 'the watchdog is the small native one');
      if (wd && wd.mb > 0) ok(wd.mb < 8, `watchdog memory ${wd.mb.toFixed(1)} MB`);
      ok(!bg.kinds.has('renderer'), 'no window process while protecting in the background');

      // Windows: logoff is heard by the hidden window even with no main window.
      if (process.platform === 'win32' && !BASELINE) {
        const hwnd = await app.evaluate(({ BaseWindow, BrowserWindow }) => {
          const w = BaseWindow.getAllWindows().find((x) => !(x instanceof BrowserWindow));
          return w ? w.getNativeWindowHandle().readBigUInt64LE(0).toString() : null;
        });
        ok(!!hwnd, 'a logoff listener exists while there is no window');
        const reg = (name) => require('child_process').spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name], { encoding: 'utf8' }).stdout || '';
        ok(/AutoConfigURL|ProxyEnable\s+REG_DWORD\s+0x1/.test(reg('AutoConfigURL') + reg('ProxyEnable')), 'the system proxy points at Shroudly');
        const ps = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);';
          $h = [System.IntPtr]::new([long]${hwnd});
          [void][W.U]::SendMessage($h, 0x11, [System.IntPtr]::Zero, [System.IntPtr]::new(0x80000000));
          [void][W.U]::SendMessage($h, 0x16, [System.IntPtr]::new(1), [System.IntPtr]::new(0x80000000))`;
        require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
        const restored = await until(() => !/AutoConfigURL\s+REG_SZ\s+http:\/\/127\.0\.0\.1/.test(reg('AutoConfigURL')), 10000);
        ok(!!restored, 'logoff with no window open: the system proxy was put back');
      } else {
        page = await open();
        stop = keepOpen(page);
        await page.evaluate(() => window.electron.stopDPI());
        await until(() => page.evaluate(() => window.electron.getDPIStatus().then((s) => !s.active)), 15000);
        stop();
        await page.evaluate(() => window.electron.closeWindow());
      }
    }
  } finally {
    const before = tree(pid).map((p) => p.pid);
    await app.close().catch(() => {});
    // Everything it started is gone with it (the watchdog exits when there
    // is nothing left to restore).
    const left = await until(() => {
      const alive = before.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
      return alive.length === 0 ? [] : null;
    }, 15000);
    ok(!!left, 'after quitting, none of its processes are left running');
    fs.rmSync(ud, { recursive: true, force: true });
  }

  console.log(`\n── memory (${process.platform}-${process.arch}${BASELINE ? `, baseline ${APP}` : ''})`);
  for (const l of report) console.log(`  ${l}`);
  fs.writeFileSync(path.join(SHOTS, `memory-${BASELINE ? 'baseline' : 'new'}-${process.platform}-${process.arch}.txt`), report.join('\n') + '\n');
  if (!BASELINE) console.log(`\ne2e: ${count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
