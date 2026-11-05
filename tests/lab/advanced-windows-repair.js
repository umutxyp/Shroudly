'use strict';

/* Advanced mode on Windows when Windows says "not found" (2, 3) about the
 * WinDivert driver although Shroudly's files are all there (Akbar, 2.6.55):
 * the engine repairs it by itself (core/src/raw_windows.c,
 * repair_stale_service and use_system_copy). On the real driver, as
 * Administrator (CI's Windows runners are):
 *
 *   A. Another program left a "WinDivert" service behind, pointing at a
 *      folder since deleted. The engine deletes it and starts its own.
 *   B. The kernel cannot read the folder Shroudly runs from: the engine is
 *      run from a drive letter made with subst, which exists only for this
 *      user's session, not for the service manager that loads drivers. The
 *      engine copies the driver to Common Files\Shroudly and starts it from
 *      there.
 *
 * Each case: the engine comes up, says what it repaired, stops, and leaves
 * no WinDivert service behind.
 *
 *   node tests/lab/advanced-windows-repair.js electron/tools/core/win32-x64/shroudly-core-adv.exe
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { buildAdvancedArgs } = require(path.join(__dirname, '..', '..', 'electron', 'advanced-mode.js'));

const engine = path.resolve(process.argv[2] || '');
let fails = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const bad = (m) => { console.log(`FAIL  ${m}`); fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sc = (...a) => { try { return execFileSync('sc', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
const state = () => { const o = sc('query', 'WinDivert'); return /1060/.test(o) ? 'missing' : ((o.match(/STATE\s*:\s*\d+\s+(\w+)/) || [])[1] || o.trim()); };

/* Runs the engine at `exe` until it is ready or ends; then stops it. */
async function run(exe, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-rep-'));
  const status = path.join(dir, 'status.log');
  const child = spawn(exe, buildAdvancedArgs({ fakeTtl: 4, statusFile: status, parentPid: process.pid, platform: 'win32' }), { stdio: 'ignore', windowsHide: true });
  let exited = null;
  child.on('exit', (c) => { exited = c; });
  child.on('error', (e) => { exited = e.message; });
  const read = () => { try { return fs.readFileSync(status, 'utf8'); } catch { return ''; } };
  for (let i = 0; i < 200 && !/"raw_ready"/.test(read()) && exited === null; i++) await sleep(100);
  const up = /"raw_ready"/.test(read());
  if (up) {
    fs.writeFileSync(`${status}.stop`, '');
    for (let i = 0; i < 100 && exited === null; i++) await sleep(100);
    if (exited === null) child.kill();
  }
  const text = read();
  console.log(`  ..  ${label}: ${text.split('\n').filter((l) => /"driver"|"error"/.test(l)).join(' ')}`);
  return { up, text, exited };
}

(async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') { console.log('advanced-windows-repair: skipped (Windows x64 only)'); return; }
  if (!fs.existsSync(engine)) { bad(`no engine at ${engine}`); process.exit(1); }
  if (state() !== 'missing') { sc('stop', 'WinDivert'); sc('delete', 'WinDivert'); await sleep(500); }

  // ── A: a service left behind, its driver file gone ──
  const gone = path.join(os.tmpdir(), `gone-${process.pid}`, 'x86_64', 'WinDivert64.sys');
  const made = sc('create', 'WinDivert', 'type=', 'kernel', 'start=', 'demand', 'binPath=', gone);
  if (/SUCCESS/i.test(made)) ok(`A: a "WinDivert" service pointing at ${gone} (never there)`);
  else { bad(`A: could not make the stale service: ${made.trim()}`); process.exit(1); }
  const a = await run(engine, 'A');
  if (a.up) ok('A: the engine came up anyway');
  else bad(`A: the engine did not come up (exit ${a.exited}): ${a.text.slice(-500)}`);
  if (/"type":"driver","stale":1,"file_gone":1/.test(a.text)) ok('A: it deleted the service left behind, and said its file was gone');
  else bad('A: no "stale":1,"file_gone":1 line');
  const afterA = state();
  if (afterA === 'missing') ok('A: no WinDivert service left after the stop');
  else { bad(`A: a WinDivert service is left: ${afterA}`); sc('stop', 'WinDivert'); sc('delete', 'WinDivert'); }

  // ── B: run from a drive the service manager cannot see ──
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'shroudly-subst-'));
  for (const f of [path.basename(engine), 'WinDivert.dll', 'WinDivert64.sys']) fs.copyFileSync(path.join(path.dirname(engine), f), path.join(src, f));
  const letter = ['R:', 'S:', 'T:', 'U:', 'V:', 'W:'].find((l) => !fs.existsSync(`${l}\\`));
  if (!letter) { bad('B: no free drive letter'); process.exit(1); }
  execFileSync('subst', [letter, src]);
  try {
    const b = await run(`${letter}\\${path.basename(engine)}`, 'B');
    if (b.up) ok(`B: run from ${letter} (subst), the engine came up`);
    else bad(`B: from ${letter} the engine did not come up (exit ${b.exited}): ${b.text.slice(-500)}`);
    if (/"type":"driver","copy":1/.test(b.text)) {
      ok('B: it started the driver from its copy in Common Files\\Shroudly');
    } else if (b.up && !/"type":"driver","copy"/.test(b.text)) {
      // This Windows let the service manager read the subst drive: nothing
      // to repair, and nothing was.
      ok('B: Windows here loaded the driver from the subst drive itself; no copy was needed');
    } else bad('B: no "copy":1 line');
    const common = path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'Shroudly');
    if (/"copy":1/.test(b.text)) {
      const same = ['WinDivert.dll', 'WinDivert64.sys'].every((f) => fs.readFileSync(path.join(common, f)).equals(fs.readFileSync(path.join(src, f))));
      if (same) ok(`B: the copy in ${common} is byte for byte Shroudly's`);
      else bad(`B: the copy in ${common} differs from Shroudly's`);
    }
    const afterB = state();
    if (afterB === 'missing') ok('B: no WinDivert service left after the stop');
    else { bad(`B: a WinDivert service is left: ${afterB}`); sc('stop', 'WinDivert'); sc('delete', 'WinDivert'); }
  } finally {
    try { execFileSync('subst', [letter, '/d']); } catch {}
  }

  console.log(fails ? `advanced-windows-repair: ${fails} failed` : 'advanced-windows-repair: all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
