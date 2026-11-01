'use strict';

/* "shroudly-core --watchdog": the process that has the network settings put
 * back when Shroudly is killed. A stand-in Shroudly is started and killed; the
 * restore command is a small script that records the arguments it was given,
 * so the test sees exactly what would have run. Covered: a leftover setting
 * gets restored (with arguments that need quoting, in a folder named with
 * spaces and non-ASCII letters, as a Windows user folder can be), nothing
 * left means nothing runs, a closed pipe while Shroudly is still alive does
 * nothing until it ends, the watchdog stays small, one stopped while
 * Shroudly runs is started again, but not once its file is gone (an
 * antivirus took it), and with the engine binary gone nothing is started in
 * its place (Electron is never run as Node.js). Shroudly ended together with
 * everything it started (Windows' "End process tree", taskkill /T; its
 * whole process group elsewhere): the watchdog is not among them, and puts
 * things back (W7). */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { enginePath, suite, sleep } = require('./helpers');

const t = suite('watchdog');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly wd ç-'));
const RECORD = 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))';
const ODD = ['a b', 'quote"inside', 'trailing\\', 'ünïcødé', ''];

function fakeApp() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

function startWatchdog(appPid, out) {
  const w = spawn(enginePath(), ['--watchdog', String(appPid), process.execPath, '-e', RECORD, out, ...ODD], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  w.exitedAt = null;
  w.on('exit', () => { w.exitedAt = Date.now(); });
  return w;
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(100); }
  return fn();
}

function rssKb(pid) {
  try {
    if (process.platform === 'linux') return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]);
    if (process.platform === 'darwin') return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim());
    const csv = execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']).toString();
    return Number((csv.split('","')[4] || '').replace(/[^\d]/g, ''));
  } catch { return NaN; }
}

(async () => {
  // 1. Killed with a setting still applied: the restore command runs, with
  //    every argument intact.
  {
    const app = fakeApp();
    const state = path.join(dir, 'proxy-state.json');
    const out = path.join(dir, 'restored 1.json');
    fs.writeFileSync(state, '{}');
    const w = startWatchdog(app.pid, out);
    w.stdin.write(`proxy\t${state}\n`);
    await sleep(1000);
    const kb = rssKb(w.pid);
    // (A sanitizer build, given in SHROUDLY_ENGINE, is several times larger.)
    if (!process.env.SHROUDLY_ENGINE) t.ok(kb > 0 && kb < 8 * 1024, `the watchdog stays small (${(kb / 1024).toFixed(1)} MB)`);
    app.kill();
    w.stdin.end();
    const ran = await waitFor(() => fs.existsSync(out), 8000);
    t.ok(ran, 'Shroudly gone with a setting applied: the restore command ran');
    const args = ran ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
    t.ok(JSON.stringify(args) === JSON.stringify(ODD), `arguments arrive exactly (${JSON.stringify(args)})`);
    t.ok(await waitFor(() => w.exitedAt, 3000), 'the watchdog exits afterwards');
  }

  // 1b. Discord app mode's line (discord-line.js): Shroudly killed with it in
  //     Discord's settings, the restore runs, as for the proxy (M1).
  {
    const app = fakeApp();
    const state = path.join(dir, 'discord-line.json');
    const out = path.join(dir, 'restored 1b.json');
    fs.writeFileSync(state, '{}');
    const w = startWatchdog(app.pid, out);
    w.stdin.write(`discord\t${state}\n`);
    await sleep(300);
    app.kill();
    w.stdin.end();
    t.ok(await waitFor(() => fs.existsSync(out), 8000), "Shroudly gone with Discord's line in place: the restore runs (it took the line out; Discord no longer waits on a relay that is gone)");
  }

  // 2. A normal quit removes its state files first: nothing to do.
  {
    const app = fakeApp();
    const state = path.join(dir, 'env-state.json');
    const out = path.join(dir, 'restored 2.json');
    const w = startWatchdog(app.pid, out);
    w.stdin.write(`env\t${state}\n`);   // never written, as after a clean stop
    await sleep(300);
    app.kill();
    w.stdin.end();
    t.ok(await waitFor(() => w.exitedAt, 5000), 'nothing left behind: the watchdog just exits');
    await sleep(500);
    t.ok(!fs.existsSync(out), 'and runs nothing');
  }

  // 3. The pipe closes while Shroudly is still running (it should not, but):
  //    nothing happens until Shroudly really ends, then the slow check acts.
  {
    const app = fakeApp();
    const state = path.join(dir, 'proxy-state-3.json');
    const out = path.join(dir, 'restored 3.json');
    fs.writeFileSync(state, '{}');
    const w = startWatchdog(app.pid, out);
    w.stdin.write(`proxy\t${state}\n`);
    w.stdin.end();
    await sleep(11500);
    t.ok(!fs.existsSync(out) && !w.exitedAt, 'pipe closed but Shroudly alive: nothing restored, still watching');
    app.kill();
    t.ok(await waitFor(() => fs.existsSync(out), 13000), 'Shroudly then ends: restored by the slow check');
  }

  // 4. Unknown lines and oversized input are ignored, not acted on.
  {
    const app = fakeApp();
    const out = path.join(dir, 'restored 4.json');
    const w = startWatchdog(app.pid, out);
    const decoy = path.join(dir, 'decoy.json');
    fs.writeFileSync(decoy, '{}');
    w.stdin.write(`exec\t${decoy}\nproxy\n\t\n${'x'.repeat(5000)}\n`);
    await sleep(300);
    app.kill();
    w.stdin.end();
    t.ok(await waitFor(() => w.exitedAt, 5000), 'garbage on the pipe: exits');
    await sleep(500);
    t.ok(!fs.existsSync(out), 'and does not treat it as something to restore');
  }

  // 5. The watchdog stopped while Shroudly runs (a task manager, a sweep of
  //    processes): started again, with what it was looking after.
  {
    const Watchdog = require(path.join(__dirname, '..', '..', 'electron', 'watchdog.js'));
    const state = path.join(dir, 'state 5.json');
    const out = path.join(dir, 'restored 5.json');
    fs.writeFileSync(state, '{}');
    const opts = { core: enginePath(), restore: { exe: process.execPath, args: ['-e', RECORD, out] } };
    t.ok(Watchdog.watch(opts, 'proxy', state) && Watchdog.running(), 'a watchdog is started for a state file');
    // (Windows: known once its copy outside Shroudly's tree has connected.)
    await waitFor(() => Watchdog.pid() > 0, 5000);
    const first = Watchdog.pid();
    t.ok(first > 0, `its process is there (${first})`);
    try { process.kill(first, 'SIGKILL'); } catch {}
    t.ok(await waitFor(() => Watchdog.pid() > 0 && Watchdog.pid() !== first, 5000), 'killed while Shroudly runs: started again');
    // Nothing left to restore when this test ends.
    fs.rmSync(state, { force: true });
  }

  // 6. Ended with its file gone (an antivirus quarantined the engine, which
  //    is the watchdog too): not started again, said once.
  {
    const Watchdog = require(path.join(__dirname, '..', '..', 'electron', 'watchdog.js'));
    const core = path.join(dir, path.basename(enginePath()));
    fs.copyFileSync(enginePath(), core);
    fs.chmodSync(core, 0o755);
    const gone = [];
    const state = path.join(dir, 'state 6.json');
    fs.writeFileSync(state, '{}');
    const opts = { core, restore: { exe: process.execPath, args: ['-e', RECORD, path.join(dir, 'restored 6.json')] }, onCoreGone: (c) => gone.push(c) };
    Watchdog.watch(opts, 'proxy', state);
    // The one running now came from test 5: ended, it comes back from this copy.
    await waitFor(() => Watchdog.pid() > 0, 5000);
    const before = Watchdog.pid();
    try { process.kill(before, 'SIGKILL'); } catch {}
    t.ok(await waitFor(() => Watchdog.pid() > 0 && Watchdog.pid() !== before, 5000), 'started again from its file while that is there');
    const fromCopy = Watchdog.pid();
    try { process.kill(fromCopy, 'SIGKILL'); } catch {}
    // As an antivirus does: the program ended, its file moved away (Windows
    // lets go of the file a moment after the end).
    await waitFor(() => !Watchdog.running(), 3000);
    fs.rmSync(core, { force: true, maxRetries: 20, retryDelay: 50 });
    await sleep(2500);
    t.ok(!Watchdog.running() && !fs.existsSync(core), 'its file gone: not started again');
    t.ok(gone.length === 1 && gone[0] === core, 'and said once (the engine\'s own end tells the user)');
  }
  // 7. The engine binary gone (an antivirus quarantined it): nothing is
  //    started in its place. Shroudly.exe is never run as plain Node.js
  //    (ELECTRON_RUN_AS_NODE), which antivirus programs flag; the build
  //    switches that off in Electron itself.
  {
    const cp = require('child_process');
    const file = path.join(__dirname, '..', '..', 'electron', 'watchdog.js');
    const realSpawn = cp.spawn;
    const spawned = [];
    cp.spawn = (cmd, args, o) => { spawned.push({ cmd, args, env: o && o.env }); return realSpawn(process.execPath, ['-e', ''], o); };
    delete require.cache[require.resolve(file)];
    let W;
    try { W = require(file); } finally { cp.spawn = realSpawn; }
    const state = path.join(dir, 'state 7.json');
    fs.writeFileSync(state, '{}');
    const gone = { core: path.join(dir, 'quarantined', path.basename(enginePath())), restore: { exe: process.execPath }, execPath: process.execPath, script: path.join(dir, 'x.js') };
    t.ok(W.watch(gone, 'proxy', state) === false && !W.running() && !spawned.length, 'engine binary missing: no watchdog, and nothing started in its place');
    const root = path.join(__dirname, '..', '..');
    const setsRunAsNode = fs.readdirSync(path.join(root, 'electron')).filter((f) => f.endsWith('.js'))
      .filter((f) => /ELECTRON_RUN_AS_NODE\s*=(?!=)|\bfork\s*\(/.test(fs.readFileSync(path.join(root, 'electron', f), 'utf8')));
    t.ok(!setsRunAsNode.length, `nothing in the app runs Electron as Node.js (${setsRunAsNode.join(', ') || 'none'})`);
    const fuses = require(path.join(root, 'package.json')).build.electronFuses || {};
    t.ok(fuses.runAsNode === false && fuses.enableNodeOptionsEnvironmentVariable === false && fuses.enableNodeCliInspectArguments === false,
      'the packaged app ignores ELECTRON_RUN_AS_NODE, NODE_OPTIONS and --inspect (electronFuses)');
    fs.rmSync(state, { force: true });
  }

  // 8. Shroudly ended with everything it started at once: Windows' "End
  //    process tree" and taskkill /T, which cafe reset scripts use; its whole
  //    process group elsewhere. The watchdog is not among them (on Windows a
  //    copy outside Shroudly's tree, told over a named pipe), and puts
  //    things back (W7).
  {
    const state = path.join(dir, 'state 8.json');
    const out = path.join(dir, 'restored 8.json');
    fs.writeFileSync(state, '{}');
    const lib = path.join(__dirname, '..', '..', 'electron', 'watchdog.js');
    const script = `const W = require(${JSON.stringify(lib)});
      W.watch({ core: ${JSON.stringify(enginePath())}, restore: { exe: process.execPath, args: ['-e', ${JSON.stringify(RECORD)}, ${JSON.stringify(out)}] } }, 'proxy', ${JSON.stringify(state)});
      const t = setInterval(() => { if (W.pid() > 0) { console.log('watchdog ' + W.pid()); clearInterval(t); } }, 50);
      setInterval(() => {}, 1000);`;
    const win = process.platform === 'win32';
    const app = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: !win });
    let said = '';
    app.stdout.on('data', (d) => { said += d; });
    t.ok(await waitFor(() => /watchdog \d+/.test(said), 8000), `Shroudly's stand-in started its watchdog (${said.trim() || 'nothing said'})`);
    const wpid = Number((/watchdog (\d+)/.exec(said) || [])[1]);
    if (win) {
      // The watchdog's parent is a process that has already left.
      const tree = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${app.pid}').ProcessId`], { encoding: 'utf8' }).match(/\d+/g) || [];
      t.ok(!tree.includes(String(wpid)), `Windows: the watchdog (${wpid}) is not in Shroudly's process tree (${tree.join(', ') || 'no children'})`);
      execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    } else {
      process.kill(-app.pid, 'SIGKILL');
    }
    t.ok(await waitFor(() => fs.existsSync(out), 10000),
      `${win ? 'taskkill /T /F' : "the whole process group killed"}: the watchdog lived on and the restore ran`);
    fs.rmSync(state, { force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`watchdog: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
