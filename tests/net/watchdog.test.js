'use strict';

/* "shroudly-core --watchdog": the process that has the network settings put
 * back when Shroudly is killed. A stand-in Shroudly is started and killed; the
 * restore command is a small script that records the arguments it was given,
 * so the test sees exactly what would have run. Covered: a leftover setting
 * gets restored (with arguments that need quoting, in a folder named with
 * spaces and non-ASCII letters, as a Windows user folder can be), nothing
 * left means nothing runs, a closed pipe while Shroudly is still alive does
 * nothing until it ends, and the watchdog stays small. */

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
    const first = Watchdog.pid();
    t.ok(first > 0, `its process is there (${first})`);
    try { process.kill(first, 'SIGKILL'); } catch {}
    t.ok(await waitFor(() => Watchdog.pid() > 0 && Watchdog.pid() !== first, 5000), 'killed while Shroudly runs: started again');
    // Nothing left to restore when this test ends.
    fs.rmSync(state, { force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`watchdog: ${t.count} passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
