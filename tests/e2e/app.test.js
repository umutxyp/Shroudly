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
  const m = await measure(pid, await metrics());
  report.push(describe(label, m));
  console.log(`  ..  ${describe(label, m)}`);
  return m;
}

(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-e2e-'));
  // Language Turkish (a language other than English, loaded on demand),
  // nothing starting by itself, no notifications on the test machine, and
  // no loopback exemptions for the runner's Store apps while memory is
  // measured (store-apps.js; tests/lab/uwp-loopback.js does that).
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    autoMode: false, showNotifications: false, minimizeToTray: true, autoStart: false, language: 'tr', shareOnlineCount: true,
    storeAppsModeOffAt: Date.now(),
  }));
  fs.mkdirSync(SHOTS, { recursive: true });
  // The main run as on a desktop that shows tray icons; a stock GNOME without
  // one is checked separately at the end (Linux).
  // SHROUDLY_E2E: the test may look inside the app (main.js); never otherwise.
  const env = { ...process.env, SHROUDLY_IDLE_RELEASE_MS: String(IDLE_MS), SHROUDLY_TRAY: 'present', SHROUDLY_E2E: '1' };
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
  // macOS: the Dock icon is there only while the window is (issue #9).
  const mac = process.platform === 'darwin' && !BASELINE;
  const dock = () => app.evaluate(({ app: a }) => a.dock.isVisible());
  // Every OS: what shows up in the taskbar / Dock / window list. Electron's
  // view (any visible window, the hidden logoff listener included), and on
  // Windows the OS's own: a process with a main window gets a taskbar button.
  const onScreen = async () => {
    const own = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().filter((w) => w.isVisible()).length);
    if (process.platform !== 'win32') return own;
    const ids = (await tree(pid)).map((p) => p.pid).join(',');
    const out = await new Promise((res) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command',
      `@(Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count`], (e, o) => res(String(o || '0').trim())));
    return own + Number(out || 0);
  };
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
    if (mac) ok(!(await dock()), 'macOS: started into the menu bar, no Dock icon');
    if (!BASELINE) ok(await onScreen() === 0, 'nothing in the taskbar or on screen, only the tray icon');

    // ── 2. opened: the interface, in the chosen language ──
    let page = await open();
    let stop = keepOpen(page);
    const tr = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'tr.json'), 'utf8'));
    const shown = await until(() => page.getByText(tr.navSettings, { exact: true }).first().isVisible(), 15000);
    ok(!!shown, `window opened from the tray, in Turkish ("${tr.navSettings}" shown)`);
    if (mac) ok(await dock(), 'macOS: the Dock icon is back with the window');
    if (!BASELINE) ok(await onScreen() > 0, 'the window is on screen and in the taskbar');
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
    if (mac) ok(!!(await until(async () => !(await dock()), 3000)), 'macOS: the Dock icon went with the window');
    if (!BASELINE) ok(await onScreen() === 0, 'window closed: nothing left in the taskbar, only the tray icon');

    // ── 4. sent to the tray: closed at once ──
    page = await open();
    stop = keepOpen(page);
    await until(() => page.getByText(tr.navSettings, { exact: true }).first().isVisible(), 15000);
    stop();
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
      if (!BASELINE) ok(await until(() => JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8')).protectionOn === true, 3000), 'pressing Start is remembered');
      await sleep(12000);   // the live-count ping has gone out by now
      const on = await record('5 window open, protection on', pid);
      ok(on.kinds.has('renderer'), 'the window stayed open while in use');
      ok(on.kinds.has('engine'), 'the engine runs');
      ok(![...on.kinds].some((k) => /ProxyResolver/i.test(k)), 'no proxy-resolver process for our own requests');

      if (!BASELINE) {
        const logsNow = () => page.evaluate(() => window.electron.getLogs());
        // By time, not by position: the log keeps its last 500 lines only.
        const stamp = () => new Date(Date.now() - 1000).toISOString();
        const has = async (re, from = '') => (await logsNow()).some((l) => (l.timestamp || '') >= from && re.test(l.message));
        const enginePid = () => app.evaluate(() => { const e = global.shroudlyE2E.engine; return e.proc ? e.proc.pid : 0; });

        // ── 5b. "Copy logs", through the window: the log in English with
        //        its times and levels and a short header, to the clipboard,
        //        while the window shows it in Turkish ──
        // Clicked as the page's own buttons (the first-run tour may lie over them).
        await page.locator('[data-tour="nav-logs"]').evaluate((el) => el.click());
        const copyBtn = page.locator('[data-testid="copy-logs"]');
        await copyBtn.waitFor({ timeout: 10000 });
        ok((await copyBtn.innerText()).includes(tr.copyLogs), `the Logs panel has "${tr.copyLogs}"`);
        await copyBtn.evaluate((el) => el.click());
        ok(!!(await until(async () => (await copyBtn.innerText()).includes(tr.logsCopied), 3000)), `pressed: it says "${tr.logsCopied}"`);
        const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
        const version = require(path.join(APP, 'package.json')).version;
        ok(clip.startsWith(`Shroudly ${version} log, copied `) && /\nSystem: .+ \((x64|arm64)\)\n/.test(clip) && clip.includes('\nProtection: on; route: ')
          && /\nAdvanced mode: (on|off)/.test(clip) && clip.includes('\nModes: Discord app mode off, Games and apps mode off') && /\nNetwork: /.test(clip),
        `the clipboard holds the header: version, system and architecture, protection and route, Advanced mode, the modes, the network (${clip.split('\n').slice(0, 6).join(' | ').slice(0, 300)})`);
        ok(/\n\S+Z OK Shroudly engine active \(strategy: /.test(clip) && /\n\S+Z INFO Starting engine: shroudly-core/.test(clip),
          'and every log line as written: English, with its time and level');
        await page.locator('[data-tour="nav-control"]').evaluate((el) => el.click()).catch(() => {});

        // ── 5c. the computer asleep, or the main process frozen, longer than
        //        the engine's hang window: the healthy engine is left alone ──
        await app.evaluate(() => { global.shroudlyE2E.engine.hangTimeoutMs = 3000; });
        const pid1 = await enginePid();
        const mark1 = stamp();
        const epoch1 = await app.evaluate(() => global.shroudlyE2E.wake.epoch);
        await app.evaluate(() => { const end = Date.now() + 8000; while (Date.now() < end) { /* nothing runs: as asleep */ } });
        await sleep(3000);
        const w1 = await app.evaluate(() => ({ epoch: global.shroudlyE2E.wake.epoch, why: global.shroudlyE2E.wake.why }));
        ok(pid1 && await enginePid() === pid1 && !(await has(/Engine stopped responding/, mark1)) && w1.epoch > epoch1 && w1.why === 'late',
          `frozen for 8 s with a 3 s hang window (a sleep, App Nap): the engine is not killed, and the wake is seen (${w1.why})`);
        ok(await has(/^The computer woke up or its clock changed \((late|clock|system)\); waiting times start afresh$/), 'the wake is in the log');
        await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
        await sleep(1500);
        ok(await app.evaluate(() => global.shroudlyE2E.wake.why) === 'system' && await enginePid() === pid1, "the system's own resume: seen, the engine left alone");

        // ── 5d. a real hang: caught; while the engine restarts, the system
        //        proxy stays and a program's connection waits for it ──
        const apPort = await app.evaluate(async () => {
          const g = global.shroudlyE2E;
          g.vias = []; g.held = null;
          const port = await g.appProxy.start(0);
          const prev = g.appProxy.onTunnel;
          g.appProxy.onTunnel = (h, v) => { g.vias.push(v); if (prev) prev(h, v); };
          const e = g.engine;
          const orig = e._onClose.bind(e);
          // At the moment the engine is gone, a program asks the app proxy
          // for a site (Discord's updater, Roblox mid download).
          e._onClose = (code) => {
            e._onClose = orig;
            const r = orig(code);
            const s = g.require('net').connect(port, '127.0.0.1', () => s.write('CONNECT www.wikipedia.org:443 HTTP/1.1\r\nHost: www.wikipedia.org:443\r\n\r\n'));
            let out = '';
            s.on('data', (d) => { out += d; if (out.includes('\r\n\r\n')) { g.held = out.split('\r\n')[0]; s.destroy(); } });
            s.on('error', (er) => { g.held = `error ${er.message}`; });
            return r;
          };
          return port;
        });
        const status0 = await app.evaluate(() => JSON.stringify(global.shroudlyE2E.engine.proxyStatus));
        const regNow = () => (process.platform === 'win32' ? (require('child_process').spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'AutoConfigURL'], { encoding: 'utf8' }).stdout || '') : '');
        const reg0 = regNow();
        const mark2 = stamp();
        const pid2 = await enginePid();
        if (process.platform === 'win32') {
          // Every thread of the engine suspended (NtSuspendProcess), and
          // looked at to be sure it took.
          const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));
          const ps = `$t = Add-Type -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h);' -Name N -Namespace S -PassThru; $p = Get-Process -Id ${pid2}; $r = $t::NtSuspendProcess($p.Handle); Start-Sleep -Milliseconds 300; $p.Refresh(); "status=$r threads=" + (@($p.Threads | ForEach-Object { "$($_.ThreadState)/$($_.WaitReason)" }) -join ',')`;
          // Not spawnSync: PowerShell may take half a minute to start (ARM),
          // and the test must keep telling the window it is in use meanwhile.
          const r = await new Promise((res) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command', ps],
            { encoding: 'utf8', timeout: 120000, env: powershellEnv() }, (e, out, err) => res({ stdout: out, stderr: err })));
          console.log(`  --  engine ${pid2} suspended: ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 300)}`);
        } else process.kill(pid2, 'SIGSTOP');
        const caught = await until(() => has(/Engine stopped responding/, mark2), 20000, 200);
        const back = await until(async () => { const p = await enginePid(); return p && p !== pid2 && await app.evaluate(() => global.shroudlyE2E.engine.isActive()); }, 20000, 200);
        const since = (await logsNow()).filter((l) => (l.timestamp || '') >= mark2).map((l) => `${l.level}: ${l.message}`.slice(0, 120));
        ok(!!caught && !!back, `an engine that really stops answering is caught and restarted (${caught ? 'caught' : 'not caught'}, ${back ? 'back' : 'not back'})${caught && back ? '' : `; the log since: ${since.join(' | ')}`}`);
        const held = await until(() => app.evaluate(() => global.shroudlyE2E.held), 20000, 200);
        const vias = await app.evaluate(() => global.shroudlyE2E.vias);
        ok(/^HTTP\/1\.1 200/.test(held || '') && vias.includes('engine') && !vias.includes('direct'),
          `a program's connection made the moment the engine died waited for it and went through it, not straight out (${held}; ${vias.join(',')})`);
        ok(!(await has(/System proxy settings restored/, mark2)) && JSON.parse(await app.evaluate(() => JSON.stringify(global.shroudlyE2E.engine.proxyStatus)) || 'null')?.ok === JSON.parse(status0 || 'null')?.ok
          && regNow() === reg0, 'the system proxy stayed pointed at Shroudly through the restart (nothing put back and set again)');
        if (process.platform !== 'win32') { try { process.kill(pid2, 'SIGCONT'); } catch {} }
        await app.evaluate(() => { const g = global.shroudlyE2E; g.engine.hangTimeoutMs = 60000; if (g.store.get('appMode') !== true) g.appProxy.stop(); });
      }
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
        // Another program takes the system proxy away (issue #27): it is set
        // back by itself, with no window and no button.
        const ours = (reg('AutoConfigURL').match(/AutoConfigURL\s+REG_SZ\s+(\S+)/) || [])[1];
        if (ours) {
          require('child_process').spawnSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'AutoConfigURL', '/f'], { encoding: 'utf8' });
          const t0 = Date.now();
          const back = await until(() => reg('AutoConfigURL').includes(ours), 40000, 500);
          ok(!!back, `another program removed the system proxy: set back by itself (${back ? `${Date.now() - t0} ms` : 'not set back'})`);
        }
        const ps =`Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);';
          $h = [System.IntPtr]::new([long]${hwnd});
          [void][W.U]::SendMessage($h, 0x11, [System.IntPtr]::Zero, [System.IntPtr]::new(0x80000000));
          [void][W.U]::SendMessage($h, 0x16, [System.IntPtr]::new(1), [System.IntPtr]::new(0x80000000))`;
        // Windows PowerShell without PowerShell 7's module path (CI steps run in pwsh).
        const { powershellEnv } = require(path.join(ROOT, 'electron', 'win-powershell.js'));
        const sent = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000, env: powershellEnv() });
        const restored = await until(() => !/AutoConfigURL\s+REG_SZ\s+http:\/\/127\.0\.0\.1/.test(reg('AutoConfigURL')), 20000);
        ok(!!restored, `logoff with no window open: the system proxy was put back${restored ? '' : ` (PowerShell: ${sent.status} ${String(sent.stderr || (sent.error && sent.error.message) || '').trim().slice(0, 200)})`}`);
      } else {
        page = await open();
        stop = keepOpen(page);
        await page.evaluate(() => window.electron.stopDPI());
        await until(() => page.evaluate(() => window.electron.getDPIStatus().then((s) => !s.active)), 15000);
        ok(JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8')).protectionOn === false, 'pressing Stop is remembered');
        stop();
        await page.evaluate(() => window.electron.closeWindow());
      }
    }
  } finally {
    const before = (await tree(pid)).map((p) => p.pid);
    await app.close().catch(() => {});
    // Everything it started is gone with it (the watchdog exits when there
    // is nothing left to restore).
    const left = await until(() => {
      const alive = before.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
      return alive.length === 0 ? [] : null;
    }, 15000);
    ok(!!left, 'after quitting, none of its processes are left running');
  }

  // ── 7. protection comes back the way the user left it (issue #8): a
  //       restart (an update, a crash, a reboot) does not turn it on again ──
  if (!BASELINE) {
    const relaunch = async (protectionOn) => {
      const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
      // Auto mode on, as for most people: it no longer decides on its own.
      fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ ...cfg, autoMode: true, protectionOn }));
      const a = await _electron.launch({
        executablePath: require(path.join(APP, 'node_modules', 'electron')),
        args: [APP, `--user-data-dir=${ud}`, '--autostart', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
        env, timeout: 60000,
      });
      const engineUp = async () => (await tree(a.process().pid)).some((p) => /shroudly-core/.test(p.cmd) && !/--watchdog/.test(p.cmd));
      const up = await until(engineUp, 8000, 500);
      await a.close().catch(() => {});
      return !!up;
    };
    ok(!(await relaunch(false)), 'stopped by the user, then restarted: protection stays off');
    if (process.env.CI) ok(await relaunch(true), 'left on by the user, then restarted: protection comes back on');
  }

  // ── 7b. the notification-area icon hidden in Settings (issue #12):
  //        closing the window leaves Shroudly running in the background, and
  //        starting it again brings the window back ──
  if (!BASELINE) {
    const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
    fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ ...cfg, autoMode: false, protectionOn: false, showTrayIcon: false }));
    const bin = require(path.join(APP, 'node_modules', 'electron'));
    const extra = process.platform === 'linux' ? ['--no-sandbox'] : [];
    const a = await _electron.launch({ executablePath: bin, args: [APP, `--user-data-dir=${ud}`, ...extra], env, timeout: 60000 });
    try {
      const w = await a.firstWindow();
      await w.waitForLoadState('domcontentloaded');
      await w.evaluate(() => window.electron.closeWindow());
      await sleep(2500);
      const shown = () => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((x) => x.isVisible()));
      ok(!(await shown()) && !a.process().killed && a.process().exitCode === null, 'icon hidden: closing the window leaves Shroudly running in the background');
      const second = require('child_process').spawn(bin, [APP, `--user-data-dir=${ud}`, ...extra], { env, stdio: 'ignore' });
      await new Promise((r) => { second.once('exit', r); second.once('error', r); setTimeout(r, 30000); });
      ok(!!(await until(shown, 20000, 300)), 'icon hidden: starting Shroudly again brings the window back');
    } finally { await a.close().catch(() => {}); }
    const after = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
    delete after.showTrayIcon;
    fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify(after));
  }

  // ── 8. a desktop with no tray icons (stock GNOME): the window must never
  //       vanish, since nothing on screen could bring it back ──
  if (!BASELINE && process.platform === 'linux') {
    const cfg = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
    fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ ...cfg, autoMode: false, protectionOn: false }));
    const envNoTray = { ...env };
    delete envNoTray.SHROUDLY_TRAY;   // the real check, on a session bus with no StatusNotifier host
    const a = await _electron.launch({
      executablePath: require(path.join(APP, 'node_modules', 'electron')),
      args: [APP, `--user-data-dir=${ud}`, '--no-sandbox'], env: envNoTray, timeout: 60000,
    });
    try {
      const w = await a.firstWindow();
      await w.waitForLoadState('domcontentloaded');
      const count = () => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      await sleep(IDLE_MS + 8000);
      ok(await count() === 1, 'no tray: an unused window is not closed');
      // With no window manager (CI's bare X server) nothing carries out a
      // minimise, so what is checked is that one was asked for and the window
      // was not hidden: minimised under a window manager, still shown without.
      await a.evaluate(({ BrowserWindow }) => {
        const x = BrowserWindow.getAllWindows()[0];
        const m = x.minimize.bind(x);
        global.minimiseAsked = 0;
        x.minimize = () => { global.minimiseAsked++; m(); };
      });
      await w.evaluate(() => window.electron.closeWindow());
      await sleep(2500);
      const st = await a.evaluate(({ BrowserWindow }) => {
        const x = BrowserWindow.getAllWindows()[0];
        return x ? { asked: global.minimiseAsked, shown: x.isMinimized() || x.isVisible() } : null;
      });
      ok(!!st && st.asked > 0 && st.shown, `no tray: closing minimises instead of hiding (${JSON.stringify(st)})`);
      ok(await w.evaluate(() => typeof window.electron.quitApp === 'function'), 'the window offers its own Quit');
    } finally { await a.close().catch(() => {}); }
    // Started at login (or by an update) with "minimize to tray" on: with no
    // tray to come back from, a window all the same, minimised.
    const b = await _electron.launch({
      executablePath: require(path.join(APP, 'node_modules', 'electron')),
      args: [APP, `--user-data-dir=${ud}`, '--autostart', '--no-sandbox'], env: envNoTray, timeout: 60000,
    });
    try {
      await b.firstWindow({ timeout: 30000 });
      ok(await b.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1, 'no tray, started at login: a window all the same, never nothing on screen');
    } finally { await b.close().catch(() => {}); }
  }
  fs.rmSync(ud, { recursive: true, force: true });

  console.log(`\n── memory (${process.platform}-${process.arch}${BASELINE ? `, baseline ${APP}` : ''})`);
  for (const l of report) console.log(`  ${l}`);
  fs.writeFileSync(path.join(SHOTS, `memory-${BASELINE ? 'baseline' : 'new'}-${process.platform}-${process.arch}.txt`), report.join('\n') + '\n');
  if (!BASELINE) console.log(`\ne2e: ${count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
